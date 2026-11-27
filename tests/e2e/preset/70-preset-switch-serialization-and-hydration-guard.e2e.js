// SPDX-License-Identifier: AGPL-3.0-or-later
//
// #70 — Preset switch serialization, upstream event ordering, hydration failure
// rollback, and null-payload savePreset protection.
//
// Guards four contracts:
//   1. `PresetManager.savePreset(name, null)` rejects instead of falling back
//      to `getPresetSettings(name)` and overwriting `name.json` with the
//      currently active `oai_settings`, while `updatePreset()` continues to
//      save the active preset.
//   2. `PresetManager.selectPreset()` / `getPresetApplicationPromise()` awaits
//      the full switch lifecycle including `OAI_PRESET_CHANGED_AFTER` and
//      `PRESET_CHANGED` (matching upstream SillyTavern 1.19.0).
//   3. Concurrent preset switches and lazy preset fetches serialize strictly
//      in FIFO order without split-brain `#settings_preset_openai` state while
//      hydration is pending and without cross-preset `regex_scripts` overwrite.
//   4. When lazy preset hydration fails, `#settings_preset_openai` reverts to
//      the previous selection, an error toast surfaces, and `oai_settings`
//      remains untouched.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
    writePreset,
} from '../_lib/fixtures.js';
import { awaitMainUI, reloadAndAwait } from '../_lib/page.js';
import { openIterStudio, sendIterPrompt, closeIterStudio } from '../_lib/ui-iter-studio.js';

async function holdWorkbenchSnapshotHttp(page) {
    let signalRequested;
    let signalRelease;
    const requestedPromise = new Promise(resolve => { signalRequested = resolve; });
    const releasePromise = new Promise(resolve => { signalRelease = resolve; });
    const inFlight = new Set();
    let captured = false;
    let released = false;
    const handler = async (route) => {
        const url = new URL(route.request().url());
        if (!released && url.searchParams.get('namespace') === 'sd_character_profiles') {
            let done;
            const pending = new Promise(resolve => { done = resolve; });
            inFlight.add(pending);
            try {
                if (!captured) {
                    captured = true;
                    signalRequested();
                }
                await releasePromise;
                await route.continue();
            } finally {
                inFlight.delete(pending);
                done();
            }
            return;
        }
        await route.continue();
    };
    await page.route('**/api/state/get*', handler);
    return {
        requested: () => requestedPromise,
        async release() {
            if (released) return;
            released = true;
            signalRelease();
            await Promise.all([...inFlight]);
            await page.unroute('**/api/state/get*', handler);
        },
    };
}
import {
    normalizeIterStudioSettings,
    selectPresetByName,
    setCounterInput,
} from './_helpers.js';

const PRESET_ALPHA = 'Beacon Alpha';
const ALPHA_TEMP = 0.34;
const ALPHA_EDITED_TEMP = 0.41;
const ALPHA_REGEX_ID = 'rx-beacon-alpha-001';

const PRESET_BETA = 'Beacon Beta';
const BETA_TEMP = 0.77;
const BETA_REGEX_ID = 'rx-beacon-beta-001';

const PRESET_SLOW = 'Beacon Slow';
const SLOW_TEMP = 0.53;
const SLOW_REGEX_ID = 'rx-beacon-slow-001';

const PRESET_BROKEN = 'Beacon Broken';

let server;
let mock;

function makeRegexScript(id, scriptName, findRegex, replaceString) {
    return {
        id,
        scriptName,
        findRegex,
        replaceString,
        trimStrings: [],
        placement: [2],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
        runOnEdit: false,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
    };
}

function readDiskPreset(dataRoot, name) {
    const filePath = resolve(dataRoot, 'default-user', 'OpenAI Settings', `${name}.json`);
    return JSON.parse(readFileSync(filePath, 'utf8'));
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({
        scope,
        batchKey: 'preset',
        scenarioId: 'preset-switch-serialization-and-hydration-guard',
        extraConfig: { storage: { mode: 'fs' } },
    });

    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, stream: false });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

    writePreset({
        dataRoot: server.dataRoot,
        name: PRESET_ALPHA,
        overrides: {
            temperature: ALPHA_TEMP,
            extensions: {
                regex_scripts: [makeRegexScript(ALPHA_REGEX_ID, 'Beacon Alpha Rule', 'alpha', 'ALPHA')],
            },
        },
    });

    writePreset({
        dataRoot: server.dataRoot,
        name: PRESET_BETA,
        overrides: {
            temperature: BETA_TEMP,
            extensions: {
                regex_scripts: [makeRegexScript(BETA_REGEX_ID, 'Beacon Beta Rule', 'beta', 'BETA')],
            },
        },
    });

    normalizeIterStudioSettings(server.dataRoot);

    const settingsPath = resolve(server.dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.extension_settings = settings.extension_settings || {};
    settings.extension_settings.preset_allowed_regex = {
        openai: [PRESET_ALPHA, PRESET_BETA, PRESET_SLOW],
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
});

test.afterAll(async () => {
    await mock?.stop();
});

test.describe('#70 — preset switch serialization & hydration guards', () => {
    test('a delayed presentation snapshot cannot assign a new preset conversation to the previous preset', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectPresetByName(page, PRESET_ALPHA);
        const win = await openIterStudio(page, 'preset', { scope: 'preset' });
        await expect(win.locator('.wb-scope-seg')).toContainText(PRESET_ALPHA);
        await closeIterStudio(page);
        const held = await holdWorkbenchSnapshotHttp(page);
        const prompt = 'Inspect the currently selected beacon preset.';
        const readOwnership = () => page.evaluate(async ({ before, after, prompt }) => {
            const ctx = window.Luker.getContext();
            const { sessionBodyNamespace } = await import('/scripts/workbench/model/sessions.js');
            const read = async name => {
                const target = { collection: 'openai', name };
                const result = await ctx.presets.state.get('workbench_sessions', { target });
                if (!result.ok) throw new Error(JSON.stringify(result));
                const matched = [];
                for (const session of (result.state?.sessions || [])) {
                    const bodyRes = await ctx.presets.state.get(sessionBodyNamespace(session.id), { target });
                    if (!bodyRes.ok) throw new Error(JSON.stringify(bodyRes));
                    const turns = bodyRes.state?.turns || [];
                    if (turns.some(turn => turn.role === 'user' && turn.text === prompt)) {
                        matched.push(session);
                    }
                }
                return matched;
            };
            return { before: await read(before), after: await read(after) };
        }, { before: PRESET_ALPHA, after: PRESET_BETA, prompt });
        let sessionId;
        try {
            await selectPresetByName(page, PRESET_BETA);
            await openIterStudio(page, 'preset', { scope: 'preset', newSession: true });
            await held.requested();
            mock.scriptReply('The selected beacon preset has been inspected.');
            await sendIterPrompt(page, 'preset', prompt);
            const ownership = await readOwnership();
            expect(ownership.before).toEqual([]);
            expect(ownership.after).toHaveLength(1);
            expect(ownership.after[0].scopeName).toBe(PRESET_BETA);
            sessionId = ownership.after[0].id;
        } finally {
            await held.release();
        }
        await closeIterStudio(page);
        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        const persisted = await readOwnership();
        expect(persisted.before).toEqual([]);
        expect(persisted.after.map(session => session.id)).toEqual([sessionId]);
    });

    test('rejects null savePreset payloads, orders events inside getPresetApplicationPromise, serializes overlapping switches, and rolls back failed hydrations', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        await selectPresetByName(page, PRESET_ALPHA);
        await expect
            .poll(async () => Number(await page.locator('#temp_counter_openai').inputValue()), { timeout: 10_000 })
            .toBeCloseTo(ALPHA_TEMP, 5);

        // 1. savePreset(name, null) must reject and MUST NOT overwrite Beacon Beta with Beacon Alpha's regex_scripts.
        const nullSaveOutcome = await page.evaluate(async (targetName) => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const pm = getPresetManager('openai');
            try {
                await pm.savePreset(targetName, null);
                return { threw: false, message: '' };
            } catch (err) {
                return { threw: true, message: String(err?.message || err) };
            }
        }, PRESET_BETA);

        expect(nullSaveOutcome.threw).toBe(true);
        const betaDiskAfterNullSave = readDiskPreset(server.dataRoot, PRESET_BETA);
        expect((betaDiskAfterNullSave.extensions?.regex_scripts || []).map(r => r.id)).toEqual([BETA_REGEX_ID]);
        expect(betaDiskAfterNullSave.temperature).toBeCloseTo(BETA_TEMP, 5);

        // Meanwhile updatePreset() (which snapshots active settings via undefined) still works.
        await setCounterInput(page, '#temp_counter_openai', ALPHA_EDITED_TEMP);
        await page.evaluate(async () => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            await getPresetManager('openai').updatePreset({ skipUpdate: true });
        });
        const alphaDiskAfterUpdate = readDiskPreset(server.dataRoot, PRESET_ALPHA);
        expect(alphaDiskAfterUpdate.temperature).toBeCloseTo(ALPHA_EDITED_TEMP, 5);
        expect((alphaDiskAfterUpdate.extensions?.regex_scripts || []).map(r => r.id)).toEqual([ALPHA_REGEX_ID]);

        // 2. selectPreset / getPresetApplicationPromise must wait for OAI_PRESET_CHANGED_AFTER & PRESET_CHANGED.
        const singleSwitchTrace = await page.evaluate(async (targetName) => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const ctx = window.Luker.getContext();
            const pm = getPresetManager('openai');
            const trace = [];
            const onBefore = (payload) => trace.push(`before:${payload?.presetName}`);
            const onAfter = () => trace.push(`after:${ctx.chatCompletionSettings.preset_settings_openai}`);
            const onChanged = (payload) => trace.push(`changed:${payload?.name}`);
            ctx.eventSource.on(ctx.eventTypes.OAI_PRESET_CHANGED_BEFORE, onBefore);
            ctx.eventSource.on(ctx.eventTypes.OAI_PRESET_CHANGED_AFTER, onAfter);
            ctx.eventSource.on(ctx.eventTypes.PRESET_CHANGED, onChanged);
            try {
                const value = pm.findPreset(targetName);
                await pm.selectPreset(value);
                trace.push('selectPresetResolved');
            } finally {
                ctx.eventSource.removeListener(ctx.eventTypes.OAI_PRESET_CHANGED_BEFORE, onBefore);
                ctx.eventSource.removeListener(ctx.eventTypes.OAI_PRESET_CHANGED_AFTER, onAfter);
                ctx.eventSource.removeListener(ctx.eventTypes.PRESET_CHANGED, onChanged);
            }
            return trace;
        }, PRESET_BETA);

        expect(singleSwitchTrace).toEqual([
            `before:${PRESET_BETA}`,
            `after:${PRESET_BETA}`,
            `changed:${PRESET_BETA}`,
            'selectPresetResolved',
        ]);

        // Switch back to Beacon Alpha before testing overlapping lazy hydration.
        await selectPresetByName(page, PRESET_ALPHA);

        // 3. Seed Beacon Slow on disk and register an unhydrated (null) slot in memory,
        // delaying its /api/presets/get response by 250ms.
        writePreset({
            dataRoot: server.dataRoot,
            name: PRESET_SLOW,
            overrides: {
                temperature: SLOW_TEMP,
                extensions: {
                    regex_scripts: [makeRegexScript(SLOW_REGEX_ID, 'Beacon Slow Rule', 'slow', 'SLOW')],
                },
            },
        });

        await page.route('**/api/presets/get*', async (route) => {
            const url = new URL(route.request().url());
            const requestedName = url.searchParams.get('name');
            if (requestedName === PRESET_SLOW) {
                await new Promise(r => setTimeout(r, 250));
                await route.continue();
                return;
            }
            if (requestedName === PRESET_BROKEN) {
                await route.fulfill({
                    status: 500,
                    contentType: 'application/json',
                    body: JSON.stringify({ error: 'corrupted preset file' }),
                });
                return;
            }
            await route.continue();
        });

        const overlapReport = await page.evaluate(async ({ slowName, betaName, brokenName }) => {
            const { getPresetManager } = await import('/scripts/preset-manager.js');
            const { getPresetApplicationPromise } = await import('/scripts/openai.js');
            const ctx = window.Luker.getContext();
            const pm = getPresetManager('openai');
            const raw = pm.getPresetListRaw();

            // Register unhydrated slots for Beacon Slow and Beacon Broken.
            const slowIdx = raw.presets.length;
            raw.presets.push(null);
            raw.preset_names[slowName] = slowIdx;
            window.jQuery('#settings_preset_openai').append(
                window.jQuery('<option></option>', { value: String(slowIdx), text: slowName }),
            );

            const brokenIdx = raw.presets.length;
            raw.presets.push(null);
            raw.preset_names[brokenName] = brokenIdx;
            window.jQuery('#settings_preset_openai').append(
                window.jQuery('<option></option>', { value: String(brokenIdx), text: brokenName }),
            );

            const events = [];
            const onBefore = (payload) => events.push(`before:${payload?.presetName}`);
            const onAfter = () => events.push(`after:${ctx.chatCompletionSettings.preset_settings_openai}`);
            const onChanged = (payload) => events.push(`changed:${payload?.name}`);
            ctx.eventSource.on(ctx.eventTypes.OAI_PRESET_CHANGED_BEFORE, onBefore);
            ctx.eventSource.on(ctx.eventTypes.OAI_PRESET_CHANGED_AFTER, onAfter);
            ctx.eventSource.on(ctx.eventTypes.PRESET_CHANGED, onChanged);

            let midHydrationSnapshot = null;
            let brokenSwitchState = null;
            try {
                const $sel = window.jQuery('#settings_preset_openai');
                const betaVal = String(raw.preset_names[betaName]);

                // Trigger switch 1 -> Beacon Slow (unhydrated, 250ms network delay).
                $sel.val(String(slowIdx)).trigger('change');

                // 40ms later, Beacon Slow is still fetching. Verify there is NO split-brain
                // between #settings_preset_openai and oai_settings.preset_settings_openai.
                await new Promise(r => setTimeout(r, 40));
                midHydrationSnapshot = {
                    domSelectedName: pm.getSelectedPresetName(),
                    activeSettingName: ctx.chatCompletionSettings.preset_settings_openai,
                };

                // Queue switch 2 -> Beacon Beta while Beacon Slow is still in flight.
                $sel.val(betaVal).trigger('change');

                await getPresetApplicationPromise();

                // 4. Trigger switch 3 -> Beacon Broken (HTTP 500) and verify clean rollback.
                $sel.val(String(brokenIdx)).trigger('change');
                await getPresetApplicationPromise();
                brokenSwitchState = {
                    domSelectedName: pm.getSelectedPresetName(),
                    activeSettingName: ctx.chatCompletionSettings.preset_settings_openai,
                    temp: ctx.chatCompletionSettings.temp_openai,
                    regexIds: (ctx.chatCompletionSettings.extensions?.regex_scripts || []).map(r => r.id),
                };
            } finally {
                ctx.eventSource.removeListener(ctx.eventTypes.OAI_PRESET_CHANGED_BEFORE, onBefore);
                ctx.eventSource.removeListener(ctx.eventTypes.OAI_PRESET_CHANGED_AFTER, onAfter);
                ctx.eventSource.removeListener(ctx.eventTypes.PRESET_CHANGED, onChanged);
            }

            return {
                midHydrationSnapshot,
                events,
                brokenSwitchState,
            };
        }, { slowName: PRESET_SLOW, betaName: PRESET_BETA, brokenName: PRESET_BROKEN });

        expect(overlapReport.midHydrationSnapshot).toEqual({
            domSelectedName: PRESET_ALPHA,
            activeSettingName: PRESET_ALPHA,
        });

        expect(overlapReport.events).toEqual([
            `before:${PRESET_SLOW}`,
            `after:${PRESET_SLOW}`,
            `changed:${PRESET_SLOW}`,
            `before:${PRESET_BETA}`,
            `after:${PRESET_BETA}`,
            `changed:${PRESET_BETA}`,
        ]);

        expect(overlapReport.brokenSwitchState).toEqual({
            domSelectedName: PRESET_BETA,
            activeSettingName: PRESET_BETA,
            temp: BETA_TEMP,
            regexIds: [BETA_REGEX_ID],
        });

        await expect(page.locator('.toast.toastr-error, .toast-error').first()).toBeVisible({ timeout: 5_000 });

        // Verify none of the three on-disk presets lost or cross-contaminated their regex_scripts.
        expect((readDiskPreset(server.dataRoot, PRESET_ALPHA).extensions?.regex_scripts || []).map(r => r.id)).toEqual([ALPHA_REGEX_ID]);
        expect((readDiskPreset(server.dataRoot, PRESET_SLOW).extensions?.regex_scripts || []).map(r => r.id)).toEqual([SLOW_REGEX_ID]);
        expect((readDiskPreset(server.dataRoot, PRESET_BETA).extensions?.regex_scripts || []).map(r => r.id)).toEqual([BETA_REGEX_ID]);
    });
});
