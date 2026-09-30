/**
 * scenarios/cardapp.cjs — record CardApp Studio: AI-driven CardApp editing with diff approval.
 *
 * Flow:
 *  1. Select 深渊行者 (Luker's official CardApp demo card).
 *  2. Open CardApp Studio via the extension's own openCardAppStudio() entry.
 *  3. Wait for the three-panel layout to render (chat / CardApp preview / code editor).
 *  4. Send an in-character CardApp modification request in the AI chat panel.
 *  5. AI proposes a diff. Wait for it to render and hold — this is the star moment.
 *  6. If a diff-approval dialog appears, approve it.
 *  7. Hold on the applied state.
 */
const H = require('./_helpers.cjs');

module.exports.run = async function (page) {
  await page.waitForSelector('#send_but', { timeout: 15000 });
  await page.waitForTimeout(1500);

  console.log('[branding] step: first-run dismissed');
  await H.selectCharacter(page, '深渊行者');
  console.log('[branding] step: character selected');
  await H.closeCharacterPanel(page);
  console.log('[branding] step: character panel closed');
  await page.waitForTimeout(1500);
  await H.scrubBadgeNow(page);

  // Defensively force non-streaming for this scenario. The upstream OpenAI-compatible
  // proxy in use sometimes truncates streaming tool_call arguments mid-message; that is
  // a proxy behaviour, not a Luker issue, but it would spoil the recording. Non-streaming
  // is already persisted in Default.json so this is a belt-and-braces guard.
  await page.evaluate(async () => {
    const oai = await import('/scripts/openai.js');
    if (oai.oai_settings.stream_openai !== false) {
      oai.oai_settings.stream_openai = false;
    }
  });

  console.log('[branding] step: opening studio');
  // The UI button lives in the CEA extension settings, which is a much longer click path.
  await page.evaluate(async () => {
    const mod = await import('/scripts/extensions/character-editor-assistant/studio/studio.js');
    const api = SillyTavern.getContext().getExtensionApi('card-app');
    const charId = api?.getCharId?.();
    if (charId) await mod.openCardAppStudio(charId);
  });

  // Wait for the three-panel Studio layout to fully mount.
  await page.waitForSelector('#card-app-studio-left .card-app-studio-input', { timeout: 10000 });
  console.log('[branding] step: studio left panel ready');
  await page.waitForSelector('#card-app-studio-right', { timeout: 10000 });
  await page.waitForTimeout(2500); // let CardApp preview render its status bar / buttons
  console.log('[branding] step: prompt composed');

  // Modest, visually-verifiable modification request. Chinese matches the card's language.
  // Simple value edit — reliably produces a diff proposal within ~90s.
  const prompt = '把 index.js 里 HP 初始值从 100 改成 120';

  await page.evaluate((text) => {
    const ta = document.querySelector('.card-app-studio-input');
    if (!ta) return;
    ta.focus();
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, prompt);

  await page.waitForTimeout(1000); // hold on the composed prompt

  await page.evaluate(() => {
    document.querySelector('button[data-studio-action="send"]')?.click();
  });
  console.log('[branding] step: send clicked, waiting for approve card');

  // Wait for the diff approval card. Playwright's own visibility semantics are
  // used here: the studio keeps hidden button skeletons in the DOM, so a plain
  // text match or an offsetParent check can fire on the wrong node.
  const approveBtn = page.getByRole('button', { name: 'Approve', exact: true }).last();
  await approveBtn.waitFor({ state: 'visible', timeout: 240000 }).catch(() => {});
  console.log('[branding] step: approve button visible (or timed out)');

  // Hold on the diff so the viewer can absorb it before approval.
  await page.waitForTimeout(6000);

  await approveBtn.click({ timeout: 15000 }).catch(() => {});
  console.log('[branding] step: approve clicked');

  // Let the applied state settle, then stop: the studio sends a follow-up round
  // afterwards, and the recording should end on the accepted diff.
  await page.waitForTimeout(5000);
  console.log('[branding] step: scenario complete');
};
