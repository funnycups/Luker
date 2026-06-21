// tests/e2e/memorygraph/60-mg-var-ops-cooperation.e2e.js
//
// #60 — MG + var_ops co-operation: a {{getvar::*}} macro inside an MG
// node's field expands at prompt-assembly time to the chat variable's
// current value.
//
// MG does not read chat variables directly. The integration point is
// SillyTavern's macro engine: `substituteParams` evaluates `{{getvar::x}}`
// in any string flowing through the standard prompt pipeline. MG fields
// (extractHint, columnHints, summary, etc.) all surface in those
// prompts; the test asserts the round-trip through `substituteParams`.
//
// Real-user flow:
//   1. Enable MG via the real checkbox.
//   2. Send a user turn whose mock reply sets a chat variable via a
//      setvar macro (`{{setvar::current_omen_threshold::7.5}}`). The
//      var-op-log extractor strips the macro and records the op.
//   3. Open the flask panel on the assistant message and assert the
//      rendered row matches the recorded op.
//   4. Seed a single MG node (via the real Import button) whose
//      identity field carries a `{{getvar::current_omen_threshold}}`
//      token. Open the real View Graph popup → the node's field text
//      (read via the Layer-1 read API for stable assertion) should
//      contain the literal token; substituteParams resolves it to "7.5".

import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    openExtensionsDrawer,
    openInlineDrawer,
} from '../_lib/page.js';
import { openVarOpsPanel, getRenderedVarOpsRows, openMgGraphView } from '../_lib/ui-mg-varops.js';

let server, mock, importPath;

const SETVAR_REPLY = '*Seraphina lifts the chart with both hands.* {{setvar::current_omen_threshold::7.5}} "The threshold for tonight reads 7.5 — anything past that and we lift the watch."';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: [SETVAR_REPLY] });
    server = await startServer({ batchKey: 'memorygraph', scenarioId: 'mg-var-ops' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    // The node we import carries the macro token in its identity field;
    // the macro should round-trip verbatim on storage and expand only
    // when read through substituteParams.
    const tmpDir = mkdtempSync(resolve(tmpdir(), 'mg-varops-'));
    importPath = resolve(tmpDir, 'macro-node.json');
    writeFileSync(importPath, JSON.stringify({
        version: 2,
        nodeSeq: 1,
        seqCounter: 1,
        appliedSeqTo: 1,
        loggedSeqTo: 1,
        nodes: {
            n_1: {
                id: 'n_1', type: 'character_sheet', level: 'semantic',
                title: 'Reef-shudder watch threshold tracker', parentId: '', childrenIds: [],
                fields: {
                    title: 'Reef-shudder watch threshold tracker',
                    identity: '负责礁石回响阈值监测的夜哨；阈值为 {{getvar::current_omen_threshold}}。',
                },
                seqTo: 1,
            },
        },
        edges: [],
    }, null, 2));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function enableMgViaCheckbox(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});
    await page.evaluate(() => {
        const el = document.getElementById('luker_rpg_memory_enabled');
        if (el && !el.checked) {
            el.checked = true;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });
}

async function importBindLatest(page, filePath) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'memory_graph_settings').catch(() => {});
    await page.locator('#luker_rpg_memory_import').click();
    await page.locator('#luker_rpg_memory_import_file').setInputFiles(filePath);
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: 10_000 });
    await popup.locator('.popup-button-custom', { hasText: /Bind Latest|绑定最新/ }).first().click();
    await popup.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(500);
}

test.describe('#60 — MG + var_ops co-operation via macro expansion', () => {
    test.setTimeout(180_000);

    test('setvar from reply lands in flask panel; MG field expands {{getvar::*}} via substituteParams', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await enableMgViaCheckbox(page);

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 }).catch(() => {});

        // Send a user turn; the mock reply embeds a setvar macro that
        // the var-op-log extractor will record on the assistant message.
        const { replyId } = await sendMessageAndAwaitReply(page, 'Read me the threshold for tonight.');
        await page.waitForFunction((id) => {
            const ctx = window.Luker.getContext();
            const m = ctx.chat?.[id];
            return Boolean(m && Array.isArray(m?.extra?.var_ops) && m.extra.var_ops.length > 0);
        }, replyId, { timeout: 15_000 });

        // Open the flask panel and assert the recorded setvar row.
        await openVarOpsPanel(page, replyId);
        const rows = await getRenderedVarOpsRows(page);
        expect(rows).toEqual([
            { op: 'setvar', key: 'current_omen_threshold', value: '7.5', path: '' },
        ]);
        await page.locator('.popup:visible .popup-button-cancel').last().click().catch(() => {});
        await page.locator('.var-ops-panel').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});

        // Confirm the chat variable was actually set (apply ran).
        const varSeen = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return ctx.chatMetadata?.variables?.current_omen_threshold ?? null;
        });
        expect(varSeen).toBe('7.5');

        // Import the MG node carrying the macro token in its identity field.
        await importBindLatest(page, importPath);

        // Open the real View Graph popup — confirms the node renders.
        await openMgGraphView(page);
        await page.waitForFunction(() => {
            const cy = document.querySelector('.luker-rpg-memory-graph-cy');
            if (!cy) return false;
            const inst = window.cy || cy.__cytoscape__ || null;
            if (inst && typeof inst.nodes === 'function') return inst.nodes().length > 0;
            return !!cy.querySelector('canvas');
        }, null, { timeout: 15_000 });
        await page.locator('.popup:visible .popup-button-ok, .popup:visible .popup-button-close, .popup:visible .popup-button-cancel').first().click().catch(() => {});

        // Read the imported node via Layer-1 — fields are stored
        // verbatim; the raw text must still contain the macro token.
        // Then run substituteParams over it (the same evaluator MG fields
        // go through during prompt assembly) — that result must contain
        // the expanded value.
        const expansion = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const mg = ctx.getExtensionApi?.('memory-graph');
            const session = await mg?.openSession?.(ctx);
            const cands = session ? session.listVisibleCandidates({}) : [];
            const node = cands.find(n => n.title === 'Reef-shudder watch threshold tracker');
            const raw = String(node?.fields?.identity || '');
            const expanded = typeof ctx.substituteParams === 'function'
                ? ctx.substituteParams(raw)
                : raw;
            return { raw, expanded };
        });
        expect(expansion.raw, 'MG stores macro tokens verbatim').toContain('{{getvar::current_omen_threshold}}');
        expect(expansion.expanded, 'substituteParams should expand the token to 7.5').toContain('7.5');
        expect(expansion.expanded, 'post-expansion should not still contain the raw macro').not.toContain('{{getvar::');
    });
});
