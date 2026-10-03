// Doc screenshot capture helper for e2e specs that double as docs
// image generators.
//
// Writing into docs/ on every regression run is wrong: CI leaves the
// working tree dirty, a mock-LLM wording change silently rewrites
// committed images, and a partial / failing run can overwrite the
// canonical set the docs reference.
//
// Gate every write behind LUKER_UPDATE_DOC_SCREENSHOTS=1. The same env
// var already gates tests/e2e/_lib/ui-chat-merge-split.js and
// tests/e2e/sync/walkthrough-screenshots.e2e.js.
//
// To rebuild the docs images deliberately:
//   LUKER_UPDATE_DOC_SCREENSHOTS=1 PW_WORKERS=1 npx playwright test e2e/storage-inspector/ --reporter=line

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DOC_SCREENSHOTS_ENABLED = !!process.env.LUKER_UPDATE_DOC_SCREENSHOTS;

/**
 * Screenshot a Playwright Page or Locator into a docs path, when doc
 * screenshot regeneration was explicitly requested.
 *
 * No-op (returns null) on a plain regression run. Parent directories are
 * created on demand so callers don't need their own mkdir.
 *
 * @param {import('@playwright/test').Page | import('@playwright/test').Locator} target
 * @param {string} filePath  absolute path under docs/public/
 * @param {object} [options]  forwarded to target.screenshot()
 * @returns {Promise<string|null>} the written path, or null when gated off
 */
export async function takeDocScreenshot(target, filePath, options = {}) {
    if (!DOC_SCREENSHOTS_ENABLED) return null;
    mkdirSync(dirname(filePath), { recursive: true });
    await target.screenshot({ path: filePath, ...options });
    return filePath;
}
