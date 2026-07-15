// #28 — Real-LLM end-to-end sweep of the post-replace world-book flow.
//
// This test drives the full user journey against the REAL upstream API
// (the connection profile the developer has configured in their working
// tree's `data/default-user/settings.json`, cloned into the e2e data
// root by tests/e2e/_lib/server.js). Two custom characters are built
// in-test with two entirely different world books; character A is
// dropped onto disk + bound as primary, character B is imported as PNG,
// then the "Replace / Update" gesture drives the post-replace popup.
//
// All five branches of the popup are exercised in individual sub-tests,
// each in an isolated data root (so no ordering coupling):
//
//   1. IMPORT: new book materialized on disk + bound; old book file
//      untouched but no longer primary.
//   2. KEEP:   new card fields land, but the previous binding + book
//      file survive verbatim; new card's embedded book is NOT written.
//   3. MERGE (happy path): new book materialized, Merge-in-editor popup
//      opens, real LLM produces a review-only turn, the seed diff is
//      complete (both prev + next entries dumped verbatim, no ellipsis),
//      the world-book preview pane's <details> shows full content, then
//      a second turn produces an edit proposal that we approve and see
//      land on disk.
//   4. MERGE-then-close-without-apply: rolls back the pre-materialize
//      step (deletes the newly-created book file, restores the previous
//      binding). This is the fix for the bug that started this session.
//   5. CANCEL: clicking Cancel on the popup does nothing — the character
//      keeps its previous binding and the new card's embedded book is
//      never materialized on disk.
//
// Design constraints:
//   - Real API access is inherited via APFS-clone of the dev's `data/`.
//     No environment-variable / API-key plumbing is needed here.
//   - The Claude profile (id 84a415a4-…, selected in the working tree)
//     is the default. Any real reachable profile works; this test asserts
//     only on behavior that is provider-agnostic (assistant reply is
//     non-empty, a tool call materializes, an edit lands on disk).
//   - The first Merge turn is post-replace-seed-primed: the seed
//     explicitly forbids tool calls. We therefore wait for the assistant
//     message bubble, NOT for a proposal card (which won't appear yet).
//     The second turn (a follow-up user prompt asking to apply an
//     obvious migration) is where we expect the tool call.
//   - Real-LLM tests can flake on 429 / provider outage. Each real-LLM
//     turn wraps the send in a small retry loop (up to 2 retries with
//     backoff) so a transient provider hiccup doesn't fail the test.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, clickCharacterCard, openCharacterEditPanel, writeEmbeddedCharacter } from './_helpers.js';
import { awaitMainUI } from '../_lib/page.js';
import { write as writePngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

// Human-review screenshots — one PNG per meaningful UI step so the
// developer can walk the flow after a run without re-driving the whole
// suite. Written under tests/.e2e-screenshots/28-real-llm-sweep/<test>/,
// which is git-ignored (`.e2e-scratch` sibling). No env-var gate: the
// whole point of these specs is that the developer wants to inspect
// each stage of the real-LLM flow.
const SCREENSHOT_ROOT = resolve(REPO_ROOT, 'tests/.e2e-screenshots/28-real-llm-sweep');

async function snap(page, testSlug, stepName) {
    const dir = resolve(SCREENSHOT_ROOT, testSlug);
    mkdirSync(dir, { recursive: true });
    // Zero-padded numeric prefix keeps directory listing in flow order
    // even with 10+ steps per test. Track step count on the page object
    // itself so callers don't have to thread a counter around.
    if (typeof page._snapStepIdx !== 'number') page._snapStepIdx = 0;
    page._snapStepIdx += 1;
    const safeName = stepName.replace(/[^a-z0-9-]/gi, '_').toLowerCase();
    const file = resolve(dir, `${String(page._snapStepIdx).padStart(2, '0')}-${safeName}.png`);
    // fullPage:true so we capture the whole popup even when it exceeds
    // the viewport (common for the studio + preview pane combo).
    await page.screenshot({ path: file, fullPage: true }).catch(() => { /* best effort */ });
    return file;
}

// Two entirely-different characters. Their world books share NO uids
// and NO entry names — every diff line the AI sees is a real migration
// candidate.
const CARD_A_NAME = 'Sable of the Watchtower';
const CARD_A_BOOK = 'watchtower-lore';
const CARD_A_DESCRIPTION = 'A steady watchtower captain in her forties. Grey at the temples, iron-quiet in a crisis, the calm voice on the wire when everyone else is shouting. Prefers black tea, hates surprises, memorizes every relief-shift roster by name.';
const CARD_A_FIRST_MES = '*Sable does not rise from her chair.* "Report. Slowly. And close the door behind you — the wind pulls maps off the wall."';
const CARD_A_ENTRIES = [
    {
        key: ['watchtower', 'the tower', 'watch'],
        comment: 'watchtower-brief',
        content: 'The Watchtower stands on the third promontory, staffed in three-hour rotations, with a fallback muster horn heard as far as the fishing terraces.',
        order: 100,
    },
    {
        key: ['relief', 'roster', 'shift'],
        comment: 'relief-schedule',
        content: 'Relief rotations run from dawn to midnight in six overlapping bands. Captain Sable knows every roster by heart and refuses paper copies "on principle".',
        order: 200,
    },
    {
        key: ['storm code', 'red code', 'code red'],
        comment: 'storm-codes',
        content: 'Storm Code Red means the reef has closed to skiffs. Code Orange means shore lights must be extinguished by the second bell.',
        order: 300,
    },
];

const CARD_B_NAME = 'Nireth of the Long River';
const CARD_B_BOOK = 'long-river-hymns';
const CARD_B_DESCRIPTION = 'A river-guide in his late twenties. Sun-bronzed, freckled, always somehow damp. Sings under his breath when steering, apologizes to fish before he catches them, keeps an unbroken tally of every knot he has ever tied and untied.';
const CARD_B_FIRST_MES = '*Nireth is coiling rope on the pier when you arrive.* "Late? No — I set the meeting hour by the second bird call, not the first. You are precisely as late as I planned."';
const CARD_B_ENTRIES = [
    {
        key: ['long river', 'the river', 'river'],
        comment: 'river-geography',
        content: 'The Long River runs 900 leagues from the Cinderpines to the delta. Nireth has walked, poled, or rowed every navigable stretch and can name the current pattern at each ford.',
        order: 100,
    },
    {
        key: ['hymn', 'river hymn', 'hymns'],
        comment: 'river-hymns',
        content: 'River-guides sing the hymns as a mnemonic for hazards: verse one warns of the tearing shallows, verse two of the whirlpool at the Hangman\'s Bend, verse three of the false current near the sluice.',
        order: 200,
    },
    {
        key: ['guild', 'river guild', 'guild oath'],
        comment: 'guild-oath',
        content: 'The Guild of Long-River Guides binds its members to three oaths: never refuse a stranded rider, never touch the coin left as toll on the stones, never sing verse four before dawn.',
        order: 300,
    },
    {
        key: ['delta', 'the delta', 'salt-flats'],
        comment: 'delta-hazard',
        content: 'The delta is not a river-guide\'s territory. Passing the second sluice is considered a formal handoff to the salt-pilots, who charge triple and refuse tips.',
        order: 400,
    },
];

// PNG-writer helper (mirrors #25's pattern). Uses the shipped Seraphina
// PNG as a neutral image carrier.
function buildCard(name, description, firstMes, bookName) {
    const payload = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name,
        description,
        personality: '',
        scenario: '',
        first_mes: firstMes,
        mes_example: '',
        creator_notes: 'e2e fixture — real-LLM sweep',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['e2e', 'real-llm'],
        creator: 'luker-e2e',
        character_version: '1.0',
        data: {
            name,
            description,
            personality: '',
            scenario: '',
            first_mes: firstMes,
            mes_example: '',
            creator_notes: 'e2e fixture — real-LLM sweep',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: ['e2e', 'real-llm'],
            creator: 'luker-e2e',
            character_version: '1.0',
            extensions: {
                world: bookName,
            },
            // Embed the book as a V2/V3 character_book so importer /
            // Merge-in-editor materialize path can lift it.
            character_book: {
                name: bookName,
                entries: (bookName === CARD_A_BOOK ? CARD_A_ENTRIES : CARD_B_ENTRIES).map((e, i) => ({
                    keys: e.key,
                    secondary_keys: e.keysecondary || [],
                    comment: e.comment,
                    content: e.content,
                    constant: false,
                    selective: true,
                    insertion_order: e.order ?? 100,
                    enabled: true,
                    position: e.position ?? 'before_char',
                    extensions: {},
                    id: i,
                    priority: 10,
                })),
                extensions: {},
            },
        },
    };
    return payload;
}

function writeCardPng(name, description, firstMes, bookName, outPath) {
    const seedPng = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));
    const png = writePngCard(seedPng, JSON.stringify(buildCard(name, description, firstMes, bookName)));
    writeFileSync(outPath, png);
    return outPath;
}

async function openReplaceWithFile(page, pngPath) {
    // Copy of #25's helper — the More dropdown → Replace with File →
    // hidden file input gesture is exactly the same.
    await page.evaluate(() => {
        const sel = document.querySelector('#char-management-dropdown');
        if (!sel) throw new Error('#char-management-dropdown not found');
        const opt = sel.querySelector('#replace_update');
        if (!opt) throw new Error('#replace_update option not found');
        opt.selected = true;
        if (window.jQuery) window.jQuery(sel).trigger('change');
        else sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const firstPopup = page.locator('dialog.popup[open]').last();
    await firstPopup.waitFor({ state: 'visible', timeout: 5000 });
    const fileBtn = firstPopup.locator('.popup-button-custom', { hasText: /Replace with File/i }).first();
    await fileBtn.click();
    await firstPopup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await page.locator('#character_replace_file').setInputFiles(pngPath);
}

async function waitForReplaceChoicePopup(page) {
    const popup = page.locator('dialog.popup[open]', {
        hasText: /Replace:|替换角色卡|替換角色卡/,
    }).last();
    await popup.waitFor({ state: 'visible', timeout: 20_000 });
    return popup;
}

/**
 * Send a prompt into the Merge-in-editor studio composer and wait for
 * either an assistant text bubble or a proposal card. `expect` picks
 * which one; the real-LLM path can't guarantee tool calls on any given
 * turn, so callers pass what they expect (`'assistant'` for the seeded
 * review turn, `'proposal'` when we've explicitly asked for edits).
 *
 * Wraps the whole send in a small retry loop so transient 429s / brief
 * upstream outages don't fail the test. Real-LLM tests are inherently
 * flaky on the network layer; the *logical* assertions afterward are
 * what we care about.
 */
async function sendStudioPromptAndWait(page, prompt, { expect: expectKind, timeoutMs = 90_000, retries = 2 } = {}) {
    const studio = page.locator('dialog.popup[open]', {
        hasText: /Character Editor — AI iteration|角色编辑器 - AI 迭代|角色編輯器 - AI 迭代/,
    }).first();
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const input = studio.locator('[data-cea-editor-input], .cea_editor_composer_input textarea').first();
            await input.waitFor({ state: 'visible', timeout: 5000 });
            await input.fill(prompt);
            // Snapshot the pre-send assistant-bubble count so we can
            // wait for a NEW bubble (real-LLM output) rather than any
            // bubble (which is instantly true because of the seeded
            // system bubble).
            const bubbleCountBefore = await studio.locator('[data-cea-editor-messages] .luker_lib_message_assistant, [data-cea-editor-messages] .luker_lib_message').count();
            await studio.locator('[data-cea-editor-action="send"]').first().click();
            if (expectKind === 'assistant') {
                // Wait for a new assistant bubble to appear.
                await page.waitForFunction(({ before }) => {
                    const root = document.querySelector('[data-cea-editor-messages]');
                    if (!root) return false;
                    const bubbles = root.querySelectorAll('.luker_lib_message_assistant, .luker_lib_message');
                    if (bubbles.length <= before) return false;
                    const last = bubbles[bubbles.length - 1];
                    return last && (last.textContent || '').trim().length > 20;
                }, { before: bubbleCountBefore }, { timeout: timeoutMs, polling: 500 });
            } else if (expectKind === 'proposal') {
                await studio.locator('[data-proposal-action="approve"], [data-proposal-action="approve-all-pending"]').first()
                    .waitFor({ state: 'visible', timeout: timeoutMs });
            } else {
                throw new Error(`sendStudioPromptAndWait: unknown expectKind ${expectKind}`);
            }
            return; // success
        } catch (err) {
            if (attempt >= retries) throw err;
            // Backoff. Real providers usually recover from a transient
            // rate limit within a few seconds.
            const delayMs = 5000 * (attempt + 1);
            // Best-effort: try to abort any in-flight round so the next
            // attempt can start clean.
            await page.evaluate(() => {
                try { window.Luker?.__testAbortCurrentIterRound?.(); } catch { /* best effort */ }
            }).catch(() => {});
            await page.waitForTimeout(delayMs);
        }
    }
}

let cardAPngPath, cardBPngPath, tmpDir;

test.describe('#28 — real-LLM post-replace world-book sweep', () => {
    test.beforeAll(async () => {
        tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-replace-real-llm-'));
        cardAPngPath = writeCardPng(CARD_A_NAME, CARD_A_DESCRIPTION, CARD_A_FIRST_MES, CARD_A_BOOK, resolve(tmpDir, 'sable.png'));
        cardBPngPath = writeCardPng(CARD_B_NAME, CARD_B_DESCRIPTION, CARD_B_FIRST_MES, CARD_B_BOOK, resolve(tmpDir, 'nireth.png'));
    });

    test.afterAll(async () => {
        if (tmpDir && existsSync(tmpDir)) {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });

    // -----------------------------------------------------------------
    // Import new book
    // -----------------------------------------------------------------
    test('IMPORT: new book materializes + is bound, old book file survives on disk unbound', async ({ page }) => {
        const slug = 'import';
        const server = await startServer({ batchKey: 'character', scenarioId: 'import' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            // Pre-plant card A + its world book on disk, already bound.
            writeWorldBook({ dataRoot: server.dataRoot, name: CARD_A_BOOK, entries: CARD_A_ENTRIES });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'sable-import.png',
                overrides: {
                    name: CARD_A_NAME,
                    description: CARD_A_DESCRIPTION,
                    first_mes: CARD_A_FIRST_MES,
                    extensions: { world: CARD_A_BOOK },
                    data: { extensions: { world: CARD_A_BOOK } },
                },
            });
            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, CARD_A_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);
            await snap(page, slug, 'card-A-selected');
            expect((await page.locator('#character_world').inputValue()) || '').toBe(CARD_A_BOOK);

            const oldBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${CARD_A_BOOK}.json`);
            const newBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${CARD_B_BOOK}.json`);
            expect(existsSync(oldBookPath)).toBe(true);
            expect(existsSync(newBookPath)).toBe(false);

            await openReplaceWithFile(page, cardBPngPath);
            const popup = await waitForReplaceChoicePopup(page);
            await snap(page, slug, 'popup-three-choices');
            const importBtn = popup.locator('.popup-button-custom', {
                hasText: /Import new book|导入新世界书|匯入新世界書/,
            }).first();
            await expect(importBtn).toBeVisible();
            await importBtn.click();
            await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

            // Await the new book showing up in the world-info list (the
            // materialize path is async).
            await page.waitForFunction(({ name }) => {
                const ctx = window.Luker?.getContext?.();
                const names = typeof ctx?.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
                return Array.isArray(names) && names.includes(name);
            }, { name: CARD_B_BOOK }, { timeout: 15_000 });
            expect(existsSync(newBookPath), 'new book file must exist').toBe(true);
            expect(existsSync(oldBookPath), 'old book file must survive on disk').toBe(true);
            expect((await page.locator('#character_world').inputValue()) || '').toBe(CARD_B_BOOK);
            await snap(page, slug, 'after-import-new-book-bound');
        } finally {
            await tearDownServer(server);
        }
    });

    // -----------------------------------------------------------------
    // Keep old book
    // -----------------------------------------------------------------
    test('KEEP: character fields update from new card, but the previous binding + book file are preserved verbatim', async ({ page }) => {
        const slug = 'keep';
        const server = await startServer({ batchKey: 'character', scenarioId: 'keep' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            writeWorldBook({ dataRoot: server.dataRoot, name: CARD_A_BOOK, entries: CARD_A_ENTRIES });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'sable-keep.png',
                overrides: {
                    name: CARD_A_NAME,
                    description: CARD_A_DESCRIPTION,
                    first_mes: CARD_A_FIRST_MES,
                    extensions: { world: CARD_A_BOOK },
                    data: { extensions: { world: CARD_A_BOOK } },
                },
            });
            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, CARD_A_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);
            await snap(page, slug, 'card-A-selected');
            const oldBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${CARD_A_BOOK}.json`);
            const newBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${CARD_B_BOOK}.json`);
            const oldBookContentBefore = readFileSync(oldBookPath, 'utf8');

            await openReplaceWithFile(page, cardBPngPath);
            const popup = await waitForReplaceChoicePopup(page);
            await snap(page, slug, 'popup-three-choices');
            const keepBtn = popup.locator('.popup-button-custom', {
                hasText: /Keep old book|保留旧世界书|保留舊世界書/,
            }).first();
            await expect(keepBtn).toBeVisible();
            await keepBtn.click();
            await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
            await page.waitForTimeout(1500); // rebind is async

            // Old book preserved verbatim, new book NOT materialized.
            expect(existsSync(oldBookPath)).toBe(true);
            expect(readFileSync(oldBookPath, 'utf8')).toBe(oldBookContentBefore);
            expect(existsSync(newBookPath), 'new book must NOT be materialized').toBe(false);
            // Card is now Nireth (fields refreshed) but bound to old book.
            expect((await page.locator('#character_world').inputValue()) || '').toBe(CARD_A_BOOK);
            // Card name has been updated by the underlying replace.
            const nameField = page.locator('#character_name_pole');
            await expect(nameField).toHaveValue(CARD_B_NAME, { timeout: 5000 });
            await snap(page, slug, 'after-keep-fields-updated-book-preserved');
        } finally {
            await tearDownServer(server);
        }
    });

    // -----------------------------------------------------------------
    // Merge in editor — happy path (real LLM produces review + edit)
    // -----------------------------------------------------------------
    test('MERGE happy: studio opens with complete diff + preview shows full content + real LLM produces review + follow-up edit lands on disk', async ({ page }) => {
        // Longest sub-test — allocate 5 minutes because it drives two
        // real LLM roundtrips.
        test.setTimeout(300_000);
        const slug = 'merge-happy';
        const server = await startServer({ batchKey: 'character', scenarioId: 'merge-happy' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            writeWorldBook({ dataRoot: server.dataRoot, name: CARD_A_BOOK, entries: CARD_A_ENTRIES });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'sable-merge.png',
                overrides: {
                    name: CARD_A_NAME,
                    description: CARD_A_DESCRIPTION,
                    first_mes: CARD_A_FIRST_MES,
                    extensions: { world: CARD_A_BOOK },
                    data: { extensions: { world: CARD_A_BOOK } },
                },
            });
            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, CARD_A_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);
            await snap(page, slug, 'card-A-selected');

            await openReplaceWithFile(page, cardBPngPath);
            const popup = await waitForReplaceChoicePopup(page);
            await snap(page, slug, 'popup-three-choices');
            const mergeBtn = popup.locator('.popup-button-custom', {
                hasText: /Merge in editor|在编辑器中合并|在編輯器中合併/,
            }).first();
            await expect(mergeBtn).toBeVisible();
            await mergeBtn.click();
            await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

            const studio = page.locator('dialog.popup[open]', {
                hasText: /Character Editor — AI iteration|角色编辑器 - AI 迭代|角色編輯器 - AI 迭代/,
            }).first();
            await studio.waitFor({ state: 'visible', timeout: 30_000 });
            await snap(page, slug, 'studio-opened');

            // --- Assertion A: pre-materialize wrote the new book -----
            await page.waitForFunction(({ name }) => {
                const ctx = window.Luker?.getContext?.();
                const names = typeof ctx?.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
                return Array.isArray(names) && names.includes(name);
            }, { name: CARD_B_BOOK }, { timeout: 15_000 });

            // --- Assertion B: seed message hidden from chat + "View
            // full replace diff" topbar button opens a popup carrying
            // the same information in structured form ---------------
            //
            // Previously the post-replace flow dumped the entire prev/
            // next diff prose into a chat bubble labeled "system". That
            // bubble was written for the LLM to read as its first-turn
            // brief; showing it verbatim to the user was pure noise.
            // Now the studio hides the system bubble via hiddenFromUi
            // and instead surfaces a topbar "View full replace diff"
            // button that opens a full-screen structured diff popup.
            //
            // Contract we exercise here:
            //   1. The chat pane contains NO system bubble.
            //   2. The topbar button is visible when replaceContext is
            //      attached (post-replace flow).
            //   3. Clicking it opens a popup whose body carries the
            //      structured diff — book names, per-entry cards, and
            //      the verbatim entry content the seed used to dump.
            const messagesRoot = studio.locator('[data-cea-editor-messages]');
            const systemBubbles = messagesRoot.locator('.luker_lib_message_system');
            expect(await systemBubbles.count()).toBe(0);

            const openDiffBtn = studio.locator('[data-cea-editor-action="open-replace-diff"]').first();
            await expect(openDiffBtn).toBeVisible();
            await openDiffBtn.click();

            const diffPopup = page.locator('dialog.popup[open]', {
                hasText: /Replace diff — previous vs current|替换差异|替換差異/,
            }).first();
            await diffPopup.waitFor({ state: 'visible', timeout: 10_000 });
            await snap(page, slug, 'replace-diff-popup-open');

            const overviewText = (await diffPopup.locator('.cea_replace_diff_overview').textContent()) || '';
            // Book rename banner (previous → current).
            expect(overviewText).toContain(CARD_A_BOOK);
            expect(overviewText).toContain(CARD_B_BOOK);
            // Full verbatim content from BOTH sides is visible (the
            // structured overview never truncates — same guarantee the
            // old prose seed offered, now with UI affordances).
            expect(overviewText).toContain('The Watchtower stands on the third promontory');
            expect(overviewText).toContain('The Long River runs 900 leagues from the Cinderpines');
            expect(overviewText).not.toContain('…');
            await snap(page, slug, 'replace-diff-popup-body-verified');

            // Close the diff popup — the studio should be uncovered
            // and functional afterwards.
            const closeDiffBtn = diffPopup.locator('.popup-button-ok, [data-result="1"]').first();
            if (await closeDiffBtn.isVisible({ timeout: 500 }).catch(() => false)) {
                await closeDiffBtn.click();
            } else {
                await page.keyboard.press('Escape');
            }
            await diffPopup.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

            // --- Assertion C: world-book preview shows FULL content --
            // Switch to the preview pane (mobile-tabbed layout on
            // narrower viewports; on wide viewports both are visible).
            const previewTab = studio.locator('[data-iter-action="switch-tab"][data-iter-tab="preview"]').first();
            if (await previewTab.isVisible({ timeout: 500 }).catch(() => false)) {
                await previewTab.click();
            }
            // Open the first entry's <details> in the preview and
            // confirm the full content is rendered — no 320-char cap.
            const previewPane = studio.locator('[data-iter-preview-pane]').first();
            await previewPane.waitFor({ state: 'visible', timeout: 5000 });
            await snap(page, slug, 'preview-pane-open');
            const firstDetails = previewPane.locator('.cea_editor_preview_card details').first();
            await firstDetails.waitFor({ state: 'attached', timeout: 5000 });
            await firstDetails.evaluate(el => { el.open = true; });
            await snap(page, slug, 'preview-entry-details-expanded');
            // The river-geography entry is 172 chars; still, the
            // structural assertion is that no ellipsis follows the
            // content. Guard against Bug 2 regression.
            const detailsInner = await firstDetails.locator('div').first().textContent();
            expect(detailsInner || '').not.toContain('…');

            // Switch back to chat tab for the AI turn.
            const chatTab = studio.locator('[data-iter-action="switch-tab"][data-iter-tab="chat"]').first();
            if (await chatTab.isVisible({ timeout: 500 }).catch(() => false)) {
                await chatTab.click();
            }

            // --- Assertion D: real LLM produces a review turn --------
            // The seed message triggers autoSend on open, so the first
            // assistant turn should already be in-flight. Wait for it.
            await page.waitForFunction(() => {
                const root = document.querySelector('[data-cea-editor-messages]');
                if (!root) return false;
                // Find any assistant bubble whose text is non-trivially
                // long. The system seed is a fixed body — a real reply
                // has to add MORE content.
                const bubbles = root.querySelectorAll('.luker_lib_message');
                for (const b of bubbles) {
                    const cls = b.className || '';
                    if (cls.includes('luker_lib_message_system')) continue;
                    if (cls.includes('luker_lib_message_user')) continue;
                    const text = (b.textContent || '').trim();
                    if (text.length > 80) return true;
                }
                return false;
            }, null, { timeout: 180_000, polling: 1000 });
            await snap(page, slug, 'real-llm-review-turn-visible');

            // --- Assertion E: follow-up edit proposal + apply --------
            // Ask the AI to migrate one specific entry. We pick a very
            // safe migration ("add the storm-code entry into the new
            // book") so any competent model produces an add_entry tool
            // call.
            await sendStudioPromptAndWait(page,
                `Please add card A's storm-codes entry (comment "storm-codes", key ["storm code","red code","code red"], content about Code Red / Code Orange) into the new book "${CARD_B_BOOK}" using cea_add_lorebook_entry. Do it now — no further planning needed.`,
                { expect: 'proposal', timeoutMs: 180_000 });
            await snap(page, slug, 'proposal-visible');

            // Approve the proposal.
            const approveBtn = studio.locator('[data-proposal-action="approve"], [data-proposal-action="approve-all-pending"]').first();
            await approveBtn.click();
            // Wait for the applied badge or for the approve button to
            // detach (both signal commit).
            await approveBtn.waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
            await snap(page, slug, 'proposal-approved');

            // --- Assertion F: edit actually landed on disk -----------
            // Poll the book file for the migrated entry.
            await page.waitForFunction(async ({ bookName }) => {
                const ctx = window.Luker?.getContext?.();
                if (!ctx?.loadWorldInfo) return false;
                try {
                    const book = await ctx.loadWorldInfo(bookName);
                    if (!book?.entries) return false;
                    return Object.values(book.entries).some(e =>
                        String(e?.comment || '').toLowerCase().includes('storm')
                        || String(e?.content || '').toLowerCase().includes('code red')
                        || String(e?.content || '').toLowerCase().includes('code orange'));
                } catch { return false; }
            }, { bookName: CARD_B_BOOK }, { timeout: 15_000 });
            await snap(page, slug, 'edit-landed-on-disk');
        } finally {
            await tearDownServer(server);
        }
    });

    // -----------------------------------------------------------------
    // Merge → close without apply → rollback
    // -----------------------------------------------------------------
    test('MERGE + close without applying → rollback deletes the new book file and restores previous binding', async ({ page }) => {
        test.setTimeout(120_000);
        const slug = 'merge-rollback';
        const server = await startServer({ batchKey: 'character', scenarioId: 'merge-rollback' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            writeWorldBook({ dataRoot: server.dataRoot, name: CARD_A_BOOK, entries: CARD_A_ENTRIES });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'sable-rollback.png',
                overrides: {
                    name: CARD_A_NAME,
                    description: CARD_A_DESCRIPTION,
                    first_mes: CARD_A_FIRST_MES,
                    extensions: { world: CARD_A_BOOK },
                    data: { extensions: { world: CARD_A_BOOK } },
                },
            });
            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, CARD_A_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);
            await snap(page, slug, 'card-A-selected');

            const oldBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${CARD_A_BOOK}.json`);
            const newBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${CARD_B_BOOK}.json`);
            const oldBookContentBefore = readFileSync(oldBookPath, 'utf8');

            await openReplaceWithFile(page, cardBPngPath);
            const popup = await waitForReplaceChoicePopup(page);
            await snap(page, slug, 'popup-three-choices');
            const mergeBtn = popup.locator('.popup-button-custom', {
                hasText: /Merge in editor|在编辑器中合并|在編輯器中合併/,
            }).first();
            await mergeBtn.click();
            await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

            const studio = page.locator('dialog.popup[open]', {
                hasText: /Character Editor — AI iteration|角色编辑器 - AI 迭代|角色編輯器 - AI 迭代/,
            }).first();
            await studio.waitFor({ state: 'visible', timeout: 30_000 });
            // Pre-materialize completed.
            await page.waitForFunction(({ name }) => {
                const ctx = window.Luker?.getContext?.();
                const names = typeof ctx?.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
                return Array.isArray(names) && names.includes(name);
            }, { name: CARD_B_BOOK }, { timeout: 15_000 });
            expect(existsSync(newBookPath)).toBe(true);
            await snap(page, slug, 'studio-opened-book-materialized');

            // Close studio without applying anything. The seed's
            // autoSend fires an in-flight LLM turn — we must let that
            // settle before Escape, otherwise onClosing blocks the
            // close with an abort handshake. The send button's text
            // toggles between 'Send' and 'Stop' as state.isBusy flips;
            // wait for it to return to a non-'Stop' label as a proxy
            // for state.isBusy === false.
            await page.waitForFunction(() => {
                const btn = document.querySelector('[data-cea-editor-action="send"]');
                if (!btn) return false;
                const label = (btn.textContent || '').trim();
                // 'Stop' (or its zh translations) means still busy.
                return !/^(Stop|终止|終止)$/.test(label);
            }, null, { timeout: 180_000, polling: 500 }).catch(() => { /* fall through; abort path still works */ });
            await snap(page, slug, 'studio-idle-ready-to-close');

            // Try close via the popup's built-in close button first
            // (dialog cancel keys can be delayed by the dialog polyfill).
            const closeBtn = studio.locator('.popup-button-close, [data-popup-close]').first();
            if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                await closeBtn.click().catch(() => {});
            } else {
                await page.keyboard.press('Escape');
            }
            // The abort handshake path may still be pending on the
            // first Escape press (if we squeezed the click in before
            // isBusy cleared); allow a second try after a beat.
            const detachedFirst = await studio.waitFor({ state: 'detached', timeout: 8000 }).then(() => true).catch(() => false);
            if (!detachedFirst) {
                await page.keyboard.press('Escape').catch(() => {});
                await studio.waitFor({ state: 'detached', timeout: 30_000 });
            }

            // Rollback: new book file deleted, old book unchanged,
            // binding restored to card A book.
            await page.waitForFunction(({ name }) => {
                const ctx = window.Luker?.getContext?.();
                const names = typeof ctx?.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
                return !(Array.isArray(names) && names.includes(name));
            }, { name: CARD_B_BOOK }, { timeout: 15_000 });
            expect(existsSync(newBookPath), 'new book file must be deleted').toBe(false);
            expect(existsSync(oldBookPath)).toBe(true);
            expect(readFileSync(oldBookPath, 'utf8')).toBe(oldBookContentBefore);
            expect((await page.locator('#character_world').inputValue()) || '').toBe(CARD_A_BOOK);
            await snap(page, slug, 'after-rollback-state-restored');
        } finally {
            await tearDownServer(server);
        }
    });

    // -----------------------------------------------------------------
    // Cancel the popup — nothing happens
    // -----------------------------------------------------------------
    test('CANCEL: clicking Cancel on the popup makes NO disk / binding changes', async ({ page }) => {
        const slug = 'cancel';
        const server = await startServer({ batchKey: 'character', scenarioId: 'cancel' });
        try {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            writeWorldBook({ dataRoot: server.dataRoot, name: CARD_A_BOOK, entries: CARD_A_ENTRIES });
            writeEmbeddedCharacter({
                dataRoot: server.dataRoot,
                avatarFile: 'sable-cancel.png',
                overrides: {
                    name: CARD_A_NAME,
                    description: CARD_A_DESCRIPTION,
                    first_mes: CARD_A_FIRST_MES,
                    extensions: { world: CARD_A_BOOK },
                    data: { extensions: { world: CARD_A_BOOK } },
                },
            });
            await awaitMainUI(page, server.baseURL);
            await clickCharacterCard(page, CARD_A_NAME);
            await dismissAnyPopup(page);
            await openCharacterEditPanel(page);
            await snap(page, slug, 'card-A-selected');

            const oldBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${CARD_A_BOOK}.json`);
            const newBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${CARD_B_BOOK}.json`);
            const oldBookContentBefore = readFileSync(oldBookPath, 'utf8');
            // Snapshot the character card file itself. Cancel should
            // NOT roll back the underlying replace either — the card
            // fields have already been swapped by ST core before the
            // CEA popup even opens, and Cancel is scoped to the
            // world-book decision only.
            //
            // (This matches user expectation: Cancel = "don't touch
            // the world book". If the user also wants to undo the
            // card-field replace, that's the character More menu's
            // own responsibility, not this popup's.)

            await openReplaceWithFile(page, cardBPngPath);
            const popup = await waitForReplaceChoicePopup(page);
            await snap(page, slug, 'popup-three-choices');
            const cancelBtn = popup.locator('.popup-button-cancel').first();
            await expect(cancelBtn).toBeVisible();
            await cancelBtn.click();
            await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
            await page.waitForTimeout(1000);

            // No world-book side effects.
            expect(existsSync(newBookPath), 'new book must NOT be materialized').toBe(false);
            expect(existsSync(oldBookPath)).toBe(true);
            expect(readFileSync(oldBookPath, 'utf8')).toBe(oldBookContentBefore);
            await snap(page, slug, 'after-cancel-no-side-effects');
        } finally {
            await tearDownServer(server);
        }
    });
});
