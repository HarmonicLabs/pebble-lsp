# Pebble LSP

A VS Code Language Server Protocol (LSP) extension for the Pebble programming language, providing comprehensive language support including syntax highlighting, diagnostics, and intelligent code features.

## Features

### ✅ Implemented Features

#### Language Support

- **Syntax Highlighting**: Complete TextMate grammar for Pebble language syntax
- **Language Configuration**: Proper bracket matching, auto-closing pairs, and comment support
- **File Association**: Automatic detection of `.pebble` files

#### LSP Features

- **Diagnostics**: Real-time error reporting and syntax validation
  - Compilation errors with detailed messages
  - Error ranges and positions
  - Related information and emit stack traces

- **Document Highlighting**: Highlights related code elements when cursor is positioned on:
  - Function declarations and their body statements
  - Control flow statements (if, for, while, etc.)
  - Assert and fail statements
  - All statement types within function bodies

- **Hover Information**: Contextual information when hovering over:
  - If statements
  - Variable declarations  
  - Loop statements (for, for-of, while)
  - Control flow (return, break, continue)
  - Block statements
  - Assert and fail statements
  - Test statements
  - Match statements
  - Import/export statements
  - Function and struct declarations
  - All other Pebble statement types

- **Code Completion**: Coming soon
- **Go to Definition**: Coming soon

### 📋 Supported Statement Types

The LSP recognizes and provides features for all Pebble statement types:
- Import/Export statements (`import`, `export`, `export *`)
- Variable declarations (`var`)
- Control flow (`if`, `for`, `for-of`, `while`, `return`, `break`, `continue`)
- Function and struct declarations
- Block statements
- Test and assertion statements (`test`, `assert`, `fail`)
- Match statements
- Expression statements
- Using statements
- Type implementation statements

### ⚙️ Language Configuration

- **Comments**: Line comments (`//`) and block comments (`/* */`)
- **Brackets**: Auto-matching for `{}`, `[]`, `()`, and `${}`
- **Auto-closing Pairs**: Automatic closing of brackets, quotes, and template literals
- **Auto-surrounding Pairs**: Smart surrounding of selected text
- **Folding**: Code folding support for blocks and comments

## Running the extension

1. Run the command: `npm install`
2. Go to "Run and Debug" in VS Code and press "play" on the job "Launch Extension"
3. A new window will open and you should open the folder with the examples and select on .pebble file from there

## Architecture

The extension consists of two main components:

### Client (`client/src/extension.ts`)
- VS Code extension entry point
- Manages the Language Server Protocol client
- Handles activation/deactivation lifecycle
- Configures document selectors for `.pebble` files

### Server (`server/src/server.ts`)
- LSP server implementation using `@harmoniclabs/pebble` compiler
- Provides real-time diagnostics through AST compilation
- Implements hover, highlighting, and completion features
- Handles all LSP protocol communications

## Development

### Running the extension

1. Run the command: `npm install`
2. Go to "Run and Debug" in VS Code and press "play" on the job "Launch Extension"
3. A new window will open and you should open the folder with the examples and select on .pebble file from there