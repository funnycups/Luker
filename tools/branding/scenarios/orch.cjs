/**
 * scenarios/orch.cjs — record the Multi-Agent Orchestrator experience.
 *
 * Flow:
 *  1. Select Seraphina, fresh chat.
 *  2. Send an in-character message. Orchestrator (spec mode) auto-runs.
 *  3. Run panel auto-opens on RUN_STARTED and shows stages executing live.
 *  4. Wait until orchestrator finishes AND the creative reply arrives.
 *  5. Hold a few seconds on the completed state.
 */
const H = require('./_helpers.cjs');

module.exports.run = async function (page) {
  await page.waitForSelector('#send_but', { timeout: 15000 });
  await page.waitForTimeout(1500);

  await H.dismissFirstRun(page);
  await H.selectCharacter(page, 'Seraphina');
  await H.startFreshChat(page);
  await H.closeCharacterPanel(page);
  await page.waitForTimeout(1500);
  await H.scrubBadgeNow(page);

  // A message that gives the orchestrator something to plan — Seraphina is a healer
  // living deep in the forest, and this asks her to make a real narrative choice
  // (leave the sanctuary to gather an urgent herb before dusk, or wait it out).
  await H.sendUserMessage(
    page,
    "*I sit up slowly, feeling steadier now.* Seraphina — the light through the window looks like it's fading. If we still need that starflower for the wound, shouldn't we go now, before dark? I can walk. I think."
  );

  // Wait for the run panel to open — RUN_STARTED triggers auto-open.
  await page.waitForFunction(
    () => document.querySelector('#luker-orch-run-panel[data-state="open"]') != null,
    { timeout: 20000 }
  ).catch(() => {});

  // Give the panel visible airtime — stages need to render live.
  await page.waitForTimeout(2500);

  // Wait for both the orchestrator to have finished AND Seraphina's final reply to arrive.
  await H.waitForCharacterReply(page, { minLen: 200, timeout: 120000 });

  // Hold on the finished state so the GIF ends on the completed reply + panel.
  await page.waitForTimeout(4000);
};
