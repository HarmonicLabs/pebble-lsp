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
	Definition,
	DefinitionParams,
	type DocumentDiagnosticReport,
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import { Source } from '@harmoniclabs/pebble/dist/ast/Source/Source';
import { SourceRange } from '@harmoniclabs/pebble/dist/ast/Source/SourceRange';

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
import { Identifier } from '@harmoniclabs/pebble/dist/ast/nodes/common/Identifier';
import { FuncDecl } from '@harmoniclabs/pebble/dist/ast/nodes/statements/declarations/FuncDecl';
import { StructDecl } from '@harmoniclabs/pebble/dist/ast/nodes/statements/declarations/StructDecl';
import { SimpleVarDecl } from '@harmoniclabs/pebble/dist/ast/nodes/statements/declarations/VarDecl/SimpleVarDecl';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize(() => {
	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: {
				resolveProvider: true,
				triggerCharacters: ['.', ' ']
			},
			diagnosticProvider: {
				interFileDependencies: false,
				workspaceDiagnostics: false
			},
			documentHighlightProvider: true,
			hoverProvider: true,
			definitionProvider: true,
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
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: []
		} satisfies DocumentDiagnosticReport;
	}
});

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

connection.onCompletion((_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
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
});

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	if (item.data === 1) {
		item.detail = 'TypeScript details';
		item.documentation = 'TypeScript documentation';
	} else if (item.data === 2) {
		item.detail = 'JavaScript details';
		item.documentation = 'JavaScript documentation';
	}
	return item;
});

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

connection.onDefinition((params: DefinitionParams): Definition | null => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return null;
	
	try {
		const [source] = Parser.parseFile(document.uri, document.getText());
		const offset = document.offsetAt(params.position);
		
		const identifierInfo = findIdentifierInSource(source, offset);
		if (!identifierInfo) return null;
		
		const definition = findDefinition(source.statements, identifierInfo.identifier);
		if (!definition) return null;
		
		const start = document.positionAt(definition.start);
		const end = document.positionAt(definition.end);
		
		return {
			uri: document.uri,
			range: Range.create(start, end)
		};
	} catch (error) {
		console.error('Error in onDefinition:', error);
		return null;
	}
});

interface IdentifierInfo {
	identifier: Identifier;
	context: 'variable' | 'function' | 'property' | 'parameter';
}

function findIdentifierInSource(source: Source, offset: number): IdentifierInfo | null {
	for (const statement of source.statements) {
		if (offset >= statement.range.start && offset <= statement.range.end) {
			const result = findIdentifierInStatement(statement, offset);
			if (result) return result;
		}
	}
	return null;
}

function findIdentifierInStatement(statement: PebbleStmt, offset: number): IdentifierInfo | null {
	if (statement instanceof FuncDecl) {
		if (statement.expr.name && 
			offset >= statement.expr.name.range.start && 
			offset <= statement.expr.name.range.end) {
			return { identifier: statement.expr.name, context: 'function' };
		}
		
		for (const param of statement.expr.signature.params) {
			if (param instanceof SimpleVarDecl && param.name && 
				offset >= param.name.range.start && 
				offset <= param.name.range.end) {
				return { identifier: param.name, context: 'parameter' };
			}
		}
		
		if (statement.expr.body instanceof BlockStmt) {
			for (const stmt of statement.expr.body.stmts) {
				const result = findIdentifierInStatement(stmt, offset);
				if (result) return result;
			}
		}
	}
	
	if (statement instanceof VarStmt) {
		for (const decl of statement.declarations) {
			if (decl instanceof SimpleVarDecl && decl.name && 
				offset >= decl.name.range.start && 
				offset <= decl.name.range.end) {
				return { identifier: decl.name, context: 'variable' };
			}
			if (decl instanceof SimpleVarDecl && decl.initExpr) {
				const result = findIdentifierInExpression(decl.initExpr, offset);
				if (result) return result;
			}
		}
	}
	
	if (statement instanceof StructDecl) {
		if (statement.name && 
			offset >= statement.name.range.start && 
			offset <= statement.name.range.end) {
			return { identifier: statement.name, context: 'function' };
		}
	}
	
	if (statement instanceof ExprStmt) {
		return findIdentifierInExpression(statement.expr, offset);
	}
	
	if ((statement as any).assignedExpr) {
		const result = findIdentifierInExpression((statement as any).assignedExpr, offset);
		if (result) return result;
	}
	
	if (statement instanceof AssertStmt && statement.condition) {
		return findIdentifierInExpression(statement.condition, offset);
	}
	
	if (statement instanceof FailStmt && statement.value) {
		return findIdentifierInExpression(statement.value, offset);
	}
	
	if (statement instanceof ReturnStmt && statement.value) {
		return findIdentifierInExpression(statement.value, offset);
	}
	
	return null;
}

function findIdentifierInExpression(expr: any, offset: number): IdentifierInfo | null {
	if (!expr || offset < expr.range.start || offset > expr.range.end) {
		return null;
	}
	
	if (expr instanceof Identifier) {
		return { identifier: expr, context: 'variable' };
	}
	
	if (expr.prop && expr.object) {
		if (offset >= expr.prop.range.start && offset <= expr.prop.range.end) {
			return { identifier: expr.prop, context: 'property' };
		}
		return findIdentifierInExpression(expr.object, offset);
	}
	
	if (expr.funcExpr) {
		const funcResult = findIdentifierInExpression(expr.funcExpr, offset);
		if (funcResult) return funcResult;
		if (expr.args) {
			for (const arg of expr.args) {
				const result = findIdentifierInExpression(arg, offset);
				if (result) return result;
			}
		}
	}
	
	if (expr.left && expr.right) {
		const leftResult = findIdentifierInExpression(expr.left, offset);
		if (leftResult) return leftResult;
		
		const rightResult = findIdentifierInExpression(expr.right, offset);
		if (rightResult) return rightResult;
	}
	
	if (expr.object && expr.index) {
		const objResult = findIdentifierInExpression(expr.object, offset);
		if (objResult) return objResult;
		
		const indexResult = findIdentifierInExpression(expr.index, offset);
		if (indexResult) return indexResult;
	}
	
	return null;
}

function findDefinition(statements: PebbleStmt[], identifier: Identifier): SourceRange | null {
	const targetName = identifier.text;
	if (!targetName) return null;
	
	for (const statement of statements) {
		if (statement instanceof FuncDecl && 
			statement.expr.name && 
			statement.expr.name.text === targetName) {
			return statement.expr.name.range;
		}
		
		if (statement instanceof StructDecl && 
			statement.name && 
			statement.name.text === targetName) {
			return statement.name.range;
		}
		
		if (statement instanceof VarStmt) {
			for (const decl of statement.declarations) {
				if (decl instanceof SimpleVarDecl && decl.name && decl.name.text === targetName) {
					return decl.name.range;
				}
			}
		}
		
		if (statement instanceof ImportStmt) {
			for (const member of statement.members) {
				if (member.identifier && member.identifier.text === targetName) {
					return member.identifier.range;
				}
				if (member.asIdentifier && member.asIdentifier.text === targetName) {
					return member.asIdentifier.range;
				}
			}
		}

		if (statement instanceof FuncDecl) {
			if (statement.expr.body instanceof BlockStmt) {
				return findDefinition(statement.expr.body.stmts, identifier);
			}
		}
	}
	
	return null;
}

documents.listen(connection);

connection.listen();
