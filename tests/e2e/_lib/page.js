// Page interaction primitives shared by tests/e2e/**.
//
// Mirrors the inline awaitMainUI pattern used by tests/frontend/*.e2e.js
// and tests/skills-ui/playwright/*.spec.js, with a few additions:
// - login picker handling (admin / default-user) when present
// - drawer + inline-drawer toggles
// - chat send + wait-for-reply
// - swipe / edit / delete helpers
// - hard reload helper that waits for the preloader gate

import { expect } from '@playwright/test';

/**
 * Navigate to baseURL and wait for ST to leave the preloader.
 * Clicks the user-select gate if present (multi-user dev configs).
 * Also kicks the API connect handshake — settings.json may say
 * "use this custom URL" but the connection status only flips after
 * a getStatusOpen() call, which is normally tied to user click. We
 * trigger it programmatically so #send_but un-hides.
 */
export async function awaitMainUI(page, baseURL) {
    if (baseURL) await page.goto(baseURL);
    else await page.goto('/');
    const gate = page.locator('#userList .userSelect:last-child');
    try {
        await gate.waitFor({ state: 'visible', timeout: 2000 });
        await gate.click();
    } catch { /* auto-login path */ }
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 60_000 });
    // Give late-bound extensions a beat to register listeners.
    await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });
    // Kick the connect handshake. The CUSTOM backend bypasses the live
    // probe and just flips online_status to a non-"no_connection" string,
    // which is enough for #send_but to un-hide.
    await page.evaluate(async () => {
        // Click the Connect button if present (the canonical entry point).
        const btn = document.querySelector('#api_button_openai');
        if (btn) {
            btn.click();
            return;
        }
        // Fallback: directly call the exported status fetcher.
        try {
            const mod = await import('/scripts/openai.js');
            if (typeof mod.startStatusLoading === 'function') mod.startStatusLoading();
        } catch { /* no-op */ }
    });
    // Wait for either: send_but becomes visible, or 10s elapse — whichever first.
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
}

/**
 * Hard reload: navigate back to root and re-await main UI. Use after a
 * server restart so the page picks up post-restart state.
 */
export async function reloadAndAwait(page, baseURL) {
    return awaitMainUI(page, baseURL);
}

export async function openExtensionsDrawer(page) {
    const block = page.locator('#rm_extensions_block');
    const isOpen = await block.evaluate(el => el && !el.classList.contains('closedDrawer')).catch(() => false);
    if (isOpen) return;
    await page.locator('#extensions-settings-button .drawer-toggle').first().click();
    await block.waitFor({ state: 'visible', timeout: 5000 });
}

export async function openInlineDrawer(page, hostId) {
    const host = page.locator(`#${hostId}`);
    await host.waitFor({ state: 'attached', timeout: 5000 });
    const drawer = host.locator('> .inline-drawer').first();
    const content = drawer.locator('> .inline-drawer-content');
    const isHidden = await content.evaluate(el => {
        if (!el) return true;
        const style = el.style.display;
        if (style === 'none') return true;
        if (style === 'block' || style === '') {
            const computed = window.getComputedStyle(el);
            return computed.display === 'none';
        }
        return false;
    }).catch(() => true);
    if (!isHidden) return;
    await drawer.locator('> .inline-drawer-toggle').first().click();
    await content.waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Select a character by its display name. Opens the right nav drawer
 * (Character Management) first if it's closed, then clicks the matching
 * card. Falls back to programmatic selection through the context API
 * if the DOM card never appears within 5 seconds — useful when the
 * drawer animation is slow or hidden behind another modal.
 */
export async function selectCharacterByName(page, name) {
    // Dismiss the onboarding modal if it's the topmost popup. Fixtures
    // set settings.firstRun = false, but a fresh dataRoot the first time
    // it ever boots may still flash the legacy modal before settings.json
    // is rewritten — be defensive.
    const onboardingCancel = page.locator('.popup .popup-button-cancel, .popup .popup-button-ok').first();
    const onboardingHeader = page.locator('.popup', { hasText: /Welcome to Luker|歡迎使用|欢迎使用/ }).first();
    if (await onboardingHeader.isVisible().catch(() => false)) {
        await onboardingCancel.click().catch(() => {});
        await onboardingHeader.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }

    // Open the right-side character drawer if it isn't already open.
    const drawer = page.locator('#rightNavDrawerIcon');
    const drawerClosed = await drawer.evaluate(el => el.classList.contains('closedIcon')).catch(() => true);
    if (drawerClosed) {
        await drawer.click();
    }
    const charBlock = page.locator('#rm_print_characters_block');
    await charBlock.waitFor({ state: 'visible', timeout: 10_000 });

    const card = charBlock.locator('.character_select', { hasText: name }).first();
    try {
        await card.waitFor({ state: 'visible', timeout: 5000 });
        await card.click();
    } catch {
        // DOM card not found — try programmatic selection.
        const picked = await page.evaluate((wantName) => {
            const ctx = window.Luker.getContext();
            const idx = ctx.characters.findIndex(c => c?.name === wantName);
            if (idx < 0) return false;
            // Mirror what setCharacterId + selectCharacter does — fire the
            // CHARACTER_SELECTED event via the chid attribute on the card.
            const sel = document.querySelector(`#rm_print_characters_block .character_select[chid="${idx}"]`);
            if (sel) { sel.click(); return true; }
            return false;
        }, name);
        if (!picked) throw new Error(`character "${name}" not present in data dir`);
    }

    // Wait for chat panel to populate or welcome panel to refresh.
    await page.waitForFunction(() => {
        const ctx = window.Luker?.getContext?.();
        return ctx && (typeof ctx.characterId === 'number' || typeof ctx.characterId === 'string');
    }, { timeout: 10_000 }).catch(() => { /* welcome panel path is ok */ });
}

/**
 * Send a user message and wait until the assistant reply mesage element
 * is fully appended to the chat list. Returns the reply text.
 *
 * Uses MESSAGE_RECEIVED event for fidelity instead of polling DOM.
 *
 * Drives via slash commands rather than clicking #send_but, so it
 * doesn't depend on the connection-status indicator turning green.
 * (Live tests may want to drive the click for true UI parity — see
 * sendMessageViaButtonAndAwaitReply below.)
 */
export async function sendMessageAndAwaitReply(page, text, { timeoutMs = 120_000 } = {}) {
    const replyPromise = page.evaluate((to) => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('reply timeout')), to);
        const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, (id) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_RECEIVED, off); } catch {}
            resolve(id);
        });
    }), timeoutMs);

    await page.evaluate(async (msg) => {
        const ctx = window.Luker.getContext();
        // Mirror what the send button does: append user message, trigger
        // generation. Using the slash-command runtime is the most reliable
        // entry point that's stable across versions.
        await ctx.executeSlashCommandsWithOptions(`/send ${msg.replace(/\n/g, ' ')} | /trigger`);
    }, text);

    const replyId = await replyPromise;
    const reply = await page.evaluate((id) => {
        const ctx = window.Luker.getContext();
        return ctx.chat[id]?.mes || '';
    }, replyId);
    return { replyId, text: reply };
}

/**
 * Send via the actual DOM send button — slower path, but exercises the
 * connect-status / button-visibility code path. Requires the API to be
 * reachable (so #send_but is not display:none).
 */
export async function sendMessageViaButtonAndAwaitReply(page, text, { timeoutMs = 120_000 } = {}) {
    const replyPromise = page.evaluate((to) => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('reply timeout')), to);
        const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, (id) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_RECEIVED, off); } catch {}
            resolve(id);
        });
    }), timeoutMs);

    const textarea = page.locator('#send_textarea');
    await textarea.fill(text);
    // Wait until the connect status flip removes displayNone — up to 30s.
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('#send_but').click();
    const replyId = await replyPromise;
    const reply = await page.evaluate((id) => {
        const ctx = window.Luker.getContext();
        return ctx.chat[id]?.mes || '';
    }, replyId);
    return { replyId, text: reply };
}

/**
 * Trigger a swipe (regen variant) on the latest assistant message.
 * Returns the new variant text.
 */
export async function swipeRightOnLatest(page, { timeoutMs = 120_000 } = {}) {
    const swipePromise = page.evaluate((to) => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('swipe timeout')), to);
        const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_SWIPED, (id) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_SWIPED, off); } catch {}
            resolve(id);
        });
    }), timeoutMs);
    const right = page.locator('.last_mes .swipe_right').last();
    await right.click();
    const swipeId = await swipePromise;
    const text = await page.evaluate((id) => {
        const ctx = window.Luker.getContext();
        return ctx.chat[id]?.mes || '';
    }, swipeId);
    return { swipeId, text };
}

/**
 * Delete the latest message via the in-app slash command, which is
 * more deterministic than driving the message-action context menu.
 */
export async function deleteLastMessage(page) {
    await page.evaluate(async () => {
        await window.Luker.getContext().executeSlashCommandsWithOptions('/cut last');
    });
}

/**
 * Edit a message by id: replaces text and clicks confirm.
 */
export async function editMessageById(page, messageId, newText) {
    await page.evaluate(({ id, text }) => {
        const ctx = window.Luker.getContext();
        ctx.chat[id].mes = text;
        ctx.saveChat();
        ctx.eventSource.emit(ctx.eventTypes.MESSAGE_EDITED, id);
        ctx.eventSource.emit(ctx.eventTypes.MESSAGE_UPDATED, id);
    }, { id: messageId, text: newText });
}

/**
 * Return chat metadata + message array — useful for cross-restart
 * persistence assertions.
 */
export async function getChatSnapshot(page) {
    return page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return {
            chatId: ctx.getCurrentChatId?.(),
            length: ctx.chat?.length,
            messages: ctx.chat?.map(m => ({
                name: m.name,
                is_user: !!m.is_user,
                mes: m.mes,
                swipes: Array.isArray(m.swipes) ? m.swipes.slice() : undefined,
                swipe_id: m.swipe_id,
            })),
            metadata: ctx.chatMetadata,
        };
    });
}

/**
 * Abort an in-flight generation by clicking the stop button.
 */
export async function abortGeneration(page) {
    const stop = page.locator('#mes_stop');
    await stop.click({ trial: false }).catch(() => {});
}

/**
 * Install a minimal director-mode orchestrator profile. The default
 * profile ships with 12 mandatory sub-agents whose system prompts pull
 * in skills via lazy resolvers — fine for production but expensive to
 * drive from a mock LLM router. This helper writes a lean profile that
 * has only the sub-agents the test cares about, then activates director
 * mode.
 *
 * Pass `subAgents: []` (the default) for a single-main-agent profile —
 * the simplest possible director run, useful when the test only wants to
 * exercise write_message → finalize. Pass an array of `{ id, description,
 * systemPrompt, tools? }` to define sub-agents the main agent can
 * dispatch via `dispatch_subagent({ subagentId, task })`.
 *
 * The profile also disables every default sub-agent skill (`skills:
 * { visible: [], deny: [] }`) so the resolver doesn't append a giant
 * `<available_skills>` catalog block to each prompt — keeps the
 * sub-agent payload predictable for assertions.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} [opts]
 * @param {string} [opts.mainSystemPrompt]
 * @param {Array<object>} [opts.subAgents]
 * @param {object} [opts.tools]   Optional override of profile.tools — by
 *                                default everything is OFF except collab.
 */
export async function installMinimalDirectorProfile(page, {
    mainSystemPrompt = 'You are the test director. Use the available tools to drive the turn to completion.',
    subAgents = [],
    tools = null,
} = {}) {
    await page.evaluate(async ({ mainSystemPrompt, subAgents, tools }) => {
        const ctx = window.Luker.getContext();
        const settings = ctx.extensionSettings?.orchestrator;
        if (!settings) throw new Error('orchestrator settings missing — extension not loaded');

        settings.enabled = true;
        settings.executionMode = 'director';
        settings.singleAgentModeEnabled = false;
        // Cap retries so a misconfigured router fails fast instead of
        // burning a long timeout pumping the no-tool-call retry loop.
        settings.toolCallRetryMax = 1;

        const presetLib = await import('/scripts/extensions/orchestrator/preset-library.js');
        const dirDefaults = await import('/scripts/extensions/orchestrator/director-defaults.js');

        // Build a flat director profile that goes through the canonical
        // sanitizer so the runtime sees the expected shape regardless of
        // what the per-spec hand-written input looked like.
        const minimalProfile = {
            mode: 'director',
            skills: { visible: [], deny: [] },
            mainAgent: {
                promptPresetName: '',
                apiPresetName: '',
                systemPrompt: mainSystemPrompt,
                skills: { visible: [], deny: [] },
            },
            subAgents: (subAgents || []).map(a => ({
                id: String(a.id),
                description: String(a.description || ''),
                systemPrompt: String(a.systemPrompt || ''),
                promptPresetName: '',
                apiPresetName: '',
                tools: a.tools || null,
                maxRounds: a.maxRounds ?? null,
                skills: { visible: [], deny: [] },
            })),
            tools: tools || {
                // Bare-minimum tool set: collaboration (so dispatch tools
                // appear when subAgents are present) + nothing else. The
                // sanitizer fills in canonical false-defaults for every
                // namespace not listed.
                collab: { dispatch_subagent: true, dispatch_inline_subagent: true },
            },
            maxRounds: 8,
            maxConcurrentSubagents: 4,
            maxTotalSubagentRuns: 8,
            discardOnAbort: false,
        };
        const sanitized = dirDefaults.sanitizeDirectorProfile(minimalProfile);
        // Overwrite the active preset with the sanitized minimal profile.
        // The active preset is what `getEffectiveProfile()` reads on every
        // GENERATE_TAKEOVER_DISPATCH, so this replaces the default ship-
        // of-twelve sub-agents with the lean test fixture for the rest of
        // the spec's lifetime.
        const ok = presetLib.writeActivePreset(settings, 'director', 'global', sanitized);
        if (!ok) throw new Error('writeActivePreset failed; library not seeded');
        // saveSettings(0, { directSave: true }) is the positional form
        // (per lessons memo). Flushes to disk so a server restart in
        // the spec can rehydrate the profile if it needs to.
        try { await ctx.saveSettings?.(0, { directSave: true }); } catch (_) { /* best-effort */ }
        ctx.saveSettingsDebounced?.();
    }, { mainSystemPrompt, subAgents, tools });
}
