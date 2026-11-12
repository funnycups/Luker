import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SWIFT_MANAGER = path.join(REPO_ROOT, 'ios-app', 'Luker', 'LukerRuntimeManager.swift');
const BUILD_IPA_SH = path.join(REPO_ROOT, 'ios-app', 'scripts', 'build-ios-ipa.sh');

describe('iOS zero-copy symlink runtime layout', () => {
    test('LukerRuntimeManager uses layout version 5, top-level symlinks, --preserve-symlinks-main, and --backupsPath', () => {
        const swift = fs.readFileSync(SWIFT_MANAGER, 'utf8');

        expect(swift).toContain('private static let runtimeLayoutVersion = "5"');
        expect(swift).toContain('"--preserve-symlinks"');
        expect(swift).toContain('"--preserve-symlinks-main"');
        expect(swift).toContain('"--backupsPath"');
        expect(swift).toContain('linkBundledNodeProject(');
        expect(swift).not.toContain('syncDirectoryContents(');
    });

    test('build-ios-ipa.sh stages nodejs-project via scripts/stage-mobile-runtime.mjs', () => {
        const script = fs.readFileSync(BUILD_IPA_SH, 'utf8');

        expect(script).toContain('scripts/stage-mobile-runtime.mjs');
        expect(script).not.toContain('rsync -a');
    });
});
