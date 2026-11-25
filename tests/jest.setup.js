import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// On dev machines the repo-root `config.yaml` exists (created by server.js
// first-run via `addMissingConfigValues`, then gitignored). On CI it does
// not — the workflow only checks out tracked files. Fall back to the
// committed `default/config.yaml` so `getConfig()` finds a valid file and
// doesn't `process.exit(1)` from every Jest worker on setup.
const localConfigPath = path.resolve(__dirname, '../config.yaml');
const defaultConfigPath = path.resolve(__dirname, '../default/config.yaml');
const configPath = fs.existsSync(localConfigPath) ? localConfigPath : defaultConfigPath;

if (!getConfigFilePath()) {
    setConfigFilePath(configPath);
    reloadConfigCache();
}

// Mirror what server.js sets so middleware that reads files under
// `globalThis.DATA_ROOT` (e.g. basicAuth's unauthorized.html lookup) does not
// blow up under jest.
//
// IMPORTANT: point DATA_ROOT at an out-of-tree scratch dir, NOT the repo's
// public/ folder. Several code paths under src/endpoints/{characters,
// tokenizers}.js and src/transformers.js create `${DATA_ROOT}/_cache/...`
// on module load or first cache lookup. Aiming DATA_ROOT at `public/` used
// to leak a runtime `public/_cache/` tree into the working directory
// during every jest run (untracked but visible in `git status`). Using a
// per-process scratch dir keeps the repo clean and matches server.js
// convention of DATA_ROOT being disjoint from the source tree. The
// scratch dir is also seeded with the small default assets those
// endpoints look for (currently just an empty structure — tests that
// need real seed data build their own dataRoot with startServer /
// makeEndpointHarness / makeTempFsEngineHarness).
// Bootstrap only. The harness setup replaces this path with a managed run
// directory before the test module evaluates and removes this bootstrap root.
if (!globalThis.DATA_ROOT) {
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-jest-bootstrap-'));
    globalThis.DATA_ROOT = scratchRoot;
}

// ---------------------------------------------------------------------------
// public/lib.js — the real module eagerly imports browser-only UMD bundles
// (notably @iconfu/svg-inject which calls document.createElement at load
// time). We don't stub document/window globally because some node libraries
// (e.g. @agnai/web-tokenizers) inspect their presence to pick a runtime
// branch. Instead we redirect `public/lib.js` through moduleNameMapper to
// the source bundle entry — see jest.config.json. That gives tests real
// lodash/Fuse/yaml/etc. without dragging the DOM-touching scripts in.
//
// Browser module globals (`Luker`, `st`, `SillyTavern`, `jQuery`, `$`) are
// intentionally NOT installed globally here. Tests that load browser modules
// declare their explicit dependencies via `tests/util/browser-module-context.js`
// (or `@jest-environment jsdom`) so missing capabilities stay observable.
// ---------------------------------------------------------------------------

