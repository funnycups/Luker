// Real-UI helpers for persona management:
//   - openPersonaPanel: open the persona drawer
//   - selectPersonaByName: click the card in the panel

export async function openPersonaPanel(page) {
    const drawer = page.locator('#persona-management-button');
    const closed = await drawer.locator('.drawer-icon').first().evaluate(el => el.classList.contains('closedIcon'));
    if (closed) {
        await drawer.locator('.drawer-toggle').first().click();
    }
    await page.waitForFunction(() => (
        document.querySelector('#PersonaManagement')?.classList.contains('openDrawer')
        && document.querySelector('#persona-management-button .drawer-icon')?.classList.contains('openIcon')
    ), { timeout: 5000 });
    await page.locator('#persona-management-block').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Select a persona by clicking its card in #persona-management-block.
 */
export async function selectPersonaByName(page, name) {
    await openPersonaPanel(page);
    const card = page.locator('#persona-management-block .avatar-container, #persona-management-block .persona_select', { hasText: name }).first();
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    await card.click();
    await page.waitForTimeout(400);
}
