import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyBackendTree } from '../../desktop-app/scripts/prepare-backend.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESKTOP_PACKAGE = path.join(REPO_ROOT, 'desktop-app', 'package.json');
const ICON = path.join(REPO_ROOT, 'desktop-app', 'build', 'icon.png');
const SOURCE_LOGO = path.join(REPO_ROOT, 'public', 'img', 'logo.png');

function readBuild() {
    return JSON.parse(fs.readFileSync(DESKTOP_PACKAGE, 'utf8')).build;
}

// electron-builder accepts a target list whose entries are either a bare
// platform target name or an object carrying the name in `target`. Flatten
// both shapes so the assertions below don't care which one the config uses.
function targetNames(targets) {
    return (targets ?? []).map(entry => (typeof entry === 'string' ? entry : entry?.target)).filter(Boolean);
}

// The icon is fed to the packager, which needs a square 512x512 source image.
// Read the IHDR block directly — a PNG's width and height are the two
// big-endian uint32s at offsets 16 and 20.
function pngSize(file) {
    const header = fs.readFileSync(file).subarray(0, 24);
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

test('the artifact name carries the version, platform and architecture', () => {
    expect(readBuild().artifactName).toBe('Luker-${version}-${os}-${arch}.${ext}');
});

test('the bundle identifies itself as Luker', () => {
    const build = readBuild();
    expect(build.appId).toBe('com.luker.desktop');
    expect(build.productName).toBe('Luker');
});

test('both platforms ship an installer and a zip', () => {
    const build = readBuild();
    expect(targetNames(build.mac?.target)).toEqual(expect.arrayContaining(['dmg', 'zip']));
    expect(targetNames(build.win?.target)).toEqual(expect.arrayContaining(['nsis', 'zip']));
});

test('the mac build is ad-hoc signed', () => {
    expect(readBuild().mac?.identity).toBe('-');
});

test('the backend tree is shipped as an extra resource', () => {
    const extraResources = readBuild().extraResources ?? [];
    expect(extraResources.some(entry => entry?.to === 'luker')).toBe(true);
});

test('the packaged icon is the source logo at 512x512', () => {
    expect(fs.readFileSync(ICON).equals(fs.readFileSync(SOURCE_LOGO))).toBe(true);
    expect(pngSize(ICON)).toEqual({ width: 512, height: 512 });
});

// A checkout that satisfies the staging entry list, holding one shippable file
// under each git-derived entry and one that .gitignore marks as local runtime
// state. A real server run leaves the latter behind, so it is what a leaked
// staging pass would pick up.
function makeCheckout() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-staging-'));
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'public'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'default', 'scaffold'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'docs', 'zh-CN'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'docs', 'zh-TW'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'docs', 'guide'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'docs', 'public'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'docs', '.vitepress', 'cache'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'docs', 'superpowers'), { recursive: true });
    for (const entry of ['server.js', 'webpack.config.js', 'package.json', 'package-lock.json', 'plugins.js']) {
        fs.writeFileSync(path.join(repo, entry), '');
    }
    for (const entry of ['src', 'node_modules']) {
        fs.mkdirSync(path.join(repo, entry), { recursive: true });
    }
    fs.writeFileSync(path.join(repo, 'public', 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(repo, 'public', 'settings.json'), '{"local":true}');
    fs.writeFileSync(path.join(repo, 'default', 'config.yaml'), 'port: 8000\n');
    fs.writeFileSync(path.join(repo, 'default', 'scaffold', 'local.md'), '# local\n');
    fs.writeFileSync(path.join(repo, 'plugins', 'package.json'), '{}');
    fs.writeFileSync(path.join(repo, 'plugins', 'local.js'), 'export default {};\n');
    fs.writeFileSync(path.join(repo, 'docs', 'changelog.md'), '# Changelog\n');
    fs.writeFileSync(path.join(repo, 'docs', 'zh-CN', 'changelog.md'), '# Changelog\n');
    fs.writeFileSync(path.join(repo, 'docs', 'zh-TW', 'changelog.md'), '# Changelog\n');
    fs.writeFileSync(path.join(repo, 'docs', 'guide', 'getting-started.md'), '# Guide\n');
    fs.writeFileSync(path.join(repo, 'docs', 'public', 'shot.png'), 'png');
    fs.writeFileSync(path.join(repo, 'docs', '.vitepress', 'config.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(repo, 'docs', '.vitepress', 'cache', 'temp.md'), '# temp\n');
    fs.writeFileSync(path.join(repo, 'docs', 'superpowers', 'draft.md'), '# draft\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), [
        'public/settings.json',
        '/plugins/*',
        '!/plugins/package.json',
        '/default/scaffold/*',
        '',
    ].join('\n'));
    return { root, repo, staging: path.join(root, 'staging') };
}

test('staging ships the tracked trees and none of the gitignored state in them', () => {
    const { root, repo, staging } = makeCheckout();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', 'public/index.html', 'default/config.yaml', 'plugins/package.json', '.gitignore'], { cwd: repo });

    copyBackendTree({ repoRoot: repo, staging });

    expect(fs.existsSync(path.join(staging, 'public', 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'public', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(staging, 'default', 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'default', 'scaffold', 'local.md'))).toBe(false);
    expect(fs.existsSync(path.join(staging, 'plugins', 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'plugins', 'local.js'))).toBe(false);
    expect(fs.existsSync(path.join(staging, 'docs', 'changelog.md'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'docs', 'zh-CN', 'changelog.md'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'docs', 'zh-TW', 'changelog.md'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'docs', 'guide', 'getting-started.md'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'docs', 'public', 'shot.png'))).toBe(false);
    expect(fs.existsSync(path.join(staging, 'docs', '.vitepress', 'config.ts'))).toBe(false);
    expect(fs.existsSync(path.join(staging, 'docs', '.vitepress', 'cache', 'temp.md'))).toBe(false);
    expect(fs.existsSync(path.join(staging, 'docs', 'superpowers', 'draft.md'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
});

test('.dockerignore whitelists shippable docs markdown after *.md and excludes non-runtime docs dirs', () => {
    const lines = fs.readFileSync(path.join(REPO_ROOT, '.dockerignore'), 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim());
    const wildcardIdx = lines.indexOf('*.md');
    expect(wildcardIdx).toBeGreaterThan(-1);
    const topMdIdx = lines.indexOf('!/docs/*.md');
    const nestedMdIdx = lines.indexOf('!/docs/**/*.md');
    expect(topMdIdx).toBeGreaterThan(wildcardIdx);
    expect(nestedMdIdx).toBeGreaterThan(wildcardIdx);
    const lastAllowIdx = Math.max(topMdIdx, nestedMdIdx);
    for (const excluded of ['/docs/public', '/docs/.vitepress', '/docs/node_modules', '/docs/dist', '/docs/cache', '/docs/superpowers']) {
        expect(lines.indexOf(excluded)).toBeGreaterThan(lastAllowIdx);
    }
});

test('staging keeps a nested directory whose name is excluded at the top level', () => {
    const { root, repo, staging } = makeCheckout();
    fs.mkdirSync(path.join(repo, 'node_modules', 'fakepkg', 'data'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'fakepkg', 'data', 'x.js'), 'module.exports = 1;');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', 'public/index.html', '.gitignore'], { cwd: repo });

    copyBackendTree({ repoRoot: repo, staging });

    expect(fs.existsSync(path.join(staging, 'node_modules', 'fakepkg', 'data', 'x.js'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('staging fails instead of shipping everything when it cannot list public', () => {
    // Same checkout, never initialised as a repository: the shippable set is
    // undeterminable, so the build has to stop rather than fall back to a
    // whole-directory copy.
    const { root, repo, staging } = makeCheckout();

    expect(() => copyBackendTree({ repoRoot: repo, staging })).toThrow(/public\//);
    fs.rmSync(root, { recursive: true, force: true });
});
