// Page interaction primitives for tests/e2e/**.
//
// Design principle (per audit response): every "act" in an e2e test should
// be a real user gesture against a real DOM element. The legacy helpers in
// this file routed sends through slash commands and routed edits through
// direct ctx.chat mutation — that gave us tests that pass when the visible
// buttons are deleted. The current iteration drives:
//   - send: fill #send_textarea + click #send_but (no fallback)
//   - edit: click .mes_edit, edit the contenteditable .mes_text, click .mes_edit_done
//   - delete: click .mes_edit then .mes_edit_delete, accept the confirm popup
//   - swipe: click .swipe_right / .swipe_left on the last bubble
//   - continue / regenerate: open the options dropdown, click #option_continue / #option_regenerate
//   - abort: click #mes_stop
//   - DOM assertions read .mes[mesid].mes_text innerText, .swipes-counter, etc.
//
// Programmatic shortcuts (sendMessageProgrammatic, editMessageProgrammatic, etc.)
// are exposed for the few places where the test cares about a server-side
// invariant (rate-limit, queueing, persistence under load) rather than the
// UI. They are NOT the default and must be named explicitly.

import { expect } from '@playwright/test';
import { accountWindow, openUserManagement, pageHead } from './account-window.js';

/**
 * Navigate to baseURL and wait for ST to leave the preloader. Clicks the
 * user-select gate if present, completes fresh-user onboarding through its
 * visible form, and waits for an auto-connect handshake when the fixture
 * enabled Auto-connect.
 */
export async function awaitMainUI(page, baseURL) {
    if (baseURL) await page.goto(baseURL);
    else await page.goto('/');
    const gate = page.locator('#userList .userSelect:last-child');
    try {
        await gate.waitFor({ state: 'visible', timeout: 2000 });
        await gate.click();
    } catch { /* auto-login path */ }
    await page.waitForFunction(() => document.getElementById('preloader') === null && !!window.Luker?.getContext
        && performance.getEntriesByName('[init] complete').length > 0, null, { timeout: 60_000 });
    await completeOnboarding(page);
    const autoConnect = await page.evaluate(() => window.Luker.getContext().powerUserSettings?.auto_connect === true);
    if (autoConnect) await waitForConnected(page);
}

export async function reloadAndAwait(page, baseURL) {
    return awaitMainUI(page, baseURL);
}

/**
 * Wait until the app shows it is connected: #send_but un-hides once the
 * status check succeeds. Generation helpers call this before acting, as
 * a user waits for the connection before generating.
 */
export async function waitForConnected(page, { timeoutMs = 30_000 } = {}) {
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: timeoutMs });
}

/**
 * Connect to the active API the way a user does without auto-connect:
 * open API Connections from the plug icon, click the visible Connect
 * button, wait for the status check to finish and close the drawer.
 * Whether the check reaches a backend is left to the caller.
 */
export async function connectViaApiDrawer(page) {
    const plug = page.locator('#API-status-top');
    const apiBlock = page.locator('#rm_api_block');
    await plug.click();
    await expect(apiBlock).toHaveClass(/\bopenDrawer\b/, { timeout: 5000 });
    const connect = apiBlock.locator('.api_button:visible').first();
    await connect.click();
    await expect(connect).not.toHaveClass(/\bdisabled\b/, { timeout: 30_000 });
    await plug.click();
    await expect(apiBlock).toHaveClass(/\bclosedDrawer\b/, { timeout: 5000 });
}

/**
 * Save an open welcome form and await its actual settings persistence.
 */
export async function completeOnboarding(page) {
    const welcome = page.locator('dialog.popup[open]', { has: page.locator('.onboarding') });
    if (!(await welcome.isVisible())) {
        // Onboarding is shown non-blocking after the init marker, so a fresh
        // data root can still open it a moment later. Wait before concluding
        // that this page has no welcome form.
        try {
            await welcome.waitFor({ state: 'visible', timeout: 1000 });
        } catch {
            return;
        }
    }
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings/save' && response.request().method() === 'POST');
    await welcome.locator('.popup-button-ok').click();
    await welcome.waitFor({ state: 'detached', timeout: 10_000 });
    if (!(await saved).ok()) throw new Error('Onboarding settings were not saved');
}

async function setDrawerState(drawer, open) {
    const content = drawer.locator('> .drawer-content');
    const icon = drawer.locator('> .drawer-toggle > .drawer-icon');
    const wanted = open ? /\bopenDrawer\b/ : /\bclosedDrawer\b/;
    if (await content.evaluate((element, open) => element.classList.contains(open ? 'closedDrawer' : 'openDrawer'), open)) {
        // The document mousedown consumer autocloses wrappers before their
        // click toggles them. Its explicit .drawer-icon target is exempt.
        await icon.and(drawer.page().locator(open ? '.closedIcon' : '.openIcon')).click();
    }
    await expect(content).toHaveClass(wanted, { timeout: 5000 });
    await expect(icon).toHaveClass(open ? /\bopenIcon\b/ : /\bclosedIcon\b/, { timeout: 5000 });
}

export async function openExtensionsDrawer(page) {
    await setDrawerState(page.locator('#extensions-settings-button'), true);
}

/**
 * Close the Extensions drawer (or any open top-settings-holder drawer
 * other than the always-visible nav rails) if it's currently open.
 *
 * Several extension specs open #rm_extensions_block to configure a
 * sub-extension (regex, AN, translate, TTS …) and then send a real user
 * message. The opened drawer-content sits on top of #send_but and
 * intercepts pointer events ("from <div id="top-settings-holder">
 * subtree intercepts pointer events"). Close it via the standard
 * .drawer-toggle handler so subsequent gestures land on the composer.
 *
 * Use this AFTER reading any user-supplied inputs from the drawer (the
 * Author's Note textarea, etc.) and BEFORE calling
 * sendMessageAndAwaitReply.
 */
export async function closeExtensionsDrawer(page) {
    await setDrawerState(page.locator('#extensions-settings-button'), false);
}

/**
 * Close any top-settings drawer (under #top-settings-holder) that has
 * the openDrawer class. This is the broader sibling of
 * closeExtensionsDrawer — it covers cases where the spec opened
 * a different settings drawer (#left-nav-panel, etc.) and needs all of
 * them closed before clicking the chat composer.
 */
export async function closeAnyOpenTopSettingsDrawer(page) {
    const drawers = page.locator('#top-settings-holder .drawer');
    const openIndices = await drawers.evaluateAll(elements => elements.flatMap((el, idx) => {
        const content = el.querySelector(':scope > .drawer-content');
        return content && content.classList.contains('openDrawer') && !content.classList.contains('pinnedOpen')
            ? [idx]
            : [];
    }));
    for (const idx of openIndices) {
        await setDrawerState(drawers.nth(idx), false);
    }
}

export async function openInlineDrawer(page, hostId) {
    const host = page.locator(`#${hostId}`);
    await host.waitFor({ state: 'attached', timeout: 5000 });
    // Most extension modules mount their HTML as `<div id="hostId">
    // <div class="inline-drawer">...</div></div>` (host is the direct
    // parent), but some wrap one more level (e.g.
    // `#translation_container > .translation_settings > .inline-drawer`,
    // `#regex_container > .regex_settings > .inline-drawer`). Look for
    // a direct child first; fall back to first descendant otherwise.
    let drawer = host.locator('> .inline-drawer').first();
    if ((await drawer.count()) === 0) {
        drawer = host.locator('.inline-drawer').first();
    }
    const content = drawer.locator('> .inline-drawer-content');
    const isHidden = await content.evaluate(el => {
        const style = el.style.display;
        if (style === 'none') return true;
        if (style === 'block' || style === '') {
            const computed = window.getComputedStyle(el);
            return computed.display === 'none';
        }
        return false;
    });
    if (!isHidden) return;
    await drawer.locator('> .inline-drawer-toggle').first().click();
    await content.waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Select a character by display name. Real path: open the right nav drawer
 * if closed, click the matching card, wait for chat panel to settle.
 *
 * The "programmatic" sibling is selectCharacterProgrammatic — use only when
 * the test explicitly needs to bypass card rendering (e.g. comparing UI
 * click vs API selection).
 */
export async function selectCharacterByName(page, name) {
    // Seed data roots that were not marked as onboarded show the welcome
    // popup on boot; a user dismisses it before reaching the list.
    const onboarding = page.locator('dialog.popup[open]', { hasText: /Welcome to Luker|歡迎使用|欢迎使用/ }).first();
    if (await onboarding.isVisible()) {
        await onboarding.locator('.popup-button-cancel, .popup-button-ok').first().click();
        await onboarding.waitFor({ state: 'detached', timeout: 5000 });
    }

    await setDrawerState(page.locator('#rightNavHolder'), true);

    // If a prior character was already selected, the right drawer is
    // showing the character-edit panel rather than the list. Click the
    // "Characters" sub-panel button so #rm_print_characters_block becomes
    // visible again.
    const listVisible = await page.locator('#rm_print_characters_block:visible').count().catch(() => 0);
    if (!listVisible) {
        await page.locator('#rm_button_characters').click();
        await page.locator('#rm_print_characters_block').waitFor({ state: 'visible', timeout: 10_000 });
    }

    const charBlock = page.locator('#rm_print_characters_block');
    if (!(await charBlock.isVisible())) {
        await page.locator('#rm_button_characters').click();
    }
    await charBlock.waitFor({ state: 'visible', timeout: 10_000 });

    const card = charBlock.locator('.character_select', { hasText: name }).first();
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    await card.click();

    await expect(page.locator('#character_name_pole')).toHaveValue(name, { timeout: 10_000 });

    // Selecting a character opens the character editor panel inside the
    // right drawer, which then overlays the chat composer. Close the
    // drawer so subsequent send-area gestures aren't intercepted by the
    // character_name_pole / description_textarea inputs.
    await closeRightNavDrawer(page);
}

/** Open the top bar drawer whose `.drawer` wrapper has id `drawerId` if it's closed. */
export async function openTopDrawer(page, drawerId) {
    const content = page.locator(`#${drawerId} > .drawer-content`);
    if (await content.evaluate(el => el.classList.contains('closedDrawer'))) {
        await page.locator(`#${drawerId} > .drawer-toggle`).click();
    }
    await content.waitFor({ state: 'visible', timeout: 5000 });
}

/** Close the top bar drawer whose `.drawer` wrapper has id `drawerId` if it's open. */
export async function closeTopDrawer(page, drawerId) {
    const content = page.locator(`#${drawerId} > .drawer-content`);
    if (!(await content.evaluate(el => el.classList.contains('closedDrawer')))) {
        await page.locator(`#${drawerId} > .drawer-toggle`).click();
    }
    await content.waitFor({ state: 'hidden', timeout: 5000 });
}

/** Open the User Settings drawer if it's closed. */
export async function openUserSettingsDrawer(page) {
    await openTopDrawer(page, 'user-settings-button');
}

/** Close the right nav (character management) drawer if it's open. */
export async function closeRightNavDrawer(page) {
    const isOpen = await page.evaluate(() => {
        const i = document.querySelector('#rightNavDrawerIcon');
        return i && i.classList.contains('openIcon');
    });
    if (isOpen) {
        // The character editor covers the drawer toggle while it opens; a
        // DOM click closes the drawer without depending on hit-testing.
        await page.evaluate(() => document.querySelector('#rightNavHolder > .drawer-toggle')?.click());
        await page.waitForFunction(() => {
            const i = document.querySelector('#rightNavDrawerIcon');
            return i && i.classList.contains('closedIcon');
        }, { timeout: 3000 }).catch(() => {});
    }
}

/**
 * Programmatic character selection — only when the test specifically needs
 * to bypass card click (e.g. focused isolation tests). Default to
 * selectCharacterByName.
 */
export async function selectCharacterProgrammatic(page, name) {
    return page.evaluate((wantName) => {
        const ctx = window.Luker.getContext();
        const idx = ctx.characters.findIndex(c => c?.name === wantName);
        if (idx < 0) throw new Error(`character "${wantName}" not present`);
        const sel = document.querySelector(`#rm_print_characters_block .character_select[chid="${idx}"]`);
        if (sel) { sel.click(); return idx; }
        if (typeof ctx.selectCharacterById === 'function') {
            ctx.selectCharacterById(idx);
            return idx;
        }
        throw new Error('no selection path available');
    }, name);
}

/**
 * Type into #send_textarea and click #send_but without waiting for the
 * reply. For specs that act while the generation is in flight; use
 * sendMessageAndAwaitReply otherwise.
 */
export async function sendMessageViaUI(page, text) {
    await page.locator('#send_textarea').fill(text);
    await waitForConnected(page);
    // Any drawer-content under #top-settings-holder that's currently in
    // the .openDrawer state sits on top of #send_but and intercepts the
    // click. Close them all (the standard .drawer-toggle handler) so the
    // click lands on the composer. This is idempotent / no-op when no
    // drawer is open.
    await closeAnyOpenTopSettingsDrawer(page);
    await page.locator('#send_but').click();
}

/**
 * Send a user message by typing into #send_textarea and clicking #send_but.
 *
 * This is the DEFAULT send path. Waits for GENERATION_ENDED (the post-
 * streaming-flush event) so the reply text in ctx.chat and DOM are stable
 * before returning. Returns the rendered reply text from the .mes_text
 * element (not from ctx.chat).
 */
export async function sendMessageAndAwaitReply(page, text, { timeoutMs = 120_000 } = {}) {
    // GENERATION_ENDED fires after streaming flushes ctx.chat[id].mes —
    // safer than MESSAGE_RECEIVED, which fires before the streamed reply
    // content has fully replaced the "..." placeholder.
    const generationPromise = page.evaluate((to) => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('reply timeout')), to);
        // GENERATION_ENDED's payload is chat.length (i.e. id+1) so we
        // return chat.length-1 as the new assistant message id.
        const off = ctx.eventSource.on(ctx.eventTypes.GENERATION_ENDED, (chatLength) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_ENDED, off); } catch { /* ignore */ }
            resolve(Math.max(0, Number(chatLength) - 1));
        });
    }), timeoutMs);

    await sendMessageViaUI(page, text);

    const replyId = await generationPromise;
    // Read the rendered DOM, not ctx.chat — that's the whole point.
    const replyText = await page.locator(`.mes[mesid="${replyId}"] .mes_text`).first().innerText({ timeout: 30_000 });
    return { replyId, text: replyText };
}

/**
 * Back-compat alias used by old tests that explicitly opted into the
 * button-click path. New code should use sendMessageAndAwaitReply.
 */
export const sendMessageViaButtonAndAwaitReply = sendMessageAndAwaitReply;

/**
 * Programmatic send — only when the test cares about a server invariant
 * (rate-limit, queueing) rather than the send-area UI.
 */
export async function sendMessageProgrammatic(page, text, { timeoutMs = 120_000 } = {}) {
    const replyPromise = page.evaluate((to) => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('reply timeout')), to);
        const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, (id) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_RECEIVED, off); } catch { /* ignore */ }
            resolve(id);
        });
    }), timeoutMs);
    await page.evaluate(async (msg) => {
        const ctx = window.Luker.getContext();
        await ctx.executeSlashCommandsWithOptions(`/send ${msg.replace(/\n/g, ' ')} | /trigger`);
    }, text);
    const replyId = await replyPromise;
    const replyText = await page.evaluate((id) => {
        const ctx = window.Luker.getContext();
        return ctx.chat[id]?.mes || '';
    }, replyId);
    return { replyId, text: replyText };
}

/**
 * Hover the last message so its swipe chevrons fade in, then click one.
 * The chevrons carry visibility:hidden while the fade runs, so the
 * actionability wait in click() covers the transition.
 */
async function clickLastMessageSwipe(page, chevronClass) {
    const lastMes = page.locator('#chat .last_mes');
    await lastMes.hover();
    await lastMes.locator(`.${chevronClass}`).click();
}

/**
 * Trigger a swipe (regen variant) on the latest assistant message via the
 * real .swipe_right button. Returns the new variant text from DOM.
 */
export async function swipeRightOnLatest(page, { timeoutMs = 120_000 } = {}) {
    const swipePromise = page.evaluate((to) => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('swipe timeout')), to);
        const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_SWIPED, (id) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_SWIPED, off); } catch { /* ignore */ }
            resolve(id);
        });
    }), timeoutMs);
    await waitForConnected(page);
    await clickLastMessageSwipe(page, 'swipe_right');
    const swipeId = await swipePromise;
    const text = await page.locator(`.mes[mesid="${swipeId}"] .mes_text`).first().innerText({ timeout: 30_000 });
    return { swipeId, text };
}

export async function swipeLeftOnLatest(page, { timeoutMs = 120_000 } = {}) {
    const swipePromise = page.evaluate((to) => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('swipe timeout')), to);
        const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_SWIPED, (id) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_SWIPED, off); } catch { /* ignore */ }
            resolve(id);
        });
    }), timeoutMs);
    await clickLastMessageSwipe(page, 'swipe_left');
    const swipeId = await swipePromise;
    const text = await page.locator(`.mes[mesid="${swipeId}"] .mes_text`).first().innerText({ timeout: 30_000 });
    return { swipeId, text };
}

/**
 * Edit a message via the real UI: click the .mes_edit pencil, replace the
 * editable .mes_text contents, click .mes_edit_done.
 *
 * The contenteditable lives on .mes_text once edit mode is active; we
 * select-all and type the new value so the saved text includes any input
 * event handlers (e.g. auto-resize, markdown preview).
 */
export async function editMessageViaUI(page, mesid, newText) {
    const mes = page.locator(`.mes[mesid="${mesid}"]`);
    await mes.waitFor({ state: 'visible', timeout: 10_000 });
    // The .mes_edit pencil is revealed by hovering the message.
    await mes.hover();
    await mes.locator('.mes_edit').first().click();
    const editArea = mes.locator('.edit_textarea, .mes_text').first();
    await editArea.waitFor({ state: 'visible', timeout: 5000 });
    // .mes_text becomes contenteditable; .fill works on textarea elements
    // only, so for the contenteditable path we select-all + type.
    const isTextarea = await editArea.evaluate(el => el.tagName.toLowerCase() === 'textarea');
    if (isTextarea) {
        await editArea.fill(newText);
    } else {
        await editArea.click();
        await editArea.press('ControlOrMeta+a');
        await editArea.press('Delete');
        await editArea.type(newText);
    }
    const saved = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/(chats\/(save|patch)|chats\/group\/(save|patch))$/.test(new URL(response.url()).pathname));
    await mes.locator('.mes_edit_done').first().click();
    if (!(await saved).ok()) throw new Error('Edited chat was not saved');
    await mes.locator('.edit_textarea').waitFor({ state: 'detached' });
}

/**
 * Delete a message via the real UI: click .mes_edit, then .mes_edit_delete,
 * then accept the confirm popup when `power_user.confirm_message_delete`
 * is on (the default), exactly as a user answers it.
 *
 * Returns after `MESSAGE_DELETED` has fired. The signal is parked on
 * `window.__deleteSignal` and polled with waitForFunction rather than
 * returned through a long-lived page-side Promise.
 */
export async function deleteMessageViaUI(page, mesid) {
    const mes = page.locator(`.mes[mesid="${mesid}"]`);
    await mes.waitFor({ state: 'visible', timeout: 10_000 });
    await mes.hover();
    await mes.locator('.mes_edit').first().click();
    const deleteButton = mes.locator('.mes_edit_delete').first();
    await deleteButton.waitFor({ state: 'visible', timeout: 5000 });

    // Register the MESSAGE_DELETED listener BEFORE the click so it is in
    // place by the time deleteMessage emits. The confirm flag is read, not
    // written: it decides whether the user sees a dialog to answer.
    const confirmDelete = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        window.__deleteSignal = { resolved: false, id: null };
        const off = (id) => {
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_DELETED, off); } catch { /* ignore */ }
            window.__deleteSignal.resolved = true;
            window.__deleteSignal.id = id;
        };
        ctx.eventSource.on(ctx.eventTypes.MESSAGE_DELETED, off);
        return ctx.powerUserSettings?.confirm_message_delete !== false;
    });

    await deleteButton.click();

    if (confirmDelete) {
        const popup = page.locator('dialog.popup[open]').last();
        await popup.waitFor({ state: 'visible', timeout: 5000 });
        await popup.locator('.popup-button-ok').click();
    }

    await page.waitForFunction(() => window.__deleteSignal?.resolved === true, null, { timeout: 20_000 });
}

/**
 * Open the options dropdown ($('#options')) and click an item by id.
 * Used for continue, regenerate, impersonate, new chat, etc.
 */
export async function openOptionsAndClick(page, optionId) {
    await page.locator('#options_button').click();
    // Some upstream option ids exist twice in index.html (e.g.
    // option_close_chat has a permanently displayNone twin); pick the
    // visible one so strict mode doesn't reject the locator.
    const item = page.locator(`#${optionId}:visible`).first();
    await item.waitFor({ state: 'visible', timeout: 5000 });
    // The item handler hides the menu itself once its action has run.
    await item.click();
}

/**
 * Continue the last assistant message via the real options dropdown.
 * Returns the new full text from DOM.
 */
export async function continueViaUI(page, { timeoutMs = 120_000 } = {}) {
    const continuePromise = page.evaluate((to) => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('continue timeout')), to);
        const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, (id) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_RECEIVED, off); } catch { /* ignore */ }
            resolve(id);
        });
    }), timeoutMs);
    await waitForConnected(page);
    await openOptionsAndClick(page, 'option_continue');
    const id = await continuePromise;
    const text = await page.locator(`.mes[mesid="${id}"] .mes_text`).first().innerText({ timeout: 30_000 });
    return { id, text };
}

/**
 * Regenerate the last assistant message via the real options dropdown.
 * Returns the new reply from DOM.
 */
export async function regenerateViaUI(page, { timeoutMs = 120_000 } = {}) {
    const regenPromise = page.evaluate((to) => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('regenerate timeout')), to);
        const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, (id) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_RECEIVED, off); } catch { /* ignore */ }
            resolve(id);
        });
    }), timeoutMs);
    await waitForConnected(page);
    await openOptionsAndClick(page, 'option_regenerate');
    const id = await regenPromise;
    const text = await page.locator(`.mes[mesid="${id}"] .mes_text`).first().innerText({ timeout: 30_000 });
    return { id, text };
}

/**
 * Impersonate via the real options dropdown. Waits for the impersonate
 * text to land in #send_textarea (the UX contract: impersonate writes the
 * proposed user line into the input bar, not into chat).
 */
export async function impersonateViaUI(page, { timeoutMs = 60_000 } = {}) {
    await waitForConnected(page);
    await openOptionsAndClick(page, 'option_impersonate');
    // Wait until #send_textarea contains non-empty text (the impersonate
    // payload). We bound by mock latency.
    await page.waitForFunction(() => {
        const ta = document.querySelector('#send_textarea');
        return ta && ta.value && ta.value.length > 0;
    }, { timeout: timeoutMs });
    return page.locator('#send_textarea').inputValue();
}

/**
 * Branch from a message via the message-action button .mes_create_branch.
 * The default behavior creates a new chat with the prefix copied; ST emits
 * CHAT_CHANGED on the switch.
 */
export async function branchFromMessageViaUI(page, mesid, { timeoutMs = 30_000 } = {}) {
    const mes = page.locator(`.mes[mesid="${mesid}"]`);
    await mes.waitFor({ state: 'visible', timeout: 10_000 });
    // Reveal the extra mes buttons (ellipsis hint) so .mes_create_branch
    // is clickable, then click.
    await mes.hover();
    await mes.locator('.extraMesButtonsHint').first().click();
    const branchBtn = mes.locator('.mes_create_branch').first();
    await branchBtn.waitFor({ state: 'visible', timeout: 5000 });
    const chatPromise = page.evaluate((to) => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('branch timeout')), to);
        const off = ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, (id) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.CHAT_CHANGED, off); } catch { /* ignore */ }
            resolve(id);
        });
    }), timeoutMs);
    await branchBtn.click();
    return chatPromise;
}

/**
 * Start a fresh empty chat for the active character via the real options
 * dropdown. Real path: click #options_button → click #option_start_new_chat
 * → accept the "Start new chat?" confirm popup. ST emits CHAT_CHANGED on
 * the switch. Returns the new chat id (the value emitted by CHAT_CHANGED).
 *
 * Used by merge/split e2e tests that need to set up multiple sibling chats
 * under the same character.
 */
export async function createNewChatViaUI(page, { timeoutMs = 30_000 } = {}) {
    const chatPromise = page.evaluate((to) => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('new-chat timeout')), to);
        const off = ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, (id) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.CHAT_CHANGED, off); } catch { /* ignore */ }
            resolve(id);
        });
    }), timeoutMs);
    await openOptionsAndClick(page, 'option_start_new_chat');
    // ST always shows a "Start new chat?" confirm popup (see script.js
    // around line 20036). Accept the topmost popup OK.
    const popup = page.locator('dialog.popup[open]').last();
    await popup.waitFor({ state: 'visible', timeout: 5000 });
    await popup.locator('.popup-button-ok').click();
    return chatPromise;
}

/**
 * Rename the currently-open chat via the Manage Chat Files UI. Mirrors the
 * gesture sequence used by tests/e2e/chat/13-rename-chat.e2e.js:
 *   1. Open options → Manage chat files (option_select_chat).
 *   2. Find the row whose .select_chat_block_filename matches the current
 *      chat id, click its .renameChatButton pencil.
 *   3. Fill the popup input with the new name, click OK.
 *   4. Wait until ctx.getCurrentChatId() flips to the new name.
 *
 * Side effect: ST's rename handler re-opens #shadow_select_chat_popup on
 * a 250ms delay AFTER the rename completes. We deliberately do NOT try
 * to close that popup here — the close-and-reopen race is hard to win
 * reliably. Downstream helpers that need the options dropdown should be
 * popup-aware (e.g. openMergeDialogViaUI detects the popup and skips the
 * options click), and callers that need a clean state should explicitly
 * close it themselves.
 */
export async function renameCurrentChatViaUI(page, newName) {
    const originalChatId = await page.evaluate(() => window.Luker.getContext().getCurrentChatId());
    await openOptionsAndClick(page, 'option_select_chat');
    const row = page.locator('.select_chat_block_wrapper', { has: page.locator('.select_chat_block_filename', { hasText: originalChatId }) }).first();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.locator('.renameChatButton').click();
    const popup = page.locator('dialog.popup[open]').last();
    const popupInput = popup.locator('.popup-input').last();
    await popupInput.waitFor({ state: 'visible', timeout: 5000 });
    await popupInput.fill(newName);
    await popup.locator('.popup-button-ok').click();
    await page.waitForFunction((expected) => {
        return window.Luker.getContext().getCurrentChatId() === expected;
    }, newName, { timeout: 15_000 });
}

/**
 * Abort an in-flight generation by clicking the stop button. Real DOM —
 * no underlying-API fallback. If the stop button is hidden because no
 * generation is in flight, this throws.
 */
export async function abortGenerationViaUI(page, { timeoutMs = 10_000 } = {}) {
    const stop = page.locator('#mes_stop');
    await stop.waitFor({ state: 'visible', timeout: timeoutMs });
    await stop.click();
}

// Backward-compat alias for old call sites.
export const abortGeneration = abortGenerationViaUI;

/**
 * @deprecated Use editMessageViaUI — this shim only exists for tests
 * still being rewritten. Goes through the real pencil → contenteditable
 * → confirm flow as well, just retains the old name.
 */
export async function editMessageById(page, mesid, newText) {
    return editMessageViaUI(page, mesid, newText);
}

/**
 * @deprecated Use deleteMessageViaUI. Delete the LAST message; tests
 * that need a specific id should call deleteMessageViaUI directly.
 */
export async function deleteLastMessage(page) {
    const lastMesId = await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        return ctx.chat.length - 1;
    });
    return deleteMessageViaUI(page, lastMesId);
}

/**
 * Capture the chat state. Reads ctx.chat for the structural snapshot
 * (used for cross-restart equality), but tests should ALSO read DOM
 * (.mes_text) for the live assertion — both checks together prove the
 * server-side state matches what the user sees.
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
 * Read the rendered text of every message in the chat — the load-bearing
 * DOM-side complement to getChatSnapshot. Use this when asserting that
 * the user sees what we expect; assert both this AND the ctx snapshot
 * for full coverage.
 */
export async function getRenderedChatTexts(page) {
    return page.locator('#chat .mes .mes_text').allInnerTexts();
}

/**
 * Accept the topmost popup (ST's in-DOM popup, not window.confirm). Used
 * for delete-character, delete-world-info, etc.
 */
export async function acceptTopmostPopup(page, { timeoutMs = 5000 } = {}) {
    const ok = page.locator('.popup .popup-button-ok').last();
    await ok.waitFor({ state: 'visible', timeout: timeoutMs });
    await ok.click();
}

export async function cancelTopmostPopup(page, { timeoutMs = 5000 } = {}) {
    const cancel = page.locator('.popup .popup-button-cancel').last();
    await cancel.waitFor({ state: 'visible', timeout: timeoutMs });
    await cancel.click();
}

/**
 * If a popup with a text input is on top, type the value and accept.
 * Used for "Save preset as…" / "Rename chat" / similar.
 */
export async function fillTopmostPopupAndAccept(page, text, { timeoutMs = 5000 } = {}) {
    const popup = page.locator('.popup:visible').last();
    await popup.waitFor({ state: 'visible', timeout: timeoutMs });
    const input = popup.locator('input[type="text"], textarea').first();
    await input.waitFor({ state: 'visible', timeout: timeoutMs });
    await input.fill(text);
    await popup.locator('.popup-button-ok').first().click();
}

/**
 * Install a minimal director-mode orchestrator profile via writeActivePreset.
 *
 * IMPORTANT: This is the programmatic shortcut used by orchestrator tests
 * that focus on the runtime (dispatch / write_message / finalize loop) and
 * don't want to spend setup time driving the preset editor UI. Tests that
 * specifically lock the preset editor itself should NOT use this; they
 * should configure the profile through the orchestrator drawer + preset
 * inputs as a real user would.
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
        settings.toolCallRetryMax = 1;
        // Clear the agent-level connection / prompt-preset overrides. Dev
        // settings.json typically carries a real connection profile name
        // here ("Claude" / "Gemini" / etc.) — when present, the orchestrator
        // resolves that profile and overrides `chat_completion_source` +
        // `custom_url` on every agent request, routing traffic AWAY from
        // the e2e mock and into the real provider's URL (which times out
        // because there's no live network in the test env). Resetting to
        // '' keeps the agent on `oai_settings` — i.e. on the CUSTOM source
        // pointed at the mock by `bootstrapCustomBackend`.
        settings.llmNodeApiPresetName = '';
        settings.llmNodePresetName = '';
        settings.requestApiPresetName = '';
        settings.requestLlmPresetName = '';

        const presetLib = await import('/scripts/extensions/orchestrator/preset-library.js');
        const dirDefaults = await import('/scripts/extensions/orchestrator/director-defaults.js');

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
                promptPresetName: String(a.promptPresetName || ''),
                apiPresetName: String(a.apiPresetName || ''),
                tools: a.tools || null,
                maxRounds: a.maxRounds ?? null,
                skills: { visible: [], deny: [] },
            })),
            tools: tools || {
                collab: { dispatch_subagent: true, dispatch_inline_subagent: true },
            },
            maxRounds: 8,
            maxConcurrentSubagents: 4,
            maxTotalSubagentRuns: 8,
            discardOnAbort: false,
        };
        const sanitized = dirDefaults.sanitizeDirectorProfile(minimalProfile);
        const writeResult = presetLib.writeActivePreset(settings, 'director', 'global', sanitized);
        if (!writeResult.ok) throw new Error(`writeActivePreset failed; library not seeded (${writeResult.reason}: ${writeResult.hint})`);
        try { await ctx.saveSettings?.(0, { directSave: true }); } catch (_) { /* best-effort */ }
        ctx.saveSettingsDebounced?.();
    }, { mainSystemPrompt, subAgents, tools });
}

/**
 * Open user management in the Account window (User Settings → Admin Panel).
 * Assumes the current user is admin (default user in single-user mode is
 * auto-admin; in multi-user mode the caller must have logged in as an
 * admin). Resolves once the user list shows.
 */
export async function openAdminPanel(page) {
    await openUserManagement(page);
}

/**
 * Create a new user via the real New User page of user management.
 * Follows the exact click path a real admin would take:
 *
 *   1. Open user management (drawer → #admin_button).
 *   2. Click "New User".
 *   3. Fill display name → the page suggests a handle; overwrite it with
 *      the desired handle explicitly (typing a handle stops the
 *      suggestion).
 *   4. Fill password + confirm password.
 *   5. Click Create.
 *   6. Wait until the user appears in the user list (proves the create
 *      round-tripped through /api/users/create and the list re-rendered
 *      from /api/users/get).
 *
 * Requires `enableUserAccounts:true` at server boot; on single-user mode
 * the page still opens but the created user can never actually log in.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ handle: string, name: string, password?: string }} spec
 */
export async function createUserViaAdminUI(page, { handle, name, password = '' }) {
    await openUserManagement(page);
    const win = accountWindow(page);
    await win.locator('[data-act="adm-push"][data-view="adminNew"]').click();
    await expect(pageHead(page)).toHaveAttribute('data-view', 'adminNew');
    await win.locator('[data-model="top.form.name"]').fill(name);
    await win.locator('[data-model="top.form.handle"]').fill(handle);
    if (password) {
        await win.locator('[data-model="top.form.password"]').fill(password);
        await win.locator('[data-model="top.form.confirm"]').fill(password);
    }
    await win.locator('[data-act="adm-create"]').click();
    // Success returns to the user list.
    await expect(pageHead(page)).toHaveAttribute('data-view', 'users', { timeout: 10_000 });
    await expect(win.locator(`[data-act="adm-user"][data-handle="${handle}"]`).first()).toBeVisible({ timeout: 15_000 });
}
