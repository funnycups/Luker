// #82 — CEA Character iter-studio: Apply → character description mutated → survives restart.
//
// Story:
//   1. Select Seraphina (the bundled character).
//   2. Apply a `set` edit on `description` via the canonical CEA Apply
//      path `commitCharacterEditorOperations(ctx, avatar, edits,
//      {liveCharacter})`. This is the entry point the studio's commit
//      ultimately reaches with edits that have been rebased from
//      `card.<field>` to `<field>` (bare) by `rebasePathToTarget`.
//   3. Verify:
//        a) In-memory `ctx.characters[id]` reflects the new description.
//        b) `/api/characters/get` returns the new description (i.e. the
//           disk PNG metadata was rewritten).
//        c) After `server.restart()` + reload + re-select character, the
//           description is still the new one.
//
// We do NOT synthesize CHARACTER_REPLACED to mount the popup (the smoke
// spec at IterWorkspaceSplit.e2e.js covers the popup shell):
// `openCharacterEditorPopup` is invoked with `autoSend: true` inside the
// event handler, and the studio's implementation `await`s `popupPromise`
// (a deferred that only resolves when the popup closes). That blocks
// `eventSource.emit` indefinitely (per public/lib/eventemitter.js#emit,
// which awaits each listener), so `await page.evaluate(... await emit ...)`
// would time out at the spec timeout. The Apply path under test is
// downstream of the popup anyway, callable standalone via the exported
// `commitCharacterEditorOperations`.
//
// REAL BUG LOCKED (see test.fail below):
//   The Apply→disk round-trip silently writes the OLD description back
//   to the PNG when the in-memory character carries BOTH the v1 legacy
//   root `description` field AND the v2 `data.description` (which is
//   exactly the shape the bundled Seraphina card hydrates into).
//
//   Reproduction (root cause traced 2026-06-13):
//   1. The canonical Apply edit shape after `rebasePathToTarget` is
//      `{ op: 'set', path: 'description', newValue: NEW, oldValue: OLD }`.
//   2. `commitCharacterEditorOperations` runs `applyEdits` against a
//      deep-clone of the live character, which is the full object
//      with both root.description (OLD) and data.description (OLD).
//      `lodash.set(workingLive, 'description', NEW)` mutates only the
//      ROOT key on the clone.
//   3. The diff against `before` produces `patch = { description: NEW }`
//      — a top-level (root) key, not `data.description`.
//   4. `mergeCharacterAttributes` routes the top-level `description`
//      into `formPatch.description = NEW` → `updateCharacterData(idx,
//      { description: NEW }, { immediate: true })`.
//   5. `updateCharacterData` does `setDotPath(character.data,
//      'description', NEW)` — only mutates `character.data.description`.
//      The legacy root `character.description` stays OLD.
//   6. `persistCharacterData` posts `/api/characters/edit` with form
//      `description=NEW` AND `json_data=JSON.stringify(character)` — and
//      that JSON still carries `character.description = OLD` (root,
//      never re-projected post-patch). Tracer confirms this.
//   7. Server side: `charaFormatData(req.body)` builds `char` from the
//      json_data (root.description=OLD, data.description=NEW), then
//      overlays the form's `description=NEW` on `data.description`
//      (no change). `existingChar = getStoredCharaCardV2(disk PNG)` →
//      data.description=OLD, no root description (stripped by the
//      existing toStoredV2Character normalization at read time).
//   8. `deepMerge(existingChar, char)` keeps `char.description=OLD`
//      (root, source overrides) and `char.data.description=NEW`.
//   9. `toStoredV2Character(merged)` then re-runs the legacy-root-to-data
//      projection (`legacyCharacterStorageFieldSpecs.description.path =
//      'data.description'`): because `merged.description=OLD` exists,
//      it overwrites `data.description` BACK to OLD, then deletes the
//      root key. The final stored shape is `{ data: { description: OLD } }`.
//   10. `writeCharacterData` writes the OLD-description card to the PNG.
//      `/api/characters/get` reads back OLD. Restart → still OLD.
//
//   Why the smoke spec doesn't catch this:
//      The smoke spec only mounts the popup; it never closes the Apply
//      loop and never reads back the persisted card.
//
//   Likely fix (out of scope for this batch):
//      `updateCharacterData` (or its callers) needs to keep
//      `character.<legacyField>` in sync with `character.data.<field>`
//      for fields in `CHARACTER_DATA_PATH_TO_FORM_DOM` whose name maps
//      1:1, so the json_data round-trip doesn't carry a stale legacy
//      root that the server-side normalization will then re-promote.
//      Alternatively, the server-side `toStoredV2Character` could
//      privilege the data.<field> over the legacy root when both are
//      present in the same write (currently it does the opposite).

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait, selectCharacterByName } from '../_lib/page.js';

let server, mock;

const NEW_DESCRIPTION = 'Seraphina now wears a wind-bitten cartographer\'s coat over her healer\'s robes. '
    + 'A brass spyglass, verdigrised at the bezel, hangs from her belt — Ash gifted it to her '
    + 'after the third reef survey. Her hands still smell of salt and chamomile.';

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: ['*Seraphina folds the chart and meets your eyes.*'] });
    server = await startServer({ batchKey: 'iterstudio', scenarioId: '82-cea-char-apply' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

test.describe('#82 — CEA Character iter-studio Apply → character description persists across restart', () => {
    // Real product bug: see the long-form comment block at the top of this
    // file. The Apply round-trip writes the stale v1 legacy root description
    // back to disk when both root and data.description are present on the
    // in-memory character (the default state for cards loaded from disk).
    test.fail('Apply writes Seraphina.description to disk; survives restart', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Read pre-edit description to prove the Apply actually changed it
        // (the bundled card has a non-empty description).
        const beforeDesc = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            const c = ctx.characters?.[ctx.characterId] || null;
            return {
                name: c?.name || '',
                description: c?.description || '',
                dataDescription: c?.data?.description || '',
                avatar: c?.avatar || '',
            };
        });
        expect(beforeDesc.name).toBe('Seraphina');
        expect(beforeDesc.avatar).toBeTruthy();
        expect(beforeDesc.description).not.toBe(NEW_DESCRIPTION);

        // Apply via the canonical commit path. The CEA character editor's
        // studio uses `commitCharacterEditorOperations(ctx, avatar, edits,
        // {liveCharacter})`. The `set` op on `description` is what the LLM's
        // `cea_set_card_field` tool generates after sandbox-diff normalization
        // (post-`rebasePathToTarget` strips the `card.` prefix to a bare
        // field name).
        const applyResult = await page.evaluate(async (args) => {
            const ctx = window.SillyTavern.getContext();
            const mod = await import(
                '/scripts/extensions/character-editor-assistant/main.js'
            );
            const character = ctx.characters.find(c => String(c?.avatar) === args.avatar);
            if (!character) return { ok: false, reason: 'character not found' };
            const liveCharacter = JSON.parse(JSON.stringify(character || {}));
            const edits = [{
                op: 'set',
                path: 'description',
                newValue: args.newDescription,
                // The `set` op's detectConflict reads `edit.oldValue` (not
                // `expectedValue`), checked against the live value at the
                // path. If oldValue mismatches and current !== newValue,
                // the engine emits a `value_drifted` conflict and the edit
                // is excluded from `clean[]` (→ applied=0).
                oldValue: liveCharacter.description,
            }];
            try {
                const r = await mod.commitCharacterEditorOperations(
                    ctx,
                    args.avatar,
                    edits,
                    { liveCharacter },
                );
                return { ok: true, applied: r?.applied, persisted: !!r?.persisted };
            } catch (e) {
                return { ok: false, reason: String(e?.message || e) };
            }
        }, { avatar: beforeDesc.avatar, newDescription: NEW_DESCRIPTION });
        expect(applyResult.ok, applyResult.reason).toBe(true);
        expect(applyResult.applied).toBeGreaterThanOrEqual(1);
        expect(applyResult.persisted).toBe(true);

        // In-memory: character object now carries the new description.
        await expect.poll(async () => {
            return await page.evaluate(() => {
                const ctx = window.SillyTavern.getContext();
                const c = ctx.characters?.[ctx.characterId] || null;
                return c?.data?.description || c?.description || '';
            });
        }, { timeout: 10_000 }).toContain('wind-bitten cartographer');

        // Confirm via API (proves disk-write went through).
        // ⚠️ This is where the locked bug manifests: API returns the OLD
        // description because the server's toStoredV2Character normalization
        // re-promoted the stale v1 legacy root over the new data.description.
        const beforeRestartFromApi = await page.evaluate(async (avatar) => {
            const ctx = window.SillyTavern.getContext();
            const resp = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }),
            });
            if (!resp.ok) return { ok: false, status: resp.status };
            const data = await resp.json();
            return { ok: true, description: data?.data?.description || data?.description || '' };
        }, beforeDesc.avatar);
        expect(beforeRestartFromApi.ok).toBe(true);
        expect(beforeRestartFromApi.description).toBe(NEW_DESCRIPTION);

        // Restart server, reload, re-select character, re-assert. (The bug
        // also surfaces here because the disk PNG was never updated with
        // NEW.)
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.SillyTavern?.getContext?.();
            const c = ctx?.characters?.[ctx?.characterId];
            return !!c && (c.description || c.data?.description);
        }, { timeout: 15_000 });

        const afterRestartCard = await page.evaluate(() => {
            const ctx = window.SillyTavern.getContext();
            const c = ctx.characters?.[ctx.characterId] || null;
            return {
                description: c?.description || '',
                dataDescription: c?.data?.description || '',
                avatar: c?.avatar || '',
            };
        });
        expect(afterRestartCard.description || afterRestartCard.dataDescription).toBe(NEW_DESCRIPTION);

        // Also confirm via API after restart (cache invalidation sanity).
        const afterRestartFromApi = await page.evaluate(async (avatar) => {
            const ctx = window.SillyTavern.getContext();
            const resp = await fetch('/api/characters/get', {
                method: 'POST',
                headers: ctx.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }),
            });
            if (!resp.ok) return { ok: false, status: resp.status };
            const data = await resp.json();
            return { ok: true, description: data?.data?.description || data?.description || '' };
        }, afterRestartCard.avatar);
        expect(afterRestartFromApi.ok).toBe(true);
        expect(afterRestartFromApi.description).toBe(NEW_DESCRIPTION);
    });
});
