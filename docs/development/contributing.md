# Contributing Guide

Thank you for your interest in the Luker project! This document explains how to contribute code, documentation, and other improvements to Luker.

## Setting Up the Development Environment

1. **Fork the repository**: Fork the Luker repository to your own GitHub account.

2. **Clone locally**:

```bash
git clone https://github.com/<your-username>/Luker.git
cd Luker
```

3. **Install dependencies**:

```bash
npm install
```

4. **Start the development server**:

```bash
node server.js
```

By default it listens on `http://localhost:8000`. You can change the port via command-line arguments or `config.yaml`.

## Branching Strategy

- **`release`** — The stable branch, always kept in a releasable state. All PRs should target `release`.
- Create feature branches from `release` for new development.

```bash
git checkout -b feat/my-new-feature release
```

> [!IMPORTANT]
> Luker's stable branch is `release`.

Recommended branch naming conventions:

| Prefix | Purpose | Example |
|------|------|------|
| `feat/` | New feature | `feat/memory-graph-export` |
| `fix/` | Bug fix | `fix/chat-sync-race-condition` |
| `docs/` | Documentation improvement | `docs/extension-api-examples` |
| `refactor/` | Code refactoring | `refactor/preset-manager` |
| `chore/` | Build/toolchain | `chore/update-dependencies` |

## Commit Convention

Luker follows the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**Types:**

| Type | Description |
|------|------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation changes |
| `style` | Code formatting (no logic changes) |
| `refactor` | Refactoring (no new features or bug fixes) |
| `perf` | Performance optimization |
| `test` | Test-related changes |
| `chore` | Build/toolchain/dependency updates |

**Examples:**

```
feat(memory-graph): add hierarchical compression for event nodes

fix(search-tools): handle empty query in web search

docs(extension-api): add examples for registerExtensionApi
```

## Pull Request Workflow

1. **Ensure code quality**: Check code style and basic functionality before submitting.

2. **Push your branch**:

```bash
git push origin feat/my-new-feature
```

3. **Create a PR**: Open a Pull Request on GitHub targeting the `release` branch.

4. **PR description**: Clearly describe the changes, motivation, and impact. Reference any related Issues.

5. **Code review**: Maintainers will review the code and provide feedback. Please respond to review comments promptly.

6. **Merge**: Once the review is approved, maintainers will merge the PR.

## Code Style

### Basic Rules

- **Indentation**: 4 spaces
- **Quotes**: Single quotes (JavaScript)
- **Semicolons**: Required
- **Line endings**: LF (`\n`), do not use CRLF
- **End of file**: Keep one trailing newline

> [!IMPORTANT]
> All files must use LF line endings. Windows users should configure Git:
> ```bash
> git config core.autocrlf input
> ```
> Or ensure `* text=auto eol=lf` is set in `.gitattributes`.

### Naming Conventions

| Context | Style | Example |
|------|------|------|
| Variables and functions | `camelCase` | `loadSettings()` |
| Constants | `UPPER_SNAKE_CASE` | `DEFAULT_TIMEOUT` |
| CSS class names | `kebab-case` | `chat-message-container` |
| File names | `kebab-case` | `preset-manager.js` |

### Module System

- **Frontend code**: ES Modules (`import`/`export`)
- **Backend code**: ES Modules (`import`/`export`)

### Comments

- Key logic and public APIs should have JSDoc comments
- Complex algorithms or business logic should include inline comments explaining intent
- Avoid meaningless comments (e.g., `// increment counter` followed by `counter++`)

## Project Structure Overview

```
Luker/
├── server.js              # Server entry point
├── src/                   # Backend source code
│   ├── endpoints/         # API routes
│   └── middleware/        # Middleware
├── public/                # Frontend assets
│   ├── scripts/           # Frontend scripts
│   │   ├── extensions/    # Built-in extensions
│   │   │   └── third-party/  # Third-party plugins
│   │   └── ...            # Core modules
│   └── ...                # Static assets
├── docs/                  # Documentation
│   ├── zh-CN/             # Chinese documentation
│   ├── zh-TW/             # Traditional Chinese documentation
│   └── en/                # English documentation
└── config.yaml            # Server configuration
```

## Testing

- New features should include basic functional verification
- Bug fixes should describe reproduction steps and the fix approach
- Ensure changes do not break existing functionality
- Test across multiple browsers and devices (where applicable)

## Documentation Contributions

Documentation is located in the `docs/` directory and uses Markdown format:

- Chinese documentation: `docs/zh-CN/`
- Traditional Chinese documentation: `docs/zh-TW/`
- English documentation: `docs/en/` (if available)

Documentation contributions follow the same PR workflow described above. When writing documentation, please note:

- Use accurate technical terminology
- Keep code and API names in English
- Use code blocks and tables where appropriate
- Use `/zh-CN/`, `/zh-TW/`, or `/en/` prefixed paths for cross-references
- All files must use LF line endings

## Reporting Issues

If you find a bug or have a feature suggestion, please submit it via GitHub Issues. When filing an Issue, please include:

- Problem description
- Reproduction steps (if applicable)
- Expected behavior vs. actual behavior
- Environment information (OS, Node.js version, browser)

## Code of Conduct

Please respect all contributors and users. Maintain a friendly and professional tone in all communications.

## Related Pages

- [Frontend Plugin Development](/development/frontend-plugin) — Getting started with third-party plugin development
- [Extension API Reference](/development/extension-api) — Complete API documentation
- [Character Card Development](/development/card-developers) — Character Card extension features
