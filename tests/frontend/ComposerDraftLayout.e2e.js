import { test, expect } from '../harness/frontend.js';
import { testSetup } from './frontent-test-utils.js';

const compactCss = `
#nonQRFormItems {
    --composer-compact-padding-x: 4px;
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr) 40px;
    column-gap: 0;
    width: 420px;
}
#leftSendForm { grid-area: 1 / 1; }
#rightSendForm { grid-area: 1 / 3; }
#send_textarea {
    grid-area: 1 / 2;
    min-width: 0;
    width: 100%;
    font: var(--mainFontSize) monospace;
    padding-inline: 4px;
    field-sizing: fixed;
}
#send_form:is([data-composer-draft-wrap], :has(#send_textarea:focus)) #send_textarea {
    grid-area: 1 / 1 / 2 / -1;
}
#send_form:is([data-composer-draft-wrap], :has(#send_textarea:focus)) :is(#leftSendForm, #rightSendForm) {
    grid-row: 2;
}
`;

test('only opt-in themes keep a long composer draft expanded after blur', async ({ page, baseURL }) => {
    await page.addInitScript(() => {
        const observed = new Set();
        window.composerObserverCount = () => observed.size;
        window.ResizeObserver = class extends window.ResizeObserver {
            observe(target, options) {
                if (target.id === 'nonQRFormItems') observed.add(this);
                super.observe(target, options);
            }
            disconnect() {
                observed.delete(this);
                super.disconnect();
            }
        };
    });
    await testSetup.awaitST({ page, baseURL });

    const input = page.locator('#send_textarea');
    const row = page.locator('#nonQRFormItems');
    const expanded = page.locator('#send_form[data-composer-draft-wrap]');
    const activeObservers = () => page.evaluate(() => window.composerObserverCount());

    await page.locator('#user-settings-button .drawer-toggle').click();
    const themes = page.locator('#themes');
    await themes.selectOption('Dark Lite');
    await input.fill('first\nsecond');
    await input.blur();
    await expect(expanded).toHaveCount(0);
    const defaultObservers = await activeObservers();

    await page.locator('#ui_preset_derive_button').click();
    const css = page.locator('#customCSS');
    await expect(css).toBeEnabled();
    await css.fill(compactCss);
    await expect(expanded).toHaveCount(1);
    await expect.poll(activeObservers).toBe(defaultObservers + 1);

    await input.fill('Short draft');
    await input.blur();
    await expect(expanded).toHaveCount(0);
    await expect(input).toHaveCSS('grid-column-start', '2');
    const compactWidth = await input.evaluate(element => element.clientWidth);

    await input.fill('0123456789'.repeat(4));
    await input.blur();
    await expect(expanded).toHaveCount(1);
    await expect.poll(() => input.evaluate(element => element.clientWidth)).toBeGreaterThan(compactWidth);

    await row.evaluate(element => { element.style.width = '550px'; });
    await expect(expanded).toHaveCount(0);
    await row.evaluate(element => { element.style.width = ''; });
    await expect(expanded).toHaveCount(1);

    const fontScale = page.locator('#font_scale');
    const originalScale = await fontScale.inputValue();
    const setFontScale = value => fontScale.evaluate((element, scale) => {
        element.value = scale;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, value);
    await setFontScale('0.75');
    await expect(expanded).toHaveCount(0);
    await setFontScale(originalScale);
    await expect(expanded).toHaveCount(1);

    await input.evaluate(element => {
        element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(expanded).toHaveCount(0);

    await input.fill('first\nsecond');
    await input.blur();
    await expect(expanded).toHaveCount(1);
    await css.fill(compactCss.replace('4px;', '2em;'));
    await expect(expanded).toHaveCount(0);
    await expect.poll(activeObservers).toBe(defaultObservers);

    await css.fill(compactCss);
    await expect(expanded).toHaveCount(1);
    await expect.poll(activeObservers).toBe(defaultObservers + 1);
    await themes.selectOption('Dark Lite');
    await expect(expanded).toHaveCount(0);
    await expect.poll(activeObservers).toBe(defaultObservers);
});
