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
	ShowMessageNotification,
	MessageType,
} from 'vscode-languageserver';

import * as child_process from "child_process";
import * as path from "path";
import Uri from "vscode-uri";
import * as iconv from "iconv-lite";

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
	includeOptionPrefix: string;
	includePath: {
		absolute: string[];
		relative: string[];
	}
	diagDelimiter: string;
	parse: {
		encoding: string,
		diagInfoPattern: string;
		index: {
			file_name: number;
			line_pos: number;
			char_pos: number;
			severity: number;
		}
		severityIdentifier: {
			error: string;
			warning: string;
			information: string;
			hint: string;
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
	includeOptionPrefix: "-I",
	includePath: {
		absolute: [],
		relative: [],
	},
	diagDelimiter: "^.+:[0-9]+:[0-9]+:",
	parse: {
		encoding: "utf-8",
		diagInfoPattern: "^(.+):([0-9]+):([0-9]+):\s*(.+):.*",
		index: {
			file_name: 1,
			line_pos: 2,
			char_pos: 3,
			severity: 4
		},
		severityIdentifier: {
			error: "error",
			warning: "warning",
			information: "information",
			hint: "hint"
		},
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
	let includePathOptions = await getIncludePathOptions(settings);

	let args = settings.compileOptions;
	
	if(includePathOptions) 
	{
		args = args.concat(includePathOptions);
	}

	args = args.concat([path.basename(textDocument.uri)]);

	child_process.execFile(settings.compileCommand, args,{
		cwd: path.dirname(Uri.parse(textDocument.uri).fsPath),
		encoding: "buffer"},
		(error, stdout, stderr) => {
			if(error){}
			if(stdout){}
			if(stderr)
			{
				try
				{
					parseDiagnosticMessageForGCC(iconv.decode(stderr, settings.parse.encoding), textDocument);
				}
				catch(e)
				{
					showDiagnosticErrorMessage(e.message);
				}
			}
			else
			{
				let diagnostics: Diagnostic[] = [];
				connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
			}
		});
}

async function getIncludePathOptions(settings: CccdSettings)
{
	let includeOptions :string[];

	if(settings.includePath.absolute.length > 0)
	{
		includeOptions = settings.includePath.absolute.map<string>((value) => {
			return settings.includeOptionPrefix + value
		});
	}

	if(settings.includePath.relative.length > 0)
	{
		let workPath = await getWorkSpaceUri();
		if(includeOptions)
		{
			includeOptions.concat(settings.includePath.relative.map<string>((value) => {
				return settings.includeOptionPrefix + Uri.parse(path.resolve(workPath, value)).fsPath;
			}));
		}
		else
		{
			includeOptions = settings.includePath.relative.map<string>((value) => {
				return settings.includeOptionPrefix + path.join(Uri.parse(workPath).fsPath, value);
			});
		}
	}

	return includeOptions;
}

async function getWorkSpaceUri()
{
	let uri :string;
	
	await connection.workspace.getWorkspaceFolders().then((folders) => {
		uri = folders[0].uri;
	});

	return uri;
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
				severity: detectSeverity(match[settings.parse.index.severity], settings),
				range:{
					start:
					{
						line: parseInt(match[settings.parse.index.line_pos], 10) - 1,
						character: 0, // for now
					},
					end:
					{
						line: parseInt(match[settings.parse.index.line_pos], 10) - 1,
						character: lines[parseInt(match[settings.parse.index.line_pos], 10) - 1].length, // for now
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

function detectSeverity(text :string, setting :CccdSettings)
{
	if(text.includes(setting.parse.severityIdentifier.error))
	{
		return DiagnosticSeverity.Error;
	}

	if(text.includes(setting.parse.severityIdentifier.warning))
	{
		return DiagnosticSeverity.Warning;
	}

	if(text.includes(setting.parse.severityIdentifier.information))
	{
		return DiagnosticSeverity.Information;
	}

	if(text.includes(setting.parse.severityIdentifier.hint))
	{
		return DiagnosticSeverity.Hint;
	}

	return DiagnosticSeverity.Error;
}

function showDiagnosticErrorMessage(message :string)
{
	connection.sendNotification(
		ShowMessageNotification.type,{
			type: MessageType.Error,
			message: "Diagnostic Error: " + message
	});
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
