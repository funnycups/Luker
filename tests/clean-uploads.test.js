// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { cleanUploads } from '../src/users.js';

describe('cleanUploads', () => {
    let dataRoot;
    let previousDataRoot;

    beforeEach(() => {
        previousDataRoot = globalThis.DATA_ROOT;
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-uploads-'));
        globalThis.DATA_ROOT = dataRoot;
    });

    afterEach(() => {
        globalThis.DATA_ROOT = previousDataRoot;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    test('removes flat upload files and restore session directories', () => {
        const uploads = path.join(dataRoot, '_uploads');
        fs.mkdirSync(path.join(uploads, 'restore-sessions', 'a'.repeat(32), 'chunks'), { recursive: true });
        fs.writeFileSync(path.join(uploads, 'flat.tmp'), 'x');
        fs.writeFileSync(path.join(uploads, 'restore-sessions', 'a'.repeat(32), 'chunks', '0.chunk'), 'y');

        cleanUploads();

        expect(fs.readdirSync(uploads)).toEqual([]);
    });
});
