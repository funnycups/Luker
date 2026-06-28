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

/**
 * Navigate to baseURL and wait for ST to leave the preloader. Clicks the
 * user-select gate if present (multi-user dev configs). Also kicks the
 * connect handshake so #send_but un-hides.
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
    await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });
    // Click the Connect button if present (canonical handshake entry).
    await page.evaluate(async () => {
        const btn = document.querySelector('#api_button_openai');
        if (btn) { btn.click(); return; }
        try {
            const mod = await import('/scripts/openai.js');
            if (typeof mod.startStatusLoading === 'function') mod.startStatusLoading();
        } catch { /* no-op */ }
    });
    // Wait up to 15s for #send_but to un-hide (CUSTOM source flips
    // online_status immediately so this is usually instant).
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
}

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
    const block = page.locator('#rm_extensions_block');
    const isOpen = await block.evaluate(el => el && el.classList.contains('openDrawer')).catch(() => false);
    if (!isOpen) return;
    // Use the .drawer-toggle handler (doNavbarIconClick) so the icon
    // state stays in sync with the drawer state.
    await page.evaluate(() => {
        const toggle = document.querySelector('#extensions-settings-button .drawer-toggle');
        toggle?.click();
    });
    await block.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

/**
 * Close any top-settings drawer (under #top-settings-holder) that has
 * the openDrawer class. This is the broader sibling of
 * closeExtensionsDrawer — it covers cases where the spec opened
 * a different settings drawer (#left-nav-panel, etc.) and needs all of
 * them closed before clicking the chat composer.
 */
export async function closeAnyOpenTopSettingsDrawer(page) {
    const hadOpen = await page.evaluate(() => {
        const opens = document.querySelectorAll('#top-settings-holder .drawer-content.openDrawer:not(.pinnedOpen)');
        if (!opens.length) return false;
        for (const drawer of opens) {
            const wrapper = drawer.closest('.drawer');
            const toggle = wrapper?.querySelector(':scope > .drawer-toggle');
            toggle?.click();
        }
        return true;
    });
    if (hadOpen) {
        // Wait briefly for the close animation/state to settle.
        await page.waitForFunction(() => {
            return document.querySelectorAll('#top-settings-holder .drawer-content.openDrawer:not(.pinnedOpen)').length === 0;
        }, { timeout: 3000 }).catch(() => {});
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
    if ((await drawer.count().catch(() => 0)) === 0) {
        drawer = host.locator('.inline-drawer').first();
    }
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
 * Select a character by display name. Real path: open the right nav drawer
 * if closed, click the matching card, wait for chat panel to settle.
 *
 * The "programmatic" sibling is selectCharacterProgrammatic — use only when
 * the test explicitly needs to bypass card rendering (e.g. comparing UI
 * click vs API selection).
 */
export async function selectCharacterByName(page, name) {
    // Dismiss onboarding modal if it ever flashes.
    const onboardingHeader = page.locator('.popup', { hasText: /Welcome to Luker|歡迎使用|欢迎使用/ }).first();
    if (await onboardingHeader.isVisible().catch(() => false)) {
        await page.locator('.popup .popup-button-cancel, .popup .popup-button-ok').first().click().catch(() => {});
        await onboardingHeader.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }

    const drawer = page.locator('#rightNavDrawerIcon');
    const drawerClosed = await drawer.evaluate(el => el.classList.contains('closedIcon')).catch(() => true);
    if (drawerClosed) await drawer.click();

    // If a prior character was already selected, the right drawer is
    // showing the character-edit panel rather than the list. Click the
    // "Characters" sub-panel button so #rm_print_characters_block becomes
    // visible again. Use a JS click so a toast or transient overlay
    // can't intercept the gesture (force:true on the locator click still
    // dispatches via pointer coordinates and is blocked by overlays in
    // some layouts).
    const listVisible = await page.locator('#rm_print_characters_block:visible').count().catch(() => 0);
    if (!listVisible) {
        await page.evaluate(() => {
            const btn = document.querySelector('#rm_button_characters');
            if (btn) btn.click();
        });
        await page.locator('#rm_print_characters_block').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    }

    const charBlock = page.locator('#rm_print_characters_block');
    await charBlock.waitFor({ state: 'visible', timeout: 10_000 });

    const card = charBlock.locator('.character_select', { hasText: name }).first();
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    await card.click();

    await page.waitForFunction(() => {
        const ctx = window.Luker?.getContext?.();
        return ctx && (typeof ctx.characterId === 'number' || typeof ctx.characterId === 'string');
    }, { timeout: 10_000 }).catch(() => { /* welcome panel ok */ });

    // Selecting a character opens the character editor panel inside the
    // right drawer, which then overlays the chat composer. Close the
    // drawer so subsequent send-area gestures aren't intercepted by the
    // character_name_pole / description_textarea inputs. The drawer
    // toggle is idempotent — clicking it again folds the panel away.
    await closeRightNavDrawer(page);
}

/**
 * Close the right nav (character management) drawer if it's open. The
 * #rightNavDrawerIcon sits behind the HotSwap row in some layouts; we
 * dispatch the click via JS to bypass the overlay reliably.
 */
export async function closeRightNavDrawer(page) {
    const isOpen = await page.evaluate(() => {
        const i = document.querySelector('#rightNavDrawerIcon');
        return i && i.classList.contains('openIcon');
    });
    if (isOpen) {
        // jQuery click() is what ST's drawer handlers listen for; dispatch
        // a real MouseEvent on the icon's drawer-toggle ancestor so the
        // .on('click', ...) bound handler runs.
        await page.evaluate(() => {
            const i = document.querySelector('#rightNavDrawerIcon');
            const toggle = i?.closest('.drawer-toggle') || i;
            toggle?.click();
        });
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
            try { ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_ENDED, off); } catch {}
            resolve(Math.max(0, Number(chatLength) - 1));
        });
    }), timeoutMs);

    const textarea = page.locator('#send_textarea');
    await textarea.fill(text);
    await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
    // Any drawer-content under #top-settings-holder that's currently in
    // the .openDrawer state sits on top of #send_but and intercepts the
    // click. Close them all (the standard .drawer-toggle handler) so the
    // click lands on the composer. This is idempotent / no-op when no
    // drawer is open.
    await closeAnyOpenTopSettingsDrawer(page);
    // Dispatch the click via JS so we bypass any residual overlay (e.g.
    // a popup that closed mid-flight, a drawer mid-animation). The
    // #send_but element's bound handler reads from #send_textarea, which
    // we already filled.
    await page.evaluate(() => {
        const btn = document.querySelector('#send_but');
        if (!btn) throw new Error('#send_but not present');
        btn.click();
    });

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
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_RECEIVED, off); } catch {}
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
 * Trigger a swipe (regen variant) on the latest assistant message via the
 * real .swipe_right button. Returns the new variant text from DOM.
 *
 * The .swipe_right element is normally invisible until the cursor hovers
 * the message — we use force:true to bypass the hover gate, which is
 * accurate enough since the user does see this control on mobile (always
 * visible) and via tab navigation. If you want to test the hover-reveal
 * specifically, write a separate test that hovers the message first.
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
    // The .swipe_right chevron has a .fade opacity transition that adds
    // visibility:hidden + pointer-events:none for ~200ms. Playwright's
    // click({force:true}) still respects pointer-events:none in headless,
    // so dispatch the click via JS (mobile-tap equivalent) instead.
    await page.evaluate(() => {
        const el = document.querySelector('.last_mes .swipe_right');
        if (!el) throw new Error('.last_mes .swipe_right not present');
        el.click();
    });
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
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_SWIPED, off); } catch {}
            resolve(id);
        });
    }), timeoutMs);
    await page.evaluate(() => {
        const el = document.querySelector('.last_mes .swipe_left');
        if (!el) throw new Error('.last_mes .swipe_left not present');
        el.click();
    });
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
    // The .mes_edit pencil lives inside the message; hovering reveals it
    // but force:true is enough here since we only care about the click.
    await mes.locator('.mes_edit').first().click({ force: true });
    const editArea = mes.locator('.edit_textarea, .mes_text').first();
    await editArea.waitFor({ state: 'visible', timeout: 5000 });
    // .mes_text becomes contenteditable; .fill works on textarea elements
    // only, so for the contenteditable path we select-all + type.
    const isTextarea = await editArea.evaluate(el => el.tagName.toLowerCase() === 'textarea').catch(() => false);
    if (isTextarea) {
        await editArea.fill(newText);
    } else {
        await editArea.click();
        await editArea.press('ControlOrMeta+a');
        await editArea.press('Delete');
        await editArea.type(newText);
    }
    // Listen for MESSAGE_EDITED before clicking confirm so we don't race
    // the save → re-render cycle.
    const editPromise = page.evaluate(() => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('edit timeout')), 15_000);
        const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_EDITED, (id) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_EDITED, off); } catch {}
            resolve(id);
        });
    }));
    await mes.locator('.mes_edit_done').first().click();
    await editPromise;
}

/**
 * Delete a message via the real UI: click .mes_edit, then .mes_edit_delete,
 * then accept the in-DOM confirm popup if it appears (ST's
 * `power_user.confirm_message_delete` defaults to true, so a Popup.CONFIRM
 * modal renders before the actual delete fires).
 *
 * Returns after `MESSAGE_DELETED` has fired. The MG extension's
 * MESSAGE_DELETED listener defers its server-fetch chain to a microtask,
 * so it no longer blocks the emit loop.
 *
 * Implementation notes:
 *   - Dispatch the click via a synthetic MouseEvent inside a page.evaluate
 *     rather than `locator.click()`. The .mes_edit_delete target sits
 *     inside .mes, which gets removed from DOM the instant deleteMessage
 *     runs (synchronously, before its first await). With
 *     `confirm_message_delete=false` that removal races with Playwright's
 *     post-action stability check and the click hangs indefinitely; the
 *     synthetic dispatch fires the jQuery delegated handler identically
 *     to a real click without any actionability heuristics.
 *   - Park the MESSAGE_DELETED signal on `window.__deleteSignal` and poll
 *     for it via waitForFunction, NOT a long-lived page-side Promise
 *     returned via JSHandle. The latter pattern stalls the CDP
 *     execution context against subsequent page.evaluate calls in
 *     some environments, producing a hang that looks like a popup-
 *     dismiss eval timing out.
 */
export async function deleteMessageViaUI(page, mesid) {
    const mes = page.locator(`.mes[mesid="${mesid}"]`);
    await mes.waitFor({ state: 'visible', timeout: 10_000 });
    await mes.locator('.mes_edit').first().click({ force: true });
    await mes.locator('.mes_edit_delete').first().waitFor({ state: 'visible', timeout: 5000 });

    // Register the MESSAGE_DELETED listener and a window-level signal
    // BEFORE dispatching the click so the listener is in place by the
    // time deleteMessage emits.
    await page.evaluate(() => {
        const ctx = window.Luker.getContext();
        window.__deleteSignal = { resolved: false, id: null };
        const off = (id) => {
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_DELETED, off); } catch {}
            window.__deleteSignal.resolved = true;
            window.__deleteSignal.id = id;
        };
        ctx.eventSource.on(ctx.eventTypes.MESSAGE_DELETED, off);
    });

    // Dispatch via synthetic MouseEvent from the page side.
    await page.evaluate((mid) => {
        const el = document.querySelector(`.mes[mesid="${mid}"] .mes_edit_delete`);
        if (!el) throw new Error(`mes_edit_delete not found for mesid=${mid}`);
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }, mesid);

    // Dismiss the confirm popup if it surfaced. We do NOT poll for the
    // dialog up front: when `confirm_message_delete` is false (the
    // common path in MG/var-ops specs) no dialog ever appears, and a
    // page.waitForFunction here would burn its full timeout. Instead,
    // dismiss-on-arrival via waitForFunction on the signal: poll the
    // sentinel, and on each poll also check for an open dialog and
    // click its OK button if present. That keeps the helper responsive
    // to both confirm=true and confirm=false paths without a fixed
    // pre-roll wait.
    await page.waitForFunction(() => {
        const openDlg = Array.from(document.querySelectorAll('dialog.popup')).reverse().find(d => d.hasAttribute('open'));
        if (openDlg) {
            const ok = openDlg.querySelector('.popup-button-ok');
            if (ok) ok.click();
        }
        return window.__deleteSignal?.resolved === true;
    }, null, { timeout: 20_000 });
}

/**
 * Open the options dropdown ($('#options')) and click an item by id.
 * Used for continue, regenerate, impersonate, new chat, etc.
 */
export async function openOptionsAndClick(page, optionId) {
    await page.locator('#options_button').click();
    const item = page.locator(`#${optionId}`);
    await item.waitFor({ state: 'visible', timeout: 5000 });
    await item.click();
    // Close the dropdown if it's still showing.
    await page.evaluate(() => {
        const opts = document.querySelector('#options');
        if (opts && opts.style.display !== 'none') opts.style.display = 'none';
    });
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
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_RECEIVED, off); } catch {}
            resolve(id);
        });
    }), timeoutMs);
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
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_RECEIVED, off); } catch {}
            resolve(id);
        });
    }), timeoutMs);
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
    await mes.locator('.extraMesButtonsHint').first().click({ force: true });
    const branchBtn = mes.locator('.mes_create_branch').first();
    await branchBtn.waitFor({ state: 'visible', timeout: 5000 });
    const chatPromise = page.evaluate((to) => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('branch timeout')), to);
        const off = ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, (id) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.CHAT_CHANGED, off); } catch {}
            resolve(id);
        });
    }), timeoutMs);
    await branchBtn.click();
    return chatPromise;
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
                promptPresetName: '',
                apiPresetName: '',
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
