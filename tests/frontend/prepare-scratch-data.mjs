// Build the scratch data root used by the `frontend` integration project.
//
// This runs as part of the Playwright webServer command, i.e. exactly once per
// test run, immediately before the server boots. It deliberately does NOT run
// at config-evaluation time: Playwright evaluates the config file in two
// processes (the runner and the loader), and a wipe from the second evaluation
// would delete the webpack bundles the first server boot had already compiled
// into this data root — leaving the browser unable to import lib.js.
//
// Steps:
//   1. Clone the repository seed `data/` (APFS copy-on-write when available).
//   2. Copy the repo `config.yaml` with storage `mode` forced to `fs`, so the
//      integration server never talks to the developer's configured storage
//      backend.

import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SCRATCH_ROOT = resolve(REPO_ROOT, 'tests/.frontend-scratch');
const SCRATCH_DATA = resolve(SCRATCH_ROOT, 'data');
const SCRATCH_CONFIG = resolve(SCRATCH_ROOT, 'config.yaml');
const SEED_DATA = resolve(REPO_ROOT, 'data');
const SEED_CONFIG = resolve(REPO_ROOT, 'config.yaml');

mkdirSync(SCRATCH_ROOT, { recursive: true });
if (existsSync(SCRATCH_DATA)) {
    rmSync(SCRATCH_DATA, { recursive: true, force: true });
}
try {
    execSync(`cp -c -R "${SEED_DATA}" "${SCRATCH_DATA}"`, { stdio: 'ignore' });
} catch {
    execSync(`cp -R "${SEED_DATA}" "${SCRATCH_DATA}"`, { stdio: 'ignore' });
}

const raw = readFileSync(SEED_CONFIG, 'utf8');
writeFileSync(SCRATCH_CONFIG, raw.replace(/^(\s+mode\s*):\s*[^\n]*$/m, '$1: fs'), 'utf8');
