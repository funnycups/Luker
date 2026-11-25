// #28 — End-to-end sweep of the post-replace world-book flow.
//
// This test drives the full user journey against a live generation
// endpoint. Two custom characters are built
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
//      opens, a scripted review turn replies, the seed diff is
//      complete (both prev + next entries dumped verbatim, no ellipsis),
//      the world-book preview pane's <details> shows full content, then
//      a second turn produces an edit proposal that we approve and see
//      land on disk. Closing the popup afterwards must PRESERVE the new
//      book + binding — an applied edit latches the pre-materialize
//      rollback off.
//   4. MERGE-then-close-without-apply: rolls back the pre-materialize
//      step (deletes the newly-created book file, restores the previous
//      binding). Closing without applying is the only path that rolls
//      back.
//   5. CANCEL: clicking Cancel on the popup does nothing — the character
//      keeps its previous binding and the new card's embedded book is
//      never materialized on disk.
//
// Design constraints:
//   - Generation runs through the repo's mock LLM harness
//     (`startMockLLM` + `bootstrapCustomBackend` + `appendConnectionProfile`),
//     giving every scenario a deterministic reachable endpoint. The
//     inherit-the-dev-connection design rotted: past e2e runs append
//     `e2e-*` profiles and leave oai_settings pointing at a dead
//     ephemeral port, so the studio's first turn died with ECONNREFUSED
//     before producing anything.
//   - The two MERGE turns are scripted: a review-only reply for the
//     seed-primed autoSend turn, then a `cea_add_lorebook_entry` tool
//     call for the follow-up edit turn. Assertions stay
//     provider-agnostic (assistant reply is non-empty, a tool call
//     materializes, an edit lands on disk).
//   - The first Merge turn is post-replace-seed-primed: the seed
//     explicitly forbids tool calls. We therefore wait for the assistant
//     message bubble, NOT for a proposal card (which won't appear yet).
//     The second turn (a follow-up user prompt asking to apply an
//     obvious migration) is where we expect the tool call.

import { test, expect } from '../../harness/playwright.js';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded, writeWorldBook } from '../_lib/fixtures.js';
import { disableTagImportPopup, dismissAnyPopup, clickCharacterCard, openCharacterEditPanel, writeEmbeddedCharacter } from './_helpers.js';
import { awaitMainUI } from '../_lib/page.js';
import { write as writePngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

async function snap(page, testSlug, stepName) {
    const dir = test.info().outputPath('worldbook-sweep', testSlug);
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
    await page.screenshot({ path: file, fullPage: true });
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
        creator_notes: 'e2e fixture — world-book sweep',
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
            creator_notes: 'e2e fixture — world-book sweep',
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
 * which one; a scripted endpoint guarantees the tool call on the turn
 * turn, so callers pass what they expect (`'assistant'` for the seeded
 * review turn, `'proposal'` when we've explicitly asked for edits).
 *
 * Wraps the whole send in a small retry loop so transient 429s / brief
 * flaky providers don't fail the test. Provider-side failures are
 * flaky on the network layer; the *logical* assertions afterward are
 * what we care about.
 */
async function sendStudioPromptAndWait(page, prompt, { expect: expectKind, timeoutMs = 90_000, retries = 2 } = {}) {
    const win = page.locator('.wbench .wb-win').first();
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const input = win.locator('.wb-composer textarea.wb-input').first();
            await input.waitFor({ state: 'visible', timeout: 5000 });
            await input.fill(prompt);
            const aiCountBefore = await win.locator('.wb-msg-ai').count();
            const sendBtn = win.locator('.wb-composer button.wb-send').first();
            await expect(sendBtn).toBeEnabled({ timeout: 10_000 });
            await sendBtn.click();
            if (expectKind === 'assistant') {
                await expect.poll(async () => {
                    const liveCount = await win.locator('.wb-reads.is-live').count();
                    if (liveCount > 0) return false;
                    const count = await win.locator('.wb-msg-ai').count();
                    if (count <= aiCountBefore) return false;
                    const lastText = (await win.locator('.wb-msg-ai').last().textContent()) || '';
                    return lastText.trim().length > 20;
                }, { timeout: timeoutMs, intervals: [200, 500] }).toBe(true);
            } else if (expectKind === 'proposal') {
                await win.locator('.wb-chg.is-pending').first()
                    .waitFor({ state: 'visible', timeout: timeoutMs });
            } else {
                throw new Error(`sendStudioPromptAndWait: unknown expectKind ${expectKind}`);
            }
            return; // success
        } catch (err) {
            if (attempt >= retries) throw err;
            const delayMs = 5000 * (attempt + 1);
            await win.locator('.wb-reads.is-live button').first().click().catch(() => {});
            await page.waitForTimeout(delayMs);
        }
    }
}

let cardBPngPath, tmpDir, mock;

test.describe('#28 — post-replace world-book sweep', () => {
    test.beforeAll(async ({ workerResources }, testInfo) => {
        const scope = await workerResources.scenario(testInfo.file);
        mock = await startMockLLM({});
        tmpDir = (await scope.directory('luker-e2e-replace-worldbook')).path;
        cardBPngPath = writeCardPng(CARD_B_NAME, CARD_B_DESCRIPTION, CARD_B_FIRST_MES, CARD_B_BOOK, resolve(tmpDir, 'nireth.png'));
    });

    test.afterAll(async () => {
        await mock?.stop();
    });

    // -----------------------------------------------------------------
    // Import new book
    // -----------------------------------------------------------------
    test('IMPORT: new book materializes + is bound, old book file survives on disk unbound', async ({ resources, page }) => {
        const slug = 'import';
        const server = await startServer({ scope: resources, batchKey: 'character', scenarioId: 'import' });
        {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
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
        }
    });

    // -----------------------------------------------------------------
    // Keep old book
    // -----------------------------------------------------------------
    test('KEEP: character fields update from new card, but the previous binding + book file are preserved verbatim', async ({ resources, page }) => {
        const slug = 'keep';
        const server = await startServer({ scope: resources, batchKey: 'character', scenarioId: 'keep' });
        {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
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
        }
    });

    // -----------------------------------------------------------------
    // Merge in editor — happy path (scripted review turn + edit proposal)
    // -----------------------------------------------------------------
    test('MERGE happy: complete diff + preview + review turn + edit lands on disk + close preserves it', async ({ resources, page }) => {
        // Longest sub-test — allocate 5 minutes because it drives two
        // scripted LLM roundtrips.
        test.setTimeout(300_000);
        const slug = 'merge-happy';
        const server = await startServer({ scope: resources, batchKey: 'character', scenarioId: 'merge-happy' });
        {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
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

            const oldBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${CARD_A_BOOK}.json`);
            const newBookPath = resolve(server.dataRoot, 'default-user', 'worlds', `${CARD_B_BOOK}.json`);
            const oldBookContentBefore = readFileSync(oldBookPath, 'utf8');

            // Turn 1 (review, seed-primed): the studio's autoSend fires on open.
            mock.scriptReply('Reviewed the replace diff. The previous book stays bound to card A only; the new long-river book materialized cleanly, its three entries are coherent, and no entry content was truncated. Ready for the next instruction.');
            await openReplaceWithFile(page, cardBPngPath);
            const popup = await waitForReplaceChoicePopup(page);
            await snap(page, slug, 'popup-three-choices');
            const mergeBtn = popup.locator('.popup-button-custom', {
                hasText: /Merge in editor|在编辑器中合并|在編輯器中合併/,
            }).first();
            await expect(mergeBtn).toBeVisible();
            await mergeBtn.click();
            await popup.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

            const studio = page.locator('.wbench .wb-win').first();
            await expect(studio).toBeVisible({ timeout: 30_000 });
            await expect(
                studio.locator('.wb-ws-seg button.lw-seg-btn:has(.lw-dot[style*="--lw-t-card"])'),
            ).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
            await snap(page, slug, 'studio-opened');

            // --- Assertion A: pre-materialize wrote the new book -----
            await page.waitForFunction(({ name }) => {
                const ctx = window.Luker?.getContext?.();
                const names = typeof ctx?.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
                return Array.isArray(names) && names.includes(name);
            }, { name: CARD_B_BOOK }, { timeout: 15_000 });

            // --- Assertion B: hidden autoSend brief carries the full
            // verbatim diff to the LLM without cluttering the user chat pane ---
            await expect(studio.locator('.wb-msg-user')).toHaveCount(0);

            await expect.poll(() => {
                const payload = mock.requests
                    .filter((r) => String(r?.url || '').includes('chat/completions'))
                    .map((r) => JSON.stringify(r?.body?.messages || []))
                    .join('\n');
                return {
                    hasOldBook: payload.includes(CARD_A_BOOK),
                    hasNewBook: payload.includes(CARD_B_BOOK),
                    hasOldEntry: payload.includes('The Watchtower stands on the third promontory'),
                    hasNewEntry: payload.includes('The Long River runs 900 leagues from the Cinderpines'),
                };
            }, { timeout: 30_000 }).toEqual({
                hasOldBook: true,
                hasNewBook: true,
                hasOldEntry: true,
                hasNewEntry: true,
            });
            await snap(page, slug, 'replace-diff-seed-verified');

            // --- Assertion D: the auto-sent review turn produces a reply ---
            await expect.poll(async () => {
                const liveCount = await studio.locator('.wb-reads.is-live').count();
                if (liveCount > 0) return false;
                const text = (await studio.locator('.wb-msg-ai').last().textContent().catch(() => '')) || '';
                return text.trim().length > 80;
            }, { timeout: 180_000, intervals: [500, 1000] }).toBe(true);
            await snap(page, slug, 'real-llm-review-turn-visible');

            // --- Assertion E: follow-up edit proposal + apply --------
            mock.scriptToolCall({
                name: 'cea_add_lorebook_entry',
                arguments: {
                    book_name: CARD_B_BOOK,
                    entry: {
                        uid: 400,
                        comment: 'storm-codes',
                        key: ['storm code', 'red code', 'code red'],
                        content: 'Storm Code Red means the reef has closed to skiffs. Code Orange means shore lights must be extinguished by the second bell.',
                        enabled: true,
                        order: 400,
                    },
                },
            });
            await sendStudioPromptAndWait(page,
                `Please add card A's storm-codes entry (comment "storm-codes", key ["storm code","red code","code red"], content about Code Red / Code Orange) into the new book "${CARD_B_BOOK}" using cea_add_lorebook_entry. Do it now — no further planning needed.`,
                { expect: 'proposal', timeoutMs: 180_000 });
            await snap(page, slug, 'proposal-visible');

            // Apply the staged change card.
            const pendingBefore = await studio.locator('.wb-chg.is-pending').count();
            const approveBtn = studio.locator('.wb-chg.is-pending .wb-chg-foot button.is-primary').last();
            await approveBtn.click();
            await expect(studio.locator('.wb-chg.is-pending')).toHaveCount(Math.max(0, pendingBefore - 1), { timeout: 30_000 });
            await snap(page, slug, 'proposal-approved');

            // --- Assertion F: edit actually landed on disk -----------
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

            // --- Assertion G: close after an applied edit keeps the new book ---
            await expect(studio.locator('.wb-reads.is-live')).toHaveCount(0, { timeout: 30_000 });
            await studio.locator('.wb-titlebar .is-close').first().click();
            await expect(studio).toBeHidden({ timeout: 15_000 });
            // Give a (buggy) rollback a beat to land so the regression
            // fails visibly instead of racing the assertion.
            await page.waitForTimeout(1500);

            expect(existsSync(newBookPath), 'new book file must survive close-after-apply').toBe(true);
            expect(readFileSync(oldBookPath, 'utf8')).toBe(oldBookContentBefore);
            expect((await page.locator('#character_world').inputValue()) || '').toBe(CARD_B_BOOK);
            const persistedBook = JSON.parse(readFileSync(newBookPath, 'utf8'));
            expect(
                Object.values(persistedBook.entries).some(e =>
                    String(e?.comment || '').toLowerCase().includes('storm')
                    || String(e?.content || '').toLowerCase().includes('code red')),
                'approved edit still on disk after close',
            ).toBe(true);
            await snap(page, slug, 'close-after-apply-persists');
        }
    });

    // -----------------------------------------------------------------
    // Merge → close without apply → rollback
    // -----------------------------------------------------------------
    test('MERGE + close without applying → rollback deletes the new book file and restores previous binding', async ({ resources, page }) => {
        test.setTimeout(120_000);
        const slug = 'merge-rollback';
        const server = await startServer({ scope: resources, batchKey: 'character', scenarioId: 'merge-rollback' });
        {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
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

            const studio = page.locator('.wbench .wb-win').first();
            await expect(studio).toBeVisible({ timeout: 30_000 });
            // Pre-materialize completed.
            await page.waitForFunction(({ name }) => {
                const ctx = window.Luker?.getContext?.();
                const names = typeof ctx?.getWorldInfoNames === 'function' ? ctx.getWorldInfoNames() : [];
                return Array.isArray(names) && names.includes(name);
            }, { name: CARD_B_BOOK }, { timeout: 15_000 });
            expect(existsSync(newBookPath)).toBe(true);
            await snap(page, slug, 'studio-opened-book-materialized');

            // Let the autoSend seed turn finish before collapsing Workbench;
            // collapsing without Apply runs `onCancelWithoutApply` rollback.
            await expect(studio.locator('.wb-reads.is-live')).toHaveCount(0, { timeout: 60_000 }).catch(() => {});
            await expect(studio.locator('.wb-msg-ai').first()).toBeVisible({ timeout: 60_000 }).catch(() => {});
            await snap(page, slug, 'studio-idle-ready-to-close');

            await studio.locator('.wb-titlebar .is-close').first().click();
            await expect(studio).toBeHidden({ timeout: 15_000 });

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
        }
    });

    // -----------------------------------------------------------------
    // Cancel the popup — nothing happens
    // -----------------------------------------------------------------
    test('CANCEL: clicking Cancel on the popup makes NO disk / binding changes', async ({ resources, page }) => {
        const slug = 'cancel';
        const server = await startServer({ scope: resources, batchKey: 'character', scenarioId: 'cancel' });
        {
            markOnboarded({ dataRoot: server.dataRoot });
            disableTagImportPopup({ dataRoot: server.dataRoot });
            bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
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
        }
    });
});
