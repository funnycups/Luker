/**
 * Task 9 — e2e: critic regex search flow.
 *
 * Exercises the regex-search tools added in Tasks 1-5:
 *   - draft_search   (sub-agent scoped, lives on the in-flight assistant message)
 *   - chat_search    (loop tool, regex over chat floors)
 *
 * The spec has two independent passes inside one test so a single
 * dev-server boot covers both shapes:
 *
 *   (A) Smoke pass — direct tool invocation.
 *       Drives `executeLoopTool('chat_search', ...)` and the
 *       sub-agent draft_search executor against an injected chat array
 *       and a fake handle. No model traffic, no UI clicks. Asserts the
 *       grep-style success shape AND the invalid-regex error shape
 *       (must include the "escape regex metacharacters" hint from
 *       grep-tool.js).
 *
 *   (B) Full critic dispatch — real director run with real model.
 *       Sets up a chat with a knowable fact, primes a draft containing
 *       (a) a platform-frame leakage line voice_critic must catch and
 *       (b) a knowledge-boundary name continuity_critic must flag, then
 *       triggers a director turn. Asserts that both critic sub-agent
 *       traces contain `draft_search` invocations (and that
 *       continuity_critic also fires `chat_search`).
 *
 *       This pass requires:
 *         - a connection profile configured in the user dir (Claude /
 *           OpenAI / Anthropic / Gemini) with a working API key, AND
 *         - the data dir has at least one selectable character card.
 *       If either is missing the pass `test.skip()`s with a precise
 *       reason — the smoke pass still runs and is the assertion of
 *       record for the regex-search wiring.
 *
 * Why both passes live in one file:
 *   The smoke pass is the deterministic regression contract for the
 *   tool registration and the grep helper return shape — it MUST pass
 *   on every dev-server boot regardless of LLM availability. The full
 *   critic dispatch is the live integration check that proves the
 *   critic skills now *use* the regex tools; it gracefully degrades
 *   when env doesn't have a model. Keeping both passes co-located makes
 *   the regex-search story easy to read and easy to maintain.
 *
 * Helpers (inlined, mirroring _local-orch-presets.spec.js):
 *   The shared helpers.js currently exports only the four core helpers
 *   (awaitMainUI, screenshotPath, ensureExtensionsDrawerOpen,
 *   ensureInlineDrawerOpen, openSkillManagerPanel,
 *   ensureSkillsApiAvailable). director-with-skills.spec.js and several
 *   siblings import names from helpers.js that the module never exports
 *   — those specs fail at import time. This spec stays self-contained:
 *   only the four real exports are imported; everything else is inlined
 *   below.
 *
 * Run:
 *   PLAYWRIGHT_BASE_URL=http://127.0.0.1:8088 \
 *     npx playwright test \
 *     skills-ui/playwright/critic-regex-search.spec.js --workers=1
 */

import { test, expect } from '@playwright/test';
import {
    awaitMainUI,
} from './helpers.js';

// Markers chosen to be impossible to hallucinate — the chat fact /
// brief / draft strings deliberately use distinct, story-realistic
// phrasing so we can grep the trace for evidence the critic actually
// scanned this content.
//
// Story-immersive (per `feedback_docs_conventions`): the chat
// establishes a name + age the writer would draw on; the draft then
// breaks two specific contracts:
//   - "上一轮你说要去赴宴" — platform-frame leakage (voice_critic Class B).
//   - "李府" — a place name the brief never mentioned, but a character
//     in-scene references as if it were known (continuity_critic
//     knowledge-boundary violation).
const ESTABLISHED_NAME = '张明远';
const KNOWN_AGE = '二十';
const CHAT_TURN_ESTABLISHING_FACT =
    `她端起茶盏，目光落在他脸上：「你的名字是${ESTABLISHED_NAME}，今年${KNOWN_AGE}岁。」`;
const ROSTER_BRIEF =
    `本场人物：${ESTABLISHED_NAME}（场上唯一非旁白角色）。无其他角色登场。`;
const KNOWLEDGE_BOUNDARY_PLACE = '李府';
const DRAFT_PLATFORM_FRAME_LINE =
    '上一轮你说要去赴宴，可这一刻她却把帖子搁在了案头。';
const DRAFT_KNOWLEDGE_BOUNDARY_LINE =
    `${ESTABLISHED_NAME}抬眼便道：「${KNOWLEDGE_BOUNDARY_PLACE}的灯今夜也未点。」`;
const DRAFT_BODY = [
    `${DRAFT_PLATFORM_FRAME_LINE}`,
    '',
    `${DRAFT_KNOWLEDGE_BOUNDARY_LINE}`,
    '',
    '夜风从回廊外吹过，烛芯轻轻一颤。',
].join('\n');

test.describe.configure({ retries: 0 });

test.describe('Orchestrator: critic regex-search flow', () => {
    test.setTimeout(600_000);

    test('smoke pass + (optional) live critic dispatch exercise regex search tools', async ({ page }) => {
        // Surface browser-side errors so flake debugging stays readable.
        page.on('pageerror', err => console.warn(`[browser:error] ${err.message}`));

        await awaitMainUI(page);

        // ── (A) Smoke pass — direct tool invocations ─────────────────
        // We import the orchestrator's `executeLoopTool` plus the
        // sub-agent draft_search executor through the dev server's
        // module URLs (the same paths the running app uses). Then we
        // run a chat_search with a valid regex against a synthetic chat
        // array and an invalid regex (`[unclosed`) and assert on the
        // documented return shapes.
        const smoke = await page.evaluate(async ({ establishedName, knownAge }) => {
            const loopMod = await import('/scripts/extensions/orchestrator/loop-tools.js');
            const dirMod = await import('/scripts/extensions/orchestrator/director-tools.js');

            // Synthetic chat. `is_user` / `is_system` shape matches what
            // chat.js's executor expects (see roleFromMessage there); the
            // first message is the establishing turn, the second is a
            // distractor so the regex match isn't trivially the only line.
            const chat = [
                { is_user: false, mes: `narrator: 灯下走廊一片寂静。${establishedName} 端坐窗前。` },
                {
                    is_user: false,
                    mes: `她端起茶盏，目光落在他脸上：「你的名字是${establishedName}，今年${knownAge}岁。」`,
                },
                { is_user: true, mes: '我点了点头，没说话。' },
            ];

            // (A.1) Valid regex search — match the established name.
            //       Loop tools return a JSON-serializable result; the
            //       grep helper returns { ok: true, output } when the
            //       pattern parses.
            const validResult = await loopMod.executeLoopTool(
                'chat_search',
                { pattern: establishedName, flags: 'gm' },
                { chat },
            );

            // (A.2) Invalid regex — unclosed bracket. The grep helper
            //       must return { ok: false, error: '...escape regex
            //       metacharacters...' } so the agent can self-correct.
            const invalidResult = await loopMod.executeLoopTool(
                'chat_search',
                { pattern: '[unclosed', flags: 'gm' },
                { chat },
            );

            // (A.3) draft_search direct executor — synthesize a minimal
            //       handle that exposes getText() (the only method
            //       executeDraftSearchTool reads). Same return shape as
            //       chat_search: { ok: true, output } / { ok: false, error }.
            const draftText = `第一行无事。\n第二行出现 ${establishedName}。\n第三行又出现 ${establishedName} 和邻人。`;
            const fakeHandle = { getText: () => draftText };
            const draftValidResult = await dirMod.executeDraftSearchTool(
                fakeHandle,
                { pattern: establishedName, flags: 'gm' },
            );
            const draftInvalidResult = await dirMod.executeDraftSearchTool(
                fakeHandle,
                { pattern: '(unclosed', flags: 'gm' },
            );

            return { validResult, invalidResult, draftValidResult, draftInvalidResult };
        }, { establishedName: ESTABLISHED_NAME, knownAge: KNOWN_AGE });

        // chat_search returns its grep-style payload directly (no extra
        // envelope) because it's registered as a loop tool whose exec
        // returns the result the agent will see.
        expect(smoke.validResult).toBeTruthy();
        expect(smoke.validResult.ok, 'valid chat_search returns ok=true').toBe(true);
        expect(typeof smoke.validResult.output, 'valid chat_search returns string output').toBe('string');
        // grep -n shape: `floor_{N} [{role}]:{lineno}: {line}`. The match
        // is on chat[1], which is an assistant message.
        expect(smoke.validResult.output).toMatch(/floor_1 \[assistant\]:1: /);
        expect(smoke.validResult.output).toContain(ESTABLISHED_NAME);

        expect(smoke.invalidResult).toBeTruthy();
        expect(smoke.invalidResult.ok, 'invalid chat_search returns ok=false').toBe(false);
        expect(typeof smoke.invalidResult.error).toBe('string');
        expect(
            smoke.invalidResult.error,
            'invalid regex error explains the escape-metacharacters fix',
        ).toMatch(/escape regex metacharacters/);

        // draft_search uses the same gatherGrepMatches helper, so the
        // shapes mirror chat_search; output prefix is empty for the
        // single-document corpus, so each line starts with `{lineno}: `.
        expect(smoke.draftValidResult).toBeTruthy();
        expect(smoke.draftValidResult.ok, 'valid draft_search returns ok=true').toBe(true);
        expect(smoke.draftValidResult.output).toMatch(/^2: .*张明远/m);
        expect(smoke.draftValidResult.output).toMatch(/^3: .*张明远/m);

        expect(smoke.draftInvalidResult).toBeTruthy();
        expect(smoke.draftInvalidResult.ok, 'invalid draft_search returns ok=false').toBe(false);
        expect(smoke.draftInvalidResult.error).toMatch(/escape regex metacharacters/);

        // eslint-disable-next-line no-console
        console.log('[critic-regex-search] smoke pass: chat_search + draft_search valid/invalid shapes asserted.');

        // ── (B) Full critic dispatch — real director run ─────────────
        // Requires both a configured connection profile and a loaded
        // character. Soft-skip the rest of the test when either is
        // missing so the smoke pass still counts as a green run.
        const env = await prepareDirectorEnv(page);
        test.skip(
            !env.ok,
            `critic dispatch pass requires ${env.reason}; smoke pass still asserts the regex-search return shape`,
        );
        if (!env.ok) return; // Belt-and-suspenders: ensure no further code runs after skip.

        // Wait for the orchestrator extension to populate its preset
        // library. It loads asynchronously after the main bootstrap; if
        // we tried to mutate the active preset before it's there, the
        // snapshot-and-restore block would throw.
        try {
            await page.waitForFunction(
                () => {
                    const s = window.SillyTavern?.getContext?.()?.extensionSettings?.orchestrator;
                    return Boolean(s?.presetLibraries?.director && s?.activePresetIds);
                },
                { timeout: 30000 },
            );
        } catch {
            test.skip(true, 'orchestrator preset library is not initialized in this session; smoke pass still asserts the regex-search return shape');
            return;
        }

        // Mode + critic-tool gating. Critics ship with `chat.read_range`
        // only; the new skill texts ask them to use `chat_search` /
        // `draft_search`, so we toggle the search flag on for both
        // critics for this spec. The director profile lives at
        // `extension_settings.orchestrator.presetLibraries.director[activePresetIds.director]`
        // after the preset-library refactor (commit a4ce3b948); if the
        // active preset has no sub-agents (user-customized empty preset),
        // we temporarily switch to the `default` preset which ships with
        // the two critics. Snapshot everything we mutate so we can restore.
        const restoreState = await page.evaluate(({ criticIds }) => {
            const ctx = window.SillyTavern?.getContext?.();
            if (!ctx) throw new Error('SillyTavern context missing');
            const settings = ctx.extensionSettings?.orchestrator;
            if (!settings) throw new Error('orchestrator settings missing');
            const lib = settings.presetLibraries?.director;
            if (!lib || typeof lib !== 'object') {
                throw new Error('orchestrator preset library not initialized');
            }
            const activeIds = settings.activePresetIds || (settings.activePresetIds = {});
            const prevDirectorPresetId = String(activeIds.director || '');
            const prevExecutionMode = String(settings.executionMode || '');
            // Pick a preset that actually has the two critics. Prefer the
            // current active preset if it does; fall back to 'default'.
            let useId = prevDirectorPresetId;
            const hasCritics = (preset) =>
                preset && Array.isArray(preset.subAgents)
                && criticIds.every(cid => preset.subAgents.some(a => a?.id === cid));
            if (!hasCritics(lib[useId])) {
                if (hasCritics(lib.default)) useId = 'default';
                else {
                    // Find any preset with both critics.
                    const fallback = Object.keys(lib).find(k => hasCritics(lib[k]));
                    if (!fallback) throw new Error('no director preset in library has voice_critic + continuity_critic');
                    useId = fallback;
                }
            }
            activeIds.director = useId;
            settings.executionMode = 'director';
            const dir = lib[useId];
            const before = JSON.parse(JSON.stringify(dir.subAgents.filter(a => criticIds.includes(a?.id))));
            for (const id of criticIds) {
                const agent = dir.subAgents.find(a => a?.id === id);
                if (!agent) continue;
                if (!agent.tools || typeof agent.tools !== 'object') agent.tools = {};
                if (!agent.tools.chat || typeof agent.tools.chat !== 'object') agent.tools.chat = {};
                agent.tools.chat.read_range = true;
                agent.tools.chat.search = true;
                if (id === 'continuity_critic') {
                    if (!agent.tools.lorebook || typeof agent.tools.lorebook !== 'object') agent.tools.lorebook = {};
                    agent.tools.lorebook.search = true;
                }
            }
            if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
            return { prevExecutionMode, prevDirectorPresetId, mutatedPresetId: useId, criticSnapshot: before };
        }, { criticIds: ['voice_critic', 'continuity_critic'] });

        // Seed the chat with the establishing fact so chat_search has
        // something to match. We push directly to ctx.chat — the
        // dispatcher reads context.chat, which IS the live array.
        await page.evaluate(({ fact, brief }) => {
            const ctx = window.SillyTavern?.getContext?.();
            if (!ctx) throw new Error('SillyTavern context missing');
            const chat = Array.isArray(ctx.chat) ? ctx.chat : null;
            if (!chat) throw new Error('ctx.chat array missing');
            chat.push({
                is_user: false,
                is_system: false,
                name: 'narrator',
                send_date: new Date().toISOString(),
                mes: fact,
            });
            chat.push({
                is_user: true,
                is_system: false,
                name: 'user',
                send_date: new Date().toISOString(),
                mes: `（task brief）${brief}`,
            });
        }, { fact: CHAT_TURN_ESTABLISHING_FACT, brief: ROSTER_BRIEF });

        // Clear any leftover store run before dispatch so the probe
        // can't read a stale committed frame.
        await page.evaluate(async () => {
            try {
                const m = await import('/scripts/extensions/orchestrator/run-state/store.js');
                m.clearCurrentRun?.();
            } catch { /* store module not loaded yet */ }
        });

        // Drive the director turn through the user-input + send path.
        // We deliberately reference the draft markers so the main agent
        // has a reason to dispatch the critics on a draft containing
        // those exact phrases — the brief also instructs the main agent
        // to keep those phrases verbatim in the draft.
        const driverPrompt = [
            `请按 director 流程完整跑一轮。Brief 给两条硬要求：`,
            `(1) 必须把这段当作 draft 的关键段落原文写入：`,
            `--- draft 起 ---`,
            `${DRAFT_BODY}`,
            `--- draft 止 ---`,
            `(2) 出 draft 后 dispatch voice_critic 与 continuity_critic 在 parallel 中复核这段 draft。Brief 内告知 continuity_critic：roster 仅有 ${ESTABLISHED_NAME}（${KNOWN_AGE}岁），任何其他角色 / 地名都需要核对 chat 是否提及。`,
            `请同时使用 draft_search / chat_search 等 regex 工具完成扫描。`,
        ].join('\n');

        await page.evaluate(async (prompt) => {
            const ta = document.getElementById('send_textarea');
            if (!ta) throw new Error('send_textarea not present in DOM');
            ta.value = prompt;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            const btn = document.getElementById('send_but');
            if (!btn) throw new Error('send_but not present in DOM');
            btn.click();
        }, driverPrompt);

        // Wait for the run-state store to settle. Director with critics
        // can take a few minutes on a real LLM; we cap at 9 minutes
        // which leaves headroom under the 10-minute per-test cap.
        const runResult = await page.evaluate(async () => {
            const settled = new Set(['committed', 'aborted', 'error']);
            const deadline = 540_000;
            const start = Date.now();
            while (Date.now() - start < deadline) {
                try {
                    const mod = await import('/scripts/extensions/orchestrator/run-state/store.js');
                    const s = mod.getCurrentRun();
                    if (s && settled.has(String(s.status || ''))) {
                        const safe = JSON.parse(JSON.stringify(s, (k, v) => (k === 'abortFn' ? undefined : v)));
                        return { status: String(s.status), state: safe };
                    }
                } catch { /* keep polling */ }
                await new Promise(r => setTimeout(r, 1500));
            }
            return { status: 'timeout', state: null };
        });

        try {
            expect(runResult.status, 'director run reached a terminal status before deadline').not.toBe('timeout');
            const state = runResult.state;
            expect(state, 'run state exists in the store').toBeTruthy();
            expect(Array.isArray(state.rounds) && state.rounds.length > 0, 'store recorded at least one round').toBe(true);

            // Each sub-agent dispatch opens its own top-level round in
            // the store with id `sub-<subagentId>-<n>`. The two critic
            // ids we mutated above are `voice_critic` and
            // `continuity_critic`; collect every round per-critic.
            const roundsForSubagent = (subagentId) => state.rounds.filter(r => String(r.id || '').startsWith(`sub-${subagentId}-`));
            const voiceRounds = roundsForSubagent('voice_critic');
            const continuityRounds = roundsForSubagent('continuity_critic');
            // eslint-disable-next-line no-console
            console.log(`[critic-regex-search] sub-agent rounds: voice_critic=${voiceRounds.length}, continuity_critic=${continuityRounds.length}`);

            expect(voiceRounds.length, 'voice_critic was dispatched at least once').toBeGreaterThan(0);
            expect(continuityRounds.length, 'continuity_critic was dispatched at least once').toBeGreaterThan(0);

            // Collect every tool_call name from a critic's rounds. The
            // sub-agent runner stores each invocation as a section with
            // kind='tool_call' and title='Tool: <name>'; meta.args carries
            // the raw arguments object.
            const collectToolCalls = (rounds) => {
                const out = [];
                for (const round of rounds) {
                    const sections = Array.isArray(round.sections) ? round.sections : [];
                    for (const sec of sections) {
                        if (sec.kind !== 'tool_call') continue;
                        const name = String(sec.title || '').replace(/^Tool: /, '');
                        if (!name) continue;
                        // Paired tool_result is `tool-result-...` matching the call's id.
                        const resultId = String(sec.id).replace(/^tool-/, 'tool-result-');
                        const result = sections.find(s => s.id === resultId) || null;
                        out.push({
                            name,
                            args: sec.meta?.args ?? {},
                            resultOk: result ? !!result.meta?.ok : null,
                        });
                    }
                }
                return out;
            };

            const voiceToolCalls = collectToolCalls(voiceRounds);
            const continuityToolCalls = collectToolCalls(continuityRounds);
            // eslint-disable-next-line no-console
            console.log(`[critic-regex-search] voice tool calls: ${voiceToolCalls.map(t => t.name).join(', ') || '(none)'}`);
            // eslint-disable-next-line no-console
            console.log(`[critic-regex-search] continuity tool calls: ${continuityToolCalls.map(t => t.name).join(', ') || '(none)'}`);

            // (B.1) voice_critic must invoke draft_search at least once
            //       — its skill text explicitly tells it to scan via
            //       draft_search for Class A / Class B vocabulary.
            const voiceDraftSearches = voiceToolCalls.filter(t => t.name === 'draft_search');
            expect(
                voiceDraftSearches.length,
                'voice_critic ran at least one draft_search (skill discipline)',
            ).toBeGreaterThan(0);

            // (B.2) continuity_critic must invoke draft_search AND
            //       chat_search — draft for the knowledge-boundary
            //       candidate, chat for verifying the OPPOSING fact.
            const continuityDraftSearches = continuityToolCalls.filter(t => t.name === 'draft_search');
            const continuityChatSearches = continuityToolCalls.filter(t => t.name === 'chat_search');
            expect(
                continuityDraftSearches.length,
                'continuity_critic ran at least one draft_search (skill discipline)',
            ).toBeGreaterThan(0);
            expect(
                continuityChatSearches.length,
                'continuity_critic ran at least one chat_search to verify the opposing fact',
            ).toBeGreaterThan(0);

            // (B.3) At least one of those regex searches succeeded —
            //       the store does not retain the tool_result body, so
            //       "result body contained a matched line" is no longer
            //       observable. ok=true on the paired tool_result is the
            //       surviving proxy: it proves the grep helper parsed
            //       the regex and returned a result envelope, which is
            //       what the critic skill chain consumes.
            const allCalls = [...voiceToolCalls, ...continuityToolCalls];
            const sawSuccessfulSearch = allCalls.some(c => (c.name === 'draft_search' || c.name === 'chat_search') && c.resultOk === true);
            expect(
                sawSuccessfulSearch,
                'at least one draft_search / chat_search call reported ok=true (the regex tool ran end-to-end)',
            ).toBe(true);

            // ── Note on dropped legacy assertion ──────────────────────
            // The previous spec scanned tool_result message bodies for
            // matched-line content (ESTABLISHED_NAME / KNOWLEDGE_BOUNDARY_PLACE
            // / "上一轮"). The RunStateStore stores tool_result section
            // metadata as `{ ok, err }` only, not the body. The
            // ok-true gate above is the surviving signal.
        } finally {
            // ── Teardown: restore the critic tool flags ──────────────
            // Best-effort — assertion failures already surfaced.
            try {
                await page.evaluate(({ criticSnapshot, prevExecutionMode, prevDirectorPresetId, mutatedPresetId }) => {
                    const ctx = window.SillyTavern?.getContext?.();
                    const settings = ctx?.extensionSettings?.orchestrator;
                    if (!settings) return;
                    const lib = settings.presetLibraries?.director;
                    if (lib && mutatedPresetId && Array.isArray(lib[mutatedPresetId]?.subAgents)) {
                        const subs = lib[mutatedPresetId].subAgents;
                        for (const snap of criticSnapshot || []) {
                            const idx = subs.findIndex(a => a?.id === snap?.id);
                            if (idx >= 0) subs[idx] = snap;
                        }
                    }
                    if (settings.activePresetIds && prevDirectorPresetId) {
                        settings.activePresetIds.director = prevDirectorPresetId;
                    }
                    if (prevExecutionMode) settings.executionMode = prevExecutionMode;
                    if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
                }, restoreState);
            } catch {
                // teardown is best-effort.
            }
        }
    });
});

// ─── Helpers (inlined; see file header for why) ──────────────────────────

/**
 * Probe the env to decide whether pass (B) can run. Returns
 * `{ ok: true }` when both a working connection profile is activated
 * and a character is loaded; otherwise `{ ok: false, reason }` so the
 * caller can `test.skip()` with a precise message.
 */
async function prepareDirectorEnv(page) {
    // The connection-manager extension initializes asynchronously AFTER
    // the preloader removal that awaitMainUI gates on. Without this wait,
    // /profile activation operates against a non-existent `<select>` and
    // never triggers ST's profile-load → status-check pipeline.
    try {
        await page.waitForFunction(
            () => Boolean(document.getElementById('connection_profiles')?.options?.length),
            { timeout: 30000 },
        );
    } catch {
        // Extension didn't initialize in time; fall through and let the
        // activation step report a clean "no profile reachable" reason.
    }
    const activated = await activateConnectionProfile(page).catch(() => '');
    if (!activated) {
        return {
            ok: false,
            reason: 'a connection profile reachable as online (set LUKER_PLAYWRIGHT_PROFILE or configure one in Connection Manager)',
        };
    }
    const llmReady = await page.evaluate(() => {
        const ctx = window.SillyTavern?.getContext?.();
        const v = ctx?.onlineStatus ?? null;
        return Boolean(v) && String(v).toLowerCase() !== 'no_connection';
    });
    if (!llmReady) {
        return {
            ok: false,
            reason: `connection profile "${activated}" activated but online_status is no_connection (provider may be unreachable or auth failed)`,
        };
    }
    const charAvatar = await ensureCharacterLoaded(page).catch(() => '');
    if (!charAvatar) {
        return {
            ok: false,
            reason: 'a loaded character (data dir has none, or the runtime did not surface one)',
        };
    }
    return { ok: true };
}

/**
 * Activate a real connection profile if one is configured. Returns
 * the profile name on success or '' when none usable. Mirrors the
 * approach used by `_local-orch-presets.spec.js` (which is itself
 * the standalone copy of the helper director-with-skills.spec.js
 * tries to import from helpers.js).
 */
async function activateConnectionProfile(page) {
    return await page.evaluate(async () => {
        const ctx = window.SillyTavern?.getContext?.();
        if (!ctx) return '';
        const profiles = ctx.extensionSettings?.connectionManager?.profiles;
        if (!Array.isArray(profiles) || !profiles.length) return '';
        const pinned = (
            (typeof process !== 'undefined' && process.env?.LUKER_PLAYWRIGHT_PROFILE)
            || ''
        ).toLowerCase();
        const pick = profiles.find(p => pinned && String(p.name || '').toLowerCase() === pinned)
            || profiles.find(p => /claude|openai|gpt|gemini|anthropic/i.test(String(p.name || '')))
            || profiles[0];
        if (!pick?.name) return '';
        try {
            await ctx.SlashCommandParser.commands.profile?.callback?.({}, pick.name);
        } catch {
            await ctx.executeSlashCommandsWithOptions?.(`/profile ${pick.name}`).catch(() => null);
        }
        await new Promise(r => setTimeout(r, 1000));
        const ok = String(ctx.onlineStatus || '').toLowerCase();
        return (ok && ok !== 'no_connection') ? pick.name : '';
    });
}

/**
 * Ensure a character card is loaded. If one is already selected we
 * return its avatar; otherwise we activate the first non-bogus
 * character via the `/char <name>` slash command. The DOM-click path
 * is unreliable in headless Chromium (ST's character tiles wire
 * jQuery handlers that don't always fire from a synthetic `.click()`),
 * so the slash command is the primary path.
 */
async function ensureCharacterLoaded(page) {
    return await page.evaluate(async () => {
        const ctx = window.SillyTavern?.getContext?.();
        if (!ctx) return '';
        const cur = ctx.characters?.[ctx.characterId];
        if (cur?.avatar) return String(cur.avatar);
        const list = Array.isArray(ctx.characters) ? ctx.characters : [];
        if (!list.length) return '';
        const first = list.find(c => c?.name && c?.avatar) || list.find(c => c?.avatar) || list[0];
        if (!first?.name) return '';
        try {
            await ctx.executeSlashCommandsWithOptions(`/char ${first.name}`);
            await new Promise(r => setTimeout(r, 500));
        } catch {
            // Fallback to DOM tile click if the slash command path isn't wired.
            const tile = document.querySelector(`#rm_print_characters_block [chid][bogus_folder='false']`)
                || document.querySelector(`#rm_print_characters_block [chid]`);
            if (tile && typeof tile.click === 'function') {
                tile.click();
                await new Promise(r => setTimeout(r, 250));
            }
        }
        const reload = ctx.characters?.[ctx.characterId];
        return String(reload?.avatar || first.avatar || '');
    });
}
