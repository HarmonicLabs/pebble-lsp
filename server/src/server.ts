import { Parser as PebbleParser } from '@harmoniclabs/pebble';

import {
	createConnection,
	Range,
	TextDocuments,
	Diagnostic,
	ProposedFeatures,
	CompletionItem,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	DocumentDiagnosticReportKind,
	DocumentHighlight,
	DocumentHighlightParams,
	DocumentHighlightKind,
	Hover,
	HoverParams,
	Definition,
	DefinitionParams,
	type DocumentDiagnosticReport,
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import Parser from 'tree-sitter';
const Pebble = require("@harmoniclabs/tree-sitter-pebble");

const parser = new Parser();
parser.setLanguage(Pebble);

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Helper functions for document highlighting
function findNodeAtPosition(node: Parser.SyntaxNode, offset: number): Parser.SyntaxNode | null {
	// Check if the offset is within this node's range
	if (offset < node.startIndex || offset > node.endIndex) {
		return null;
	}
	
	// If this node has children, recursively search them
	for (const child of node.children) {
		const result = findNodeAtPosition(child, offset);
		if (result) {
			return result;
		}
	}
	
	// If no child contains the position, this node is the most specific one
	return node;
}

function getIdentifierName(node: Parser.SyntaxNode, text: string): string | null {
	// Check if the node is an identifier or contains an identifier
	if (node.type === 'identifier') {
		return text.slice(node.startIndex, node.endIndex);
	}
	
	// Handle Pebble-specific node types that contain identifiers
	const identifierContainingTypes = [
		'variable_declaration',
		'function_declaration', 
		'parameter',
		'let_declaration',
		'const_declaration',
		'struct_declaration',
		'field_declaration',
		'enum_variant',
		'member_expression',
		'call_expression'
	];
	
	if (identifierContainingTypes.includes(node.type)) {
		// Find the identifier child
		for (const child of node.children) {
			if (child.type === 'identifier') {
				return text.slice(child.startIndex, child.endIndex);
			}
		}
	}
	
	// Check if parent is an identifier (in case we're on part of an identifier)
	if (node.parent && node.parent.type === 'identifier') {
		return text.slice(node.parent.startIndex, node.parent.endIndex);
	}
	
	// Walk up the tree to find identifier in parent nodes
	let current = node.parent;
	while (current) {
		if (current.type === 'identifier') {
			return text.slice(current.startIndex, current.endIndex);
		}
		// Look for identifier children in parent nodes
		for (const child of current.children) {
			if (child.type === 'identifier' && 
				child.startIndex <= node.startIndex && 
				child.endIndex >= node.endIndex) {
				return text.slice(child.startIndex, child.endIndex);
			}
		}
		current = current.parent;
	}
	
	return null;
}

function findIdentifierOccurrences(
	node: Parser.SyntaxNode, 
	identifierName: string, 
	text: string, 
	document: TextDocument, 
	highlights: DocumentHighlight[]
): void {
	// Check if this node is an identifier with the same name
	if (node.type === 'identifier') {
		const nodeText = text.slice(node.startIndex, node.endIndex);
		if (nodeText === identifierName) {
			const range = Range.create(
				document.positionAt(node.startIndex),
				document.positionAt(node.endIndex)
			);
			
			// Use text highlighting for all occurrences
			// TODO: Implement proper Read/Write distinction when type issues are resolved
			const kind = DocumentHighlightKind.Text;
			
			highlights.push({ range, kind });
		}
	}
	
	// Recursively search all children
	for (const child of node.children) {
		findIdentifierOccurrences(child, identifierName, text, document, highlights);
	}
}

// Helper function to generate hover information
function generateHoverInfo(node: Parser.SyntaxNode, text: string, rootNode: Parser.SyntaxNode): string | null {
	// Get the identifier name if this is an identifier node
	const identifierName = getIdentifierName(node, text);
	if (!identifierName) {
		// Handle non-identifier nodes that might be interesting to hover over
		return getNodeTypeInfo(node, text);
	}
	
	// Find the declaration of this identifier
	const declaration = findDeclaration(identifierName, rootNode, text);
	if (declaration) {
		return formatDeclarationInfo(declaration, text, identifierName);
	}
	
	// Handle built-in types and keywords
	const builtInInfo = getBuiltInInfo(identifierName);
	if (builtInInfo) {
		return builtInInfo;
	}
	
	// If no declaration found, provide basic information
	if (node.type === 'identifier') {
		return `**${identifierName}**\n\n*Identifier* (no declaration found in current file)`;
	}
	
	return null;
}

function getNodeTypeInfo(node: Parser.SyntaxNode, text: string): string | null {
	const nodeText = text.slice(node.startIndex, node.endIndex).trim();
	
	switch (node.type) {
		case 'string_literal':
			return `**String Literal**\n\n\`\`\`pebble\n${nodeText}\n\`\`\`\n\nString value: ${nodeText}`;
		case 'number_literal':
		case 'integer_literal':
			return `**Number Literal**\n\n\`\`\`pebble\n${nodeText}\n\`\`\`\n\nNumeric value: ${nodeText}`;
		case 'boolean_literal':
			return `**Boolean Literal**\n\n\`\`\`pebble\n${nodeText}\n\`\`\`\n\nBoolean value: ${nodeText}`;
		case 'comment':
			return `**Comment**\n\n\`\`\`pebble\n${nodeText}\n\`\`\``;
		default:
			return null;
	}
}

// Find the declaration of an identifier
function findDeclaration(identifierName: string, rootNode: Parser.SyntaxNode, text: string): Parser.SyntaxNode | null {
	// First, try to find the most specific declaration (function, struct, or variable declarations)
	const primaryDeclaration = findPrimaryDeclaration(identifierName, rootNode, text);
	if (primaryDeclaration) return primaryDeclaration;
	
	// Fallback to general recursive search
	return findDeclarationRecursive(identifierName, rootNode, text);
}

// Find primary declarations (functions, structs, top-level variables)
function findPrimaryDeclaration(identifierName: string, node: Parser.SyntaxNode, text: string): Parser.SyntaxNode | null {
	const primaryDeclarationTypes = [
		'function_declaration',
		'struct_declaration',
		'const_declaration',
		'let_declaration',
		'variable_declaration'
	];
	
	// Check direct children first for top-level declarations
	for (const child of node.children) {
		if (primaryDeclarationTypes.includes(child.type) && isDeclarationNode(child, identifierName, text)) {
			return child;
		}
	}
	
	// Also check for parameter declarations and local scope declarations
	const allDeclarationTypes = [
		...primaryDeclarationTypes,
		'parameter',
		'field_declaration'
	];
	
	// Recursively search for declarations
	for (const child of node.children) {
		if (allDeclarationTypes.includes(child.type) && isDeclarationNode(child, identifierName, text)) {
			return child;
		}
		const result = findPrimaryDeclaration(identifierName, child, text);
		if (result) return result;
	}
	
	return null;
}

function findDeclarationRecursive(identifierName: string, node: Parser.SyntaxNode, text: string): Parser.SyntaxNode | null {
	// Check if this node is a declaration for the identifier
	if (isDeclarationNode(node, identifierName, text)) {
		return node;
	}
	
	// Recursively search children
	for (const child of node.children) {
		const result = findDeclarationRecursive(identifierName, child, text);
		if (result) return result;
	}
	
	return null;
}

function isDeclarationNode(node: Parser.SyntaxNode, identifierName: string, text: string): boolean {
	const declarationTypes = [
		'variable_declaration',
		'function_declaration',
		'let_declaration',
		'const_declaration',
		'struct_declaration',
		'parameter',
		'field_declaration'
	];
	
	if (!declarationTypes.includes(node.type)) return false;
	
	// Find identifier child and check if it matches
	for (const child of node.children) {
		if (child.type === 'identifier') {
			const childText = text.slice(child.startIndex, child.endIndex);
			if (childText === identifierName) {
				return true;
			}
		}
	}
	
	return false;
}

function formatDeclarationInfo(declarationNode: Parser.SyntaxNode, text: string, identifierName: string): string {
	const nodeText = text.slice(declarationNode.startIndex, declarationNode.endIndex);
	
	switch (declarationNode.type) {
		case 'function_declaration':
			return formatFunctionDeclaration(declarationNode, text, identifierName);
		case 'variable_declaration':
		case 'let_declaration':
		case 'const_declaration':
			return formatVariableDeclaration(declarationNode, text, identifierName);
		case 'struct_declaration':
			return formatStructDeclaration(declarationNode, text, identifierName);
		case 'parameter':
			return formatParameterDeclaration(declarationNode, text, identifierName);
		case 'field_declaration':
			return formatFieldDeclaration(declarationNode, text, identifierName);
		default:
			return `**${identifierName}**\n\n\`\`\`pebble\n${nodeText.trim()}\n\`\`\``;
	}
}

function formatFunctionDeclaration(node: Parser.SyntaxNode, text: string, identifierName: string): string {
	const nodeText = text.slice(node.startIndex, node.endIndex);
	const lines = nodeText.split('\n');
	const signature = lines[0].trim();
	
	// Extract parameters if possible
	let paramInfo = '';
	const parameterNodes = node.children.filter(child => child.type === 'parameter' || child.type === 'parameter_list');
	if (parameterNodes.length > 0) {
		const params = parameterNodes.map(param => {
			const paramText = text.slice(param.startIndex, param.endIndex).trim();
			return paramText;
		}).join(', ');
		paramInfo = `\n\n**Parameters:** ${params}`;
	}
	
	return `**${identifierName}** *(function)*\n\n\`\`\`pebble\n${signature}\n\`\`\`${paramInfo}\n\n*Function declaration*`;
}

function formatVariableDeclaration(node: Parser.SyntaxNode, text: string, identifierName: string): string {
	const nodeText = text.slice(node.startIndex, node.endIndex).trim();
	const declarationType = node.type === 'const_declaration' ? 'constant' : 'variable';
	
	// Try to extract type information
	let typeInfo = '';
	const typeNodes = node.children.filter(child => 
		child.type === 'type_annotation' || 
		child.type === 'type' ||
		child.type.includes('type')
	);
	
	if (typeNodes.length > 0) {
		const typeText = typeNodes.map(typeNode => 
			text.slice(typeNode.startIndex, typeNode.endIndex).trim()
		).join(' ');
		typeInfo = `\n\n**Type:** \`${typeText}\``;
	}
	
	return `**${identifierName}** *(${declarationType})*\n\n\`\`\`pebble\n${nodeText}\n\`\`\`${typeInfo}`;
}

function formatStructDeclaration(node: Parser.SyntaxNode, text: string, identifierName: string): string {
	const nodeText = text.slice(node.startIndex, node.endIndex);
	const lines = nodeText.split('\n');
	const signature = lines[0].trim();
	
	return `**${identifierName}** *(struct)*\n\n\`\`\`pebble\n${signature}\n\`\`\`\n\n*Struct declaration*`;
}

function formatParameterDeclaration(node: Parser.SyntaxNode, text: string, identifierName: string): string {
	const nodeText = text.slice(node.startIndex, node.endIndex).trim();
	return `**${identifierName}** *(parameter)*\n\n\`\`\`pebble\n${nodeText}\n\`\`\``;
}

function formatFieldDeclaration(node: Parser.SyntaxNode, text: string, identifierName: string): string {
	const nodeText = text.slice(node.startIndex, node.endIndex).trim();
	return `**${identifierName}** *(field)*\n\n\`\`\`pebble\n${nodeText}\n\`\`\``;
}

function getBuiltInInfo(identifierName: string): string | null {
	const builtIns: Record<string, string> = {
		// Pebble built-in types
		'int': '**int** *(built-in type)*\n\nInteger type for whole numbers.',
		'string': '**string** *(built-in type)*\n\nString type for text data.',
		'bool': '**bool** *(built-in type)*\n\nBoolean type with values `true` or `false`.',
		'bytes': '**bytes** *(built-in type)*\n\nByte array type.',
		'unit': '**unit** *(built-in type)*\n\nUnit type representing no value.',
		
		// Pebble keywords
		'function': '**function** *(keyword)*\n\nDefines a function.',
		'struct': '**struct** *(keyword)*\n\nDefines a struct type.',
		'let': '**let** *(keyword)*\n\nDeclares a mutable variable.',
		'const': '**const** *(keyword)*\n\nDeclares an immutable constant.',
		'if': '**if** *(keyword)*\n\nConditional statement.',
		'else': '**else** *(keyword)*\n\nAlternative branch for if statement.',
		'match': '**match** *(keyword)*\n\nPattern matching expression.',
		'for': '**for** *(keyword)*\n\nLoop statement.',
		'while': '**while** *(keyword)*\n\nWhile loop statement.',
		'return': '**return** *(keyword)*\n\nReturns a value from a function.',
		'assert': '**assert** *(keyword)*\n\nAssertion statement that fails if condition is false.',
		'trace': '**trace** *(keyword)*\n\nTracing statement for debugging - prints value to trace log.',
		'fail': '**fail** *(keyword)*\n\nFails execution immediately with an optional error message.',
		'true': '**true** *(boolean literal)*\n\nBoolean true value.',
		'false': '**false** *(boolean literal)*\n\nBoolean false value.',
		'import': '**import** *(keyword)*\n\nImports definitions from another module.',
		'as': '**as** *(keyword)*\n\nType casting or import aliasing.',
		
		// Pebble contract and script keywords
		'contract': '**contract** *(keyword)*\n\nDefines a smart contract.',
		'param': '**param** *(keyword)*\n\nDefines a parameter for a contract or script.',
		'spend': '**spend** *(keyword)*\n\nDefines a spending validator script.',
		'mint': '**mint** *(keyword)*\n\nDefines a minting policy script.',
		'certify': '**certify** *(keyword)*\n\nDefines a certificate validation script.',
		'withdraw': '**withdraw** *(keyword)*\n\nDefines a withdrawal script for stake rewards.',
		'propose': '**propose** *(keyword)*\n\nDefines a governance proposal script.',
		'vote': '**vote** *(keyword)*\n\nDefines a governance voting script.',
		
		// Common Cardano/Plutus types that might appear in Pebble
		'ScriptContext': '**ScriptContext** *(type)*\n\nContext information available to Plutus scripts containing transaction and purpose info.',
		'TxInfo': '**TxInfo** *(type)*\n\nTransaction information including inputs, outputs, and metadata.',
		'Address': '**Address** *(type)*\n\nBlockchain address type.',
		'Value': '**Value** *(type)*\n\nValue representing native tokens and ADA.',
		'Datum': '**Datum** *(type)*\n\nData attached to UTXOs.',
		'Redeemer': '**Redeemer** *(type)*\n\nData provided when spending a UTXO.',
		'PubKeyHash': '**PubKeyHash** *(type)*\n\nHash of a public key.',
		'ValidatorHash': '**ValidatorHash** *(type)*\n\nHash of a validator script.',
		'CurrencySymbol': '**CurrencySymbol** *(type)*\n\nIdentifier for a native token currency.',
		'TokenName': '**TokenName** *(type)*\n\nName of a native token.',
		'POSIXTime': '**POSIXTime** *(type)*\n\nTimestamp in POSIX format.',
		
		// Script purposes
		'Spending': '**Spending** *(constructor)*\n\nScript purpose for spending a UTXO.',
		'Minting': '**Minting** *(constructor)*\n\nScript purpose for minting/burning tokens.',
		'Certify': '**Certify** *(constructor)*\n\nScript purpose for certificate validation.',
		'Burning': '**Burning** *(constructor)*\n\nScript purpose for burning tokens.',
		
		// Common patterns
		'Just': '**Just** *(constructor)*\n\nMaybe type constructor for present values.',
		'Nothing': '**Nothing** *(constructor)*\n\nMaybe type constructor for absent values.',
		'Some': '**Some** *(constructor)*\n\nOption type constructor for present values.',
		'None': '**None** *(constructor)*\n\nOption type constructor for absent values.'
	};
	
	return builtIns[identifierName] || null;
}

// Find import declarations for an identifier
function findImportDeclaration(identifierName: string, rootNode: Parser.SyntaxNode, text: string): Parser.SyntaxNode | null {
	return findImportDeclarationRecursive(identifierName, rootNode, text);
}

function findImportDeclarationRecursive(identifierName: string, node: Parser.SyntaxNode, text: string): Parser.SyntaxNode | null {
	// Check if this is an import statement that imports the identifier
	if (node.type === 'import_statement' || node.type === 'import_declaration') {
		// Look for the identifier in the import statement
		for (const child of node.children) {
			if (child.type === 'identifier') {
				const childText = text.slice(child.startIndex, child.endIndex);
				if (childText === identifierName) {
					return node; // Return the entire import statement
				}
			}
			// Also check for import lists/destructuring
			if (child.type === 'import_clause' || child.type === 'import_specifier') {
				for (const grandchild of child.children) {
					if (grandchild.type === 'identifier') {
						const grandchildText = text.slice(grandchild.startIndex, grandchild.endIndex);
						if (grandchildText === identifierName) {
							return node;
						}
					}
				}
			}
		}
	}
	
	// Recursively search children
	for (const child of node.children) {
		const result = findImportDeclarationRecursive(identifierName, child, text);
		if (result) return result;
	}
	
	return null;
}

// Get the range of the identifier within a declaration node
function getIdentifierRangeInDeclarationWithDocument(declarationNode: Parser.SyntaxNode, identifierName: string, text: string, document: TextDocument): Range | null {
	// Find the identifier child in the declaration
	for (const child of declarationNode.children) {
		if (child.type === 'identifier') {
			const childText = text.slice(child.startIndex, child.endIndex);
			if (childText === identifierName) {
				// Use the document to convert offsets to positions
				return Range.create(
					document.positionAt(child.startIndex),
					document.positionAt(child.endIndex)
				);
			}
		}
	}
	return null;
}

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
	const documentText = textDocument.getText();

	const [_, diagnostics] = PebbleParser.parseFile(documentPath, documentText);

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
	return []; // TODO: implement completion items
});

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	return item; // TODO: implement completion resolve
});

connection.onDocumentHighlight((params: DocumentHighlightParams): DocumentHighlight[] => {
	try {
		const document = documents.get(params.textDocument.uri);
		if (!document) return [];
		
		const text = document.getText();
		const tree = parser.parse(text);
		const position = params.position;
		const offset = document.offsetAt(position);
		
		// Find the node at the cursor position
		const nodeAtPosition = findNodeAtPosition(tree.rootNode, offset);
		if (!nodeAtPosition) return [];
		
		// Get the identifier name at the cursor position
		const identifierName = getIdentifierName(nodeAtPosition, text);
		if (!identifierName || identifierName.trim().length === 0) return [];
		
		// Don't highlight keywords or very short identifiers (likely not meaningful)
		if (identifierName.length < 2) return [];
		
		// Find all occurrences of this identifier in the document
		const highlights: DocumentHighlight[] = [];
		findIdentifierOccurrences(tree.rootNode, identifierName, text, document, highlights);
		
		return highlights;
	} catch (error) {
		// Log error but don't crash the language server
		console.error('Error in onDocumentHighlight:', error);
		return [];
	}
});

connection.onHover((params: HoverParams): Hover | null => {
	try {
		const document = documents.get(params.textDocument.uri);
		if (!document) return null;
		
		const text = document.getText();
		const tree = parser.parse(text);
		const position = params.position;
		const offset = document.offsetAt(position);
		
		// Find the node at the cursor position
		const nodeAtPosition = findNodeAtPosition(tree.rootNode, offset);
		if (!nodeAtPosition) return null;
		
		// Generate hover information based on the node type and context
		const hoverInfo = generateHoverInfo(nodeAtPosition, text, tree.rootNode);
		if (!hoverInfo) return null;
		
		// Create the range for the hover (typically the identifier being hovered)
		const range = Range.create(
			document.positionAt(nodeAtPosition.startIndex),
			document.positionAt(nodeAtPosition.endIndex)
		);
		
		return {
			contents: {
				kind: 'markdown',
				value: hoverInfo
			},
			range
		};
	} catch (error) {
		console.error('Error in onHover:', error);
		return null;
	}
});

connection.onDefinition((params: DefinitionParams): Definition | null => {
	try {
		const document = documents.get(params.textDocument.uri);
		if (!document) return null;
		
		const text = document.getText();
		const tree = parser.parse(text);
		const position = params.position;
		const offset = document.offsetAt(position);
		
		// Find the node at the cursor position
		const nodeAtPosition = findNodeAtPosition(tree.rootNode, offset);
		if (!nodeAtPosition) return null;
		
		// Get the identifier name at the cursor position
		const identifierName = getIdentifierName(nodeAtPosition, text);
		if (!identifierName || identifierName.trim().length === 0) return null;
		
		// Don't try to find definitions for very short identifiers or built-ins
		if (identifierName.length < 2) return null;
		
		// Check if it's a built-in type/keyword (no definition to jump to)
		if (getBuiltInInfo(identifierName)) return null;
		
		// Find the declaration of this identifier
		const declaration = findDeclaration(identifierName, tree.rootNode, text);
		if (!declaration) {
			// Check if it might be an imported symbol
			const importDeclaration = findImportDeclaration(identifierName, tree.rootNode, text);
			if (importDeclaration) {
				// For now, just return the import statement location
				// TODO: In the future, this could resolve to the actual file
				const range = Range.create(
					document.positionAt(importDeclaration.startIndex),
					document.positionAt(importDeclaration.endIndex)
				);
				
				return {
					uri: document.uri,
					range: range
				};
			}
			return null;
		}
		
		// Create the definition location - focus on the identifier within the declaration
		const identifierRange = getIdentifierRangeInDeclarationWithDocument(declaration, identifierName, text, document);
		const range = identifierRange || Range.create(
			document.positionAt(declaration.startIndex),
			document.positionAt(declaration.endIndex)
		);
		
		return {
			uri: document.uri,
			range: range
		};
	} catch (error) {
		console.error('Error in onDefinition:', error);
		return null;
	}
});

documents.listen(connection);

connection.listen();
