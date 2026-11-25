// Stage the backend tree the packaged shell runs, so electron-builder only
// has to copy a single directory into the app's resources.
//
// The staged tree is `.staging/luker/` next to this script's package:
//   - the backend entry point and the assets git considers shippable,
//   - the full dependency tree,
//   - the pre-compiled frontend bundles under `_prebuilt-bundles/`, which the
//     server picks up through LUKER_PREBUILT_BUNDLES_DIR and then skips its
//     in-process compile entirely.
//
// `prepareBackend()` is exported for the build script; running this file
// directly stages the tree on its own.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const STAGING_BACKEND = path.resolve(SCRIPT_DIR, '..', '.staging', 'luker');
const BUNDLE_DIR = path.join(STAGING_BACKEND, '_prebuilt-bundles');

// The backend tree, as whole directories: entry point, frontend build config,
// manifest, and the source tree. The dependency tree is gitignored by design,
// so it ships as a directory. The server's config file is deliberately absent:
// the shell seeds the user's copy from `default/`, and the checkout's own
// config.yaml is local runtime state that must not ship.
const BACKEND_ENTRIES = [
    'server.js',
    'webpack.config.js',
    'package.json',
    'package-lock.json',
    'plugins.js',
    'src',
    'node_modules',
];

// `public/`, `default/` and `plugins/` mix the shipped application with
// per-install runtime state that .gitignore marks as local — settings,
// characters, chats, themes, user css, caches, installed server plugins and
// scaffold content. Copying the directories would put the build machine's
// state into every installer, so each staged subtree is exactly what git
// reports as shippable: the tracked files plus the checkout's
// new-but-not-ignored ones.
const GIT_DERIVED_ENTRIES = ['public', 'default', 'plugins'];
const SHIPPED_CHANGELOG_FILES = [
    'docs/changelog.md',
    'docs/zh-CN/changelog.md',
    'docs/zh-TW/changelog.md',
];

const BUNDLE_FILES = ['lib.core.bundle.js', 'lib.optional.bundle.js', 'codemirror.bundle.js'];

// Runtime state, other platforms' sources, and debug artifacts stay out of
// the top level of each copied entry. A directory with one of these names
// deeper inside a copied entry belongs to that entry and ships with it — the
// dependency tree carries runtime `data/` directories of its own.
const EXCLUDED_NAMES = new Set([
    '.git', '.github', 'backups', 'data', 'tests', 'docs',
    'android-app', 'harmony-app', 'desktop-app', '.DS_Store',
]);

function keep(entryPath, entryRoot) {
    const name = path.basename(entryPath);
    if (name.endsWith('.map')) return false;
    return !(path.dirname(entryPath) === entryRoot && EXCLUDED_NAMES.has(name));
}

function listShippableFiles(repoRoot, entry) {
    const result = spawnSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', entry],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.error) {
        throw new Error(`could not list the shippable files of ${entry}/: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`git ls-files failed for ${entry}/ (exit ${result.status}): ${String(result.stderr).trim()}`);
    }
    const files = result.stdout.split('\0').filter(Boolean);
    if (files.length === 0) {
        throw new Error(`git reports no shippable files under ${entry}/ in ${repoRoot}`);
    }
    return files;
}

function compileFrontendBundles() {
    const result = spawnSync(process.execPath, ['docker/build-lib.js'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
    });
    if (result.status !== 0) {
        throw new Error(`docker/build-lib.js exited with ${result.status ?? result.signal}`);
    }
}

export function copyBackendTree({ repoRoot = REPO_ROOT, staging = STAGING_BACKEND } = {}) {
    // Resolved first: an unusable checkout has to fail before anything is
    // written, not after a partial tree has been staged.
    const shippable = GIT_DERIVED_ENTRIES.map(entry => ({
        entry,
        files: listShippableFiles(repoRoot, entry),
    }));

    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    for (const entry of BACKEND_ENTRIES) {
        const source = path.join(repoRoot, entry);
        if (!fs.existsSync(source)) {
            throw new Error(`backend entry missing from the checkout: ${entry}`);
        }
        fs.cpSync(source, path.join(staging, entry), {
            recursive: true,
            dereference: true,
            filter: entryPath => keep(entryPath, source),
        });
    }

    for (const { files } of shippable) {
        for (const relative of files) {
            const destination = path.join(staging, relative);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(path.join(repoRoot, relative), destination);
        }
    }

    for (const relative of SHIPPED_CHANGELOG_FILES) {
        const source = path.join(repoRoot, relative);
        if (!fs.existsSync(source)) {
            throw new Error(`shipped changelog missing from the checkout: ${relative}`);
        }
        const destination = path.join(staging, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
    }
}

function findBundleOutput() {
    const webpackRoot = path.join(REPO_ROOT, 'dist', '_webpack');
    const candidates = fs.existsSync(webpackRoot)
        ? fs.readdirSync(webpackRoot).map(name => path.join(webpackRoot, name, 'output'))
        : [];
    const complete = candidates.find(dir => BUNDLE_FILES.every(file => fs.existsSync(path.join(dir, file))));
    if (!complete) {
        throw new Error(`no complete frontend bundle output under ${webpackRoot}; expected ${BUNDLE_FILES.join(', ')}`);
    }
    return complete;
}

function stageBundles() {
    const output = findBundleOutput();
    fs.mkdirSync(BUNDLE_DIR, { recursive: true });
    for (const file of BUNDLE_FILES) {
        fs.copyFileSync(path.join(output, file), path.join(BUNDLE_DIR, file));
    }
}

export async function prepareBackend() {
    compileFrontendBundles();
    copyBackendTree();
    stageBundles();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    await prepareBackend();
}
