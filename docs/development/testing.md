# Testing Guide

Luker runs Jest and Playwright suites through a lightweight test harness under `tests/harness/`. The harness allocates temporary directories, server processes, and database schemas under explicit scopes so tests declare what they need and tear down cleanly.

## Running Test Profiles

All standard commands delegate to `tests/harness/run.js --profile <name>`:

```bash
# Unit suite (Jest unit project; no external database required)
npm run test:unit --prefix tests

# Serial Jest unit execution
npm run test:unit:serial --prefix tests

# Local storage engines (filesystem and SQLite)
npm run test:storage:local --prefix tests

# SQL storage engines (requires reachable MySQL and PostgreSQL)
npm run test:storage:sql --prefix tests

# Browser E2E and frontend suites
npm run test:e2e --prefix tests

# Regular coverage union (unit + storage:local + storage:sql + e2e)
npm test --prefix tests

# Desktop source and packaged suites
npm run test:e2e:desktop --prefix tests
npm run test:e2e:desktop:packaged --prefix tests

# Full suite union including desktop source and packaged apps
npm run test:all --prefix tests

# Real-data compatibility checks (requires an explicit read-only source directory)
npm run test:compatibility --prefix tests -- --input /absolute/path/to/data
```

### Selecting Files

Use `tests/harness/run.js` directly to list a profile or run specific files:

```bash
node tests/harness/run.js --profile unit --list
node tests/harness/run.js --profile unit --file tests/announcements.test.js
```

## Profiles and External Dependencies

| Profile | Framework | External Requirements |
|---------|-----------|-----------------------|
| `unit` | `jest` | None |
| `storage-local` | `jest` | Built `better-sqlite3` native addon |
| `storage-sql` | `jest` | Reachable MySQL (`LUKER_TEST_MYSQL_ROOT_URL`) and PostgreSQL (`LUKER_TEST_POSTGRES_URL`) |
| `e2e` | `playwright` | Playwright Chromium |
| `frontend` | `playwright` | Playwright Chromium |
| `desktop` | `playwright` | Electron runtime (`desktop-app/node_modules` or `LUKER_DESKTOP_ELECTRON_PATH`) |
| `desktop-packaged` | `playwright` | Built packaged artifact (`desktop-app/dist`, `LUKER_DESKTOP_ARTIFACT_DIR`, or `LUKER_DESKTOP_ARTIFACT_MANIFEST`) |
| `compatibility` | `playwright` | Playwright Chromium and explicit `--input <absolute-dir>` |

When a required database or packaged desktop artifact is missing, preflight fails immediately with a non-zero exit code instead of falling back.

## Writing Tests

- **Directories**: Allocate temporary directories via `scope.directory(label)` (Jest) or `resources.directory(label)` (Playwright). Read-only external inputs can be registered via `scope.borrowDirectory(absPath)`.
- **Application servers**: Start Luker via `startServer({ scope, batchKey, scenarioId, extraConfig, extraEnv })` from `tests/harness/server.js`.
- **Desktop shells**: Start Electron via `launchLukerDesktop` or `spawnLukerDesktop` from `tests/e2e/_lib/desktop.js`.
- **Network interception**: Hold and release HTTP requests/responses via `observeOperations({ page, scope, ... })` from `tests/harness/observations.js`.
- **Unit browser globals**: Use `createBrowserModuleContext` and `installBrowserModuleContext` from `tests/util/browser-module-context.js`.

## Static Checks

```bash
npm run lint
npm run lint:plugin-imports
npm run lint:i18n
```
