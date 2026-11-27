import { test, expect } from '../harness/frontend.js';
import { testSetup } from './frontent-test-utils.js';

const customGridCss = `
#nonQRFormItems {
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

test('expands long composer drafts via user preference across built-in and custom themes', async ({ page, baseURL }) => {
    await testSetup.awaitST({ page, baseURL });

    const form = page.locator('#send_form');
    const input = page.locator('#send_textarea');
    const leftControls = page.locator('#leftSendForm');
    const rightControls = page.locator('#rightSendForm');
    const expanded = page.locator('#send_form[data-composer-draft-wrap]');

    await page.locator('#user-settings-button .drawer-toggle').click();
    const toggle = page.locator('#expand_composer_on_long_draft');
    const themes = page.locator('#themes');

    // Enabled by default as a pure user preference.
    await expect(toggle).toBeChecked();

    // Built-in Lens theme expands long drafts on desktop and mobile viewports.
    await themes.selectOption('Lens');
    await input.fill('Short');
    await input.blur();
    await expect(expanded).toHaveCount(0);
    const compactWidthDesktop = await input.evaluate(element => element.clientWidth);

    await input.fill('first\nsecond');
    await input.blur();
    await expect(expanded).toHaveCount(1);
    await expect(form).toHaveAttribute('data-composer-draft-layout', 'flex');
    await expect.poll(() => input.evaluate(element => element.clientWidth)).toBeGreaterThan(compactWidthDesktop);
    await expect.poll(async () => {
        const taBox = await input.boundingBox();
        const leftBox = await leftControls.boundingBox();
        const rightBox = await rightControls.boundingBox();
        return Boolean(taBox && leftBox && rightBox && leftBox.y >= taBox.y + taBox.height - 1 && rightBox.y >= taBox.y + taBox.height - 1);
    }).toBe(true);

    // Responsive switch to mobile viewport keeps Lens pill padding and stable collapse/expand.
    await page.setViewportSize({ width: 390, height: 700 });
    await expect(expanded).toHaveCount(1);
    await expect(input).toHaveCSS('padding-left', '12px');
    await expect(input).toHaveCSS('padding-right', '12px');

    await input.fill('Hi');
    await input.blur();
    await expect(expanded).toHaveCount(0);
    const compactWidthMobile = await input.evaluate(element => element.clientWidth);

    await input.fill('0123456789'.repeat(4));
    await input.blur();
    await expect(expanded).toHaveCount(1);
    await expect.poll(() => input.evaluate(element => element.clientWidth)).toBeGreaterThan(compactWidthMobile);

    await page.setViewportSize({ width: 1280, height: 720 });
    await input.fill('first\nsecond');
    await input.blur();
    await expect(expanded).toHaveCount(1);

    // Turning the user toggle off collapses layout and persists across theme switches.
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(expanded).toHaveCount(0);
    await expect(form).not.toHaveAttribute('data-composer-draft-layout', /.*/);

    await themes.selectOption('Dark Lite');
    await expect(toggle).not.toBeChecked();
    await expect(expanded).toHaveCount(0);

    // Turning it back on expands the built-in flex composer on classic themes too.
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(expanded).toHaveCount(1);
    await expect(form).toHaveAttribute('data-composer-draft-layout', 'flex');

    // Custom 3-column grid themes receive data-composer-draft-wrap without flex layout overrides.
    await page.locator('#ui_preset_derive_button').click();
    const css = page.locator('#customCSS');
    await expect(css).toBeEnabled();
    await css.fill(customGridCss);
    await expect(expanded).toHaveCount(1);
    await expect(form).not.toHaveAttribute('data-composer-draft-layout', 'flex');

    await input.fill('Short draft');
    await input.blur();
    await expect(expanded).toHaveCount(0);
    await expect(input).toHaveCSS('grid-column-start', '2');
    const compactWidthGrid = await input.evaluate(element => element.clientWidth);

    await input.fill('0123456789'.repeat(4));
    await input.blur();
    await expect(expanded).toHaveCount(1);
    await expect.poll(() => input.evaluate(element => element.clientWidth)).toBeGreaterThan(compactWidthGrid);

    await css.fill(customGridCss.replace('width: 420px;', 'width: 550px;'));
    await expect(expanded).toHaveCount(0);
    await css.fill(customGridCss);
    await expect(expanded).toHaveCount(1);

    const fontScaleCounter = page.locator('#font_scale_counter');
    const originalScale = await fontScaleCounter.inputValue();
    const typeFontScale = async (value) => {
        await fontScaleCounter.click();
        await fontScaleCounter.fill('');
        await fontScaleCounter.pressSequentially(value);
        await fontScaleCounter.press('Enter');
    };
    await typeFontScale('0.75');
    await expect(expanded).toHaveCount(0);
    await typeFontScale(originalScale);
    await expect(expanded).toHaveCount(1);

    await input.fill('');
    await expect(expanded).toHaveCount(0);

    // Switching back to a built-in theme keeps the user preference enabled.
    await input.fill('first\nsecond');
    await input.blur();
    await expect(expanded).toHaveCount(1);
    await themes.selectOption('Dark Lite');
    await expect(toggle).toBeChecked();
    await expect(expanded).toHaveCount(1);
    await expect(form).toHaveAttribute('data-composer-draft-layout', 'flex');
});
