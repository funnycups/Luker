import { describe, expect, test } from '@jest/globals';

import { getVersion } from '../src/util.js';

describe('version info contract', () => {
    test('pkgVersion carries the SillyTavern version third-party code reads from /version', async () => {
        const version = await getVersion();

        // Upstream SillyTavern fills /version.pkgVersion with its own version,
        // and extensions such as JS-Slash-Runner expose that value as the tavern
        // version. A fork version here fails their version gates.
        expect(version.pkgVersion).toBe(version.stCompatVersion);
        expect(version.pkgVersion).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/);
    });

    test('the fork version stays available as lukerVersion', async () => {
        const version = await getVersion();

        expect(version.lukerVersion).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/);
        expect(version.agent).toBe(`Luker:${version.lukerVersion}:Cohee#1207`);
        expect(version.compatAgent).toBe(`Luker:${version.stCompatVersion}:Cohee#1207`);
    });
});
