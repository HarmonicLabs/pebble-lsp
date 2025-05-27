# Contribute to Pebble LSP Development

Hey there beautiful soul!

If you got here is probably because you want to help building the awesome VS Code language extension for Pebble

Here you find some guidelines that will help you get the best the community has to offer when contributing.

> **_note:_** if you found something that doesn't convinces you or want to propose some new contribution guideline feel free to propose changes to this document in a pull request.

<a name="table_of_contents"></a>

## Table of contents

- [Code of Conduct](#code_of_conduct)
- [I just have a question 😅](#question)
- [Before you get started](#before_get_started)
    - [best practices](#best_practices)
    - [code style guide](#style_guide)
- [What can I do to contribute?](#what_can_i_contribute)
    - [Report Bugs](#report_bugs)
    - [Suggest Enhancements](#suggest_enhancements)
    - [Your First Code Contribution](#first_contribution)
    - [Pull Requests](#pull_requests)

<a name="code_of_conduct"></a>

## Code of Conduct

This project and everyone participating in it is governed by the [Pebble LSP Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to [harmonic.pool@protonmail.com](mailto:harmonic.pool@protonmail.com).

<a name="question"></a>

## I just have a question 😅

Consider to open an issue or propose a pull request only if you: 

- found a bug
- want to propose a new feature
- think something can be improved

<a name="before_get_started"></a>

## Before you get started

Before you start contributing to the Pebble LSP consider having a look at the [best practices](#best_practices) and the [code style guide](#style_guide) adopted in the Pebble LSP project

<a name="best_practices"></a>

### Best Practices

- **Test your changes**: Always test the extension in the VS Code Extension Development Host
- **Use TypeScript**: All code should be written in TypeScript with proper type annotations
- **Follow LSP specifications**: When implementing LSP features, follow the [Language Server Protocol specification](https://microsoft.github.io/language-server-protocol/)
- **Update syntax definitions**: When adding new Pebble language features, update the TextMate grammar accordingly
- **Documentation**: Update documentation when adding new features or changing existing behavior

<a name="style_guide"></a>

### Code Style Guide

- Use consistent indentation (2 spaces for TypeScript, 4 spaces for JSON)
- Follow existing naming conventions (camelCase for variables/functions, PascalCase for classes)
- Add JSDoc comments for public APIs
- Use meaningful variable and function names
- Keep functions focused and small
- Handle errors appropriately in the LSP server

<a name="what_can_i_contribute"></a>

## What can I do to contribute?

<a name="report_bugs"></a>

### Report Bugs

If you find a bug in the Pebble LSP extension:

1. Check if the issue already exists in the [issue tracker](../../issues)
2. If not, create a new issue with:
   - Clear description of the bug
   - Steps to reproduce
   - Expected vs actual behavior
   - VS Code version and OS information
   - Sample Pebble code that demonstrates the issue

<a name="suggest_enhancements"></a>

### Suggest Enhancements

We welcome suggestions for new features:

- **LSP Features**: Code completion, diagnostics, hover information, go-to-definition
- **Syntax Highlighting**: Improvements to the TextMate grammar
- **Code Snippets**: Useful Pebble code snippets
- **Editor Integration**: Better VS Code integration features

<a name="first_contribution"></a>

### Your First Code Contribution

Good first contributions include:

- Fixing typos in documentation
- Adding new code snippets
- Improving syntax highlighting for edge cases
- Adding tests for existing functionality
- Fixing small bugs

<a name="pull_requests"></a>

### Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Make your changes
4. Test thoroughly
5. Commit with clear messages
6. Push to your fork
7. Create a pull request with:
   - Clear title and description
   - Reference to any related issues
   - Screenshots for UI changes
   - Description of testing performed

Thank you for contributing to the Pebble LSP! 🚀