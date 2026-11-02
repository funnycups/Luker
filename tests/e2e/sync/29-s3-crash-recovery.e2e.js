/* eslint-disable playwright/no-conditional-in-test, playwright/no-conditional-expect -- Crash boundaries have distinct pre-restart artifacts; a provider may retain a completed orphan. */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { s3Fixture, createReadyWorldBook } from '../_lib/sync-s3.js';
import { pair, manual, startManual, remoteHead, remotePacks, restart, assertLocal, pathsOf } from '../_lib/s3-races.js';
import { addWorldEntry } from '../_lib/ui-worldinfo.js';
import { readUserFile } from '../_lib/sync.js';
import { hasCompleteClosure } from '../../../src/sync/objects.js';

test.afterEach(async ({}, info) => {
    for (const error of info.errors) console.error(error.message);
});

const fixture = s3Fixture(test);
// Includes actual process startup, SIGKILL, startup recovery, real encryption
// and browser editing; the test budget is not a product network deadline.
test.describe.configure({ timeout: 300_000 });

const receiving = ['s3-download-after-first-chunk', 's3-pack-installed-before-index', 's3-indexed-before-ledger', 'reconcile-after-first-write'];
const sending = ['snapshot-before-commit', 'push-before-cas', 's3-upload-after-first-chunk'];
for (const point of [...receiving, ...sending]) {
    test(`actual SIGKILL at ${point} recovers the same root and complete typed closure`, async ({ browser }, testInfo) => {
        const arm = testInfo.outputPath('crash.arm');
        const env = { LUKER_SYNC_FAILPOINT: point, LUKER_SYNC_FAILPOINT_ARM: arm };
        const receives = receiving.includes(point);
        const { a, b, options } = await pair(fixture, browser, receives ? {} : env, receives ? env : {});
        await createReadyWorldBook(a.page, 'Crash Moonwell');
        await addWorldEntry(a.page, { key: 'keeper', content: 'The moonwell keeper survives an actual process kill.' });
        // Incompressible lore makes the encrypted pack exceed a filesystem /
        // HTTP chunk without any product size limit or fabricated pack.
        await addWorldEntry(a.page, { key: 'archive', content: randomBytes(128 * 1024).toString('base64') });
        await expect.poll(() => Object.values(JSON.parse(readUserFile(a.server, 'worlds/Crash Moonwell.json')).entries).some(entry => entry.content.length > 128 * 1024), { timeout: 30_000 }).toBe(true);
        if (receives) await manual(a);
        const victim = receives ? b : a;
        const before = await remoteHead(fixture, options, a);
        const packsBefore = await remotePacks(fixture, options);
        const orphaned = [];
        fs.writeFileSync(arm, '');
        await startManual(victim);
        await victim.server.waitForStderr(`luker-sync-failpoint: ${point}\n`);
        expect(await victim.server.kill()).toEqual({ code: null, signal: 'SIGKILL' });
        expect(fs.existsSync(arm)).toBe(false);
        expect(victim.server.output.match(/^luker-sync-failpoint: .*$/gm)).toEqual([`luker-sync-failpoint: ${point}`]);
        const localPaths = pathsOf(victim);
        const installed = fs.readdirSync(`${localPaths.gitDir}/objects/pack`);
        if (point === 's3-pack-installed-before-index') {
            expect(installed.some(name => name.endsWith('.pack'))).toBe(true);
        }
        if (point === 's3-indexed-before-ledger') {
            expect(installed.some(name => name.endsWith('.idx'))).toBe(true);
        }
        if (['s3-download-after-first-chunk', 's3-pack-installed-before-index', 's3-indexed-before-ledger'].includes(point)) {
            const ledger = JSON.parse(fs.readFileSync(`${localPaths.peerDir}/s3-packs.json`, 'utf8'));
            const newPacks = before.head.packs.filter(pack => !ledger.packs[pack.name]);
            expect(newPacks.length).toBeGreaterThan(0);
        }
        const afterKill = await remoteHead(fixture, options, a);
        expect(afterKill.envelope).toEqual(before.envelope);
        if (point === 'push-before-cas') {
            const orphans = await remotePacks(fixture, options);
            expect(orphans.length).toBeGreaterThan(packsBefore.length);
            expect(afterKill.head.packs).toEqual(before.head.packs);
            for (const orphan of orphans.filter(pack => !packsBefore.some(previous => previous.name === pack.name))) {
                expect(afterKill.head.packs.map(pack => pack.name)).not.toContain(orphan.name);
                orphaned.push(orphan);
            }
        }
        await restart(victim);
        await manual(a); await manual(b); await manual(a);
        const final = await remoteHead(fixture, options, a);
        expect(await remotePacks(fixture, options)).toEqual(expect.arrayContaining(orphaned));
        for (const device of [a, b]) {
            expect(readUserFile(device.server, 'worlds/Crash Moonwell.json')).toContain('survives an actual process kill');
            const local = await assertLocal(device);
            expect(local.oid).toBe(final.head.commit);
            // Only downloaded packs belong to this ledger. A publisher's
            // existing loose closure need not download its own earlier pack.
            if (device === b) expect(Object.keys(local.ledger.packs)).toEqual(expect.arrayContaining(before.head.packs.map(pack => pack.name)));
        }
    });
}

test('SIGKILL during forwarding-only partial original pack upload never publishes a partial object', async ({ browser }) => {
    const { a, b, proxyA, options } = await pair(fixture, browser);
    await createReadyWorldBook(a.page, 'Incomplete Archive');
    // Exceeds the normal 64KiB fs source chunk and HTTP high-water mark after
    // compression, guaranteeing a strictly partial observed first chunk.
    const archive = randomBytes(256 * 1024).toString('base64');
    await addWorldEntry(a.page, { key: 'archive', content: archive });
    const rel = 'worlds/Incomplete Archive.json';
    await expect.poll(() => {
        const file = readUserFile(a.server, rel);
        return file !== null && Object.values(JSON.parse(file).entries).some(entry => entry.content === archive);
    }, { timeout: 30_000 }).toBe(true);
    const savedArchive = readUserFile(a.server, rel);
    expect(savedArchive.length).toBeGreaterThan(256 * 1024);
    const before = await remoteHead(fixture, options, a);
    const gate = proxyA.addFault({ match: { method: 'PUT', keyPrefix: 'shared/packs/' }, hold: 'after-first-forwarded-body-chunk' });
    try {
        await startManual(a);
        const record = await gate.reached;
        expect(record.relativeKey).toMatch(/^shared\/packs\/[a-f0-9]{32}$/);
        const advertised = Number(record.headers['content-length']);
        expect(advertised).toBeGreaterThan(record.bytesObserved);
        expect(record.bytesObserved).toBeGreaterThan(0);
        expect(record.bytesForwarded).toBe(record.bytesObserved);
        expect(record.headers['if-none-match']).toBe('*');
        expect(record.upstreamStatus).toBeNull();
        expect(await a.server.kill('SIGKILL')).toEqual({ code: null, signal: 'SIGKILL' });
        expect(a.server.output).not.toContain('luker-sync-failpoint:');
        expect((await remoteHead(fixture, options, a)).envelope).toEqual(before.envelope);
        // Old committed closure remains intact even while the outgoing body
        // and its source process have been interrupted.
        const paths = pathsOf(a);
        expect(await hasCompleteClosure({ dir: paths.workdir, gitdir: paths.gitDir, oid: before.head.commit, verify: true })).toBe(true);
        gate.cancel();
        const objects = await remotePacks(fixture, options);
        const partial = objects.find(object => record.relativeKey.endsWith(object.name));
        if (partial) expect(partial.size).toBe(advertised);
        expect(before.head.packs.map(pack => pack.name)).not.toContain(record.relativeKey.split('/').at(-1));
        await restart(a);
        await manual(b); await manual(a);
        const final = await remoteHead(fixture, options, a);
        expect(final.head.packs.map(pack => pack.name)).not.toContain(record.relativeKey.split('/').at(-1));
        for (const device of [a, b]) {
            expect(readUserFile(device.server, rel)).toBe(savedArchive);
            const local = await assertLocal(device);
            expect(local.oid).toBe(final.head.commit);
            if (device === b) {
                expect(final.head.packs.length).toBeGreaterThan(0);
                for (const pack of final.head.packs) expect(local.ledger.packs[pack.name]).toMatchObject({ size: pack.size });
            }
        }
    } finally { gate.cancel(); }
});
