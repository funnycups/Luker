/**
 * scenarios/memgraph.cjs — record Memory Graph in action.
 *
 * Orchestrator is disabled for this recording so the Memory Graph gets
 * uncontested visual real estate.
 *
 * Flow:
 *  1. Disable orchestrator, enable Memory Graph (auto extraction + recall on).
 *  2. Open Seraphina in a fresh chat.
 *  3. Turn 1: introduce named entities (old bridge, wolves). Reply arrives.
 *     Open Memory drawer -> Graph tab, hold, close.
 *  4. Turn 2: introduce more entities (starflower, ruined shrine). Reply arrives.
 *     Open Memory drawer -> Graph tab, hold to show the graph has grown, close.
 *  5. Turn 3: user question that recalls Turn 1 and Turn 2 entities together.
 *     Reply arrives citing prior context.
 *     Open Memory drawer -> Recall tab, hold to show the recall trace payload
 *     for that turn (which nodes were fetched to shape the reply).
 */
const H = require('./_helpers.cjs');

async function disableOrchestrator(page) {
  await page.evaluate(async () => {
    const ext = await import('/scripts/extensions.js');
    const s = ext.extension_settings.orchestrator || (ext.extension_settings.orchestrator = {});
    s.enabled = false;
    ext.saveSettingsDebounced?.();
  });
  await page.waitForTimeout(400);
}

async function enableMemoryGraph(page) {
  await page.evaluate(async () => {
    const ext = await import('/scripts/extensions.js');
    const s = ext.extension_settings.memory_graph = ext.extension_settings.memory_graph || {};
    s.enabled = true;
    s.autoExtractionEnabled = true;
    s.recallEnabled = true;
    ext.saveSettingsDebounced?.();
  });
  await page.waitForTimeout(400);
}

async function openExtensionsAndShowMemoryTab(page, tabKey) {
  // Open the Extensions SETTINGS drawer (top-nav gear icon on the right),
  // scroll Memory into view, expand it, click a tab.
  // NOTE: `#extensionsMenuButton` is a different button — the bottom-bar wand
  // that opens a dropdown of slash-menu entries — do not confuse them.
  await page.evaluate(() => {
    const btn = document.querySelector('#extensions-settings-button > .drawer-toggle')
      || document.querySelector('#extensions-settings-button .drawer-icon')
      || document.querySelector('#extensions-settings-button');
    // Only open if the panel is currently closed.
    const panel = document.querySelector('#rm_extensions_block');
    if (panel && panel.classList.contains('closedDrawer')) btn?.click();
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const drawers = Array.from(document.querySelectorAll('.inline-drawer-header'));
    const mg = drawers.find(d => /^Memory\b/.test(d.textContent.trim()));
    mg?.scrollIntoView({ behavior: 'instant', block: 'center' });
    const body = mg?.parentElement?.querySelector('.inline-drawer-content');
    const isOpen = body && !body.classList.contains('collapsed') && body.getBoundingClientRect().height > 10;
    if (mg && !isOpen) mg.click();
  });
  await page.waitForTimeout(700);
  await page.evaluate((k) => {
    document.querySelector(`[data-luker-tab-key="${k}"][data-luker-tabs-target="luker_rpg_memory_tabs"]`)?.click();
  }, tabKey);
  await page.waitForTimeout(700);
}

/** Open the interactive graph modal (Graph tab -> View Graph). Modal covers
 * most of the viewport and shows the actual node/edge visualization. */
async function openGraphModal(page) {
  // Dismiss any lingering popup (e.g. preset-embedded-regex confirm) before
  // trying to open the graph modal, otherwise the click lands on the popup.
  await H.dismissEmbeddedRegexPopupIfPresent(page);
  // Use a real playwright locator click (dispatches full pointer events) —
  // page.evaluate + `.click()` sometimes fires before the jQuery handler is
  // (re)bound after tab switch. Also wait for the button to be actually
  // visible + stable first.
  const locator = page.locator('#luker_rpg_memory_view_graph');
  await locator.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  // Diagnostic: snapshot before + after to see what actually happens.
  const fs = require('fs');
  fs.mkdirSync('/tmp/mg-diag', { recursive: true });
  await page.screenshot({ path: `/tmp/mg-diag/before-view-graph-${Date.now()}.png` }).catch(() => {});
  await locator.click({ force: true, timeout: 3000 }).catch((e) => {
    fs.writeFileSync(`/tmp/mg-diag/click-error-${Date.now()}.txt`, String(e));
  });
  // Wait for the popup to actually appear before returning.
  await page.locator('.popup').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `/tmp/mg-diag/after-view-graph-${Date.now()}.png` }).catch(() => {});
  // Also log DOM state.
  const state = await page.evaluate(() => {
    const view = document.querySelector('#luker_rpg_memory_view_graph');
    const popups = Array.from(document.querySelectorAll('.popup')).map(p => ({ cls: p.className, txt: (p.innerText || '').slice(0, 120) }));
    const stats = document.querySelector('#luker_rpg_memory_stats')?.textContent?.trim();
    return { viewExists: !!view, viewVisible: view?.offsetParent !== null, popups, stats };
  }).catch(() => null);
  fs.writeFileSync(`/tmp/mg-diag/state-${Date.now()}.json`, JSON.stringify(state, null, 2));
}

/** Close whatever modal / popup is currently at the top. */
async function closeTopModal(page) {
  await page.evaluate(() => {
    // Standard popup close button lives at .popup-button-close.
    const closers = Array.from(document.querySelectorAll('.popup-button-close, .dialogue_popup_close, .popup-controls .menu_button'));
    // Prefer the last-opened popup's close button (they stack).
    const visible = closers.filter(b => b.offsetParent !== null);
    visible[visible.length - 1]?.click();
  });
  await page.waitForTimeout(600);
}

async function closeExtensionsSettings(page) {
  await page.evaluate(() => {
    const btn = document.querySelector('#extensions-settings-button > .drawer-toggle')
      || document.querySelector('#extensions-settings-button');
    const panel = document.querySelector('#rm_extensions_block');
    if (panel && !panel.classList.contains('closedDrawer')) btn?.click();
  });
  await page.waitForTimeout(500);
}

module.exports.run = async function (page) {
  await page.waitForSelector('#send_but', { timeout: 15000 });
  await page.waitForTimeout(1500);

  await H.dismissFirstRun(page);

  // Turn orchestrator OFF and Memory Graph ON before starting the chat.
  await disableOrchestrator(page);
  await enableMemoryGraph(page);

  await H.selectCharacter(page, 'Seraphina');
  await H.startFreshChat(page);
  await H.closeCharacterPanel(page);
  await page.waitForTimeout(1500);
  await H.scrubBadgeNow(page);

  // ── Turn 1 ── introduce: old bridge, wolves, injured traveler
  await H.sendUserMessage(page,
    "*I sit up carefully.* Seraphina, thank you… but I don't even remember how I got here. The last thing I remember is the sound of wolves near the old bridge."
  );
  // Embedded-regex popup can trigger on the first generation with a fresh preset.
  await page.waitForTimeout(1500);
  await H.dismissEmbeddedRegexPopupIfPresent(page);
  await H.waitForCharacterReply(page, { minLen: 200, timeout: 120000 });
  // Wait for MG extraction request to complete (debounced fire + API round-trip
  // for a full luker_rpg_extract_done tool-call sequence typically 40-90s on
  // claude-opus-4-7). Without this the graph stays empty and the whole GIF is
  // worthless.
  await page.waitForTimeout(90000);

  // Show the graph after Turn 1 so the viewer sees the very first nodes appear.
  await openExtensionsAndShowMemoryTab(page, 'graph');
  await openGraphModal(page);
  await page.waitForTimeout(5000);
  await closeTopModal(page);
  await closeExtensionsSettings(page);

  // ── Turn 2 ── introduce: starflower, ruined shrine
  await H.sendUserMessage(page,
    "*I glance at my bandaged side.* You mentioned starflower earlier. Is that what you used on the wound? I've heard travellers say it only grows near the ruined shrine."
  );
  await H.waitForCharacterReply(page, { minLen: 200, timeout: 120000 });
  await page.waitForTimeout(90000);

  // Show the graph after Turn 2 so the viewer sees it has grown.
  await openExtensionsAndShowMemoryTab(page, 'graph');
  await openGraphModal(page);
  await page.waitForTimeout(5000);
  await closeTopModal(page);
  await closeExtensionsSettings(page);

  // ── Turn 3 ── payoff: user references BOTH prior turns' entities together.
  // The recall pass on this turn should pull in nodes from Turn 1 (bridge, wolves)
  // AND Turn 2 (starflower, ruined shrine), shaping Seraphina's reply.
  await H.sendUserMessage(page,
    "*I steady myself against the wall.* Seraphina — if the starflower only grows near the ruined shrine, and the wolves prowl the old bridge, then the safe path is blocked either way. Is there a third route to the shrine?"
  );
  await H.waitForCharacterReply(page, { minLen: 200, timeout: 120000 });
  await page.waitForTimeout(90000);

  // Show the recall tab: this is where the trace for Turn 3's recall pass lives,
  // and it visually proves that the Turn 3 reply was informed by prior memory.
  await openExtensionsAndShowMemoryTab(page, 'recall');
  await page.waitForTimeout(6000);
};
