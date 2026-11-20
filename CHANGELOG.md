# Changelog

## 0.6.0

Pebble 0.6.0, and the editor features that its `check()` makes possible.

### Compiler

- `@harmoniclabs/pebble` **0.6.0** (from `^0.3.0`). `Compiler.check()` now answers for the
  text as it is while it is being written: it goes past errors, type-checking every file
  and statement the parser kept. A file with a parse error is checked too, and its
  symbols are still there for hover and go to definition.

### Language server

- **Go to definition** uses `CheckResult.symbols` (`symbolAt`, `definitionOf`): the name
  under the cursor is resolved through scopes and imports, so an imported function,
  constant or struct jumps to its declaration in the other file. The syntax tree is used
  only when the index has nothing to say.
- **Find all references** uses `SymbolIndex.references()`: every use of the declaration in
  every file the check compiled — an import and its uses count, an alias
  (`import { a as b }`) is a name of its own. The project's own check (its
  `pebble.config.json` `entry`) is consulted too, so references reach files that import
  this one.
- **Hover** shows the symbol's kind and type from the index (`function double:
  (int) => int`, `field x: int`, `// imported from src/lib.pebble`), and the type map is
  now read with `typeAt( file, offset )`: it knows the file of each entry, so a position is
  no longer answered with a type from an imported file at the same offset.
- **Completion** offers the names visible at the cursor (`SymbolIndex.visibleAt`),
  innermost first, with their types as detail; dot-completion reads the type map with
  `typeAt` too.
- **Project root**: `check()` runs with the directory of `pebble.config.json` (else the
  document's own) instead of the document's directory, so imports resolve as they do for
  the project.
- **Diagnostics** are filtered to the document that was checked: `check()` reports for
  every file it compiled, and another file's offsets mean nothing in this document's text.
- An imported file that changes re-checks the open documents that import it, so their
  diagnostics, types and symbols are not stale.
- The compiler's IO reads open documents (unsaved edits included) before the disk.

### Tests

- `npm test` — a headless LSP client (`server/test/lsp.test.mjs`) that spawns
  `node server/out/server.js --stdio` and drives initialize, `didOpen`, diagnostics, hover,
  definition, references and completion against the fixtures in
  `server/test/fixtures/project`. No VS Code, no `vscode` module.

### Known limitations

- `tree-sitter-pebble@0.3.0` (still the latest) does not parse map literals
  (`{ #01: 10 }`), `case … is Some{} =>`, or struct literals in return position
  (`return Point{ … }`). The compiler handles all of them; only the tree-sitter fallbacks
  (document highlight, signature help, rename, semantic tokens) are affected.
- Rename still matches names by text in the syntax tree, not through the symbol index.

## 0.3.0

- `@harmoniclabs/pebble` and `@harmoniclabs/tree-sitter-pebble` **0.3.0**.
