import { afterEach, describe, expect, test } from '@jest/globals';
import envPaths from 'env-paths';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandLineParser } from '../src/command-line.js';
import { getConfigFilePath, reloadConfigCache, setConfigFilePath } from '../src/util.js';

describe('CommandLineParser global directory defaults', () => {
    const tmpDirs = [];

    afterEach(() => {
        delete globalThis.FORCE_GLOBAL_MODE;
        for (const dir of tmpDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('getDefaultConfig(true) places all writable directories under the Luker app data path', () => {
        const parser = new CommandLineParser();
        const defaults = parser.getDefaultConfig(true);
        const lukerDataDir = envPaths('Luker', { suffix: '' }).data;

        expect(defaults.configPath).toBe(path.join(lukerDataDir, 'config.yaml'));
        expect(defaults.dataRoot).toBe(path.join(lukerDataDir, 'data'));
        expect(defaults.serverPluginsPath).toBe(path.join(lukerDataDir, 'plugins'));
        expect(defaults.backupsPath).toBe(path.join(lukerDataDir, 'backups'));
        expect(defaults.globalExtensionsPath).toBe(path.join(lukerDataDir, 'extensions', 'third-party'));
    });

    test('getDefaultConfig(false) keeps local relative defaults unchanged', () => {
        const parser = new CommandLineParser();
        const defaults = parser.getDefaultConfig(false);

        expect(defaults.configPath).toBe('./config.yaml');
        expect(defaults.dataRoot).toBe('./data');
        expect(defaults.serverPluginsPath).toBe('./plugins');
        expect(defaults.backupsPath).toBe('backups/');
        expect(defaults.globalExtensionsPath).toBe('./public/scripts/extensions/third-party');
    });

    test('global mode replaces stock relative config.yaml paths with Luker global paths while honoring explicit CLI overrides', () => {
        const prevConfigPath = getConfigFilePath();
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-cmdline-global-'));
        tmpDirs.push(tmp);

        const parser = new CommandLineParser();
        const fakeGlobalRoot = path.join(tmp, 'luker-global');
        const originalGetDefaultConfig = parser.getDefaultConfig.bind(parser);
        parser.getDefaultConfig = (isGlobal) => {
            if (!isGlobal) {
                return originalGetDefaultConfig(false);
            }
            return Object.freeze({
                ...originalGetDefaultConfig(true),
                configPath: path.join(fakeGlobalRoot, 'config.yaml'),
                dataRoot: path.join(fakeGlobalRoot, 'data'),
                serverPluginsPath: path.join(fakeGlobalRoot, 'plugins'),
                backupsPath: path.join(fakeGlobalRoot, 'backups'),
                globalExtensionsPath: path.join(fakeGlobalRoot, 'extensions', 'third-party'),
            });
        };

        try {
            const parsedDefault = parser.parse(['node', 'server.js', '--global']);
            expect(parsedDefault.configPath).toBe(path.join(fakeGlobalRoot, 'config.yaml'));
            expect(parsedDefault.dataRoot).toBe(path.join(fakeGlobalRoot, 'data'));
            expect(parsedDefault.serverPluginsPath).toBe(path.join(fakeGlobalRoot, 'plugins'));
            expect(parsedDefault.backupsPath).toBe(path.join(fakeGlobalRoot, 'backups'));
            expect(parsedDefault.globalExtensionsPath).toBe(path.join(fakeGlobalRoot, 'extensions', 'third-party'));

            const customPlugins = path.join(tmp, 'custom-plugins');
            const parsedOverride = parser.parse(['node', 'server.js', '--global', '--serverPluginsPath', customPlugins]);
            expect(parsedOverride.serverPluginsPath).toBe(customPlugins);
        } finally {
            if (prevConfigPath) {
                setConfigFilePath(prevConfigPath);
                reloadConfigCache();
            }
        }
    });
});
