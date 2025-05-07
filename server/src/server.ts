import { Parser, AstCompiler } from '@harmoniclabs/pebble';

import {
	createConnection,
	Range,
	TextDocuments,
	Diagnostic,
	ProposedFeatures,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	DocumentDiagnosticReportKind,
	DocumentHighlight,
	DocumentHighlightKind,
	DocumentHighlightParams,
	Hover,
	HoverParams,
	type DocumentDiagnosticReport,
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import { PebbleStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/PebbleStmt';
import { ImportStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/ImportStmt';
import { VarStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/VarStmt';
import { IfStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/IfStmt';
import { ForStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/ForStmt';
import { ForOfStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/ForOfStmt';
import { WhileStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/WhileStmt';
import { ReturnStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/ReturnStmt';
import { BlockStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/BlockStmt';
import { BreakStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/BreakStmt';
import { ContinueStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/ContinueStmt';
import { EmptyStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/EmptyStmt';
import { FailStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/FailStmt';
import { AssertStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/AssertStmt';
import { TestStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/TestStmt';
import { MatchStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/MatchStmt';
import { ExportStarStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/ExportStarStmt';
import { ImportStarStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/ImportStarStmt';
import { ExportImportStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/ExportImportStmt';
import { TypeImplementsStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/TypeImplementsStmt';
import { ExprStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/ExprStmt';
import { UsingStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/UsingStmt';
import { ExportStmt } from '@harmoniclabs/pebble/dist/ast/nodes/statements/ExportStmt';
import { FuncDecl } from '@harmoniclabs/pebble/dist/ast/nodes/statements/declarations/FuncDecl';
import { StructDecl } from '@harmoniclabs/pebble/dist/ast/nodes/statements/declarations/StructDecl';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

connection.onInitialize(() => {
	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true
			},
			diagnosticProvider: {
				interFileDependencies: false,
				workspaceDiagnostics: false
			},
			documentHighlightProvider: true,
			hoverProvider: true,
		}
	};
	return result;
});

connection.languages.diagnostics.on(async (params) => {
	const document = documents.get(params.textDocument.uri);
	if (document !== undefined) {
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: await validateTextDocument(document)
		} satisfies DocumentDiagnosticReport;
	} else {
		// We don't know the document. We can either try to read it from disk
		// or we don't report problems for it.
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: []
		} satisfies DocumentDiagnosticReport;
	}
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<Diagnostic[]> {
	const documentPath = textDocument.uri.replace('file://', '');
	const documentBasePath = documentPath.split('/').slice(0, -1).join('/');
	const documentText = textDocument.getText();

	const compiler = new AstCompiler({ entry: documentPath, root: documentBasePath } as any);
	const diagnostics = await compiler.compileSource(documentPath, documentText);

	return diagnostics.filter(d => d.range).map(d => ({
		range: Range.create(textDocument.positionAt(d.range!!.start), textDocument.positionAt(d.range!!.end)),
		code: d.code,
		message: d.message,
		relatedInformation: d.emitStack ? [{
			location: {
				uri: textDocument.uri,
				range: Range.create(textDocument.positionAt(d.range!!.start), textDocument.positionAt(d.range!!.end))
			},
			message: `${d.message}\n${d.emitStack}`
		}] : []
	}));
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received a file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		// The pass parameter contains the position of the text document in
		// which code complete got requested. For the example we ignore this
		// info and always provide the same completion items.
		return [
			{
				label: 'TypeScript',
				kind: CompletionItemKind.Text,
				data: 1
			},
			{
				label: 'JavaScript',
				kind: CompletionItemKind.Text,
				data: 2
			}
		];
	}
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		if (item.data === 1) {
			item.detail = 'TypeScript details';
			item.documentation = 'TypeScript documentation';
		} else if (item.data === 2) {
			item.detail = 'JavaScript details';
			item.documentation = 'JavaScript documentation';
		}
		return item;
	}
);

connection.onDocumentHighlight((params: DocumentHighlightParams): DocumentHighlight[] => {
	const results: DocumentHighlight[] = [];
	const document = documents.get(params.textDocument.uri);
	if (document !== undefined) {
		const [source] = Parser.parseFile(document.uri, document.getText());
		const offset = document.offsetAt(params.position);
		for (const statement of source.statements) {
			if (offset >= statement.range.start && offset <= statement.range.end) {
				if (statement instanceof FuncDecl) {
					if (statement.expr.body instanceof BlockStmt) {
						for (const s of statement.expr.body.stmts) {
							let range = s.range;
							if (s instanceof AssertStmt) {
								range = s.condition.range;
								range.start -= 7;
								if (s.elseExpr) range.end = s.elseExpr.range.end;
							}
							if (s instanceof FailStmt) {
								if (s.value) {
									range = s.value.range;
									range.start -= 5;
								} else {
									range.start = range.end - 5;
								}
							}
							if (offset >= range.start && offset <= range.end) {
								const start = document.positionAt(range.start);
								const end = document.positionAt(range.end);
								results.push({
									range: Range.create(start, end),
									kind: DocumentHighlightKind.Read
								});
							}
						}
					}
				} else {
					const start = document.positionAt(statement.range.start);
					const end = document.positionAt(statement.range.end);
					results.push({
						range: Range.create(start, end),
						kind: DocumentHighlightKind.Read
					});
				}
			}
		}
	}
	return results;
});

// TODO: We need to implement SignatureHelp instead, and provide more context
function getStmtHoverText(statement: PebbleStmt): string {
	if (statement instanceof IfStmt) return 'If statement';
	if (statement instanceof VarStmt) return 'Var statement';
	if (statement instanceof ForStmt) return 'For statement';
	if (statement instanceof ForOfStmt) return 'For of statement';
	if (statement instanceof WhileStmt) return 'While statement';
	if (statement instanceof ReturnStmt) return 'Return statement';
	if (statement instanceof BlockStmt) return 'Block statement';
	if (statement instanceof BreakStmt) return 'Break statement';
	if (statement instanceof ContinueStmt) return 'Continue statement';
	if (statement instanceof EmptyStmt) return 'Empty statement';
	if (statement instanceof FailStmt) return 'Fail statement';
	if (statement instanceof AssertStmt) return 'Assert statement';
	if (statement instanceof TestStmt) return 'Test statement';
	if (statement instanceof MatchStmt) return 'Match statement';
	if (statement instanceof ExportStarStmt) return 'Export star statement';
	if (statement instanceof ImportStarStmt) return 'Import star statement';
	if (statement instanceof ExportImportStmt) return 'Export import statement';
	if (statement instanceof ImportStmt) return 'Import statement';
	if (statement instanceof TypeImplementsStmt) return 'Type implements statement';
	if (statement instanceof ExprStmt) return 'Expression  statement';
	if (statement instanceof UsingStmt) return 'Using  statement';
	if (statement instanceof ExportStmt) return 'Export statement';
	if (statement instanceof FuncDecl) return 'Function declaration';
	if (statement instanceof StructDecl) return 'Struct declaration';
	return '';
}

connection.onHover((params: HoverParams): Hover | null => {
	const document = documents.get(params.textDocument.uri);
	if (document !== undefined) {
		const [source] = Parser.parseFile(document.uri, document.getText());
		const offset = document.offsetAt(params.position);
		console.log(source.statements);
		for (const statement of source.statements) {
			if (offset >= statement.range.start && offset <= statement.range.end) {
				if (statement instanceof FuncDecl) {
					if (statement.expr.body instanceof BlockStmt) {
						for (const s of statement.expr.body.stmts) {
							let range = s.range;
							if (s instanceof AssertStmt) {
								range = s.condition.range;
								range.start -= 7;
								if (s.elseExpr) range.end = s.elseExpr.range.end;
							}
							if (s instanceof FailStmt) {
								if (s.value) {
									range = s.value.range;
									range.start -= 5;
								} else {
									range.start = range.end - 5;
								}
							}
							if (offset >= range.start && offset <= range.end) {
								const start = document.positionAt(range.start);
								const end = document.positionAt(range.end);
								return {
									contents: {
										kind: 'markdown',
										value: getStmtHoverText(s)
									},
									range: Range.create(start, end)
								};
							}
						}
					}
				} else {
					const start = document.positionAt(statement.range.start);
					const end = document.positionAt(statement.range.end);
					return {
						contents: {
							kind: 'markdown',
							value: getStmtHoverText(statement)
						},
						range: Range.create(start, end)
					};
				}
			}
		}
	}
	return null;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
