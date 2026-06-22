// #84 — iter-studio v2 session auto-migrates on first read and remains usable.
//
// REAL USER-GESTURE flow (with one fixture-planting step, since v2 sessions
// can only be produced by running pre-migration code):
//   1. Boot server, write Default preset with a known temperature (1.0).
//   2. Plant a v1-shape CPA session sidecar on disk with currentSessionId set
//      to the legacy id and one v1-shape edit on the assistant message
//      (oldValue/newValue, no `target` field). The session lacks the v3
//      sentinel `version: 3` — so CPA's load() will route it through
//      migrateToV3 on first read.
//   3. Load the page, select Default, open the CPA studio. The studio's
//      initSession calls sessionStore.load(currentSessionId), which triggers
//      lazy migration: the legacy session is rewritten in place on disk
//      with `target: {type:'preset'}` and an RFC-6902 `inverse` patch.
//   4. Close the studio and inspect the sidecar on disk — it must now be
//      v3-shape (top-level `version: 3`, edits in patch form).

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writePreset } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';
import { openIterStudio, closeIterStudio } from '../_lib/ui-iter-studio.js';
import { selectPresetByName, normalizeIterStudioSettings } from '../preset/_helpers.js';

let server;

const CPA_SIDECAR_PATH_SEGMENTS = ['default-user', 'OpenAI Settings', 'Default.luker-state.completion_preset_assistant_session.json'];

function cpaSidecarPath(dataRoot) {
    return resolve(dataRoot, ...CPA_SIDECAR_PATH_SEGMENTS);
}

function plantLegacySidecar(dataRoot) {
    // v1-shape session: top-level lacks `version:3`, edits use oldValue+newValue
    // and have no `target` field. Migration must stamp { type: 'preset' } as
    // the default target and produce an RFC-6902 inverse patch.
    const sidecar = {
        version: 1,
        currentSessionId: 'legacy-s1',
        sessions: [
            {
                id: 'legacy-s1',
                title: 'Migrated legacy session',
                createdAt: 1700000000000,
                updatedAt: 1700000001000,
                summary: '',
                surfaceState: { sessionMode: 'general' },
                messages: [
                    {
                        id: 'cpa_msg_user',
                        role: 'user',
                        content: 'Tighten the focus.',
                        at: 1700000000000,
                    },
                    {
                        id: 'cpa_msg_assistant',
                        role: 'assistant',
                        content: 'Lowered temperature from 1.0 to 0.5 for a steadier voice.',
                        at: 1700000000500,
                        toolCalls: [{
                            id: 'tc1',
                            name: 'preset_set_field',
                            arguments: { path: 'temperature', value_json: '0.5' },
                        }],
                        edits: [{
                            op: 'set',
                            path: '',
                            oldValue: { temperature: 1.0 },
                            newValue: { temperature: 0.5 },
                        }],
                        appliedAt: 1700000001000,
                        appliedTarget: 'preset',
                        rolledBackAt: null,
                    },
                ],
            },
        ],
    };
    writeFileSync(cpaSidecarPath(dataRoot), JSON.stringify(sidecar, null, 4));
}

test.describe('#84 — iter-studio v2 session auto-migrates to v3 on first read', () => {
    test.beforeAll(async () => {
        server = await startServer({
            batchKey: 'iterstudio',
            scenarioId: '84-migration-from-v2',
            extraConfig: { 'storage.mode': 'fs' },
        });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: 'http://127.0.0.1:65535' });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: 'http://127.0.0.1:65535' });
        normalizeIterStudioSettings(server.dataRoot);
        writePreset({ dataRoot: server.dataRoot, name: 'Default', overrides: { temperature: 1.0 } });
        plantLegacySidecar(server.dataRoot);
    });

    test.afterAll(async () => {
        await tearDownServer(server);
    });

    test('opening CPA studio with a legacy currentSessionId rewrites the sidecar to v3', async ({ page }) => {
        // Verify the planted sidecar starts in legacy shape.
        const beforePath = cpaSidecarPath(server.dataRoot);
        const before = JSON.parse(readFileSync(beforePath, 'utf8'));
        expect(before.sessions[0].version).toBeUndefined();
        expect(before.sessions[0].messages[1].edits[0]).toHaveProperty('oldValue');
        expect(before.sessions[0].messages[1].edits[0]).toHaveProperty('newValue');

        await awaitMainUI(page, server.baseURL);
        await selectPresetByName(page, 'Default');
        // Opening the studio triggers initSession -> sessionStore.load() ->
        // migrateToV3 -> in-place write. We do NOT need to send any prompt:
        // the load is what flips the on-disk shape.
        await openIterStudio(page, 'cpa');
        // Give the migration write a beat to settle on disk before we read.
        await expect.poll(async () => {
            const parsed = JSON.parse(readFileSync(beforePath, 'utf8'));
            return parsed.sessions[0].version;
        }, { timeout: 10_000 }).toBe(3);
        await closeIterStudio(page);

        const after = JSON.parse(readFileSync(beforePath, 'utf8'));
        const session = after.sessions[0];
        expect(session.version).toBe(3);
        const migratedEdit = session.messages[1].edits[0];
        expect(migratedEdit).not.toHaveProperty('oldValue');
        expect(migratedEdit).not.toHaveProperty('newValue');
        expect(migratedEdit.target).toEqual({ type: 'preset' });
        expect(Array.isArray(migratedEdit.inverse)).toBe(true);
        expect(migratedEdit.inverse.length).toBeGreaterThan(0);
    });
});
