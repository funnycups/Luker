import { test, expect } from '@playwright/test';
import { s3Fixture } from '../_lib/sync-s3.js';
import { restoreChatCorpus, openCorpusChat, readChat, COMPANIONS, closeChatPopups } from '../_lib/s3-chat.js';
import { openTopDrawer } from '../_lib/page.js';

const fixture = s3Fixture(test);
test.use({ actionTimeout: 30_000 });

test('corpus selection addresses the card avatar rather than the first identical display name', async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const device = await fixture.device(browser, 'corpus-card-identity');
    const { page } = device;
    const rel = 'chats/Seraphina/Forest Path.jsonl';
    await restoreChatCorpus(device, testInfo, { companions: { iter_studio: COMPANIONS.iter_studio } });
    await closeChatPopups(page);
    await openTopDrawer(page, 'rightNavHolder');
    await page.locator('#rm_button_characters').click();
    await page.locator('#character_sort_order').selectOption({ label: 'Oldest' });
    const cards = page.locator('#rm_print_characters_block .character_select', { hasText: 'Seraphina' });
    await expect(cards).toHaveCount(2);
    await expect(cards.first().locator('.avatar')).toHaveAttribute('title', /File: default_Seraphina\.png$/);
    const original = await readChat(page, rel);
    const read = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chats/get'
        && response.request().postDataJSON()?.avatar_url === 'Seraphina.png'
        && response.request().postDataJSON()?.file_name === 'Forest Path');
    const observed = read.then(response => ({ response }), error => ({ error }));
    try {
        await openCorpusChat(page, rel);
        const result = await observed;
        if (result.error) throw result.error;
        expect(result.response.ok()).toBe(true);
        expect(await result.response.json()).toEqual(original);
        expect(await readChat(page, rel)).toEqual(original);
        expect(await page.evaluate(() => {
            const context = window.Luker.getContext();
            return { avatar: context.characters[context.characterId]?.avatar, chatId: context.getCurrentChatId() };
        })).toEqual({ avatar: 'Seraphina.png', chatId: 'Forest Path' });
    } finally {
        await device.context.close();
        await observed;
    }
});
