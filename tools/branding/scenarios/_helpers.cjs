/**
 * scenarios/_helpers.cjs — shared helpers for all recording scenarios.
 */

async function scrubBadgeNow(page) {
  await page.evaluate(() => {
    const v = document.querySelector('#version_display');
    if (v) v.textContent = 'Luker';
  }).catch(() => {});
}

async function dismissFirstRun(page) {
  // Handle the standard first-run splash.
  const btn = await page.$('button:has-text("Okay")');
  if (btn) { await btn.click(); await page.waitForTimeout(400); }
  // Handle the "This preset has embedded regex script(s)" confirm popup
  // that fires the first time a fresh preset is used per browser session.
  // Cancel it — we're not installing preset-bundled regex in the recording.
  await dismissEmbeddedRegexPopupIfPresent(page);
  await scrubBadgeNow(page);
}

/** If a preset-embedded-regex-script confirm popup is currently open, cancel it.
 * Safe to call at any time; no-op if no such popup exists. */
async function dismissEmbeddedRegexPopupIfPresent(page) {
  // Loop a few times because the popup can be triggered by later events too.
  for (let i = 0; i < 3; i++) {
    const found = await page.evaluate(() => {
      const popups = Array.from(document.querySelectorAll('.popup'));
      const target = popups.find(p => /embedded regex script/i.test(p.textContent || ''));
      if (!target) return false;
      // Prefer the "Cancel" or "Close" control; fall back to popup-button-cancel.
      const cancel = target.querySelector('.popup-button-cancel, .popup-button-close');
      cancel?.click();
      return true;
    });
    if (!found) break;
    await page.waitForTimeout(400);
  }
}

async function openCharacterPanel(page) {
  const isOpen = await page.evaluate(() => !!document.querySelector('#right-nav-panel:not(.closedDrawer)'));
  if (!isOpen) {
    await page.evaluate(() => document.querySelector('#rightNavDrawerIcon')?.click());
    await page.waitForTimeout(600);
  }
}

async function closeCharacterPanel(page) {
  const isOpen = await page.evaluate(() => !!document.querySelector('#right-nav-panel:not(.closedDrawer)'));
  if (isOpen) {
    await page.evaluate(() => document.querySelector('#rightNavDrawerIcon')?.click());
    await page.waitForTimeout(400);
  }
}

async function selectCharacter(page, name) {
  await openCharacterPanel(page);
  await page.evaluate((n) => {
    const c = Array.from(document.querySelectorAll('.character_select')).find(x => new RegExp(n, 'i').test(x.textContent));
    if (c) c.click();
  }, name);
  await page.waitForTimeout(1500);
}

/**
 * Start a brand-new chat for the currently-selected character via /newchat slash command.
 * Cheaper than fumbling the "Start new chat" button, and leaves prior chats archived.
 */
async function startFreshChat(page) {
  await page.evaluate(() => {
    const ta = document.querySelector('#send_textarea');
    if (!ta) return;
    ta.value = '/newchat';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send_but')?.click();
  });
  await page.waitForTimeout(1200);
}

async function sendUserMessage(page, text) {
  // Record the message count BEFORE sending so waitForCharacterReply can wait
  // for a strictly-new assistant message. Without this baseline, a pre-existing
  // long assistant greeting would satisfy the "reply present" check instantly
  // and every turn would race ahead without waiting for generation. The
  // baseline lives on window so any subsequent helper can read it.
  await page.evaluate((t) => {
    window.__lukerBrandingLastMsgCount = document.querySelectorAll('#chat .mes').length;
    const ta = document.querySelector('#send_textarea');
    ta.value = t;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send_but').click();
  }, text);
}

/** Wait for a NEW character reply to arrive after the most recent sendUserMessage.
 * "New" is measured against the message count captured at send time. Also waits
 * for the message to grow past `minLen` chars so the check catches
 * still-generating messages that are still tiny.
 */
async function waitForCharacterReply(page, { minLen = 80, timeout = 90000 } = {}) {
  await page.waitForFunction(({ minLen }) => {
    const msgs = document.querySelectorAll('#chat .mes');
    const baseline = window.__lukerBrandingLastMsgCount ?? 0;
    // Need at least two new messages: the user echo plus the assistant reply.
    if (msgs.length < baseline + 2) return false;
    const last = msgs[msgs.length - 1];
    const isUser = last.getAttribute('is_user') === 'true';
    if (isUser) return false;
    const text = (last.querySelector('.mes_text')?.textContent || '').trim();
    if (text.length < minLen) return false;
    // In streaming mode the send button flips to a stop class; in non-streaming
    // mode there's no such flip, so this is only a defensive extra check.
    const stillGenerating = !!document.querySelector('#send_but.mes_stop');
    return !stillGenerating;
  }, { minLen }, { timeout }).catch(() => {});
}

module.exports = {
  dismissFirstRun,
  dismissEmbeddedRegexPopupIfPresent,
  openCharacterPanel,
  closeCharacterPanel,
  selectCharacter,
  startFreshChat,
  sendUserMessage,
  waitForCharacterReply,
  scrubBadgeNow,
};
