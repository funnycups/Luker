// #15 — Import a PNG character card with embedded world book / skills /
// preset metadata, verify it lands on disk, persists across restart.
//
// Strategy: build a v2 PNG card in memory (re-embedding the bundled
// Seraphina PNG with our own metadata via `src/character-card-parser.js`
// `write()`), POST it through `/api/characters/import`, then verify
//
//   1. The character appears in `ctx.characters` after refresh.
//   2. The `data.character_book` field round-trips into the saved card.
//   3. `extensions.luker.embedded_skills_source` round-trips (this is the
//      payload the import dialog would consume; we assert the field is
//      present on the saved card — full skill materialization is covered
//      by tests/skills-ui/playwright/character-export-with-skills.spec.js).
//   4. After `server.restart()`, all of the above still resolve via the
//      `/api/characters/all` endpoint.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, listCharacters } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { write as writePngCard } from '../../../src/character-card-parser.js';

let server, mock;

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const EMBEDDED_CARD = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    name: 'Briallen the Lighthouse Keeper',
    description: 'A weathered keeper of the eastern light, raised on the rocks beyond the reef. She knows every tide and every name carved into the lantern base.',
    personality: 'Patient. Sees patterns. Suspicious of unfamiliar lights at sea but never of unfamiliar people on her dock.',
    scenario: 'You climb the spiral stair as Briallen trims the wick. Outside, the reef is restless and the wind smells of brine.',
    first_mes: '*Briallen does not turn from the lantern.* "Close the hatch. The wick is fickle and the night is long. Tell me what brought you up the stair."',
    mes_example: '',
    creator_notes: 'e2e fixture — import-png',
    system_prompt: 'You are Briallen. Stay in scene. Reply with one to three paragraphs.',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: ['rp', 'fixture'],
    creator: 'luker-e2e',
    character_version: '1.0',
    extensions: {
        depth_prompt: { prompt: '', depth: 4, role: 'system' },
        // Luker-only payload — embedded skills source (the format the
        // import-dialog discovers and offers to install).
        luker: {
            embedded_skills_source: {
                version: 1,
                items: [
                    {
                        bundleFormat: 'inline-files-v1',
                        name: 'lighthouse-protocol',
                        files: [
                            {
                                path: 'SKILL.md',
                                encoding: 'utf8',
                                content: [
                                    '---',
                                    'name: lighthouse-protocol',
                                    'description: "Protocol for trimming the eastern light"',
                                    '---',
                                    '',
                                    'Body anchor: import-png embedded skill v1.',
                                ].join('\n'),
                            },
                        ],
                    },
                ],
            },
        },
    },
    // Embedded world book — the import-embedded-book dialog will surface this.
    character_book: {
        name: 'briallen-tides',
        entries: [
            {
                keys: ['eastern light', 'lantern'],
                content: 'The eastern light burns whale oil on a sixteen-hour cycle. The wick must be trimmed at slack tide or it smokes.',
                extensions: {},
                enabled: true,
                insertion_order: 0,
            },
            {
                keys: ['reef'],
                content: 'The reef shifts three feet a year. Old maps are obsolete by their fifth winter.',
                extensions: {},
                enabled: true,
                insertion_order: 1,
            },
        ],
        extensions: {},
    },
};

const v2Payload = {
    spec: EMBEDDED_CARD.spec,
    spec_version: EMBEDDED_CARD.spec_version,
    name: EMBEDDED_CARD.name,
    description: EMBEDDED_CARD.description,
    personality: EMBEDDED_CARD.personality,
    scenario: EMBEDDED_CARD.scenario,
    first_mes: EMBEDDED_CARD.first_mes,
    mes_example: EMBEDDED_CARD.mes_example,
    creator_notes: EMBEDDED_CARD.creator_notes,
    system_prompt: EMBEDDED_CARD.system_prompt,
    post_history_instructions: EMBEDDED_CARD.post_history_instructions,
    alternate_greetings: EMBEDDED_CARD.alternate_greetings,
    tags: EMBEDDED_CARD.tags,
    creator: EMBEDDED_CARD.creator,
    character_version: EMBEDDED_CARD.character_version,
    data: {
        name: EMBEDDED_CARD.name,
        description: EMBEDDED_CARD.description,
        personality: EMBEDDED_CARD.personality,
        scenario: EMBEDDED_CARD.scenario,
        first_mes: EMBEDDED_CARD.first_mes,
        mes_example: EMBEDDED_CARD.mes_example,
        creator_notes: EMBEDDED_CARD.creator_notes,
        system_prompt: EMBEDDED_CARD.system_prompt,
        post_history_instructions: EMBEDDED_CARD.post_history_instructions,
        alternate_greetings: EMBEDDED_CARD.alternate_greetings,
        tags: EMBEDDED_CARD.tags,
        creator: EMBEDDED_CARD.creator,
        character_version: EMBEDDED_CARD.character_version,
        extensions: EMBEDDED_CARD.extensions,
        character_book: EMBEDDED_CARD.character_book,
    },
};

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'character', scenarioId: 'import-png' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#15 — Import PNG character card', () => {
    test('PNG with embedded card data + character_book + embedded skills survives import and restart', async ({ page }) => {
        // Build a PNG buffer containing our embedded card metadata by
        // re-encoding the bundled Seraphina default PNG with a fresh
        // `chara`/`ccv3` tEXt chunk.
        const seedPath = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');
        const seed = readFileSync(seedPath);
        const png = writePngCard(seed, JSON.stringify(v2Payload));
        expect(png.length).toBeGreaterThan(1000);

        await awaitMainUI(page, server.baseURL);

        // POST the PNG to the import endpoint via the page so cookies/CSRF
        // come from the same browser session ST already authenticated.
        const importResult = await page.evaluate(async ({ b64, name }) => {
            const ctx = window.Luker.getContext();
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const file = new File([bytes], `${name}.png`, { type: 'image/png' });
            const form = new FormData();
            form.append('avatar', file);
            form.append('file_type', 'png');
            const headers = ctx.getRequestHeaders({ omitContentType: true });
            const res = await fetch('/api/characters/import', { method: 'POST', body: form, headers, cache: 'no-cache' });
            const text = await res.text();
            let data; try { data = JSON.parse(text); } catch { data = { rawText: text }; }
            return { ok: res.ok, status: res.status, data };
        }, { b64: png.toString('base64'), name: 'Briallen' });

        expect(importResult.ok, `import failed (${importResult.status}): ${JSON.stringify(importResult.data)}`).toBe(true);
        expect(importResult.data?.error).toBeFalsy();
        expect(importResult.data?.file_name, 'import returned a file_name').toBeTruthy();
        const importedAvatar = `${importResult.data.file_name}.png`;

        // File must exist on disk.
        const onDisk = listCharacters({ dataRoot: server.dataRoot });
        expect(onDisk, 'imported file present on disk').toContain(importedAvatar);

        // Refresh ST's in-memory character list by calling the exported
        // getCharacters() helper directly (no slash exists for it).
        await page.evaluate(async () => {
            const mod = await import('/script.js');
            if (typeof mod.getCharacters === 'function') await mod.getCharacters();
        });
        await page.waitForFunction((name) => {
            const ctx = window.Luker?.getContext?.();
            return !!ctx?.characters?.find?.(c => c?.name === name);
        }, EMBEDDED_CARD.name, { timeout: 15_000 });

        const found = await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const shallow = ctx.characters.find(c => c?.name === name);
            if (!shallow) return null;
            // /all returns shallow rows; pull the full record via /get for
            // assertions on description / first_mes / character_book / etc.
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: shallow.avatar }),
                cache: 'no-cache',
            });
            const full = await res.json();
            return {
                name: full.name,
                description: full.description || full.data?.description || '',
                first_mes: full.first_mes || full.data?.first_mes || '',
                hasCharacterBook: !!full.data?.character_book,
                bookEntries: full.data?.character_book?.entries?.length ?? 0,
                hasEmbeddedSkills: !!full.data?.extensions?.luker?.embedded_skills_source,
                skillItems: full.data?.extensions?.luker?.embedded_skills_source?.items?.length ?? 0,
                avatar: shallow.avatar,
            };
        }, EMBEDDED_CARD.name);

        expect(found, 'imported character surfaces in ctx.characters').toBeTruthy();
        expect(found.description).toContain('eastern light');
        expect(found.first_mes).toContain('Close the hatch');
        expect(found.hasCharacterBook, 'embedded character_book preserved').toBe(true);
        expect(found.bookEntries).toBe(2);
        expect(found.hasEmbeddedSkills, 'embedded_skills_source preserved').toBe(true);
        expect(found.skillItems).toBe(1);

        // ── Persistence: kill server, respawn against same dataRoot ─────
        await server.restart();
        await reloadAndAwait(page, server.baseURL);

        const afterRestart = await page.evaluate(async (name) => {
            const ctx = window.Luker.getContext();
            const shallow = ctx.characters.find(c => c?.name === name);
            if (!shallow) return null;
            const res = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: shallow.avatar }),
                cache: 'no-cache',
            });
            const full = await res.json();
            return {
                description: full.description || full.data?.description || '',
                hasBook: !!full.data?.character_book,
                bookEntries: full.data?.character_book?.entries?.length ?? 0,
                hasSkills: !!full.data?.extensions?.luker?.embedded_skills_source,
            };
        }, EMBEDDED_CARD.name);
        expect(afterRestart, 'character still present after restart').toBeTruthy();
        expect(afterRestart.description).toContain('eastern light');
        expect(afterRestart.hasBook).toBe(true);
        expect(afterRestart.bookEntries).toBe(2);
        expect(afterRestart.hasSkills).toBe(true);
    });
});
