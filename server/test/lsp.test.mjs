#!/usr/bin/env node
/**
 * Headless LSP client: drives `server/out/server.js` over stdio, the way an editor does,
 * against the fixtures in `test/fixtures/project` — no VS Code, no `vscode` module.
 *
 *   node test/lsp.test.mjs            (from `server/`, or `npm test`)
 *
 * It checks, for real files:
 *   - diagnostics pushed on didOpen (clean file, and a deliberate type error with its range)
 *   - hover (a local name, an imported function, a field, a struct)
 *   - go to definition (local, and a symbol imported from another file)
 *   - find references (across files)
 *   - completion (visible names, and members after a `.`)
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const serverEntry = path.join(serverDir, 'out', 'server.js');
const projectDir = path.join(here, 'fixtures', 'project');
const srcDir = path.join(projectDir, 'src');

if (!fs.existsSync(serverEntry)) {
	console.error(`missing ${serverEntry} — run \`npm run compile\` in the repository root first`);
	process.exit(2);
}

// ── a minimal LSP client over stdio ─────────────────────────────────

class LspClient {
	constructor(child) {
		this.child = child;
		this.nextId = 1;
		this.pending = new Map();
		this.notifications = [];
		this.notificationWaiters = [];
		this.stderr = '';

		child.stderr.on('data', chunk => { this.stderr += chunk.toString(); });

		let buffer = Buffer.alloc(0);
		child.stdout.on('data', chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				const headerEnd = buffer.indexOf('\r\n\r\n');
				if (headerEnd < 0) return;
				const header = buffer.subarray(0, headerEnd).toString('ascii');
				const match = /Content-Length: (\d+)/i.exec(header);
				if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
				const length = Number(match[1]);
				if (buffer.length < headerEnd + 4 + length) return;
				const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
				buffer = buffer.subarray(headerEnd + 4 + length);
				this.#handle(JSON.parse(body));
			}
		});
	}

	#handle(message) {
		if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
			const entry = this.pending.get(message.id);
			if (!entry) return;
			this.pending.delete(message.id);
			if (message.error) entry.reject(new Error(`${entry.method}: ${JSON.stringify(message.error)}`));
			else entry.resolve(message.result);
			return;
		}
		if (message.id !== undefined) {
			// a server → client request: answer what is answerable, decline the rest
			this.#write({ jsonrpc: '2.0', id: message.id, result: null });
			return;
		}
		this.notifications.push(message);
		for (const waiter of [...this.notificationWaiters]) {
			if (waiter.method === message.method && waiter.matches(message.params)) {
				this.notificationWaiters.splice(this.notificationWaiters.indexOf(waiter), 1);
				clearTimeout(waiter.timer);
				waiter.resolve(message.params);
			}
		}
	}

	#write(message) {
		const body = JSON.stringify({ jsonrpc: '2.0', ...message });
		this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	}

	request(method, params, timeoutMs = 30000) {
		const id = this.nextId++;
		this.#write({ id, method, params });
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, {
				method,
				resolve: value => { clearTimeout(timer); resolve(value); },
				reject: error => { clearTimeout(timer); reject(error); },
			});
		});
	}

	notify(method, params) {
		this.#write({ method, params });
	}

	/** resolves with the params of the next notification of `method` matching `matches` */
	waitForNotification(method, matches = () => true, timeoutMs = 30000) {
		const already = this.notifications.find(n => n.method === method && matches(n.params));
		if (already) {
			this.notifications.splice(this.notifications.indexOf(already), 1);
			return Promise.resolve(already.params);
		}
		return new Promise((resolve, reject) => {
			const waiter = { method, matches, resolve, reject, timer: null };
			waiter.timer = setTimeout(() => {
				this.notificationWaiters.splice(this.notificationWaiters.indexOf(waiter), 1);
				reject(new Error(`${method}: no notification within ${timeoutMs}ms`));
			}, timeoutMs);
			this.notificationWaiters.push(waiter);
		});
	}

	close() {
		this.child.stdin.end();
		this.child.kill();
	}
}

// ── text/position helpers ───────────────────────────────────────────

const documents = new Map();

function uriOf(fileName) {
	return url.pathToFileURL(path.join(srcDir, fileName)).toString();
}

function textOf(fileName) {
	if (!documents.has(fileName)) documents.set(fileName, fs.readFileSync(path.join(srcDir, fileName), 'utf8'));
	return documents.get(fileName);
}

/** offset of the `nth` (from 0) whole-word occurrence of `word` in `fileName` */
function offsetOf(fileName, word, nth = 0) {
	const text = textOf(fileName);
	const re = new RegExp(`(?<![A-Za-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g');
	let match;
	let index = 0;
	while ((match = re.exec(text)) !== null) {
		if (index++ === nth) return match.index;
	}
	throw new Error(`no ${nth}th '${word}' in ${fileName}`);
}

function positionAt(fileName, offset) {
	const text = textOf(fileName);
	let line = 0;
	let lineStart = 0;
	for (let i = 0; i < offset; i++) {
		if (text[i] === '\n') { line++; lineStart = i + 1; }
	}
	return { line, character: offset - lineStart };
}

function rangeText(fileName, range) {
	const text = textOf(fileName);
	const lines = text.split('\n');
	if (range.start.line === range.end.line) {
		return lines[range.start.line].slice(range.start.character, range.end.character);
	}
	const first = lines[range.start.line].slice(range.start.character);
	const last = lines[range.end.line].slice(0, range.end.character);
	return [first, ...lines.slice(range.start.line + 1, range.end.line), last].join('\n');
}

function uriName(uri) {
	return path.basename(url.fileURLToPath(uri));
}

// ── the harness ─────────────────────────────────────────────────────

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
	checks++;
	if (condition) {
		console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
	} else {
		failures++;
		console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
	}
}

const client = new LspClient(spawn(process.execPath, [serverEntry, '--stdio'], { cwd: serverDir }));

async function open(fileName) {
	const uri = uriOf(fileName);
	client.notify('textDocument/didOpen', {
		textDocument: { uri, languageId: 'pebble', version: 1, text: textOf(fileName) },
	});
	const params = await client.waitForNotification(
		'textDocument/publishDiagnostics',
		p => p.uri === uri
	);
	return params.diagnostics;
}

const at = (fileName, word, nth = 0) => ({ textDocument: { uri: uriOf(fileName) }, position: positionAt(fileName, offsetOf(fileName, word, nth)) });

console.log(`Pebble LSP headless test`);
console.log(`  server:  ${serverEntry}`);
console.log(`  project: ${projectDir}\n`);

try {
	// ── initialize ──
	const init = await client.request('initialize', {
		processId: process.pid,
		rootUri: url.pathToFileURL(projectDir).toString(),
		capabilities: { textDocument: { publishDiagnostics: {}, hover: {}, definition: {}, references: {}, completion: {} } },
		workspaceFolders: [{ uri: url.pathToFileURL(projectDir).toString(), name: 'fixtures' }],
	});
	client.notify('initialized', {});
	const caps = init.capabilities ?? {};
	check('initialize', caps.hoverProvider === true && caps.definitionProvider === true && caps.referencesProvider === true && !!caps.completionProvider && !!caps.diagnosticProvider,
		`hover/definition/references/completion/diagnostics advertised`);
	console.log(`        serverInfo: ${init.serverInfo?.name ?? '(none)'}\n`);

	// ── diagnostics: a clean file ──
	console.log('[diagnostics] src/main.pebble');
	let diagnostics = await open('main.pebble');
	check('clean file has no diagnostics', diagnostics.length === 0, `${diagnostics.length} diagnostic(s)`);
	for (const d of diagnostics) console.log(`        ${d.severity} ${d.code} ${d.message} ${JSON.stringify(d.range)}`);
	console.log('');

	// ── diagnostics: a deliberate type error, with its range ──
	console.log('[diagnostics] src/error.pebble (double( "not an int" ))');
	diagnostics = await open('error.pebble');
	check('the type error is reported', diagnostics.length === 1, `${diagnostics.length} diagnostic(s)`);
	const errorDiag = diagnostics[0];
	if (errorDiag) {
		const covered = rangeText('error.pebble', errorDiag.range);
		console.log(`        message:  ${errorDiag.message}`);
		console.log(`        code:     ${errorDiag.code}   severity: ${errorDiag.severity}`);
		console.log(`        range:    ${JSON.stringify(errorDiag.range)} -> ${JSON.stringify(covered)}`);
		check('the diagnostic range covers the offending argument', covered === '"not an int"', JSON.stringify(covered));
		check('the diagnostic is an error', errorDiag.severity === 1, `severity ${errorDiag.severity}`);
	}
	console.log('');

	// ── a file that does not parse: check() goes past the error ──
	let hover;
	let hoverText;
	console.log('[diagnostics] src/broken.pebble (a parse error: `double( 1;`)');
	diagnostics = await open('broken.pebble');
	console.log(`        ${diagnostics.map(d => `[${d.code}] ${d.message} @${JSON.stringify(d.range)}`).join('\n        ')}`);
	check('the parse error is reported', diagnostics.some(d => /expected/i.test(d.message)), `${diagnostics.length} diagnostic(s)`);
	check('the type error after it is reported too', diagnostics.some(d => d.code === 2322));

	// the symbols survive the parse error: hover still answers, through the import
	hover = await client.request('textDocument/hover', at('broken.pebble', 'double', 1));
	hoverText = hover?.contents?.value ?? '';
	console.log(`  src/broken.pebble, on \`double\`: ${JSON.stringify(hoverText)}`);
	check('hover still answers in a file that does not parse', hoverText.includes('double'), hoverText.replace(/\n/g, ' '));
	console.log('');

	// ── hover ──
	console.log('[hover]');
	hover = await client.request('textDocument/hover', at('main.pebble', 'double', 1));
	hoverText = hover?.contents?.value ?? '';
	console.log(`  src/main.pebble, on the call \`double( n )\`: ${JSON.stringify(hoverText)}`);
	check('hover on an imported function gives its type', hoverText.includes('double') && hoverText.includes('(int) => int'), hoverText.replace(/\n/g, ' '));

	hover = await client.request('textDocument/hover', at('main.pebble', 'K', 1));
	hoverText = hover?.contents?.value ?? '';
	console.log(`  src/main.pebble, on \`K\`: ${JSON.stringify(hoverText)}`);
	check('hover on an imported constant gives its type', hoverText.includes('K') && hoverText.includes('int'), hoverText.replace(/\n/g, ' '));

	hover = await client.request('textDocument/hover', at('main.pebble', 'p', 1));
	hoverText = hover?.contents?.value ?? '';
	console.log(`  src/main.pebble, on the parameter \`p\`: ${JSON.stringify(hoverText)}`);
	check('hover on a parameter gives its type', hoverText.includes('p') && hoverText.includes('Point'), hoverText.replace(/\n/g, ' '));

	hover = await client.request('textDocument/hover', at('main.pebble', 'x', 1));
	hoverText = hover?.contents?.value ?? '';
	console.log(`  src/main.pebble, on the field \`p.x\`: ${JSON.stringify(hoverText)}`);
	check('hover on a field gives its type and container', hoverText.includes('x') && hoverText.includes('int') && hoverText.includes('Point'), hoverText.replace(/\n/g, ' '));
	console.log('');

	// ── definition ──
	console.log('[definition]');
	let definition = await client.request('textDocument/definition', at('main.pebble', 'scaled', 1));
	let definitionUri = Array.isArray(definition) ? definition[0]?.uri : definition?.uri;
	let definitionRange = Array.isArray(definition) ? definition[0]?.range : definition?.range;
	console.log(`  src/main.pebble, on \`scaled\` in the test: ${definitionUri && uriName(definitionUri)} ${JSON.stringify(definitionRange)} -> ${definitionRange ? JSON.stringify(rangeText('main.pebble', definitionRange)) : ''}`);
	check('definition of a local function stays in the file', definitionUri === uriOf('main.pebble') && definitionRange && rangeText('main.pebble', definitionRange) === 'scaled');

	definition = await client.request('textDocument/definition', at('main.pebble', 'double', 1));
	definitionUri = Array.isArray(definition) ? definition[0]?.uri : definition?.uri;
	definitionRange = Array.isArray(definition) ? definition[0]?.range : definition?.range;
	const crossFileText = definitionUri && uriName(definitionUri) === 'lib.pebble' ? rangeText('lib.pebble', definitionRange) : '';
	console.log(`  src/main.pebble, on \`double\` (imported): ${definitionUri && uriName(definitionUri)} ${JSON.stringify(definitionRange)} -> ${JSON.stringify(crossFileText)}`);
	check('definition of an imported function lands in the other file, on its name', uriName(definitionUri ?? '') === 'lib.pebble' && crossFileText === 'double');
	console.log(`        line: ${textOf('lib.pebble').split('\n')[definitionRange?.start.line ?? 0]}`);

	definition = await client.request('textDocument/definition', at('main.pebble', 'K', 1));
	definitionUri = Array.isArray(definition) ? definition[0]?.uri : definition?.uri;
	definitionRange = Array.isArray(definition) ? definition[0]?.range : definition?.range;
	console.log(`  src/main.pebble, on \`K\` (imported): ${definitionUri && uriName(definitionUri)} ${JSON.stringify(definitionRange)} -> ${definitionRange ? JSON.stringify(rangeText('lib.pebble', definitionRange)) : ''}`);
	check('definition of an imported constant lands on its declaration', uriName(definitionUri ?? '') === 'lib.pebble' && rangeText('lib.pebble', definitionRange) === 'K');
	console.log('');

	// ── references ──
	console.log('[references]');
	let references = await client.request('textDocument/references', {
		...at('main.pebble', 'double', 1),
		context: { includeDeclaration: true },
	});
	let rendered = (references ?? []).map(r => `${uriName(r.uri)}:${r.range.start.line + 1}:${r.range.start.character + 1} ${JSON.stringify(rangeText(uriName(r.uri), r.range))}`);
	console.log(`  src/main.pebble, on \`double\`: ${references?.length ?? 0} location(s)`);
	for (const line of rendered) console.log(`        ${line}`);
	check('references of an imported function include its declaration and its uses',
		(references ?? []).length === 3
		&& rendered.some(l => l.startsWith('lib.pebble') && l.includes('"double"'))
		&& rendered.filter(l => l.startsWith('main.pebble')).length === 2);

	// from the declaring file, with main.pebble open: its check contributes the uses
	await open('lib.pebble');
	references = await client.request('textDocument/references', {
		...at('lib.pebble', 'double', 0),
		context: { includeDeclaration: true },
	});
	rendered = (references ?? []).map(r => `${uriName(r.uri)}:${r.range.start.line + 1}:${r.range.start.character + 1}`);
	console.log(`  src/lib.pebble, on the declaration of \`double\`: ${references?.length ?? 0} location(s)`);
	console.log(`        ${rendered.join(', ')}`);
	check('references from the declaring file reach the importing file',
		(references ?? []).length === 3 && rendered.some(l => l.startsWith('main.pebble')));

	references = await client.request('textDocument/references', {
		...at('main.pebble', 'double', 1),
		context: { includeDeclaration: false },
	});
	console.log(`  src/main.pebble, on \`double\` (without the declaration): ${references?.length ?? 0} location(s)`);
	check('references without the declaration omit it', (references ?? []).length === 2);
	console.log('');

	// ── completion ──
	console.log('[completion]');
	const completion = await client.request('textDocument/completion', {
		textDocument: { uri: uriOf('main.pebble') },
		position: positionAt('main.pebble', offsetOf('main.pebble', 'return double', 0) + 'return d'.length),
	});
	const items = Array.isArray(completion) ? completion : completion?.items ?? [];
	const labels = new Set(items.map(i => i.label));
	const find = label => items.find(i => i.label === label);
	console.log(`  src/main.pebble, inside \`scaled\`: ${items.length} item(s)`);
	console.log(`        double: ${JSON.stringify(find('double'))}`);
	console.log(`        K:      ${JSON.stringify(find('K'))}`);
	console.log(`        Point:  ${JSON.stringify(find('Point'))}`);
	console.log(`        scaled: ${JSON.stringify(find('scaled'))}`);
	check('visible names include the imported function, constant and struct',
		labels.has('double') && labels.has('K') && labels.has('Point') && labels.has('scaled'));
	check('the imported function carries its type as detail', find('double')?.detail === '(int) => int', JSON.stringify(find('double')?.detail));
	check('keywords are still offered', labels.has('let') && labels.has('struct'));

	// members after a `.`
	const dot = await client.request('textDocument/completion', {
		textDocument: { uri: uriOf('main.pebble') },
		position: positionAt('main.pebble', offsetOf('main.pebble', 'p.x', 0) + 2),
	});
	const dotItems = Array.isArray(dot) ? dot : dot?.items ?? [];
	console.log(`  src/main.pebble, after \`p.\`: ${dotItems.map(i => `${i.label}: ${i.detail}`).join(', ')}`);
	check('completion after a dot lists the fields of the type', dotItems.length === 2 && dotItems.every(i => i.label === 'x' || i.label === 'y'));

	// ── syntax: what 0.6.0 accepts ──
	console.log('\n[diagnostics] src/modern.pebble (map literals, `case … is Some{} =>`, `+=`)');
	const modern = await open('modern.pebble');
	check('0.6.0 syntax type-checks clean', modern.length === 0, `${modern.length} diagnostic(s)`);
	for (const d of modern) console.log(`        ${d.code} ${d.message}`);
} catch (error) {
	failures++;
	console.error(`\nERROR: ${error?.stack ?? error}`);
	if (client.stderr.trim()) console.error(`--- server stderr ---\n${client.stderr}`);
} finally {
	client.close();
}

if (process.env.LSP_DEBUG) console.log('--- server stderr ---\n' + client.stderr);
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
	if (client.stderr.trim()) console.error(`--- server stderr ---\n${client.stderr}`);
	process.exit(1);
}
