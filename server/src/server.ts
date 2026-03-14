import { Parser as PebbleParser, Compiler } from '@harmoniclabs/pebble';
import type { CheckResult, CompilerIoApi } from '@harmoniclabs/pebble';

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
	DocumentHighlightParams,
	DocumentHighlightKind,
	Hover,
	HoverParams,
	Definition,
	DefinitionParams,
	Location,
	ReferenceParams,
	RenameParams,
	WorkspaceEdit,
	TextEdit,
	PrepareRenameParams,
	DocumentSymbol,
	DocumentSymbolParams,
	SymbolKind,
	SignatureHelp,
	SignatureHelpParams,
	SignatureInformation,
	ParameterInformation,
	CodeAction,
	CodeActionParams,
	CodeActionKind,
	DiagnosticSeverity,
	SemanticTokensBuilder,
	SemanticTokensLegend,
	SemanticTokensParams,
	type DocumentDiagnosticReport,
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import Parser from 'tree-sitter';
const Pebble = require("@harmoniclabs/tree-sitter-pebble");

const parser = new Parser();
parser.setLanguage(Pebble);

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Cache for type-check results per document
const checkResultCache = new Map<string, CheckResult>();

// Semantic token types and modifiers for syntax highlighting
const SEMANTIC_TOKEN_TYPES = [
	'type',           // 0: type names (MyContract, PubKeyHash, Spend, Some, int, data)
	'variable',       // 1: mutable variables / destructuring field labels
	'parameter',      // 2: function parameters
	'property',       // 3: property access / field labels in destructuring
	'keyword',        // 4: keywords (context)
	'function',       // 5: function names
	'struct',         // 6: struct names
	'enum',           // 7: enum/variant names
	'enumMember',     // 8: constructor names in patterns (Spend, Some)
] as const;

const SEMANTIC_TOKEN_MODIFIERS = [
	'declaration',    // 0
	'readonly',       // 1: const variables
	'defaultLibrary', // 2: built-in types
] as const;

const semanticTokensLegend: SemanticTokensLegend = {
	tokenTypes: [...SEMANTIC_TOKEN_TYPES],
	tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
};

function createLspCompilerIoApi( currentDocPath: string, currentDocText: string ): CompilerIoApi {
	return {
		stdout: { write() {} },
		stderr: { write() {} },
		readFile: ( filename: string, _baseDir: string ) => {
			// if reading the current document, use the in-memory version
			if( filename === currentDocPath ) return currentDocText;
			// for any other file, read from disk
			try { return fs.readFileSync( filename, 'utf-8' ); }
			catch { return undefined; }
		},
		writeFile: () => {},
		exsistSync: ( filename: string ) => {
			if( filename === currentDocPath ) return true;
			return fs.existsSync( filename );
		},
		listFiles: ( dirname: string, _baseDir: string ) => {
			try { return fs.readdirSync( dirname ); }
			catch { return undefined; }
		},
		reportDiagnostic: () => {},
	};
}

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
function generateHoverInfo(node: Parser.SyntaxNode, text: string, rootNode: Parser.SyntaxNode, documentUri?: string): string | null {
	// Get the identifier name if this is an identifier node
	const identifierName = getIdentifierName(node, text);
	if (!identifierName) {
		// Handle non-identifier nodes that might be interesting to hover over
		return getNodeTypeInfo(node, text);
	}

	// Check if this is a property in a member expression (e.g. hovering "name" in "dog.name")
	const parent = node.parent;
	if (parent && parent.type === 'member_expression') {
		const propNode = parent.childForFieldName('property') ?? parent.children.find(c => c.type === 'property_identifier');
		if (propNode && propNode.id === node.id) {
			// This is the property side — resolve the object's type to find the field type
			const objectNode = parent.children[0];
			if (objectNode) {
				return resolvePropertyHover(objectNode, identifierName, rootNode, text, documentUri);
			}
		}
	}

	// Find the declaration of this identifier
	const declaration = findDeclaration(identifierName, rootNode, text);
	if (declaration) {
		const baseInfo = formatDeclarationInfo(declaration, text, identifierName);
		// Also resolve the type for variables/parameters
		const resolvedType = resolveIdentifierType(identifierName, rootNode, text);
		if (resolvedType && !baseInfo.includes(`**Type:**`)) {
			return baseInfo + `\n\n**Type:** \`${resolvedType}\``;
		}
		return baseInfo;
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

function resolvePropertyHover(
	objectNode: Parser.SyntaxNode,
	propertyName: string,
	rootNode: Parser.SyntaxNode,
	text: string,
	documentUri?: string
): string | null {
	let typeName: string | null = null;

	if (objectNode.type === 'identifier') {
		const objectName = text.slice(objectNode.startIndex, objectNode.endIndex);

		// "this" inside a contract refers to the enclosing contract
		if (objectName === 'this') {
			let current: Parser.SyntaxNode | null = objectNode;
			while (current) {
				if (current.type === 'contract_declaration') {
					for (const c of current.children) {
						if (c.type === 'identifier') {
							typeName = text.slice(c.startIndex, c.endIndex);
							break;
						}
					}
					break;
				}
				current = current.parent;
			}
		} else {
			typeName = resolveIdentifierType(objectName, rootNode, text);
		}
	} else if (objectNode.type === 'member_expression') {
		// Chained access like a.b.c — recursively resolve
		const innerProp = objectNode.childForFieldName('property') ?? objectNode.children.find(c => c.type === 'property_identifier');
		if (innerProp) {
			const innerPropName = text.slice(innerProp.startIndex, innerProp.endIndex);
			const innerObj = objectNode.children[0];
			if (innerObj) {
				const innerType = resolveChainedType(innerObj, innerPropName, rootNode, text, documentUri);
				typeName = innerType;
			}
		}
	}

	if (!typeName) return null;

	// Find the struct/contract and look up the field
	const typeDecl = findTypeDeclaration(typeName, rootNode, text);
	if (!typeDecl) return null;

	const fieldType = findFieldType(typeDecl, propertyName, text);
	if (fieldType) {
		return `**${propertyName}** *(field of ${typeName})*\n\n\`\`\`pebble\n${propertyName}: ${fieldType}\n\`\`\`\n\n**Type:** \`${fieldType}\``;
	}

	return `**${propertyName}** *(member of ${typeName})*`;
}

function resolveChainedType(
	objectNode: Parser.SyntaxNode,
	propertyName: string,
	rootNode: Parser.SyntaxNode,
	text: string,
	documentUri?: string
): string | null {
	let typeName: string | null = null;

	if (objectNode.type === 'identifier') {
		const objectName = text.slice(objectNode.startIndex, objectNode.endIndex);
		if (objectName === 'this') {
			let current: Parser.SyntaxNode | null = objectNode;
			while (current) {
				if (current.type === 'contract_declaration') {
					for (const c of current.children) {
						if (c.type === 'identifier') {
							typeName = text.slice(c.startIndex, c.endIndex);
							break;
						}
					}
					break;
				}
				current = current.parent;
			}
		} else {
			typeName = resolveIdentifierType(objectName, rootNode, text);
		}
	} else if (objectNode.type === 'member_expression') {
		const innerProp = objectNode.childForFieldName('property') ?? objectNode.children.find(c => c.type === 'property_identifier');
		if (innerProp) {
			const innerPropName = text.slice(innerProp.startIndex, innerProp.endIndex);
			const innerObj = objectNode.children[0];
			if (innerObj) {
				typeName = resolveChainedType(innerObj, innerPropName, rootNode, text, documentUri);
			}
		}
	}

	if (!typeName) return null;

	const typeDecl = findTypeDeclaration(typeName, rootNode, text);
	if (!typeDecl) return null;

	return findFieldType(typeDecl, propertyName, text);
}

function findFieldType(typeDecl: Parser.SyntaxNode, fieldName: string, text: string): string | null {
	for (const child of typeDecl.children) {
		if (child.type === 'struct_field' || child.type === 'field_declaration' || child.type === 'param_statement') {
			const identifiers = child.children.filter(c => c.type === 'identifier');
			if (identifiers.length >= 2) {
				const name = text.slice(identifiers[0].startIndex, identifiers[0].endIndex);
				if (name === fieldName) {
					return text.slice(identifiers[1].startIndex, identifiers[1].endIndex);
				}
			}
		}
		// Check inside struct variants
		if (child.type === 'struct_variant') {
			const result = findFieldType(child, fieldName, text);
			if (result) return result;
		}
		// Check inside contract body
		if (child.type === 'contract_body' || child.type === 'struct_body') {
			const result = findFieldType(child, fieldName, text);
			if (result) return result;
		}
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
	// Check direct children first for top-level declarations
	for (const child of node.children) {
		if (DECLARATION_TYPES.includes(child.type) && isDeclarationNode(child, identifierName, text)) {
			return child;
		}
	}

	// Recursively search for declarations
	for (const child of node.children) {
		if (DECLARATION_TYPES.includes(child.type) && isDeclarationNode(child, identifierName, text)) {
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

const DECLARATION_TYPES = [
	'variable_declaration',
	'function_declaration',
	'let_declaration',
	'const_declaration',
	'struct_declaration',
	'contract_declaration',
	'struct_variant',
	'struct_field',
	'typed_parameter',
	'param_statement',
	'spend_statement',
	'mint_statement',
	'certify_statement',
	'withdraw_statement',
	'propose_statement',
	'vote_statement',
	'parameter',
	'field_declaration'
];

function isDeclarationNode(node: Parser.SyntaxNode, identifierName: string, text: string): boolean {
	if (!DECLARATION_TYPES.includes(node.type)) return false;

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

// Extract the source path from an import statement node
function getImportSourcePath(importNode: Parser.SyntaxNode, text: string): string | null {
	for (const child of importNode.children) {
		// The source is stored as a 'string' node (field name 'source')
		if (child.type === 'string') {
			const raw = text.slice(child.startIndex, child.endIndex);
			// Strip quotes
			return raw.replace(/^['"]|['"]$/g, '');
		}
		// Also check _from_clause children
		const nested = getImportSourcePath(child, text);
		if (nested) return nested;
	}
	return null;
}

// Resolve a relative import path to an absolute file path
function resolveImportPath(importSource: string, currentDocumentUri: string): string | null {
	// Only handle relative imports
	if (!importSource.startsWith('.')) return null;

	const currentFilePath = fileURLToPath(currentDocumentUri);
	const currentDir = path.dirname(currentFilePath);

	// Try with common extensions, then as-is (empty string)
	const extensions = ['.pebble', '.ts', '.js', ''];
	for (const ext of extensions) {
		const resolved = path.resolve(currentDir, importSource + ext);
		if (fs.existsSync(resolved)) {
			return resolved;
		}
	}

	return null;
}

// Find the definition of an identifier in another file's AST
function findDefinitionInFile(identifierName: string, filePath: string): Location | null {
	let fileContent: string;
	try {
		fileContent = fs.readFileSync(filePath, 'utf-8');
	} catch {
		return null;
	}

	const tree = parser.parse(fileContent);
	const declaration = findDeclaration(identifierName, tree.rootNode, fileContent);
	if (!declaration) return null;

	const fileUri = pathToFileURL(filePath).toString();

	// Find the identifier child to get precise range
	for (const child of declaration.children) {
		if (child.type === 'identifier') {
			const childText = fileContent.slice(child.startIndex, child.endIndex);
			if (childText === identifierName) {
				const startPos = offsetToPosition(fileContent, child.startIndex);
				const endPos = offsetToPosition(fileContent, child.endIndex);
				return Location.create(fileUri, Range.create(startPos, endPos));
			}
		}
	}

	// Fallback to declaration node range
	const startPos = offsetToPosition(fileContent, declaration.startIndex);
	const endPos = offsetToPosition(fileContent, declaration.endIndex);
	return Location.create(fileUri, Range.create(startPos, endPos));
}

// Convert a byte offset to a line/character position
function offsetToPosition(text: string, offset: number): { line: number; character: number } {
	let line = 0;
	let lastLineStart = 0;
	for (let i = 0; i < offset; i++) {
		if (text[i] === '\n') {
			line++;
			lastLineStart = i + 1;
		}
	}
	return { line, character: offset - lastLineStart };
}

// ── Completion helpers ──────────────────────────────────────────────

interface SymbolInfo {
	name: string;
	kind: CompletionItemKind;
	detail?: string;
}

// Collect all declared symbols visible from the AST
function collectSymbols(node: Parser.SyntaxNode, text: string, symbols: SymbolInfo[]): void {
	const kindMap: Record<string, CompletionItemKind> = {
		'function_declaration': CompletionItemKind.Function,
		'struct_declaration': CompletionItemKind.Struct,
		'contract_declaration': CompletionItemKind.Class,
		'variable_declaration': CompletionItemKind.Variable,
		'let_declaration': CompletionItemKind.Variable,
		'const_declaration': CompletionItemKind.Constant,
		'struct_variant': CompletionItemKind.EnumMember,
		'struct_field': CompletionItemKind.Field,
		'typed_parameter': CompletionItemKind.Variable,
		'param_statement': CompletionItemKind.Property,
		'spend_statement': CompletionItemKind.Method,
		'mint_statement': CompletionItemKind.Method,
		'certify_statement': CompletionItemKind.Method,
		'withdraw_statement': CompletionItemKind.Method,
		'propose_statement': CompletionItemKind.Method,
		'vote_statement': CompletionItemKind.Method,
		'parameter': CompletionItemKind.Variable,
		'field_declaration': CompletionItemKind.Field,
	};

	const kind = kindMap[node.type];
	if (kind !== undefined) {
		for (const child of node.children) {
			if (child.type === 'identifier') {
				const name = text.slice(child.startIndex, child.endIndex);
				if (name.length >= 2) {
					symbols.push({ name, kind });
				}
				break;
			}
		}
	}

	for (const child of node.children) {
		collectSymbols(child, text, symbols);
	}
}

// Collect imported symbol names from import statements
function collectImportedSymbols(rootNode: Parser.SyntaxNode, text: string): SymbolInfo[] {
	const symbols: SymbolInfo[] = [];
	for (const child of rootNode.children) {
		if (child.type !== 'import_statement' && child.type !== 'import_declaration') continue;
		collectImportIdentifiers(child, text, symbols);
	}
	return symbols;
}

function collectImportIdentifiers(node: Parser.SyntaxNode, text: string, symbols: SymbolInfo[]): void {
	if (node.type === 'identifier') {
		const name = text.slice(node.startIndex, node.endIndex);
		// Skip the "from" keyword value (the source string precedes it)
		if (name !== 'from' && name !== 'as' && name !== 'import') {
			symbols.push({ name, kind: CompletionItemKind.Reference });
		}
		return;
	}
	if (node.type === 'import_specifier') {
		// For `import { Foo as Bar }`, we want "Bar" (the alias) or "Foo" (the name)
		const alias = node.children.find(c => c.type === 'identifier');
		if (alias) {
			// If there's an 'as', the last identifier is what's in scope
			const identifiers = node.children.filter(c => c.type === 'identifier');
			const inScope = identifiers[identifiers.length - 1];
			symbols.push({
				name: text.slice(inScope.startIndex, inScope.endIndex),
				kind: CompletionItemKind.Reference
			});
			return;
		}
	}
	// Skip the string source node
	if (node.type === 'string') return;
	for (const child of node.children) {
		collectImportIdentifiers(child, text, symbols);
	}
}

// Built-in completion items for Pebble keywords and types
const KEYWORD_COMPLETIONS: CompletionItem[] = [
	'function', 'struct', 'contract', 'let', 'const',
	'if', 'else', 'match', 'for', 'while', 'return',
	'assert', 'trace', 'fail', 'import', 'from',
	'param', 'spend', 'mint', 'certify', 'withdraw', 'propose', 'vote',
	'true', 'false',
].map(kw => ({ label: kw, kind: CompletionItemKind.Keyword }));

const TYPE_COMPLETIONS: CompletionItem[] = [
	'int', 'string', 'bool', 'bytes', 'unit',
	'ScriptContext', 'TxInfo', 'Address', 'Value',
	'Datum', 'Redeemer', 'PubKeyHash', 'ValidatorHash',
	'CurrencySymbol', 'TokenName', 'POSIXTime',
	'Just', 'Nothing', 'Some', 'None',
	'Spending', 'Minting', 'Certify', 'Burning',
].map(t => ({ label: t, kind: CompletionItemKind.Struct }));

// ── Dot-completion helpers ───────────────────────────────────────────

// Collect fields and variants from a struct_declaration node
function collectStructMembers(structNode: Parser.SyntaxNode, text: string): CompletionItem[] {
	const items: CompletionItem[] = [];
	for (const child of structNode.children) {
		if (child.type === 'struct_field') {
			for (const fc of child.children) {
				if (fc.type === 'identifier') {
					const name = text.slice(fc.startIndex, fc.endIndex);
					items.push({ label: name, kind: CompletionItemKind.Field });
					break;
				}
			}
		} else if (child.type === 'struct_variant') {
			for (const vc of child.children) {
				if (vc.type === 'identifier') {
					const name = text.slice(vc.startIndex, vc.endIndex);
					items.push({ label: name, kind: CompletionItemKind.EnumMember });
					break;
				}
			}
		}
	}
	return items;
}

// Collect members from a contract_declaration node
function collectContractMembers(contractNode: Parser.SyntaxNode, text: string): CompletionItem[] {
	const items: CompletionItem[] = [];
	for (const child of contractNode.children) {
		if (child.type !== 'contract_member') continue;
		for (const member of child.children) {
			const memberKindMap: Record<string, CompletionItemKind> = {
				'param_statement': CompletionItemKind.Property,
				'spend_statement': CompletionItemKind.Method,
				'mint_statement': CompletionItemKind.Method,
				'certify_statement': CompletionItemKind.Method,
				'withdraw_statement': CompletionItemKind.Method,
				'propose_statement': CompletionItemKind.Method,
				'vote_statement': CompletionItemKind.Method,
			};
			const kind = memberKindMap[member.type];
			if (kind === undefined) continue;
			for (const mc of member.children) {
				if (mc.type === 'identifier') {
					const name = text.slice(mc.startIndex, mc.endIndex);
					items.push({ label: name, kind });
					break;
				}
			}
		}
	}
	return items;
}

// Try to resolve the type name for an identifier by finding its declaration
function resolveIdentifierType(identifierName: string, rootNode: Parser.SyntaxNode, text: string): string | null {
	const decl = findDeclaration(identifierName, rootNode, text);
	if (!decl) return null;

	// For variable/let/const declarations, look for a type annotation or an initializer that's a call expression
	if (['variable_declaration', 'let_declaration', 'const_declaration'].includes(decl.type)) {
		// Check for type annotation (typed_parameter style: `let x: MyType = ...`)
		for (const child of decl.children) {
			if (child.type === 'type_annotation' || child.type === 'typed_parameter') {
				for (const tc of child.children) {
					if (tc.type === 'identifier') {
						return text.slice(tc.startIndex, tc.endIndex);
					}
				}
			}
		}
		// Check for initializer — if it's a call expression, the function name may be the type (constructor)
		for (const child of decl.children) {
			if (child.type === 'call_expression') {
				for (const cc of child.children) {
					if (cc.type === 'identifier') {
						return text.slice(cc.startIndex, cc.endIndex);
					}
				}
			}
			// If it's an object with destructuring from a known type
			if (child.type === 'identifier') {
				// skip the variable name itself
				continue;
			}
		}
	}

	// For typed_parameter (e.g. `owner: PubKeyHash`)
	if (decl.type === 'typed_parameter' || decl.type === 'param_statement') {
		const identifiers = decl.children.filter(c => c.type === 'identifier');
		// Second identifier is the type
		if (identifiers.length >= 2) {
			return text.slice(identifiers[1].startIndex, identifiers[1].endIndex);
		}
	}

	// For struct_field (e.g. `name: string`)
	if (decl.type === 'struct_field') {
		const identifiers = decl.children.filter(c => c.type === 'identifier');
		if (identifiers.length >= 2) {
			return text.slice(identifiers[1].startIndex, identifiers[1].endIndex);
		}
	}

	return null;
}

// Find a struct or contract declaration by name in the AST
function findTypeDeclaration(typeName: string, rootNode: Parser.SyntaxNode, text: string): Parser.SyntaxNode | null {
	for (const child of rootNode.children) {
		if (child.type === 'struct_declaration' || child.type === 'contract_declaration') {
			for (const cc of child.children) {
				if (cc.type === 'identifier' && text.slice(cc.startIndex, cc.endIndex) === typeName) {
					return child;
				}
			}
		}
	}
	return null;
}

// Get dot-completion items for an expression before the dot
function getDotCompletionItems(
	objectNode: Parser.SyntaxNode,
	rootNode: Parser.SyntaxNode,
	text: string,
	documentUri: string
): CompletionItem[] {
	let typeName: string | null = null;

	if (objectNode.type === 'identifier') {
		const objectName = text.slice(objectNode.startIndex, objectNode.endIndex);

		// Check if the identifier itself IS a struct/contract name (static access)
		const directType = findTypeDeclaration(objectName, rootNode, text);
		if (directType) {
			if (directType.type === 'struct_declaration') return collectStructMembers(directType, text);
			if (directType.type === 'contract_declaration') return collectContractMembers(directType, text);
		}

		// Otherwise resolve the variable's type
		typeName = resolveIdentifierType(objectName, rootNode, text);
	} else if (objectNode.type === 'member_expression') {
		// Nested: e.g. `a.b.c` — we'd need to resolve recursively
		// For now, just try the property name as a type
		const propChild = objectNode.children.find(c => c.type === 'property_identifier');
		if (propChild) {
			const propName = text.slice(propChild.startIndex, propChild.endIndex);
			typeName = resolveIdentifierType(propName, rootNode, text);
		}
	} else if (objectNode.type === 'call_expression') {
		// e.g. `getAnimal().` — resolve the function's return type if possible
		const fnChild = objectNode.children.find(c => c.type === 'identifier');
		if (fnChild) {
			const fnName = text.slice(fnChild.startIndex, fnChild.endIndex);
			// If the function name matches a struct, assume it's a constructor
			const typeDecl = findTypeDeclaration(fnName, rootNode, text);
			if (typeDecl) {
				if (typeDecl.type === 'struct_declaration') return collectStructMembers(typeDecl, text);
				if (typeDecl.type === 'contract_declaration') return collectContractMembers(typeDecl, text);
			}
		}
	} else if (objectNode.type === 'this') {
		// `this.` inside a contract — find the enclosing contract
		let current: Parser.SyntaxNode | null = objectNode;
		while (current) {
			if (current.type === 'contract_declaration') {
				return collectContractMembers(current, text);
			}
			current = current.parent;
		}
	}

	if (!typeName) return [];

	// Look up the type in current file
	let typeDecl = findTypeDeclaration(typeName, rootNode, text);

	// If not found locally, try imported files
	if (!typeDecl) {
		const importNode = findImportDeclaration(typeName, rootNode, text);
		if (importNode) {
			const importSource = getImportSourcePath(importNode, text);
			if (importSource) {
				const resolvedPath = resolveImportPath(importSource, documentUri);
				if (resolvedPath) {
					try {
						const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
						const fileTree = parser.parse(fileContent);
						typeDecl = findTypeDeclaration(typeName, fileTree.rootNode, fileContent);
						if (typeDecl) {
							if (typeDecl.type === 'struct_declaration') return collectStructMembers(typeDecl, fileContent);
							if (typeDecl.type === 'contract_declaration') return collectContractMembers(typeDecl, fileContent);
						}
					} catch { /* ignore */ }
				}
			}
		}
	}

	if (!typeDecl) return [];
	if (typeDecl.type === 'struct_declaration') return collectStructMembers(typeDecl, text);
	if (typeDecl.type === 'contract_declaration') return collectContractMembers(typeDecl, text);
	return [];
}

// ── References / Rename helpers ─────────────────────────────────────

// Collect all identifier nodes matching a name in an AST
function collectIdentifierNodes(
	node: Parser.SyntaxNode,
	identifierName: string,
	text: string,
	results: Parser.SyntaxNode[]
): void {
	if (node.type === 'identifier') {
		const nodeText = text.slice(node.startIndex, node.endIndex);
		if (nodeText === identifierName) {
			results.push(node);
		}
	}
	for (const child of node.children) {
		collectIdentifierNodes(child, identifierName, text, results);
	}
}

// Find all .pebble files in the same directory (for cross-file references)
function getSiblingPebbleFiles(documentUri: string): string[] {
	try {
		const filePath = fileURLToPath(documentUri);
		const dir = path.dirname(filePath);
		return fs.readdirSync(dir)
			.filter(f => f.endsWith('.pebble'))
			.map(f => path.join(dir, f));
	} catch {
		return [];
	}
}

// Check whether a file imports a given symbol (by name) from a given source file
function fileImportsSymbol(filePath: string, symbolName: string, sourceFilePath: string): boolean {
	let content: string;
	try {
		content = fs.readFileSync(filePath, 'utf-8');
	} catch {
		return false;
	}
	const tree = parser.parse(content);
	for (const child of tree.rootNode.children) {
		if (child.type !== 'import_statement' && child.type !== 'import_declaration') continue;
		const importSource = getImportSourcePath(child, content);
		if (!importSource) continue;
		const resolved = resolveImportPath(importSource, pathToFileURL(filePath).toString());
		if (resolved !== sourceFilePath) continue;
		// Check if this import mentions the symbol
		const ids: SymbolInfo[] = [];
		collectImportIdentifiers(child, content, ids);
		if (ids.some(s => s.name === symbolName)) return true;
	}
	return false;
}

// Find all Location references to an identifier across the current file and siblings
function findAllReferences(
	identifierName: string,
	documentUri: string,
	documentText: string,
	rootNode: Parser.SyntaxNode,
	includeDeclaration: boolean
): Location[] {
	const locations: Location[] = [];

	// Current file occurrences
	const nodes: Parser.SyntaxNode[] = [];
	collectIdentifierNodes(rootNode, identifierName, documentText, nodes);
	for (const n of nodes) {
		if (!includeDeclaration) {
			// Skip the declaration identifier itself
			if (n.parent && DECLARATION_TYPES.includes(n.parent.type)) continue;
		}
		const range = Range.create(
			offsetToPosition(documentText, n.startIndex),
			offsetToPosition(documentText, n.endIndex)
		);
		locations.push(Location.create(documentUri, range));
	}

	// Cross-file: if the symbol is declared here, find sibling files that import it
	const currentFilePath = fileURLToPath(documentUri);
	const declaration = findDeclaration(identifierName, rootNode, documentText);
	if (declaration) {
		const siblings = getSiblingPebbleFiles(documentUri);
		for (const siblingPath of siblings) {
			if (siblingPath === currentFilePath) continue;
			if (!fileImportsSymbol(siblingPath, identifierName, currentFilePath)) continue;
			let sibContent: string;
			try { sibContent = fs.readFileSync(siblingPath, 'utf-8'); } catch { continue; }
			const sibTree = parser.parse(sibContent);
			const sibNodes: Parser.SyntaxNode[] = [];
			collectIdentifierNodes(sibTree.rootNode, identifierName, sibContent, sibNodes);
			const sibUri = pathToFileURL(siblingPath).toString();
			for (const n of sibNodes) {
				const range = Range.create(
					offsetToPosition(sibContent, n.startIndex),
					offsetToPosition(sibContent, n.endIndex)
				);
				locations.push(Location.create(sibUri, range));
			}
		}
	}

	return locations;
}

// ── Document Symbols helpers ────────────────────────────────────────

const SYMBOL_KIND_MAP: Record<string, SymbolKind> = {
	'function_declaration': SymbolKind.Function,
	'struct_declaration': SymbolKind.Struct,
	'contract_declaration': SymbolKind.Class,
	'variable_declaration': SymbolKind.Variable,
	'let_declaration': SymbolKind.Variable,
	'const_declaration': SymbolKind.Constant,
	'struct_variant': SymbolKind.EnumMember,
	'struct_field': SymbolKind.Field,
	'param_statement': SymbolKind.Property,
	'spend_statement': SymbolKind.Method,
	'mint_statement': SymbolKind.Method,
	'certify_statement': SymbolKind.Method,
	'withdraw_statement': SymbolKind.Method,
	'propose_statement': SymbolKind.Method,
	'vote_statement': SymbolKind.Method,
};

function buildDocumentSymbols(node: Parser.SyntaxNode, text: string, document: TextDocument): DocumentSymbol[] {
	const symbols: DocumentSymbol[] = [];

	for (const child of node.children) {
		const kind = SYMBOL_KIND_MAP[child.type];
		if (kind === undefined) {
			// Recurse into non-symbol nodes (e.g. contract_member wrapper)
			symbols.push(...buildDocumentSymbols(child, text, document));
			continue;
		}

		// Find the identifier name
		let name: string | null = null;
		let nameRange: Range | null = null;
		for (const cc of child.children) {
			if (cc.type === 'identifier') {
				name = text.slice(cc.startIndex, cc.endIndex);
				nameRange = Range.create(
					document.positionAt(cc.startIndex),
					document.positionAt(cc.endIndex)
				);
				break;
			}
		}
		if (!name || !nameRange) continue;

		const fullRange = Range.create(
			document.positionAt(child.startIndex),
			document.positionAt(child.endIndex)
		);

		// Build children symbols for containers (structs, contracts)
		const children = buildDocumentSymbols(child, text, document);

		symbols.push(DocumentSymbol.create(
			name,
			undefined, // detail
			kind,
			fullRange,
			nameRange,
			children.length > 0 ? children : undefined
		));
	}

	return symbols;
}

// ── Signature Help helpers ──────────────────────────────────────────

// Find the enclosing call expression and which argument index the cursor is at
function findEnclosingCall(
	rootNode: Parser.SyntaxNode,
	offset: number,
	text: string
): { fnName: string; argIndex: number } | null {
	const node = findNodeAtPosition(rootNode, offset);
	if (!node) return null;

	// Walk up to find a call_expression or arguments node
	let current: Parser.SyntaxNode | null = node;
	while (current) {
		if (current.type === 'arguments') {
			const callExpr = current.parent;
			if (!callExpr || callExpr.type !== 'call_expression') {
				current = current.parent;
				continue;
			}
			// Get function name
			const fnChild = callExpr.childForFieldName('function');
			if (!fnChild) return null;

			let fnName: string;
			if (fnChild.type === 'identifier') {
				fnName = text.slice(fnChild.startIndex, fnChild.endIndex);
			} else if (fnChild.type === 'member_expression') {
				const prop = fnChild.children.find(c => c.type === 'property_identifier');
				if (!prop) return null;
				fnName = text.slice(prop.startIndex, prop.endIndex);
			} else {
				return null;
			}

			// Count which argument we're in by counting commas before cursor
			let argIndex = 0;
			for (const child of current.children) {
				if (child.startIndex >= offset) break;
				if (text.slice(child.startIndex, child.endIndex) === ',') {
					argIndex++;
				}
			}

			return { fnName, argIndex };
		}
		current = current.parent;
	}
	return null;
}

// Extract parameter information from a function/method declaration
function extractParameters(declNode: Parser.SyntaxNode, text: string): ParameterInformation[] {
	const params: ParameterInformation[] = [];
	const formalParams = declNode.children.find(
		c => c.type === 'formal_parameters'
	) ?? declNode.childForFieldName('parameters');

	if (!formalParams) return params;

	for (const child of formalParams.children) {
		if (child.type === 'typed_parameter') {
			const paramText = text.slice(child.startIndex, child.endIndex).trim();
			params.push(ParameterInformation.create(paramText));
		} else if (child.type === 'identifier') {
			const paramText = text.slice(child.startIndex, child.endIndex).trim();
			params.push(ParameterInformation.create(paramText));
		} else if (child.type === 'assignment_pattern') {
			const paramText = text.slice(child.startIndex, child.endIndex).trim();
			params.push(ParameterInformation.create(paramText));
		}
	}

	return params;
}

// Build the signature label from a declaration
function buildSignatureLabel(declNode: Parser.SyntaxNode, fnName: string, text: string): string {
	const formalParams = declNode.children.find(
		c => c.type === 'formal_parameters'
	) ?? declNode.childForFieldName('parameters');

	if (!formalParams) return `${fnName}()`;
	const paramsText = text.slice(formalParams.startIndex, formalParams.endIndex).trim();
	return `${fnName}${paramsText}`;
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
			referencesProvider: true,
			renameProvider: {
				prepareProvider: true,
			},
			documentSymbolProvider: true,
			signatureHelpProvider: {
				triggerCharacters: ['(', ','],
			},
			codeActionProvider: {
				codeActionKinds: [CodeActionKind.QuickFix],
			},
			semanticTokensProvider: {
				legend: semanticTokensLegend,
				full: true,
			},
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

documents.onDidChangeContent(async (change) => {
	const diagnostics = await validateTextDocument(change.document);
	connection.sendDiagnostics({ uri: change.document.uri, diagnostics });
});

function pebbleCategoryToSeverity(category: number): DiagnosticSeverity {
	switch (category) {
		case 3: return DiagnosticSeverity.Error;
		case 2: return DiagnosticSeverity.Warning;
		case 1: return DiagnosticSeverity.Information;
		case 0: return DiagnosticSeverity.Hint;
		default: return DiagnosticSeverity.Error;
	}
}

async function validateTextDocument(textDocument: TextDocument): Promise<Diagnostic[]> {
	const documentPath = fileURLToPath(textDocument.uri);
	const documentText = textDocument.getText();

	// --- Run the full compiler frontend for type-checking diagnostics ---
	try {
		const io = createLspCompilerIoApi( documentPath, documentText );
		const compiler = new Compiler( io );
		const result = await compiler.check({ entry: documentPath, root: path.dirname( documentPath ) + '/' });
		// cache for hover / completion
		checkResultCache.set( textDocument.uri, result );

		const compilerDiags: Diagnostic[] = result.diagnostics
			.filter(d => d.range)
			.map(d => ({
				range: Range.create(textDocument.positionAt(d.range!.start), textDocument.positionAt(d.range!.end)),
				severity: pebbleCategoryToSeverity(d.category),
				code: d.code,
				source: 'pebble',
				message: d.message,
			}));

		if( compilerDiags.length > 0 ) return compilerDiags;
	} catch (error) {
		console.error('Error in compiler check:', error);
	}

	// --- Fallback: parser-only diagnostics ---
	try {
		const [_, diagnostics] = PebbleParser.parseFile(documentPath, documentText);

		return diagnostics.filter(d => d.range).map(d => ({
			range: Range.create(textDocument.positionAt(d.range!.start), textDocument.positionAt(d.range!.end)),
			severity: pebbleCategoryToSeverity(d.category),
			code: d.code,
			source: 'pebble',
			message: d.message,
			relatedInformation: d.emitStack ? [{
				location: {
					uri: textDocument.uri,
					range: Range.create(textDocument.positionAt(d.range!.start), textDocument.positionAt(d.range!.end))
				},
				message: `${d.message}\n${d.emitStack}`
			}] : []
		}));
	} catch (error) {
		console.error('Error validating document:', error);
		return [];
	}
}

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
	try {
		const document = documents.get(params.textDocument.uri);
		if (!document) return [];

		const text = document.getText();
		const tree = parser.parse(text);
		const offset = document.offsetAt(params.position);

		// ── Dot-completion: detect if we're right after a '.' ──
		const charBefore = offset > 0 ? text[offset - 1] : '';
		if (charBefore === '.') {
			const dotOffset = offset - 1;
			const nodeBeforeDot = findNodeAtPosition(tree.rootNode, dotOffset - 1);

			// Handle `context.` — show purpose-specific fields
			if (nodeBeforeDot && nodeBeforeDot.type === 'identifier' && text.slice(nodeBeforeDot.startIndex, nodeBeforeDot.endIndex) === 'context') {
				const ctxType = getEnclosingContractMethodType(nodeBeforeDot);
				if (ctxType) {
					return ctxType.fields.map(f => ({
						label: f.name,
						kind: CompletionItemKind.Field,
						detail: f.type,
					}));
				}
			}

			// Try compiler type map first
			const cached = checkResultCache.get(params.textDocument.uri);
			if (cached && nodeBeforeDot) {
				const objEntry = cached.sourceTypeMap.typeAtOffset(nodeBeforeDot.startIndex);
				if (objEntry) {
					const members = cached.sourceTypeMap.membersOfType(objEntry.type);
					if (members.length > 0) {
						return members.map(m => ({
							label: m.name,
							kind: m.kind === 'field' ? CompletionItemKind.Field : CompletionItemKind.Method,
							detail: m.type.toString(),
						}));
					}
				}
			}

			// Fallback: tree-sitter heuristic dot-completion
			if (nodeBeforeDot) {
				let objectNode = nodeBeforeDot;
				if (objectNode.parent?.type === 'member_expression') {
					const memberExpr = objectNode.parent;
					const objChild = memberExpr.childForFieldName('object');
					if (objChild) objectNode = objChild;
				}
				const dotItems = getDotCompletionItems(objectNode, tree.rootNode, text, document.uri);
				if (dotItems.length > 0) return dotItems;
			}
		}

		// Also check if we're inside a partially-typed member_expression (e.g. `myVar.na|`)
		const nodeAtPosition = findNodeAtPosition(tree.rootNode, offset);
		if (nodeAtPosition) {
			const parent = nodeAtPosition.parent;
			if (parent?.type === 'member_expression') {
				// Try compiler type map first
				const cached = checkResultCache.get(params.textDocument.uri);
				const objChild = parent.childForFieldName('object');
				if (cached && objChild) {
					const objEntry = cached.sourceTypeMap.typeAtOffset(objChild.startIndex);
					if (objEntry) {
						const members = cached.sourceTypeMap.membersOfType(objEntry.type);
						if (members.length > 0) {
							return members.map(m => ({
								label: m.name,
								kind: m.kind === 'field' ? CompletionItemKind.Field : CompletionItemKind.Method,
								detail: m.type.toString(),
							}));
						}
					}
				}
				// Fallback
				if (objChild) {
					const dotItems = getDotCompletionItems(objChild, tree.rootNode, text, document.uri);
					if (dotItems.length > 0) return dotItems;
				}
			}
		}

		// ── General completion ──
		const insideContract = isInsideNodeType(nodeAtPosition, 'contract_declaration');
		const insideStruct = isInsideNodeType(nodeAtPosition, 'struct_declaration');

		const items: CompletionItem[] = [];
		const seen = new Set<string>();

		// Add symbols declared in this file
		const symbols: SymbolInfo[] = [];
		collectSymbols(tree.rootNode, text, symbols);
		for (const sym of symbols) {
			if (seen.has(sym.name)) continue;
			seen.add(sym.name);
			items.push({ label: sym.name, kind: sym.kind });
		}

		// Add imported symbols
		for (const sym of collectImportedSymbols(tree.rootNode, text)) {
			if (seen.has(sym.name)) continue;
			seen.add(sym.name);
			items.push({ label: sym.name, kind: sym.kind });
		}

		// Add keywords – filter contextually
		if (insideContract) {
			const contractKeywords = ['param', 'spend', 'mint', 'certify', 'withdraw', 'propose', 'vote'];
			for (const kw of contractKeywords) {
				if (!seen.has(kw)) {
					seen.add(kw);
					items.push({ label: kw, kind: CompletionItemKind.Keyword });
				}
			}
		}

		for (const kw of KEYWORD_COMPLETIONS) {
			if (!seen.has(kw.label)) {
				seen.add(kw.label);
				items.push(kw);
			}
		}

		// Add built-in types
		for (const t of TYPE_COMPLETIONS) {
			if (!seen.has(t.label)) {
				seen.add(t.label);
				items.push(t);
			}
		}

		return items;
	} catch (error) {
		console.error('Error in onCompletion:', error);
		return [];
	}
});

function isInsideNodeType(node: Parser.SyntaxNode | null, nodeType: string): boolean {
	let current = node;
	while (current) {
		if (current.type === nodeType) return true;
		current = current.parent;
	}
	return false;
}

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	// Enrich with documentation from built-in info if available
	const info = getBuiltInInfo(item.label);
	if (info) {
		item.documentation = { kind: 'markdown', value: info };
	}
	return item;
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

		// Handle `context` keyword — show purpose-specific type
		if (nodeAtPosition.type === 'identifier' && text.slice(nodeAtPosition.startIndex, nodeAtPosition.endIndex) === 'context') {
			const ctxType = getEnclosingContractMethodType(nodeAtPosition);
			if (ctxType) {
				const fieldsStr = ctxType.fields.map(f => `  ${f.name}: ${f.type}`).join(',\n');
				const hoverText = `\`\`\`pebble\ncontext: ${ctxType.name} {\n${fieldsStr}\n}\n\`\`\``;
				const range = Range.create(
					document.positionAt(nodeAtPosition.startIndex),
					document.positionAt(nodeAtPosition.endIndex)
				);
				return { contents: { kind: 'markdown', value: hoverText }, range };
			}
		}

		// Handle destructured fields of `context` — show individual field types
		{
			const contextField = getContextFieldAtNode(nodeAtPosition, text);
			if (contextField) {
				const hoverText = `\`\`\`pebble\n${contextField.name}: ${contextField.type}\n\`\`\``;
				const range = Range.create(
					document.positionAt(nodeAtPosition.startIndex),
					document.positionAt(nodeAtPosition.endIndex)
				);
				return { contents: { kind: 'markdown', value: hoverText }, range };
			}
		}

		// Try compiler type info first
		const cached = checkResultCache.get(params.textDocument.uri);
		if (cached) {
			const entry = cached.sourceTypeMap.typeAtOffset(offset);
			if (entry) {
				const typeName = entry.type.toString();
				const identName = entry.name ?? getIdentifierName(nodeAtPosition, text);
				let hoverText: string;
				if (identName) {
					hoverText = `\`\`\`pebble\n${identName}: ${typeName}\n\`\`\``;
				} else {
					hoverText = `\`\`\`pebble\n${typeName}\n\`\`\``;
				}
				const range = Range.create(
					document.positionAt(nodeAtPosition.startIndex),
					document.positionAt(nodeAtPosition.endIndex)
				);
				return { contents: { kind: 'markdown', value: hoverText }, range };
			}
		}

		// Fallback: tree-sitter based hover
		const hoverInfo = generateHoverInfo(nodeAtPosition, text, tree.rootNode, params.textDocument.uri);
		if (!hoverInfo) return null;

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
		const offset = document.offsetAt(params.position);

		// Find the node at the cursor position
		const nodeAtPosition = findNodeAtPosition(tree.rootNode, offset);
		if (!nodeAtPosition) return null;

		// Get the identifier name at the cursor position
		const identifierName = getIdentifierName(nodeAtPosition, text);
		if (!identifierName || identifierName.trim().length === 0) return null;

		// Don't try to find definitions for built-in types/keywords
		if (getBuiltInInfo(identifierName)) return null;

		// Find a local declaration in this file
		const declaration = findDeclaration(identifierName, tree.rootNode, text);
		if (declaration) {
			const identifierRange = getIdentifierRangeInDeclarationWithDocument(declaration, identifierName, text, document);
			const range = identifierRange || Range.create(
				document.positionAt(declaration.startIndex),
				document.positionAt(declaration.endIndex)
			);
			return { uri: document.uri, range };
		}

		// Check if it's an imported symbol — resolve to the source file
		const importNode = findImportDeclaration(identifierName, tree.rootNode, text);
		if (importNode) {
			const importSource = getImportSourcePath(importNode, text);
			if (importSource) {
				const resolvedPath = resolveImportPath(importSource, document.uri);
				if (resolvedPath) {
					const loc = findDefinitionInFile(identifierName, resolvedPath);
					if (loc) return loc;
				}
			}
			// Fallback: jump to the import statement itself
			const range = Range.create(
				document.positionAt(importNode.startIndex),
				document.positionAt(importNode.endIndex)
			);
			return { uri: document.uri, range };
		}

		return null;
	} catch (error) {
		console.error('Error in onDefinition:', error);
		return null;
	}
});

// ── Find All References ─────────────────────────────────────────────

connection.onReferences((params: ReferenceParams): Location[] => {
	try {
		const document = documents.get(params.textDocument.uri);
		if (!document) return [];

		const text = document.getText();
		const tree = parser.parse(text);
		const offset = document.offsetAt(params.position);

		const nodeAtPosition = findNodeAtPosition(tree.rootNode, offset);
		if (!nodeAtPosition) return [];

		const identifierName = getIdentifierName(nodeAtPosition, text);
		if (!identifierName || identifierName.trim().length === 0) return [];

		// Skip keywords
		const keywords = new Set([
			'function', 'struct', 'contract', 'let', 'const', 'if', 'else',
			'match', 'for', 'while', 'return', 'assert', 'trace', 'fail',
			'import', 'from', 'true', 'false', 'as',
			'param', 'spend', 'mint', 'certify', 'withdraw', 'propose', 'vote',
		]);
		if (keywords.has(identifierName)) return [];

		return findAllReferences(
			identifierName,
			document.uri,
			text,
			tree.rootNode,
			params.context.includeDeclaration
		);
	} catch (error) {
		console.error('Error in onReferences:', error);
		return [];
	}
});

// ── Rename Symbol ───────────────────────────────────────────────────

connection.onPrepareRename((params: PrepareRenameParams): Range | null => {
	try {
		const document = documents.get(params.textDocument.uri);
		if (!document) return null;

		const text = document.getText();
		const tree = parser.parse(text);
		const offset = document.offsetAt(params.position);

		const nodeAtPosition = findNodeAtPosition(tree.rootNode, offset);
		if (!nodeAtPosition || nodeAtPosition.type !== 'identifier') return null;

		const identifierName = text.slice(nodeAtPosition.startIndex, nodeAtPosition.endIndex);

		// Don't allow renaming keywords or built-in types
		if (getBuiltInInfo(identifierName)) return null;

		return Range.create(
			document.positionAt(nodeAtPosition.startIndex),
			document.positionAt(nodeAtPosition.endIndex)
		);
	} catch (error) {
		console.error('Error in onPrepareRename:', error);
		return null;
	}
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit | null => {
	try {
		const document = documents.get(params.textDocument.uri);
		if (!document) return null;

		const text = document.getText();
		const tree = parser.parse(text);
		const offset = document.offsetAt(params.position);

		const nodeAtPosition = findNodeAtPosition(tree.rootNode, offset);
		if (!nodeAtPosition) return null;

		const identifierName = getIdentifierName(nodeAtPosition, text);
		if (!identifierName || identifierName.trim().length === 0) return null;
		if (getBuiltInInfo(identifierName)) return null;

		const newName = params.newName;

		// Find all references (including declaration) across files
		const allRefs = findAllReferences(
			identifierName,
			document.uri,
			text,
			tree.rootNode,
			true // include declaration
		);

		if (allRefs.length === 0) return null;

		// Group edits by document URI
		const changes: Record<string, TextEdit[]> = {};
		for (const ref of allRefs) {
			if (!changes[ref.uri]) changes[ref.uri] = [];
			changes[ref.uri].push(TextEdit.replace(ref.range, newName));
		}

		return { changes };
	} catch (error) {
		console.error('Error in onRenameRequest:', error);
		return null;
	}
});

// ── Document Symbols ────────────────────────────────────────────────

connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
	try {
		const document = documents.get(params.textDocument.uri);
		if (!document) return [];

		const text = document.getText();
		const tree = parser.parse(text);

		return buildDocumentSymbols(tree.rootNode, text, document);
	} catch (error) {
		console.error('Error in onDocumentSymbol:', error);
		return [];
	}
});

// ── Signature Help ──────────────────────────────────────────────────

connection.onSignatureHelp((params: SignatureHelpParams): SignatureHelp | null => {
	try {
		const document = documents.get(params.textDocument.uri);
		if (!document) return null;

		const text = document.getText();
		const tree = parser.parse(text);
		const offset = document.offsetAt(params.position);

		const callInfo = findEnclosingCall(tree.rootNode, offset, text);
		if (!callInfo) return null;

		const { fnName, argIndex } = callInfo;

		// Find the declaration of the function
		const decl = findDeclaration(fnName, tree.rootNode, text);
		if (!decl) return null;

		// Only provide signatures for function-like declarations
		const functionLikeTypes = [
			'function_declaration',
			'spend_statement', 'mint_statement', 'certify_statement',
			'withdraw_statement', 'propose_statement', 'vote_statement',
		];
		if (!functionLikeTypes.includes(decl.type)) return null;

		const parameters = extractParameters(decl, text);
		if (parameters.length === 0) return null;

		const label = buildSignatureLabel(decl, fnName, text);
		const sig = SignatureInformation.create(label, undefined, ...parameters);

		return {
			signatures: [sig],
			activeSignature: 0,
			activeParameter: Math.min(argIndex, parameters.length - 1),
		};
	} catch (error) {
		console.error('Error in onSignatureHelp:', error);
		return null;
	}
});

// ── Code Actions ────────────────────────────────────────────────────

connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
	try {
		const document = documents.get(params.textDocument.uri);
		if (!document) return [];

		const text = document.getText();
		const tree = parser.parse(text);
		const actions: CodeAction[] = [];

		for (const diagnostic of params.context.diagnostics) {
			const message = diagnostic.message.toLowerCase();

			// "Add missing import" for undeclared identifiers
			if (message.includes('undeclared') || message.includes('not defined') || message.includes('cannot find')) {
				// Extract identifier from the diagnostic range
				const startOffset = document.offsetAt(diagnostic.range.start);
				const endOffset = document.offsetAt(diagnostic.range.end);
				const identifierName = text.slice(startOffset, endOffset).trim();

				if (identifierName && identifierName.length >= 2 && /^[A-Za-z_]/.test(identifierName)) {
					// Scan sibling .pebble files for a matching exported declaration
					const importAction = buildAddImportAction(
						identifierName, document, tree.rootNode, text, diagnostic
					);
					if (importAction) actions.push(importAction);
				}
			}

			// "Wrap in assert" for expressions that look like conditions
			if (message.includes('unused') || message.includes('expression')) {
				const action = CodeAction.create(
					`Wrap in assert`,
					{
						changes: {
							[document.uri]: [
								TextEdit.replace(diagnostic.range,
									`assert ${text.slice(
										document.offsetAt(diagnostic.range.start),
										document.offsetAt(diagnostic.range.end)
									)}`
								)
							]
						}
					},
					CodeActionKind.QuickFix
				);
				action.diagnostics = [diagnostic];
				actions.push(action);
			}
		}

		return actions;
	} catch (error) {
		console.error('Error in onCodeAction:', error);
		return [];
	}
});

function findNamedImportsNode(node: Parser.SyntaxNode, text: string): Parser.SyntaxNode | null {
	if (node.type === 'named_imports' || node.type === 'import_clause') {
		const nodeText = text.slice(node.startIndex, node.endIndex);
		if (nodeText.includes('{') && nodeText.includes('}')) {
			return node;
		}
	}
	for (const child of node.children) {
		const result = findNamedImportsNode(child, text);
		if (result) return result;
	}
	return null;
}

// Build an "Add import" code action if the identifier is found in a sibling file
function buildAddImportAction(
	identifierName: string,
	document: TextDocument,
	rootNode: Parser.SyntaxNode,
	text: string,
	diagnostic: Diagnostic,
): CodeAction | null {
	const siblings = getSiblingPebbleFiles(document.uri);
	const currentFilePath = fileURLToPath(document.uri);

	for (const siblingPath of siblings) {
		if (siblingPath === currentFilePath) continue;

		let sibContent: string;
		try { sibContent = fs.readFileSync(siblingPath, 'utf-8'); } catch { continue; }

		const sibTree = parser.parse(sibContent);
		const decl = findDeclaration(identifierName, sibTree.rootNode, sibContent);
		if (!decl) continue;

		// Found it — build the import path
		const relativePath = './' + path.basename(siblingPath).replace(/\.pebble$/, '');

		// Check if there's already an import from the same source
		let existingImport: Parser.SyntaxNode | null = null;
		let insertLine = 0;
		for (const child of rootNode.children) {
			if (child.type === 'import_statement' || child.type === 'import_declaration') {
				const endPos = offsetToPosition(text, child.endIndex);
				insertLine = endPos.line + 1;

				const sourcePath = getImportSourcePath(child, text);
				if (sourcePath === relativePath) {
					existingImport = child;
				}
			}
		}

		let edit: TextEdit;
		if (existingImport) {
			// Merge into existing import — find the node containing { ... }
			const namedImports = findNamedImportsNode(existingImport, text);

			if (namedImports) {
				const namedText = text.slice(namedImports.startIndex, namedImports.endIndex);
				const closingBrace = namedText.lastIndexOf('}');
				const beforeBrace = namedText.slice(0, closingBrace).trimEnd();
				// Build new named imports text: add comma if needed, then the new identifier
				const needsComma = beforeBrace.length > 0 && !beforeBrace.endsWith(',') && !beforeBrace.endsWith('{');
				const separator = needsComma ? ', ' : ' ';
				const newNamedText = beforeBrace + separator + identifierName + ' }';

				const startPos = offsetToPosition(text, namedImports.startIndex);
				const endPos = offsetToPosition(text, namedImports.endIndex);
				edit = TextEdit.replace(
					{ start: startPos, end: endPos },
					newNamedText
				);
			} else {
				// Fallback: couldn't find named imports node, create new import
				const importText = `import { ${identifierName} } from "${relativePath}";\n`;
				edit = TextEdit.insert({ line: insertLine, character: 0 }, importText);
			}
		} else {
			const importText = `import { ${identifierName} } from "${relativePath}";\n`;
			edit = TextEdit.insert({ line: insertLine, character: 0 }, importText);
		}

		const action = CodeAction.create(
			`Add import from "${relativePath}"`,
			{ changes: { [document.uri]: [edit] } },
			CodeActionKind.QuickFix
		);
		action.diagnostics = [diagnostic];
		action.isPreferred = true;
		return action;
	}

	return null;
}

// ── Contract context types (runtime-only, for LSP display) ──

interface ContextFieldInfo {
	name: string;
	type: string;
}

interface ContractContextType {
	name: string;
	fields: ContextFieldInfo[];
}

const CONTRACT_CONTEXT_TYPES: Record<string, ContractContextType> = {
	spend_statement: {
		name: 'SpendContractContext',
		fields: [
			{ name: 'tx', type: 'Tx' },
			{ name: 'purpose', type: 'Spend' },
			{ name: 'redeemer', type: 'data' },
			{ name: 'spendingRef', type: 'TxOutRef' },
			{ name: 'optionalDatum', type: 'Optional<data>' },
		],
	},
	mint_statement: {
		name: 'MintContractContext',
		fields: [
			{ name: 'tx', type: 'Tx' },
			{ name: 'purpose', type: 'Mint' },
			{ name: 'redeemer', type: 'data' },
			{ name: 'policy', type: 'PolicyId' },
		],
	},
	withdraw_statement: {
		name: 'WithdrawContractContext',
		fields: [
			{ name: 'tx', type: 'Tx' },
			{ name: 'purpose', type: 'Withdraw' },
			{ name: 'redeemer', type: 'data' },
			{ name: 'credential', type: 'Credential' },
		],
	},
	certify_statement: {
		name: 'CertifyContractContext',
		fields: [
			{ name: 'tx', type: 'Tx' },
			{ name: 'purpose', type: 'Certificate' },
			{ name: 'redeemer', type: 'data' },
			{ name: 'certificateIndex', type: 'int' },
			{ name: 'certificate', type: 'Certificate' },
		],
	},
	propose_statement: {
		name: 'ProposeContractContext',
		fields: [
			{ name: 'tx', type: 'Tx' },
			{ name: 'purpose', type: 'Propose' },
			{ name: 'redeemer', type: 'data' },
			{ name: 'proposalIndex', type: 'int' },
			{ name: 'proposal', type: 'ProposalProcedure' },
		],
	},
	vote_statement: {
		name: 'VoteContractContext',
		fields: [
			{ name: 'tx', type: 'Tx' },
			{ name: 'purpose', type: 'Vote' },
			{ name: 'redeemer', type: 'data' },
			{ name: 'voter', type: 'Voter' },
		],
	},
};

function getEnclosingContractMethodType(node: Parser.SyntaxNode): ContractContextType | null {
	let current: Parser.SyntaxNode | null = node;
	while (current) {
		const ctxType = CONTRACT_CONTEXT_TYPES[current.type];
		if (ctxType) return ctxType;
		current = current.parent;
	}
	return null;
}

/**
 * Check if a node is a destructured field of `context`.
 * Handles patterns like `const { tx, purpose, redeemer } = context;`
 * where `tx` is a `shorthand_property_identifier_pattern` inside an `object_pattern`
 * whose `variable_declarator` initializer is `context`.
 * Also handles `pair_pattern` for renamed fields: `const { tx: myTx } = context;`
 */
function getContextFieldAtNode(node: Parser.SyntaxNode, text: string): ContextFieldInfo | null {
	let fieldName: string | null = null;
	let patternNode: Parser.SyntaxNode | null = null;

	if (node.type === 'shorthand_property_identifier_pattern') {
		fieldName = text.slice(node.startIndex, node.endIndex);
		patternNode = node.parent; // object_pattern
	} else if (node.type === 'identifier' && node.parent?.type === 'pair_pattern') {
		// `tx: myTx` — the key is the field name
		const pairPattern = node.parent;
		const keyNode = pairPattern.children[0];
		if (keyNode) fieldName = text.slice(keyNode.startIndex, keyNode.endIndex);
		patternNode = pairPattern.parent; // object_pattern
	}

	if (!fieldName || !patternNode || patternNode.type !== 'object_pattern') return null;

	// object_pattern -> variable_declarator
	const declarator = patternNode.parent;
	if (!declarator || declarator.type !== 'variable_declarator') return null;

	// Check if the initializer (right of `=`) is `context`
	const children = declarator.children;
	const lastChild = children[children.length - 1];
	if (!lastChild || lastChild.type !== 'identifier' || text.slice(lastChild.startIndex, lastChild.endIndex) !== 'context') return null;

	// Find the enclosing contract method to get purpose-specific fields
	const ctxType = getEnclosingContractMethodType(node);
	if (!ctxType) return null;

	const field = ctxType.fields.find(f => f.name === fieldName);
	return field ?? null;
}

// ── Semantic tokens handler ──
connection.languages.semanticTokens.on((params: SemanticTokensParams) => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return { data: [] };

	const text = document.getText();
	const tree = parser.parse(text);
	const builder = new SemanticTokensBuilder();

	function pushToken(node: Parser.SyntaxNode, tokenType: number, tokenModifiers: number = 0) {
		const startPos = document!.positionAt(node.startIndex);
		const length = node.endIndex - node.startIndex;
		builder.push(startPos.line, startPos.character, length, tokenType, tokenModifiers);
	}

	// Token type indices (must match SEMANTIC_TOKEN_TYPES array)
	const TOKEN_TYPE = 0;      // 'type'
	const TOKEN_VARIABLE = 1;  // 'variable'
	const TOKEN_KEYWORD = 4;   // 'keyword'

	// Token modifier bits (must match SEMANTIC_TOKEN_MODIFIERS array)
	const MOD_READONLY = 1 << 1; // 'readonly'

	// Pass 1: collect all const-declared names
	const constNames = new Set<string>();
	collectConstNames(tree.rootNode);

	// Pass 2: mark all identifiers that are const-declared as readonly
	markConstUsages(tree.rootNode);

	function collectConstNames(node: Parser.SyntaxNode) {
		if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
			const declKind = node.children[0];
			if (declKind && text.slice(declKind.startIndex, declKind.endIndex) === 'const') {
				collectNamesFromPattern(node);
			}
		}
		// Function parameters are constants by default in Pebble
		if (node.type === 'typed_parameter' || node.type === 'required_parameter' || node.type === 'optional_parameter') {
			const nameChild = node.children.find(c => c.type === 'identifier');
			if (nameChild) {
				const name = text.slice(nameChild.startIndex, nameChild.endIndex);
				if (!/^[A-Z]/.test(name)) {
					constNames.add(name);
				}
			}
		}
		for (const child of node.children) {
			collectConstNames(child);
		}
	}

	function collectNamesFromPattern(node: Parser.SyntaxNode) {
		for (const child of node.children) {
			if (child.type === 'identifier') {
				const name = text.slice(child.startIndex, child.endIndex);
				if (name === 'const') continue;
				if (/^[A-Z]/.test(name)) continue;
				if (isInPatternPosition(child)) {
					constNames.add(name);
				}
			}
			if (child.type === 'shorthand_property_identifier_pattern') {
				constNames.add(text.slice(child.startIndex, child.endIndex));
			}
			if (child.type === 'object_pattern' || child.type === 'array_pattern' ||
				child.type === 'variable_declarator' || child.type === 'shorthand_property_identifier_pattern' ||
				child.type === 'pair_pattern' || child.type === 'object' ||
				child.type === 'pair' || child.type === 'ERROR') {
				collectNamesFromPattern(child);
			}
		}
	}

	function markConstUsages(node: Parser.SyntaxNode) {
		// Mark identifier usages of const-declared names
		if (node.type === 'identifier') {
			const name = text.slice(node.startIndex, node.endIndex);
			if (constNames.has(name) && !isPropertyPosition(node)) {
				pushToken(node, TOKEN_VARIABLE, MOD_READONLY);
			}
		}
		// Also mark shorthand_property_identifier_pattern nodes (destructuring declarations)
		if (node.type === 'shorthand_property_identifier_pattern') {
			const name = text.slice(node.startIndex, node.endIndex);
			if (constNames.has(name)) {
				pushToken(node, TOKEN_VARIABLE, MOD_READONLY);
			}
		}
		for (const child of node.children) {
			markConstUsages(child);
		}
	}

	function isPropertyPosition(node: Parser.SyntaxNode): boolean {
		// Don't mark identifiers that are property names after `.`
		const parent = node.parent;
		if (!parent) return false;
		if (parent.type === 'member_expression') {
			const prop = parent.childForFieldName('property') ?? parent.children.find(c => c.type === 'property_identifier');
			if (prop && prop.id === node.id) return true;
		}
		return false;
	}

	function isInPatternPosition(node: Parser.SyntaxNode): boolean {
		let current: Parser.SyntaxNode | null = node;
		while (current) {
			if (current.type === 'variable_declarator') {
				const firstChild = current.children[0];
				if (firstChild && node.startIndex >= firstChild.startIndex && node.endIndex <= firstChild.endIndex) {
					return true;
				}
				const hasEquals = current.children.some(c => text.slice(c.startIndex, c.endIndex) === '=');
				if (!hasEquals) return true;
				return false;
			}
			if (current.type === 'object_pattern' || current.type === 'array_pattern' ||
				current.type === 'shorthand_property_identifier_pattern') {
				return true;
			}
			current = current.parent;
		}
		return false;
	}

	return builder.build();
});

documents.listen(connection);

connection.listen();
