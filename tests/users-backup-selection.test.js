// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import {
    getUserBackupTargets,
    normalizeUserBackupSelection,
} from '../src/users.js';

const EMPTY_SELECTION = {
    settings: false,
    settingsBackups: false,
    secrets: false,
    characters: false,
    chats: false,
    lorebooks: false,
    presets: false,
    assets: false,
    extensions: false,
    globalExtensions: false,
    vectors: false,
};

describe('backup selection: settings vs settingsBackups', () => {
    test('defaults preserve legacy behavior (both settings and its history are included)', () => {
        const defaults = normalizeUserBackupSelection(undefined);
        expect(defaults.settings).toBe(true);
        expect(defaults.settingsBackups).toBe(true);
    });

    test('settingsBackups:false keeps settings.json but excludes the backups/ directory', () => {
        const directories = {
            root: path.join(path.sep, 'data', 'alice'),
            backups: path.join(path.sep, 'data', 'alice', 'backups'),
        };
        const selection = normalizeUserBackupSelection({
            ...EMPTY_SELECTION,
            settings: true,
            settingsBackups: false,
        });
        const targets = getUserBackupTargets(directories, selection);

        expect(targets.files).toContain(path.join(directories.root, 'settings.json'));
        expect(targets.directories).not.toContain(directories.backups);
        expect(targets.directories).toHaveLength(0);
    });

    test('settingsBackups:true still includes the backups/ directory', () => {
        const directories = {
            root: path.join(path.sep, 'data', 'alice'),
            backups: path.join(path.sep, 'data', 'alice', 'backups'),
        };
        const selection = normalizeUserBackupSelection({
            ...EMPTY_SELECTION,
            settings: true,
            settingsBackups: true,
        });
        const targets = getUserBackupTargets(directories, selection);

        expect(targets.files).toContain(path.join(directories.root, 'settings.json'));
        expect(targets.directories).toContain(directories.backups);
    });
});
