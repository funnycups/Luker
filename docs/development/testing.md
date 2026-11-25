# Testing Guide

Luker runs Jest, Playwright, and `node --test` suites through a unified managed test harness under `tests/harness/`. The harness allocates directories, processes, database leases, desktop shells, and failure diagnostics under explicit scopes so tests declare what they need without writing ad-hoc cleanup code.

## Running Test Profiles

All standard commands delegate to `tests/harness/run.js --profile <name>`:

```bash
# Unit suite (Jest unit project + native harness suites; no external database required)
npm run test:unit --prefix tests

# Serial Jest unit execution without --forceExit
npm run test:unit:serial --prefix tests

# Local storage engines (filesystem and SQLite)
npm run test:storage:local --prefix tests

# SQL storage engines (requires reachable MySQL and PostgreSQL with real auth preflight)
npm run test:storage:sql --prefix tests

# Browser E2E and frontend suites
npm run test:e2e --prefix tests

# Regular coverage union (unit + storage:local + storage:sql + e2e)
npm test --prefix tests

# Desktop source and packaged suites
npm run test:e2e:desktop --prefix tests
npm run test:e2e:desktop:packaged --prefix tests

# Complete deterministic suite union including desktop source and packaged apps
npm run test:all --prefix tests

# Real-data compatibility checks (requires an explicit read-only source directory)
npm run test:compatibility --prefix tests -- --input /absolute/path/to/data
```

### Selecting Files, Listing, and Exporting Environments

Use `tests/harness/run.js` directly to list or filter files while preserving the profile's diagnostic slot:

```bash
# Inspect profile selection without allocating any runtime resources
node tests/harness/run.js --profile unit --list
node tests/harness/run.js --profile storage-sql --list --json

# Run specific files within a profile
node tests/harness/run.js --profile unit --file tests/browser-module-context.test.js

# Export the managed environment archive to a new absolute path
node tests/harness/run.js --profile unit --file tests/browser-module-context.test.js --export-environment /tmp/luker-env-export
```

Direct framework invocations (`jest`, `playwright test`, `node --test`) load the same managed adapters and produce the same resource ownership guarantees.

## Profiles and External Dependencies

| Profile | Frameworks | External Requirements |
|---------|------------|-----------------------|
| `unit` | `node`, `jest` | None for Jest & core harness; Chromium for browser/observation harness files |
| `storage-local` | `jest` | Built `better-sqlite3` native addon |
| `storage-sql` | `node`, `jest` | Reachable MySQL (`LUKER_TEST_MYSQL_ROOT_URL`) and PostgreSQL (`LUKER_TEST_POSTGRES_URL`) |
| `e2e` | `playwright` | Playwright Chromium |
| `frontend` | `playwright` | Playwright Chromium |
| `desktop` | `node`, `playwright` | Electron runtime (`desktop-app/node_modules` or `LUKER_DESKTOP_ELECTRON_PATH`) |
| `desktop-packaged` | `playwright` | Built packaged artifact (`desktop-app/dist` or `LUKER_DESKTOP_ARTIFACT_DIR` / `LUKER_DESKTOP_ARTIFACT_MANIFEST`) |
| `compatibility` | `playwright` | Playwright Chromium and explicit `--input <absolute-dir>` |

When a required database or packaged desktop artifact is missing, preflight fails immediately with a non-zero exit code instead of silently shrinking coverage or falling back to a source build.

## Writing Managed Tests

- **Directories**: Allocate temporary directories via `scope.directory(label)` (Node/Jest `testWithResources`) or `resources.directory(label)` (Playwright). Ordinary fixture reads and writes inside an owned directory inherit its ownership. External read-only inputs must be registered with `scope.borrowDirectory(absPath)`.
- **Application servers**: Start Luker via `startServer({ scope, batchKey, scenarioId, extraConfig, extraEnv })` from `tests/harness/server.js`.
- **Desktop shells**: Start Electron via `launchLukerDesktop({ scope, scenarioId, packaged, ... })` or `spawnLukerDesktop({ scope, defaultUserData, ... })` from `tests/e2e/_lib/desktop.js`. Auto-created `userData` survives `relaunch()` and is reclaimed on `close()` or scope disposal; explicitly borrowed directories are never deleted.
- **Browser operation observation**: Correlate invocations, CDP network/fetch requests, response holds, and final disk state via `observeOperations({ page, scope, ... })` from `tests/harness/observations.js`.
- **Unit browser globals**: Declare explicit module dependencies with `createBrowserModuleContext` and `installBrowserModuleContext` from `tests/util/browser-module-context.js` instead of installing recursive `Proxy` stubs.

## Ownership and Boundary Checks

Run the repository static boundary guards before committing:

```bash
npm run lint:plugin-imports
npm run lint:test-ownership
```

`lint:test-ownership` parses `tests/` with an AST analyzer to block new unregistered temp roots, raw `child_process` spawns, unmanaged database clients, `Proxy` stubs, and `--forceExit` scripts outside `tests/harness/`.
