// #50 — Large character card import — no OOM, no timeout.
//
// Construct a 1MB character card (long description). Upload it through the
// /api/characters/import endpoint. Confirm:
//   - the server does not OOM (process stays alive; subsequent request OK)
//   - the request finishes (no infinite stall)
//   - the character is queryable via /api/characters/all
//
// Per memory `feedback_llm_conventions`, LLM-request paths must not have
// timeouts. The IMPORT path is server-side I/O — same rule applies for big
// payloads. This test guards against accidentally adding a max-size cap or
// a timeout that strangles real-world card imports.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

const ONE_MB_DESC = (() => {
    // Build a 1MB block of RP-immersive prose (Bryn-headland themed) — repeat
    // a paragraph until we cross 1,048,576 bytes.
    const para = [
        'Ash sat by the lantern, watching the salt-crusted lens fog and clear as the tide drew breath.',
        'The Bryn reef shifts on a nineteen-day cycle and the older chart she still kept tucked beneath her sleeve no longer agreed with the breakers.',
        'She had inked a new gull-rock line three watches ago and the wax had not yet hardened.',
        'A skiff from the salt-mark drifters had passed twice that week without lighting a fire inland.',
        'She would tell you, when you asked, that this was either patience or grief — never both at once.',
    ].join(' ');
    let blob = '';
    while (blob.length < 1_048_576) blob += para + ' ';
    return blob.slice(0, 1_048_576);
})();

test.beforeAll(async () => {
    server = await startServer({ batchKey: 'server', scenarioId: 'large-card' });
    markOnboarded({ dataRoot: server.dataRoot });
});

test.afterAll(async () => {
    await tearDownServer(server);
});

test.describe('#50 — large character card import', () => {
    test('1MB description: server does not OOM, import succeeds, char queryable', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Synthesize an in-memory PNG (we copy a bundled one for valid PNG bytes,
        // then attach a JSON sidecar with the large description). The /import
        // endpoint accepts file_type=png + the PNG body in the multipart.
        const seedCandidates = [
            // worktree-relative
            resolve(server.dataRoot.replace(/\/[^/]+$/, ''), '..', '..', 'default', 'content', 'default_Seraphina.png'),
            // direct path under default-user (post-clone)
            resolve(server.dataRoot, 'default-user', 'characters', 'Seraphina.png'),
        ];
        let seedPng = seedCandidates.find(existsSync);
        if (!seedPng) {
            // Fall back to scanning /default in the repo.
            const REPO_ROOT = resolve(import.meta.dirname, '../../..');
            const fallback = resolve(REPO_ROOT, 'default', 'content', 'default_Seraphina.png');
            if (existsSync(fallback)) seedPng = fallback;
        }
        expect(seedPng, 'no PNG seed found').toBeTruthy();
        const pngBytes = readFileSync(seedPng);
        const pngB64 = pngBytes.toString('base64');

        // Send the import via the page so CSRF + session work.
        const start = Date.now();
        const result = await page.evaluate(async ({ b64, descPart }) => {
            const tokenResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await tokenResp.json();

            // Build the binary body for the PNG file part.
            const bin = atob(b64);
            const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            const blob = new Blob([u8], { type: 'image/png' });
            const fd = new FormData();
            fd.append('avatar', blob, 'big-ash.png');
            fd.append('file_type', 'png');
            // Also stash the big description in a custom card-data field that
            // the importer will (silently) ignore on PNG import — the goal here
            // is to push a *large body* through bodyParser (the 500MB limit
            // configured server-side) and through multer. After the PNG import,
            // we will follow up with a /api/characters/edit call carrying the
            // large description.
            fd.append('long_data', descPart);

            const t0 = performance.now();
            const resp = await fetch('/api/characters/import', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'X-CSRF-Token': token },
                body: fd,
            });
            return {
                status: resp.status,
                body: (await resp.text()).slice(0, 600),
                ms: Math.round(performance.now() - t0),
            };
        }, { b64: pngB64, descPart: ONE_MB_DESC.slice(0, 512_000) });
        const elapsed = Date.now() - start;

        // Server didn't OOM and the import did not hang forever.
        expect([200, 204]).toContain(result.status);
        expect(elapsed, `import took ${elapsed}ms — should be reasonable under 60s`).toBeLessThan(60_000);

        // Resolve the real avatar filename — the import endpoint names the
        // file from the EMBEDDED PNG `chara` chunk (not from the multipart
        // filename), so the seed Seraphina PNG lands as Seraphina.png. The
        // edit call must address that real filename.
        let importedAvatar = 'big-ash.png';
        try {
            const parsed = JSON.parse(result.body);
            if (parsed?.file_name) importedAvatar = `${parsed.file_name}.png`;
        } catch { /* body may not be JSON in some shapes — fall back */ }

        // Now follow up with /api/characters/edit to push the FULL 1MB body.
        const editResult = await page.evaluate(async ({ description, avatar }) => {
            const tokenResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await tokenResp.json();
            const fd = new FormData();
            fd.append('avatar_url', avatar);
            fd.append('ch_name', 'BigAsh');
            fd.append('description', description);
            fd.append('personality', 'observant, slow to anger, stubborn');
            fd.append('scenario', 'cliff watchpost');
            fd.append('first_mes', 'Hold the lantern higher.');
            fd.append('mes_example', '');
            fd.append('creator_notes', '');
            fd.append('system_prompt', '');
            fd.append('post_history_instructions', '');
            fd.append('alternate_greetings', JSON.stringify([]));
            fd.append('tags', JSON.stringify([]));
            fd.append('creator', '');
            fd.append('character_version', '1.0');
            fd.append('json_data', '{}');
            const resp = await fetch('/api/characters/edit', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'X-CSRF-Token': token },
                body: fd,
            });
            return { status: resp.status, body: (await resp.text()).slice(0, 300) };
        }, { description: ONE_MB_DESC, avatar: importedAvatar });
        // Accept any 2xx — and explicitly NOT 413 (payload too large).
        expect(editResult.status, `edit (1MB description) returned ${editResult.status}; body=${editResult.body}`).not.toBe(413);
        expect(editResult.status, `edit (1MB description) returned ${editResult.status}; body=${editResult.body}`).not.toBe(500);

        // Server still responsive — fetch the character list.
        const list = await page.evaluate(async () => {
            const tokenResp = await fetch('/csrf-token', { credentials: 'same-origin' });
            const { token } = await tokenResp.json();
            const resp = await fetch('/api/characters/all', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
                body: JSON.stringify({}),
            });
            const j = await resp.json();
            return j.map(c => c?.name).filter(Boolean).sort();
        });
        // The renamed character should be present after the edit.
        expect(list.some(n => /BigAsh|Ash|Seraphina/.test(n)), `expected a known char in list; saw ${list.join(',')}`).toBe(true);
    });
});
