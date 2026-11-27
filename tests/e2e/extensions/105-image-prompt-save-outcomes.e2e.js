import { test, expect } from '../../harness/playwright.js';
import { observeOperations } from '../../harness/observations.js';
import { readFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    openExtensionsDrawer,
    openInlineDrawer,
    selectCharacterByName,
} from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

const AVATAR_A = 'watchpost-portrait-a.png';
const AVATAR_B = 'watchpost-portrait-b.png';
const NAME_A = 'Keeper of the Watchpost Portrait';
const NAME_B = 'Keeper of the Harbor Portrait';

const UNSHARED_EXT_A = {
    retained: { sibling: 'keep-portrait-a', notes: ['headland', 'lantern'] },
};

const SHARED_PROMPT_A = {
    positive: 'storm cloak, copper lantern, coastal cliffs',
    negative: 'lowres, blurry',
};

const SHARED_EXT_A = {
    ...UNSHARED_EXT_A,
    sd_character_prompt: SHARED_PROMPT_A,
};

const SHARED_PROMPT_B = {
    positive: 'harbor mist, brass compass, oilskin coat',
    negative: 'glare, watermark',
};

const SHARED_EXT_B = {
    retained: { sibling: 'keep-portrait-b' },
    sd_character_prompt: SHARED_PROMPT_B,
};

let server;

const cardPath = (avatar = AVATAR_A) => resolve(server.dataRoot, 'default-user', 'characters', avatar);
const readDiskCard = (avatar = AVATAR_A) => JSON.parse(readPngCard(readFileSync(cardPath(avatar)))).data;

async function bootstrapScenario(resources, { scenarioId, extA = UNSHARED_EXT_A, extB = SHARED_EXT_B } = {}) {
    server = await startServer({
        scope: resources,
        batchKey: 'extensions',
        scenarioId,
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: AVATAR_A,
        overrides: { name: NAME_A, extensions: structuredClone(extA) },
    });
    writeEmbeddedCharacter({
        dataRoot: server.dataRoot,
        avatarFile: AVATAR_B,
        overrides: { name: NAME_B, extensions: structuredClone(extB) },
    });
}

async function openImageGenerationDrawer(page) {
    await openExtensionsDrawer(page);
    await openInlineDrawer(page, 'sd_container');
    await expect(page.locator('#sd_character_prompt_block')).toBeVisible();
}

async function readPromptMirrors(page, avatarA = AVATAR_A, avatarB = AVATAR_B) {
    return page.evaluate(({ a, b }) => {
        const ctx = window.Luker.getContext();
        const charA = ctx.characters.find(c => c?.avatar === a);
        const charB = ctx.characters.find(c => c?.avatar === b);
        const selected = ctx.characters[Number(ctx.characterId)];
        const editorJsonRaw = document.querySelector('#character_json_data')?.value || '';
        const editorJson = editorJsonRaw ? JSON.parse(editorJsonRaw) : null;
        const keyA = a.replace(/\.[^/.]+$/, '');
        const keyB = b.replace(/\.[^/.]+$/, '');
        return {
            selectedAvatar: selected?.avatar || null,
            liveA: charA?.data?.extensions ?? null,
            jsonA: charA?.json_data ? JSON.parse(charA.json_data).data.extensions : null,
            liveB: charB?.data?.extensions ?? null,
            jsonB: charB?.json_data ? JSON.parse(charB.json_data).data.extensions : null,
            editorExtensions: editorJson?.data?.extensions ?? null,
            positiveControl: document.querySelector('#sd_character_prompt')?.value ?? '',
            negativeControl: document.querySelector('#sd_character_negative_prompt')?.value ?? '',
            shareChecked: Boolean(document.querySelector('#sd_character_prompt_share')?.checked),
            descriptionControl: document.querySelector('#description_textarea')?.value ?? '',
            localPositiveA: ctx.extensionSettings?.sd?.character_prompts?.[keyA] ?? '',
            localNegativeA: ctx.extensionSettings?.sd?.character_negative_prompts?.[keyA] ?? '',
            localPositiveB: ctx.extensionSettings?.sd?.character_prompts?.[keyB] ?? '',
            localNegativeB: ctx.extensionSettings?.sd?.character_negative_prompts?.[keyB] ?? '',
        };
    }, { a: avatarA, b: avatarB });
}

async function runWithFailureMode(failureMode, { page, context, avatar = AVATAR_A }, trigger) {
    const file = cardPath(avatar);
    const originalBytes = readFileSync(file);
    const held = `${file}.held`;
    if (failureMode === 'http') {
        renameSync(file, held);
    } else {
        await context.setOffline(true);
    }
    try {
        const failWait = failureMode === 'http'
            ? page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes'))
            : page.waitForEvent('requestfailed', r => r.url().endsWith('/api/characters/merge-attributes'));
        await trigger();
        const outcome = await failWait;
        if (failureMode === 'http') {
            expect(outcome.status()).toBe(500);
        }
        return {
            originalBytes,
            currentBytes: readFileSync(failureMode === 'http' ? held : file),
        };
    } finally {
        if (failureMode === 'http') {
            renameSync(held, file);
        } else {
            await context.setOffline(false);
        }
    }
}

for (const failureMode of ['http', 'transport']) {
    test(`share enable ${failureMode} failure keeps local prompts and unsaved form state, reverts checkbox, and retries cleanly`, async ({ page, context, resources }) => {
        test.setTimeout(120_000);
        await bootstrapScenario(resources, { scenarioId: `105-sd-share-enable-${failureMode}` });
        const mergeRequests = [];
        page.on('request', req => {
            if (req.url().endsWith('/api/characters/merge-attributes')) {
                mergeRequests.push(req.postData());
            }
        });

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, NAME_B);
        await selectCharacterByName(page, NAME_A);

        // Create unrelated unsaved character form state to verify it is preserved.
        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#description_textarea')).toBeVisible();
        const unsavedDescription = 'Unsaved headland watch note that must stay untouched.';
        await page.locator('#description_textarea').fill(unsavedDescription);

        await openImageGenerationDrawer(page);
        await expect(page.locator('#sd_character_prompt_share')).not.toBeChecked();

        const typedPositive = 'sea cloak, brass spyglass, steady lantern glow';
        const typedNegative = 'blurry, extra fingers';
        const settingsSavedAfterTyping = page.waitForResponse(r => /\/api\/settings\/(save|patch)$/.test(r.url()) && r.status() === 200);
        await page.locator('#sd_character_prompt').fill(typedPositive);
        await page.locator('#sd_character_negative_prompt').fill(typedNegative);
        await settingsSavedAfterTyping;

        // Typing while share is UNCHECKED must NOT publish sd_character_prompt to the card!
        expect(mergeRequests).toEqual([]);
        expect(readDiskCard(AVATAR_A).extensions).toEqual(UNSHARED_EXT_A);

        const failedBytes = await runWithFailureMode(failureMode, { page, context, avatar: AVATAR_A }, async () => {
            await page.locator('#sd_character_prompt_share').click();
        });
        expect(failedBytes.currentBytes).toEqual(failedBytes.originalBytes);

        await expect(page.locator('#sd_character_prompt_share')).not.toBeChecked();
        await expect(page.locator('#toast-container .toast-error').filter({ hasText: 'character image prompts' }).first()).toBeVisible();

        const mirrors = await readPromptMirrors(page);
        expect(mirrors.positiveControl).toBe(typedPositive);
        expect(mirrors.negativeControl).toBe(typedNegative);
        expect(mirrors.localPositiveA).toBe(typedPositive);
        expect(mirrors.localNegativeA).toBe(typedNegative);
        expect(mirrors.descriptionControl).toBe(unsavedDescription);
        expect(mirrors.liveA).toEqual(UNSHARED_EXT_A);
        expect(mirrors.jsonA).toEqual(UNSHARED_EXT_A);
        expect(mirrors.editorExtensions).toEqual(UNSHARED_EXT_A);
        expect(mirrors.liveB).toEqual(SHARED_EXT_B);

        // Retry enabling share -> persists complete sd_character_prompt object cleanly.
        const okShare = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes') && r.status() === 200);
        await page.locator('#sd_character_prompt_share').check();
        await okShare;

        const expectedShared = {
            ...UNSHARED_EXT_A,
            sd_character_prompt: {
                positive: typedPositive,
                negative: typedNegative,
            },
        };
        await expect(page.locator('#sd_character_prompt_share')).toBeChecked();
        await expect.poll(async () => (await readPromptMirrors(page)).liveA).toEqual(expectedShared);
        const afterRetry = await readPromptMirrors(page);
        expect(readDiskCard(AVATAR_A).extensions).toEqual(expectedShared);
        expect(afterRetry.jsonA).toEqual(expectedShared);
        expect(afterRetry.editorExtensions).toEqual(expectedShared);
        expect(afterRetry.descriptionControl).toBe(unsavedDescription);
        expect(readDiskCard(AVATAR_B).extensions).toEqual(SHARED_EXT_B);
    });

    test(`share disable ${failureMode} failure preserves shared card state, reverts checkbox, and retries to null`, async ({ page, context, resources }) => {
        test.setTimeout(120_000);
        await bootstrapScenario(resources, {
            scenarioId: `105-sd-share-disable-${failureMode}`,
            extA: SHARED_EXT_A,
        });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, NAME_A);
        await openImageGenerationDrawer(page);
        await expect(page.locator('#sd_character_prompt_share')).toBeChecked();
        await expect(page.locator('#sd_character_prompt')).toHaveValue(SHARED_PROMPT_A.positive);
        await expect(page.locator('#sd_character_negative_prompt')).toHaveValue(SHARED_PROMPT_A.negative);

        const failedBytes = await runWithFailureMode(failureMode, { page, context, avatar: AVATAR_A }, async () => {
            await page.locator('#sd_character_prompt_share').click();
        });
        expect(failedBytes.currentBytes).toEqual(failedBytes.originalBytes);

        await expect(page.locator('#sd_character_prompt_share')).toBeChecked();
        await expect(page.locator('#toast-container .toast-error').filter({ hasText: 'character image prompts' }).first()).toBeVisible();

        const mirrors = await readPromptMirrors(page);
        expect(mirrors.liveA).toEqual(SHARED_EXT_A);
        expect(mirrors.jsonA).toEqual(SHARED_EXT_A);
        expect(mirrors.editorExtensions).toEqual(SHARED_EXT_A);
        expect(mirrors.positiveControl).toBe(SHARED_PROMPT_A.positive);
        expect(mirrors.negativeControl).toBe(SHARED_PROMPT_A.negative);

        // Retry disabling share -> writes literal null while preserving editable local prompts.
        const okUnshare = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes') && r.status() === 200);
        await page.locator('#sd_character_prompt_share').uncheck();
        await okUnshare;

        const expectedUnshared = {
            ...UNSHARED_EXT_A,
            sd_character_prompt: null,
        };
        await expect(page.locator('#sd_character_prompt_share')).not.toBeChecked();
        await expect.poll(async () => (await readPromptMirrors(page)).liveA).toEqual(expectedUnshared);
        const afterUnshare = await readPromptMirrors(page);
        expect(readDiskCard(AVATAR_A).extensions).toEqual(expectedUnshared);
        expect(afterUnshare.jsonA).toEqual(expectedUnshared);
        expect(afterUnshare.editorExtensions).toEqual(expectedUnshared);
        expect(afterUnshare.positiveControl).toBe(SHARED_PROMPT_A.positive);
        expect(afterUnshare.negativeControl).toBe(SHARED_PROMPT_A.negative);
        expect(afterUnshare.localPositiveA).toBe(SHARED_PROMPT_A.positive);
        expect(afterUnshare.localNegativeA).toBe(SHARED_PROMPT_A.negative);
    });
}

test('pending debounced edit cancelled by unshare never republishes sharing and newer same-avatar edit supersedes older held write', async ({ page, resources }) => {
    test.setTimeout(120_000);
    await bootstrapScenario(resources, {
        scenarioId: '105-sd-debounce-unshare-and-supersede',
        extA: SHARED_EXT_A,
    });
    const mergePayloads = [];
    page.on('request', req => {
        if (req.url().endsWith('/api/characters/merge-attributes')) {
            mergePayloads.push(JSON.parse(req.postData()));
        }
    });

    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, NAME_A);
    await openImageGenerationDrawer(page);

    // Part 1: Type into shared prompt (arming 1s debounce) then immediately uncheck Share before debounce fires.
    const editedPositive = 'winter cloak, salt frost, weathered chart';
    const editedNegative = 'foggy, washed out';
    await page.locator('#sd_character_prompt').fill(editedPositive);
    await page.locator('#sd_character_negative_prompt').fill(editedNegative);
    const unshareOk = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes') && r.status() === 200);
    const settingsSaved = page.waitForResponse(r => /\/api\/settings\/(save|patch)$/.test(r.url()) && r.status() === 200);
    await page.locator('#sd_character_prompt_share').uncheck();
    await unshareOk;
    await settingsSaved;

    // Trigger another debounced local edit while unshared and await its settings save (which is >= 1s debounce window)
    // to prove the previously cancelled debounce never fired and unshared edits never write to the card.
    const secondLocalSave = page.waitForResponse(r => /\/api\/settings\/(save|patch)$/.test(r.url()) && r.status() === 200);
    await page.locator('#sd_character_prompt').fill(editedPositive + ', slate sky');
    await secondLocalSave;

    expect(mergePayloads).toHaveLength(1);
    expect(mergePayloads[0].data.extensions.sd_character_prompt).toBeNull();
    const expectedNull = { ...UNSHARED_EXT_A, sd_character_prompt: null };
    expect(readDiskCard(AVATAR_A).extensions).toEqual(expectedNull);
    const afterUnshare = await readPromptMirrors(page);
    expect(afterUnshare.shareChecked).toBe(false);
    expect(afterUnshare.liveA).toEqual(expectedNull);
    expect(afterUnshare.positiveControl).toBe(editedPositive + ', slate sky');
    expect(afterUnshare.negativeControl).toBe(editedNegative);

    // Part 2: Re-enable share, then hold edit #1 via observeOperations while typing newer edit #2 on same avatar.
    const reShareOk = page.waitForResponse(r => r.url().endsWith('/api/characters/merge-attributes') && r.status() === 200);
    await page.locator('#sd_character_prompt_share').check();
    await reShareOk;

    const observer = await observeOperations({
        page,
        scope: resources,
        baseURL: server.baseURL,
        patterns: ['Request', 'Response'].map(requestStage => ({ urlPattern: '*/api/characters/merge-attributes*', requestStage })),
        networkFilter: e => new URL(e.request.url).pathname.endsWith('/api/characters/merge-attributes'),
        readStored: () => readDiskCard(AVATAR_A),
        recordBodies: true,
        enableDebugger: false,
    });
    let heldEdit1 = null;
    let resolveEdit1 = null;
    const edit1HeldPromise = new Promise(r => { resolveEdit1 = r; });
    observer.hold('hold-older-prompt-edit', ({ response, event }) => {
        if (!response) return false;
        heldEdit1 = event;
        resolveEdit1(event);
        return true;
    }, { repeat: false });

    try {
        await page.locator('#sd_character_prompt').fill('dawn watch lantern');
        await edit1HeldPromise;

        // While edit #1's response is still held, type newer edit #2 on the same avatar.
        const edit2Response = page.waitForResponse(r => {
            if (!r.url().endsWith('/api/characters/merge-attributes') || r.status() !== 200) return false;
            const body = JSON.parse(r.request().postData() || '{}');
            return body?.data?.extensions?.sd_character_prompt?.positive === 'midnight beacon flame';
        });
        await page.locator('#sd_character_prompt').fill('midnight beacon flame');

        // Release edit #1; edit #2 must run next and be the final acknowledged state.
        await observer.release(heldEdit1);
        await edit2Response;

        const expectedFinal = {
            ...UNSHARED_EXT_A,
            sd_character_prompt: {
                positive: 'midnight beacon flame',
                negative: editedNegative,
            },
        };
        await expect.poll(async () => (await readPromptMirrors(page)).liveA).toEqual(expectedFinal);
        const finalMirrors = await readPromptMirrors(page);
        expect(readDiskCard(AVATAR_A).extensions).toEqual(expectedFinal);
        expect(finalMirrors.jsonA).toEqual(expectedFinal);
        expect(finalMirrors.editorExtensions).toEqual(expectedFinal);
        expect(finalMirrors.shareChecked).toBe(true);
        expect(finalMirrors.positiveControl).toBe('midnight beacon flame');
    } finally {
        await observer.close();
    }
});

test('selection change and character object replacement during pending prompt writes never corrupt another avatar or controls', async ({ page, resources }) => {
    test.setTimeout(120_000);
    await bootstrapScenario(resources, {
        scenarioId: '105-sd-ownership-and-replacement',
        extA: UNSHARED_EXT_A,
        extB: SHARED_EXT_B,
    });
    await awaitMainUI(page, server.baseURL);
    await selectCharacterByName(page, NAME_B);
    await selectCharacterByName(page, NAME_A);
    await openImageGenerationDrawer(page);
    await page.locator('#sd_character_prompt').fill('watchpost signal lamp');
    await page.locator('#sd_character_negative_prompt').fill('overexposed');

    const observer = await observeOperations({
        page,
        scope: resources,
        baseURL: server.baseURL,
        patterns: ['Request', 'Response'].map(requestStage => ({ urlPattern: '*/api/characters/merge-attributes*', requestStage })),
        networkFilter: e => new URL(e.request.url).pathname.endsWith('/api/characters/merge-attributes'),
        readStored: () => ({ a: readDiskCard(AVATAR_A), b: readDiskCard(AVATAR_B) }),
        recordBodies: true,
        enableDebugger: false,
    });
    let heldA = null;
    let resolveHeldA = null;
    const heldAPromise = new Promise(r => { resolveHeldA = r; });
    observer.hold('hold-share-a', ({ response, event }) => {
        if (response) return false;
        heldA = event;
        resolveHeldA(event);
        return true;
    }, { repeat: false });

    try {
        // Trigger share on Character A -> held before server commit.
        await page.locator('#sd_character_prompt_share').click();
        await heldAPromise;

        // Switch to Character B while A's share write is pending.
        await selectCharacterByName(page, NAME_B);
        await expect.poll(async () => (await readPromptMirrors(page)).selectedAvatar).toBe(AVATAR_B);
        await expect(page.locator('#sd_character_prompt_share')).toBeChecked();
        await expect(page.locator('#sd_character_prompt')).toHaveValue(SHARED_PROMPT_B.positive);

        // Fail Character A's late response with ConnectionReset -> B's checkbox and controls MUST stay untouched!
        await observer.release(heldA, { failReason: 'ConnectionReset' });
        await expect(page.locator('#toast-container .toast-error').first()).toBeVisible();

        const afterLateFail = await readPromptMirrors(page);
        expect(afterLateFail.selectedAvatar).toBe(AVATAR_B);
        expect(afterLateFail.shareChecked).toBe(true);
        expect(afterLateFail.positiveControl).toBe(SHARED_PROMPT_B.positive);
        expect(afterLateFail.negativeControl).toBe(SHARED_PROMPT_B.negative);
        expect(afterLateFail.liveB).toEqual(SHARED_EXT_B);
        expect(readDiskCard(AVATAR_B).extensions).toEqual(SHARED_EXT_B);
        expect(afterLateFail.liveA).toEqual(UNSHARED_EXT_A);
        expect(readDiskCard(AVATAR_A).extensions).toEqual(UNSHARED_EXT_A);
    } finally {
        await observer.close();
    }
});
