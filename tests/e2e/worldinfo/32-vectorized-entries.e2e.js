// #32 — Vectorized entries — embed → query → inject via real UI toggles
//
// Vectorized WI entries get added to the vectors extension's semantic
// pool: (1) embedded into a per-world collection, (2) queried by the
// recent chat tail, (3) top-K appended back into the prompt context.
// The mock embedder (`tests/e2e/_lib/mockLLM.js`) ships a deterministic
// `/v1/embeddings` endpoint so shared tokens cluster by cosine
// similarity — exactly what the WI vector path needs to score
// "navigate the coast" against "Coastal navigation in fog" without a
// real embedder. `bootstrapVectorsBackend` wires that profile into
// `extension_settings.vectors.embeddingProfileId`.
//
// What this test verifies:
//   - The vectorized flag is reflected in the WI editor's per-entry
//     `entryStateSelector` — read via the real DOM after opening the
//     book in the WI drawer.
//   - The flag does NOT prevent keyword activation — a vectorized
//     entry with a primary key still injects via the keyword path.
//   - With the vectors extension's WI flag enabled, an empty-key
//     vectorized entry whose content is semantically near the user's
//     turn DOES inject via the semantic pool, while a semantically
//     distant empty-key entry does not.
//
// All toggles are driven through the real DOM: open the Extensions
// drawer, open the Vectors inline drawer, click
// #vectors_enabled_world_info via Playwright check(). The vectors
// extension's settings.html is appended to #vectors_container at boot
// so the element is in DOM whether or not the drawer is expanded; we
// open the drawer for parity with the user gesture.

import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend, appendConnectionProfile,
    bootstrapVectorsBackend, markOnboarded, writeWorldBook,
} from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply, openExtensionsDrawer } from '../_lib/page.js';
import { openWorldInfoDrawer } from '../_lib/ui-worldinfo.js';
import { writeCharacterWithBinding, startWorldInfoServer, tearDownWorldInfoServer } from './_helpers.js';

test.describe.configure({ mode: 'serial' });

let server, mock;

const VECTOR_ENTRIES = [
    {
        key: [], // empty key — only the vectors extension's semantic path can activate this
        comment: 'coastal-navigation',
        content: 'VECTOR_NAV: Coastal navigation in fog relies on rhythmic bell pings from harbor markers; mariners listen for the 4-second cadence to triangulate position.',
        vectorized: true,
        order: 100,
    },
    {
        key: [],
        comment: 'inland-husbandry',
        content: 'VECTOR_FARM: Inland sheep husbandry in the Bryn highlands follows a 9-month grazing rotation tied to the rainfall pattern.',
        vectorized: true,
        order: 110,
    },
    {
        key: ['kelp', 'south reef'],
        comment: 'vectorized-with-keyword',
        content: 'VECTOR_KEYWORD: This vectorized entry also has a primary key — keyword matching should still activate it even though the vectorized flag is set.',
        vectorized: true,
        order: 120,
    },
    {
        key: ['always'],
        comment: 'baseline-keyword',
        content: 'BASELINE_LORE: This baseline lore activates via the keyword "always" and proves the WI pipeline is reaching the prompt.',
        order: 130,
    },
];

function scrubPresetPrompts(dataRoot, handle = 'default-user') {
    const path = resolve(dataRoot, handle, 'settings.json');
    if (!existsSync(path)) return;
    const s = JSON.parse(readFileSync(path, 'utf8'));
    s.oai_settings = s.oai_settings || {};
    s.oai_settings.preset_settings_openai = 'Default';
    s.oai_settings.prompts = [];
    s.oai_settings.prompt_order = [];
    s.oai_settings.main_prompt = '';
    s.oai_settings.nsfw_prompt = '';
    s.oai_settings.jailbreak_prompt = '';
    s.oai_settings.impersonation_prompt = '';
    s.oai_settings.new_chat_prompt = '';
    s.oai_settings.new_group_chat_prompt = '';
    s.oai_settings.new_example_chat_prompt = '';
    s.oai_settings.continue_nudge_prompt = '';
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.orchestrator = { ...(s.extension_settings.orchestrator || {}), enabled: false };
    s.extensionSettings = s.extensionSettings || {};
    s.extensionSettings.orchestrator = { ...(s.extensionSettings.orchestrator || {}), enabled: false };
    writeFileSync(path, JSON.stringify(s, null, 4));
}

test.beforeAll(async () => {
    mock = await startMockLLM({
        scriptedReplies: Array.from({ length: 10 }, (_, i) =>
            `*A reply tuned to the wind.* Acknowledged (${i + 1}).`,
        ),
    });
    server = await startWorldInfoServer({ specBaseName: '32-vectorized-entries', scenarioId: 'vectorized' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    bootstrapVectorsBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    scrubPresetPrompts(server.dataRoot);

    writeWorldBook({ dataRoot: server.dataRoot, name: 'vector-book', entries: VECTOR_ENTRIES });
    writeCharacterWithBinding({
        dataRoot: server.dataRoot,
        avatarFile: 'ash-navigator.png',
        name: 'Ash Navigator',
        worldBook: 'vector-book',
    });
});

test.afterAll(async () => {
    await tearDownWorldInfoServer(server);
    await mock?.stop();
});

async function sendAndCaptureBody(page, text) {
    const before = mock.requests.length;
    await sendMessageAndAwaitReply(page, text);
    const newReqs = mock.requests.slice(before);
    const chatReq = newReqs.find(r => r.url.includes('chat/completions'));
    expect(chatReq, 'expected a chat-completion request after sending').toBeTruthy();
    return JSON.stringify(chatReq.body.messages);
}

async function openBookInEditor(page, bookName) {
    await openWorldInfoDrawer(page);
    await page.locator('#world_editor_select').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction((wanted) => {
        const select = document.querySelector('#world_editor_select');
        if (!select) return false;
        return Array.from(select.options).some(o => String(o.textContent || '').trim() === wanted);
    }, bookName, { timeout: 15_000 });
    const optionValue = await page.evaluate((wanted) => {
        const select = document.querySelector('#world_editor_select');
        if (!select) return null;
        for (const option of Array.from(select.options)) {
            if (String(option.textContent || '').trim() === wanted) return option.value;
        }
        return null;
    }, bookName);
    if (!optionValue) throw new Error(`no editor-dropdown option matches "${bookName}"`);
    let rendered = false;
    for (let attempt = 0; attempt < 3 && !rendered; attempt++) {
        await page.evaluate((value) => {
            const jq = window.jQuery || window.$;
            if (!jq) throw new Error('jQuery missing');
            jq('#world_editor_select').val(value).trigger('change');
        }, optionValue);
        try {
            await page.locator('#world_popup_entries_list .world_entry').first().waitFor({ state: 'visible', timeout: 6_000 });
            rendered = true;
        } catch { /* retry */ }
    }
    if (!rendered) throw new Error(`book "${bookName}" entries did not render after 3 retries`);
}

async function closeWIDrawerIfOpen(page) {
    await page.evaluate(() => {
        const i = document.querySelector('#WIDrawerIcon');
        if (i && i.classList.contains('openIcon')) {
            (i.closest('.drawer-toggle') || i).click();
        }
    });
    await page.locator('#world_popup').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

/**
 * Close the Extensions drawer so the chat composer (send button area)
 * is unobstructed. Symmetric with openExtensionsDrawer.
 */
async function closeExtensionsDrawerIfOpen(page) {
    await page.evaluate(() => {
        const block = document.querySelector('#rm_extensions_block');
        if (!block || !block.classList.contains('openDrawer')) return;
        const toggle = document.querySelector('#extensions-settings-button .drawer-toggle');
        toggle?.click();
    });
    await page.locator('#rm_extensions_block.openDrawer').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

/**
 * Open the Extensions drawer + expand the Vectors inline drawer so the
 * `#vectors_enabled_world_info` checkbox is interactable. The vectors
 * extension's settings.html template is appended to #vectors_container
 * at boot, wrapped in `<div class="vectors_settings">` — the
 * inline-drawer is NOT a direct child of #vectors_container, so the
 * shared openInlineDrawer helper doesn't find it. Walk the DOM
 * explicitly here.
 */
async function openVectorsSettings(page) {
    await openExtensionsDrawer(page);
    // Wait for the vectors template to have mounted under #vectors_container.
    await page.waitForFunction(() => {
        const container = document.querySelector('#vectors_container');
        return container && container.querySelector('.inline-drawer-content');
    }, { timeout: 10_000 });
    // Expand the vectors inline drawer if collapsed (toggle is the header).
    await page.evaluate(() => {
        const container = document.querySelector('#vectors_container');
        if (!container) return;
        const drawer = container.querySelector('.inline-drawer');
        if (!drawer) return;
        const content = drawer.querySelector(':scope > .inline-drawer-content');
        if (!content || window.getComputedStyle(content).display !== 'none') return;
        const toggle = drawer.querySelector(':scope > .inline-drawer-toggle');
        toggle?.click();
    });
    await page.waitForFunction(() => {
        const cb = document.querySelector('#vectors_enabled_world_info');
        if (!cb) return false;
        const content = cb.closest('.inline-drawer-content');
        return content && window.getComputedStyle(content).display !== 'none';
    }, { timeout: 10_000 });
}

/**
 * Toggle the vectors extension's "Enable for World Info" checkbox via
 * a real check()/uncheck() click. Then verify the bound handler ran
 * by reading the module-scope mirror through ctx.extensionSettings.
 *
 * Also explicitly sets the score threshold (slider input) and embedding
 * profile because the vectors module-scope `settings` mirror diverges
 * from extension_settings.vectors on init — the user-visible knobs are
 * the ones that drive the interceptor.
 */
async function enableVectorsWI(page) {
    // Set the embedding profile via the canonical select widget. The
    // bootstrapVectorsBackend fixture wrote it into settings.json, but
    // the vectors module reads its own settings mirror on init — set it
    // again via the widget for safety.
    await page.evaluate(() => {
        const jq = window.jQuery || window.$;
        const ctx = window.Luker.getContext();
        const cm = ctx.extensionSettings?.connectionManager;
        const embedProfiles = (cm?.profiles || []).filter(p => p.mode === 'embed');
        if (embedProfiles.length === 0) throw new Error('no embed profile available');
        const sel = jq('#vectors_embedding_profile');
        if (!sel.find(`option[value="${embedProfiles[0].id}"]`).length) {
            sel.append(new Option(embedProfiles[0].name, embedProfiles[0].id));
        }
        sel.val(embedProfiles[0].id).trigger('change');
        // Score threshold via the canonical slider input.
        const thresh = jq('#vectors_score_threshold');
        if (thresh.length) thresh.val('0.2').trigger('input');
    });

    // Real check() on the WI-enable toggle. The bound handler is
    // `.on('input')` per vectors/index.js#1562 — Playwright's
    // check() fires both change and input.
    const cb = page.locator('#vectors_enabled_world_info');
    await cb.check();
    // Dispatch input explicitly for the vectors module-scope mirror.
    await page.evaluate(() => {
        const el = document.querySelector('#vectors_enabled_world_info');
        el?.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

test.describe('#32 — Vectorized WI entries', () => {
    test('vectorized entries expose the flag in the editor and remain keyword-active', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Navigator');
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return ctx.characters?.[id]?.data?.extensions?.world === 'vector-book';
        }, { timeout: 10_000 });
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Open the book in the editor and read the vectorized flag
        // from each entry's `entryStateSelector` widget — the same
        // dropdown a user clicks to switch constant/normal/vectorized.
        await openBookInEditor(page, 'vector-book');
        const states = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('#world_popup_entries_list .world_entry'));
            return rows.map(r => {
                const commentEl = r.querySelector('input[name="comment"], textarea[name="comment"]');
                const stateEl = r.querySelector('select[name="entryStateSelector"]');
                return {
                    comment: commentEl?.value || '',
                    state: stateEl?.value || '',
                };
            });
        });
        const byComment = Object.fromEntries(states.map(s => [s.comment, s.state]));
        expect(byComment['coastal-navigation']).toBe('vectorized');
        expect(byComment['inland-husbandry']).toBe('vectorized');
        expect(byComment['vectorized-with-keyword']).toBe('vectorized');
        expect(byComment['baseline-keyword'], 'baseline should be normal, not vectorized').not.toBe('vectorized');

        await closeWIDrawerIfOpen(page);

        // Send a turn that triggers BASELINE_LORE ("always") + the
        // vectorized-with-keyword entry ("kelp"/"south reef"). With
        // the vectors WI flag still OFF, the empty-key vectorized
        // entries (VECTOR_NAV / VECTOR_FARM) should NOT inject —
        // they have no key, so the keyword path can't reach them.
        const body = await sendAndCaptureBody(page, 'I always think about kelp on the south reef when the bells start ringing.');
        expect(body, 'baseline keyword entry should fire on "always" key').toContain('BASELINE_LORE');
        expect(body, 'vectorized entry with a primary key should activate via keyword path').toContain('VECTOR_KEYWORD');
        expect(body, 'empty-key vectorized entry should NOT inject without vectors extension').not.toContain('VECTOR_NAV');
        expect(body, 'empty-key vectorized entry should NOT inject without vectors extension').not.toContain('VECTOR_FARM');
    });

    test('semantic injection: empty-key vectorized entry near the query injects, distant one does not', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash Navigator');
        await page.waitForFunction(() => {
            const ctx = window.Luker?.getContext?.();
            if (!ctx) return false;
            const id = ctx.characterId;
            if (typeof id !== 'number' && typeof id !== 'string') return false;
            return ctx.characters?.[id]?.data?.extensions?.world === 'vector-book';
        }, { timeout: 10_000 });
        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Flip the vectors-extension WI flag on via the real UI.
        await openVectorsSettings(page);
        await enableVectorsWI(page);
        // Close the extensions drawer so the chat composer is
        // unobstructed by the open vectors panel for the send turns.
        await closeExtensionsDrawerIfOpen(page);

        // The semantic-similarity query: tokens overlap "Coastal
        // navigation in fog" / "harbor markers" / "mariners" — none of
        // those are keys on any WI entry, so the only path that can
        // pull VECTOR_NAV in is the semantic one. Also avoid every
        // keyword from baseline / VECTOR_KEYWORD / "always" entries.
        const navBody = await sendAndCaptureBody(
            page,
            'Mariners cannot see the harbor markers tonight; tell me how to use the rhythmic pings to navigate through this fog.',
        );
        expect(navBody, 'NAV entry should be force-activated by semantic similarity').toContain('VECTOR_NAV');
        expect(navBody, 'FARM entry should NOT inject when query is about coastal navigation').not.toContain('VECTOR_FARM');
        expect(navBody, 'baseline keyword should NOT inject (no "always" in the query)').not.toContain('BASELINE_LORE');
        expect(navBody, 'VECTOR_KEYWORD should NOT inject (no "kelp"/"south reef" in the query)').not.toContain('VECTOR_KEYWORD');

        // Sanity check: the mock saw embeddings requests once the WI
        // flag flipped on (otherwise a regression that silently
        // bypasses the embedder would leave the assertions above
        // passing for the wrong reason).
        const embedCalls = mock.requests.filter(r => r.url.includes('/embeddings'));
        expect(embedCalls.length, 'expected the mock to receive embeddings requests').toBeGreaterThan(0);

        // Inverse query: tokens overlap FARM, not NAV.
        const farmBody = await sendAndCaptureBody(
            page,
            'Tell me about inland sheep husbandry — how does the highland grazing rotation align with the rainfall pattern?',
        );
        expect(farmBody, 'FARM entry should inject when query is about inland husbandry').toContain('VECTOR_FARM');
        expect(farmBody, 'NAV entry should NOT inject when query has no coastal-navigation tokens').not.toContain('VECTOR_NAV');
    });

    test('vectorized flag persists on disk through a server restart', async ({ page }) => {
        await server.restart();
        await awaitMainUI(page, server.baseURL);

        // After restart, open the book in the editor again. The
        // vectorized state must round-trip via disk.
        await openBookInEditor(page, 'vector-book');
        const states = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('#world_popup_entries_list .world_entry'));
            return rows.map(r => {
                const commentEl = r.querySelector('input[name="comment"], textarea[name="comment"]');
                const stateEl = r.querySelector('select[name="entryStateSelector"]');
                return { comment: commentEl?.value || '', state: stateEl?.value || '' };
            });
        });
        const byComment = Object.fromEntries(states.map(s => [s.comment, s.state]));
        expect(byComment['coastal-navigation']).toBe('vectorized');
        expect(byComment['inland-husbandry']).toBe('vectorized');
        expect(byComment['vectorized-with-keyword']).toBe('vectorized');
        expect(byComment['baseline-keyword']).not.toBe('vectorized');
    });
});
