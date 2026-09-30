// #130 — CardApp ctx.renderText keeps `.html` on the awaited value
// (commits 6964419d6 → 4dc4c6ab2)
//
// Bug shape: ctx.renderText was made sync-callable by returning a String
// subclass carrying `.html` and a `then` handler, so both of these work:
//
//   el.innerHTML = ctx.renderText(text)              // sync
//   el.innerHTML = (await ctx.renderText(text)).html // awaited, `.html` read
//
// A follow-up commit changed `then` to resolve to the raw html string (to
// fix `${await ctx.renderText(...)}` rendering "[object Object]"). That
// fixed interpolation but silently broke the awaited `.html` read: awaiting
// now yields a *plain* string, so `.html` is `undefined` and
// `el.innerHTML = undefined` renders the literal text "undefined".
//
// CardApps written against the pre-6964419d6 `async {html}` shape — including
// the bundled demo card — hit the second form and show "undefined" in their
// message list.
//
// REAL USER FLOW: import a PNG card whose `card_app.files` carries an entry
// module that seeds history via `(await ctx.renderText(mes, idx)).html` —
// exactly the bundled-demo pattern. Then select the card so the CardApp
// loader activates it, and assert the rendered container contains the
// formatted message text and NOT the literal token "undefined".
//
// The fix must satisfy three call shapes at once, so this test pins all of
// them from inside real CardApp code (not a page.evaluate of the function in
// isolation): sync call, awaited `.html`, and awaited template interpolation.

import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { markOnboarded, bootstrapCustomBackend, appendConnectionProfile } from '../_lib/fixtures.js';
import { awaitMainUI, closeRightNavDrawer, selectCharacterByName } from '../_lib/page.js';
import { dismissAnyPopup, disableTagImportPopup } from '../character/_helpers.js';
import { importCharacterFile } from '../_lib/ui-character.js';
import { write as writePngCard } from '../../../src/character-card-parser.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const NAME = 'Wren the Tidewright';
const FIRST_MES = '*Wren sets the tide-glass down and wipes the salt from her palms.* "You came at slack water. Good. The reef is quieter than it has been all week, and I want a second pair of eyes on the western channel before the light goes."';

// The CardApp entry module reproduces the bundled-demo seeding pattern:
// history messages are rendered through "(await ctx.renderText(x)).html".
// It also records what each call shape returned so the test can assert on
// them without poking at the function in isolation.
// (Written as a plain string — no template literal — so the module's own
// backticks and ${...} interpolation don't collide with this file's syntax.)
const CARD_APP_ENTRY = [
    'export async function init(ctx) {',
    '    const results = { sync: null, awaited_html: null, interpolated: null, messages: [] };',
    '',
    '    const probe = \'<b>probe-body</b>\';',
    '',
    '    // Shape 1 - sync call, coerced by innerHTML.',
    '    const syncEl = document.createElement("div");',
    '    syncEl.innerHTML = ctx.renderText(probe, -1);',
    '    results.sync = syncEl.innerHTML;',
    '',
    '    // Shape 2 - awaited ".html" (the bundled-demo seeding pattern).',
    '    const awaited = await ctx.renderText(probe, -1);',
    '    results.awaited_html = awaited.html;',
    '',
    '    // Shape 3 - awaited template interpolation.',
    '    results.interpolated = `${await ctx.renderText(probe, -1)}`;',
    '',
    '    const history = ctx.getHistory();',
    '    const list = document.createElement("div");',
    '    list.id = "wren-cardapp-messages";',
    '    for (const msg of history) {',
    '        const rendered = await ctx.renderText(msg.mes, msg.index ?? -1);',
    '        const row = document.createElement("div");',
    '        row.className = "wren-row";',
    '        row.innerHTML = rendered.html;',
    '        list.appendChild(row);',
    '        results.messages.push(row.textContent);',
    '    }',
    '    ctx.container.appendChild(list);',
    '',
    '    const probeEl = document.createElement("pre");',
    '    probeEl.id = "wren-cardapp-probe";',
    '    probeEl.textContent = JSON.stringify(results);',
    '    ctx.container.appendChild(probeEl);',
    '}',
    '',
].join('\n');

let server, mock, tmpDir, pngPath;

test.beforeAll(async () => {
    mock = await startMockLLM({});
    server = await startServer({ batchKey: 'regression', scenarioId: '130-cardapp-rendertext' });
    // The fixture card carries tags, so an import would open the tag-import
    // modal and block the UI behind it. Sibling specs pre-disable it too.
    disableTagImportPopup({ dataRoot: server.dataRoot });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // Build a PNG card carrying an embedded CardApp. Importing it makes the
    // server extract `card_app.files` into the per-character card-apps dir,
    // which is the production path real cards take.
    tmpDir = mkdtempSync(resolve(tmpdir(), 'luker-e2e-130-'));
    const seed = readFileSync(resolve(REPO_ROOT, 'default/content/default_Seraphina.png'));

    const v2 = {
        name: NAME,
        description: 'A tidewright who reads the western channel by glass and by hand.',
        personality: 'Precise, unhurried, suspicious of anyone who trusts a chart over the water itself.',
        scenario: 'You and Wren share the tide-house at the western channel, timing the reef before the light goes.',
        first_mes: FIRST_MES,
        mes_example: '',
        creator_notes: 'e2e fixture — cardapp renderText regression',
        system_prompt: 'You are Wren. Stay in scene.',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['rp', 'fixture'],
        creator: 'luker-e2e',
        character_version: '1.0',
        extensions: {
            card_app: {
                enabled: true,
                entry: 'index.js',
                files: {
                    'index.js': CARD_APP_ENTRY,
                },
            },
        },
    };
    const payload = { spec: 'chara_card_v2', spec_version: '2.0', ...v2, data: v2 };
    pngPath = resolve(tmpDir, 'wren.png');
    writeFileSync(pngPath, writePngCard(seed, JSON.stringify(payload)));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
    if (tmpDir && existsSync(tmpDir)) {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

test.describe('#130 — CardApp ctx.renderText awaited `.html`', () => {
    test('all three renderText call shapes yield the formatted html, not "undefined"', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        // Import through the real file picker (#character_import_button +
        // hidden input), same gesture as a user dragging a card in.
        await importCharacterFile(page, { filePath: pngPath, expectedName: NAME });
        await dismissAnyPopup(page);
        await closeRightNavDrawer(page);

        // Selecting the card fires CHAT_CHANGED → the CardApp loader activates
        // the embedded app and runs its init(ctx) in a real browser.
        await selectCharacterByName(page, NAME);

        const container = page.locator('#card-app-container');
        await container.waitFor({ state: 'visible', timeout: 30_000 });

        // The probe records the outcome of each call shape.
        const probeEl = page.locator('#wren-cardapp-probe');
        await probeEl.waitFor({ state: 'visible', timeout: 20_000 });
        const probe = JSON.parse(await probeEl.textContent());

        // Shape 1 — sync call coerces to the html.
        expect(probe.sync, 'sync ctx.renderText(x) used as innerHTML').toContain('probe-body');
        // Shape 2 — the regression: awaited `.html` must not be undefined.
        expect(probe.awaited_html, '(await ctx.renderText(x)).html').toContain('probe-body');
        // Shape 3 — awaited interpolation must not be "[object Object]".
        expect(probe.interpolated, '`${await ctx.renderText(x)}`').toContain('probe-body');
        expect(probe.interpolated, '`${await ...}` must not stringify a wrapper').not.toContain('[object');

        // The seeded message list is the user-visible surface: it must carry
        // the real first message text, with no literal "undefined".
        const messagesEl = page.locator('#wren-cardapp-messages');
        await messagesEl.waitFor({ state: 'visible', timeout: 10_000 });
        const renderedText = await messagesEl.textContent();
        expect(renderedText, 'seeded history renders the message body').toContain('slack water');
        expect(renderedText, 'awaited `.html` must not render the literal "undefined"').not.toContain('undefined');

        // Every seeded row is non-empty (a broken `.html` renders exactly "undefined").
        const rowTexts = await page.locator('#wren-cardapp-messages .wren-row').allTextContents();
        expect(rowTexts.length, 'history seeded at least one message').toBeGreaterThan(0);
        for (const text of rowTexts) {
            expect(text.trim(), 'no empty seeded row').not.toBe('');
            expect(text, 'no literal undefined in a seeded row').not.toContain('undefined');
        }
    });
});
