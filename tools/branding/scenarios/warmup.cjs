/**
 * scenarios/warmup.cjs — sanity check: open Seraphina in a fresh chat, exchange one round.
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

  await H.sendUserMessage(page, '*I sit up carefully, the amber light warm on my face.* The pain… is much less than I feared. Thank you.');
  await H.waitForCharacterReply(page, { minLen: 100, timeout: 90000 });
  await page.waitForTimeout(3000);
};
