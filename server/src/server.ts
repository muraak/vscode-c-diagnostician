/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
	createConnection,
	TextDocuments,
	TextDocument,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
} from 'vscode-languageserver';

import * as child_process from "child_process";
import * as path from "path";

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we will fall back using global settings
	hasConfigurationCapability =
		capabilities.workspace && !!capabilities.workspace.configuration;
	hasWorkspaceFolderCapability =
		capabilities.workspace && !!capabilities.workspace.workspaceFolders;

	return {
		capabilities: {
			textDocumentSync: documents.syncKind,
			// Tell the client that the server supports code completion
			completionProvider: {
				resolveProvider: true
			}
		}
	};
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(
			DidChangeConfigurationNotification.type,
			undefined
		);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

interface CccdSettings {
	maxNumberOfProblems: number;
	compileCommand: string;
	compileOptions: string[];
	diagDelimiter: string;
	parse: {
		diagInfoPattern: string;
		index: {
			file_name: number;
			line_pos: number;
			char_pos: number;
			severity: number;
		}
	}
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: CccdSettings = {
	maxNumberOfProblems: 1000,
	compileCommand: "gcc",
	compileOptions: ["-fsyntax-only", "-Wall", "-fdiagnostics-parseable-fixits"],
	diagDelimiter: "^.+:[0-9]+:[0-9]+:",
	parse: {
		diagInfoPattern: "^(.+):([0-9]+):([0-9]+):\s*(.+):.*",
		index: {
			file_name: 1,
			line_pos: 2,
			char_pos: 3,
			severity: 4
		}
	}
};

let globalSettings: CccdSettings = defaultSettings;

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<CccdSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <CccdSettings>(
			(change.settings.cccdLanguageServer || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(validateTextDocumentForGCC);
});

function getDocumentSettings(resource: string): Thenable<CccdSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'cccdiag'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

documents.onDidSave(change => {
	validateTextDocumentForGCC(change.document);
});

documents.onDidOpen(e =>{
	validateTextDocumentForGCC(e.document);
})


/* --------------------------------------------------------------------------------------------
 * Copyright (c) Muraak. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
async function validateTextDocumentForGCC(textDocument: TextDocument): Promise<void>
{
	let settings = await getDocumentSettings(textDocument.uri);
	let args = settings.compileOptions.concat([path.basename(textDocument.uri)]);

	child_process.execFile(settings.compileCommand, args,{
		cwd: path.dirname(textDocument.uri.replace("file://", ""))},
		(error, stdout, stderr) => {
			console.log(error);
			console.log(stdout);
			if(stderr)
			{
				parseDiagnosticMessageForGCC(stderr, textDocument);
			}
			else
			{
				let diagnostics: Diagnostic[] = [];
				connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
			}
		});
}

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Muraak. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
async function parseDiagnosticMessageForGCC(message: string, textDocument: TextDocument)
{
	let settings = await getDocumentSettings(textDocument.uri);

	let pattern = new RegExp("(?=" + settings.diagDelimiter + ")", "m");

	let errors = message.split(pattern);
	let lines = textDocument.getText().split(/\r\n|\r|\n/);

	let diagnostics: Diagnostic[] = [];

	errors.forEach(error => {
		let pattern = new RegExp(settings.parse.diagInfoPattern, "m");
		let match =  pattern.exec(error);
		
		if(path.basename(textDocument.uri) === match[1]) {
			let diagnosic :Diagnostic = {
				severity: DiagnosticSeverity.Error, // for now
				range:{
					start:
					{
						line: parseInt(match[settings.parse.index.line_pos], 10) - 1,
						character: 0, // for now
					},
					end:
					{
						line: parseInt(match[settings.parse.index.line_pos], 10) - 1,
						character: lines[parseInt(match[settings.parse.index.line_pos], 10) - 1].length - 1, // for now
					},
				},
				message: error,
				source: settings.compileCommand
			};
			diagnostics.push(diagnosic);
		}
	});

	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
