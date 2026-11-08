import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Every supported way of preparing a checkout for `node server.js`. The Docker
// image installs with `npm ci`; the launchers install with `npm install`.
const INSTALLERS = [
    'Dockerfile',
    'start.sh',
    'Start.bat',
    'UpdateAndStart.bat',
    'UpdateForkAndStart.bat',
];

function read(relativePath) {
    return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

test('the root manifest approves the sqlite native install script', () => {
    const manifest = JSON.parse(read('package.json'));

    // npm 12 blocks dependency install scripts unless the root package allows
    // them. A name-only entry keeps the approval across version bumps; the
    // lockfile still pins the version that actually runs.
    expect(manifest.allowScripts?.['better-sqlite3']).toBe(true);
    expect(manifest.scripts['storage:install-sqlite'])
        .toBe('npm rebuild better-sqlite3 --ignore-scripts=false');
});

test.each(INSTALLERS)('%s builds the sqlite native binding after installing packages', (installer) => {
    const source = read(installer);
    const installCommand = installer === 'Dockerfile' ? 'npm ci' : 'npm install';
    const installAt = source.indexOf(installCommand);
    const rebuildAt = source.indexOf('npm run storage:install-sqlite');

    expect(installAt).toBeGreaterThanOrEqual(0);
    expect(rebuildAt).toBeGreaterThan(installAt);
});

test.each(INSTALLERS)('%s keeps dependency install scripts disabled', (installer) => {
    expect(read(installer)).toMatch(/npm (ci|install)[^\n]*--ignore-scripts/);
});

test('the Docker image fails the build when the sqlite binding cannot load', () => {
    const dockerfile = read('Dockerfile');
    const rebuildAt = dockerfile.indexOf('npm run storage:install-sqlite');
    const smokeAt = dockerfile.indexOf("import Database from 'better-sqlite3'");

    expect(rebuildAt).toBeGreaterThanOrEqual(0);
    expect(smokeAt).toBeGreaterThan(rebuildAt);
});
