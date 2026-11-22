// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, jest } from '@jest/globals';

function createMemoryGlobalStateContext() {
    const bucket = new Map();
    const revisions = new Map();
    let writeCount = 0;
    const updateGlobalState = jest.fn(async (ns, updater) => {
        for (let attempt = 0; attempt <= 1; attempt++) {
            const seenRev = revisions.get(ns) ?? 0;
            const current = bucket.has(ns) ? structuredClone(bucket.get(ns)) : {};
            const next = await updater(current, { attempt, namespace: ns });
            if (next === null || next === undefined) {
                return { ok: true, state: structuredClone(bucket.get(ns) ?? current), updated: false };
            }
            if (typeof next === 'object') {
                const liveRev = revisions.get(ns) ?? 0;
                if (liveRev !== seenRev) {
                    continue;
                }
                bucket.set(ns, structuredClone(next));
                revisions.set(ns, liveRev + 1);
                writeCount += 1;
                return { ok: true, state: structuredClone(bucket.get(ns)), updated: true };
            }
        }
        return { ok: false, reason: 'conflict', hint: 'Concurrent modification conflict.' };
    });
    return {
        bucket,
        getWriteCount: () => writeCount,
        context: {
            getGlobalState: async (ns) => ({
                ok: true,
                state: bucket.has(ns) ? structuredClone(bucket.get(ns)) : null,
            }),
            updateGlobalState,
        },
    };
}

describe('character-archive/store, lens/studio-store, and DataMaidService image protection', () => {
    test('removesCardBindingsAndLegacyV1KeysFromProfiles', async () => {
        const {
            CHARACTER_PROFILES_VERSION,
            normalizeReferenceImageEntry,
            normalizeCharacterProfile,
        } = await import('../public/scripts/extensions/stable-diffusion/character-archive/store.js');

        expect(CHARACTER_PROFILES_VERSION).toBe(2);
        expect(normalizeReferenceImageEntry({ path: ' /user/images/_references/a.png ', label: ' Casual ' })).toEqual({
            path: '/user/images/_references/a.png',
            label: 'Casual',
        });
        expect(normalizeReferenceImageEntry('/user/images/_references/b.png')).toEqual({
            path: '/user/images/_references/b.png',
            label: '',
        });
        expect(normalizeReferenceImageEntry({ path: '   ', label: 'Ignored' })).toBeNull();
        expect(normalizeReferenceImageEntry(null)).toBeNull();

        const profile = normalizeCharacterProfile({
            id: 'profile_visual',
            name: 'Visual profile',
            sourceWork: 'Supplied setting',
            sourceCardAvatars: ['unrelated-card.png'],
            canonicalTags: ['should_strip'],
            negativeTags: ['should_strip'],
            proseDescription: 'should_strip',
            outfits: [{ id: 'o1', name: 'Default', referenceImages: ['/should_strip.png'] }],
            defaultOutfitId: 'o1',
            description: 'Appearance supplied by the user.',
            referenceImages: [
                { path: '/user/images/_references/dup.png', label: '' },
                { path: '/user/images/_references/dup.png', label: 'First Label' },
                { path: '/user/images/_references/dup.png', label: 'Second Label' },
            ],
        }, 100);
        expect(profile).toEqual({
            id: 'profile_visual',
            name: 'Visual profile',
            aliases: [],
            sourceWork: 'Supplied setting',
            description: 'Appearance supplied by the user.',
            referenceImages: [{ path: '/user/images/_references/dup.png', label: 'First Label' }],
            createdAt: 100,
            updatedAt: 100,
        });
        for (const removedKey of ['sourceCardAvatars', 'canonicalTags', 'negativeTags', 'proseDescription', 'outfits', 'defaultOutfitId']) {
            expect(Object.hasOwn(profile, removedKey)).toBe(false);
        }
    });

    test('profile versions use canonical normalized data', async () => {
        const store = await import('../public/scripts/extensions/stable-diffusion/character-archive/store.js');
        expect(typeof store.profileVersion).toBe('function');
        const profile = store.normalizeCharacterProfile({
            id: 'profile_visual',
            name: 'Visual profile',
            description: 'Appearance supplied by the user.',
        }, 100);
        const reordered = Object.fromEntries(Object.entries(profile).reverse());
        const withRetiredBinding = { ...reordered, sourceCardAvatars: ['unrelated-card.png'] };
        expect(store.profileVersion(withRetiredBinding)).toBe(store.profileVersion(profile));
        expect(store.profileVersion(profile)).toBe(JSON.stringify(profile));
    });

    test('profile versions distinguish changed content', async () => {
        const store = await import('../public/scripts/extensions/stable-diffusion/character-archive/store.js');
        expect(typeof store.profileVersion).toBe('function');
        const profile = store.normalizeCharacterProfile({ id: 'profile_visual', name: 'Visual profile' }, 100);
        expect(store.profileVersion({ ...profile, description: 'A revised appearance.' }))
            .not.toBe(store.profileVersion(profile));
    });

    test('an absent profile has no version', async () => {
        const store = await import('../public/scripts/extensions/stable-diffusion/character-archive/store.js');
        expect(typeof store.profileVersion).toBe('function');
        expect(store.profileVersion(null)).toBeNull();
    });

    test('character profile store performs v2 CRUD, enforces CAS and _sandbox_tmp guard, and formats index and agent views by mode', async () => {
        const {
            CHARACTER_PROFILES_NAMESPACE,
            CHARACTER_PROFILES_VERSION,
            buildCompactProfileIndex,
            formatCharacterProfileForAgent,
            profileVersion,
            createCharacterProfileStore,
        } = await import('../public/scripts/extensions/stable-diffusion/character-archive/store.js');

        const { bucket, context } = createMemoryGlobalStateContext();
        const store = createCharacterProfileStore(context);

        expect(await store.listProfiles()).toEqual([]);
        expect(context.updateGlobalState).not.toHaveBeenCalled();

        // Rejects unpromoted _sandbox_tmp reference image before persist
        await expect(store.upsertProfile({
            name: 'Unpromoted Temp',
            referenceImages: [{ path: '/user/images/_sandbox_tmp/sess-1/draft.png', label: 'Temp' }],
        })).rejects.toThrow(/Promote temporary reference images/i);

        const created = await store.upsertProfile({
            name: 'Celeste Vance',
            aliases: ['Silver Navigator', 'Celeste'],
            sourceWork: 'Sky Chronicles',
            description: 'Danbooru character tag: celeste_vance\nTall navigator with silver hair, amber eyes, and a double-breasted navy coat with brass goggles.',
            referenceImages: [
                { path: '/user/images/_references/char_celeste_aabbccddeeff0011.png', label: 'Captain Coat' },
                { path: '/user/images/_references/char_celeste_2233445566778899.png', label: 'Casual Shirt' },
            ],
        }, 1000, { expectedVersion: null, transientSessionId: 'sess-commit-1' });

        expect(created.id).toMatch(/^char_/);
        expect(bucket.get(CHARACTER_PROFILES_NAMESPACE)?.version).toBe(CHARACTER_PROFILES_VERSION);
        expect(bucket.get(CHARACTER_PROFILES_NAMESPACE)?.profiles?.[created.id]).toEqual(created);
        expect(context.updateGlobalState).toHaveBeenLastCalledWith(
            CHARACTER_PROFILES_NAMESPACE,
            expect.any(Function),
            { asyncDiff: false, transientSessionId: 'sess-commit-1' },
        );

        const listed = await store.listProfiles();
        expect(listed).toHaveLength(1);
        const indexWithImages = store.buildCompactProfileIndex(listed);
        expect(indexWithImages).toContain(`1: id=${created.id}`);
        expect(indexWithImages).toContain('name=Celeste Vance');
        expect(indexWithImages).toContain('aliases=Silver Navigator,Celeste');
        expect(indexWithImages).toContain('work=Sky Chronicles');
        expect(indexWithImages).toContain('refs=2(Captain Coat, Casual Shirt)');

        const indexWithoutImages = buildCompactProfileIndex(listed, { includeImages: false });
        expect(indexWithoutImages).not.toContain('refs=');

        const textOnly = formatCharacterProfileForAgent(created, { mode: 'text_only' });
        expect(textOnly).toContain('description: Danbooru character tag: celeste_vance');
        expect(textOnly).not.toContain('reference_images');

        const imageOnly = formatCharacterProfileForAgent(created, { mode: 'image_only' });
        expect(imageOnly).not.toContain('description:');
        expect(imageOnly).toContain('path=/user/images/_references/char_celeste_aabbccddeeff0011.png | label=Captain Coat');
        expect(imageOnly).toContain('path=/user/images/_references/char_celeste_2233445566778899.png | label=Casual Shirt');

        const textAndImage = formatCharacterProfileForAgent(created, { mode: 'text_and_image' });
        expect(textAndImage).toContain('description: Danbooru character tag: celeste_vance');
        expect(textAndImage).toContain('reference_images:');

        expect(() => formatCharacterProfileForAgent(created, { mode: 'invalid' })).toThrow(/Unsupported character profile format mode/);

        // CAS expectedVersion check rejects stale updates and deletes
        await expect(store.upsertProfile({ id: created.id, name: 'Stale' }, 2000, { expectedVersion: 'wrong' }))
            .rejects.toThrow(/changed/i);
        await expect(store.deleteProfile(created.id, { expectedVersion: 'wrong' }))
            .rejects.toThrow(/changed/i);

        const byIds = await store.getProfilesByIds([created.id, 'missing_id']);
        expect(byIds).toHaveLength(1);
        expect(byIds[0].id).toBe(created.id);

        await store.deleteProfile(created.id, { expectedVersion: profileVersion(created) });
        expect(await store.listProfiles()).toEqual([]);
    });

    test('migrates persisted v1 profiles to v2 once on first read with default outfit ordered first and deduplicated references', async () => {
        const {
            CHARACTER_PROFILES_NAMESPACE,
            CHARACTER_PROFILES_VERSION,
            migrateV1ProfileToV2,
            createCharacterProfileStore,
        } = await import('../public/scripts/extensions/stable-diffusion/character-archive/store.js');

        const rawV1 = {
            id: 'char_v1',
            name: 'Seraphina',
            aliases: ['Sera'],
            sourceWork: 'Star Harbor',
            sourceCardAvatars: ['Seraphina.png'],
            canonicalTags: ['silver_hair', 'amber_eyes'],
            negativeTags: ['extra_limbs'],
            proseDescription: 'Navigator with silver hair and amber eyes.',
            defaultOutfitId: 'outfit_coat',
            outfits: [
                {
                    id: 'outfit_casual',
                    name: 'Casual',
                    tags: ['white_shirt'],
                    prose: 'Linen shirt.',
                    referenceImages: ['/user/images/_references/shared.png', '/user/images/_references/casual.png'],
                },
                {
                    id: 'outfit_coat',
                    name: 'Captain Coat',
                    tags: ['navy_coat'],
                    prose: 'Double-breasted navy coat.',
                    referenceImages: ['/user/images/_references/shared.png'],
                },
            ],
            createdAt: 100,
            updatedAt: 200,
        };

        const migratedDirect = migrateV1ProfileToV2(rawV1, 300);
        expect(migratedDirect).not.toHaveProperty('sourceCardAvatars');
        expect(migratedDirect).not.toHaveProperty('outfits');
        expect(migratedDirect.description).toContain('Navigator with silver hair and amber eyes.');
        expect(migratedDirect.description).toContain('Tags: silver_hair, amber_eyes');
        expect(migratedDirect.description).toContain('Avoid: extra_limbs');
        expect(migratedDirect.description.indexOf('Outfit (Captain Coat):')).toBeLessThan(
            migratedDirect.description.indexOf('Outfit (Casual):'),
        );
        expect(migratedDirect.referenceImages).toEqual([
            { path: '/user/images/_references/shared.png', label: 'Captain Coat' },
            { path: '/user/images/_references/casual.png', label: 'Casual' },
        ]);

        const { bucket, context, getWriteCount } = createMemoryGlobalStateContext();
        bucket.set(CHARACTER_PROFILES_NAMESPACE, {
            version: 1,
            profiles: { char_v1: rawV1 },
        });
        const store = createCharacterProfileStore(context);

        const firstRead = await store.listProfiles();
        expect(firstRead).toHaveLength(1);
        expect(firstRead[0].id).toBe('char_v1');
        expect(firstRead[0].referenceImages).toEqual(migratedDirect.referenceImages);
        expect(bucket.get(CHARACTER_PROFILES_NAMESPACE)?.version).toBe(CHARACTER_PROFILES_VERSION);
        expect(getWriteCount()).toBe(1);

        // Subsequent reads see version 2 and do not rewrite GlobalState.
        const secondRead = await store.getProfile('char_v1');
        expect(secondRead).toEqual(firstRead[0]);
        expect(getWriteCount()).toBe(1);
    });

    test('studio session store migrates legacy settings.studioSessions once, deletes legacy field, and supports fork/CRUD', async () => {
        const {
            STUDIO_SESSIONS_NAMESPACE,
            createStudioSession,
            appendStudioUserMessage,
            appendStudioAssistantTurn,
            buildStudioHistoryMessages,
            createStudioSessionStore,
        } = await import('../public/scripts/extensions/stable-diffusion/lens/studio-store.js');

        const { bucket, context } = createMemoryGlobalStateContext();
        const store = createStudioSessionStore(context);

        const legacySession = createStudioSession({ presetId: 'preset_1', now: 100 });
        appendStudioUserMessage(legacySession, 'Draw a coastal lighthouse at dusk', 101);
        appendStudioAssistantTurn(legacySession, {
            text: 'Generated first draft.',
            toolCalls: [{ id: 'call_1', name: 'generate_image', arguments: { prompt: 'lighthouse, dusk' } }],
            toolResults: [{ tool_call_id: 'call_1', content: '{"status":"ready","url":"/user/images/_studio/s1.png"}' }],
            images: [{
                id: 'img_1',
                prompt: 'lighthouse, dusk',
                imageUrl: '/user/images/_studio/s1.png',
                characterRefs: [{ profile_id: 'char_1', image_paths: ['/user/images/_references/char_1.png'] }],
                loras: [{ name: 'a.safetensors', weight: 0.7 }],
            }],
            now: 102,
        });
        appendStudioUserMessage(legacySession, 'Add storm clouds', 103);
        appendStudioAssistantTurn(legacySession, {
            text: 'Generated second draft.',
            images: [{ id: 'img_2', prompt: 'lighthouse, storm clouds', imageUrl: '/user/images/_studio/s2.png' }],
            now: 104,
        });

        const illustrationSettings = {
            enabled: true,
            studioSessions: {
                [legacySession.id]: legacySession,
            },
        };
        const saveSettings = jest.fn();

        await store.migrateLegacySettingsSessionsOnce(illustrationSettings, saveSettings);
        expect('studioSessions' in illustrationSettings).toBe(false);
        expect(saveSettings).toHaveBeenCalledTimes(1);
        expect(bucket.get(STUDIO_SESSIONS_NAMESPACE)?.sessions?.[legacySession.id]).toBeTruthy();

        const loaded = await store.getSession(legacySession.id);
        expect(loaded.title).toBe('Draw a coastal lighthouse at dusk');
        expect(loaded.images).toHaveLength(2);
        expect(loaded.images[0].characterRefs).toEqual([
            { profileId: 'char_1', imagePaths: ['/user/images/_references/char_1.png'] },
        ]);
        const llmHistory = buildStudioHistoryMessages(loaded);
        expect(llmHistory[0]).toEqual({ role: 'user', content: 'Draw a coastal lighthouse at dusk' });
        expect(llmHistory[1].role).toBe('assistant');
        expect(llmHistory[2].role).toBe('tool');

        // Fork after the first user+assistant exchange (first 2 messages) keeps img_1 and excludes img_2.
        const forked = await store.forkSessionAt(legacySession.id, 2);
        expect(forked.id).not.toBe(legacySession.id);
        expect(forked.messages).toHaveLength(2);
        expect(forked.images.map(i => i.id)).toEqual(['img_1']);

        await store.deleteSession(forked.id);
        expect((await store.listSessions()).map(s => s.id)).toEqual([legacySession.id]);
    });

    test('DataMaidService protects _references, _style_references, and _studio images referenced in globalStates and settings.json while flagging unreferenced loose images', async () => {
        const { DataMaidService } = await import('../src/endpoints/data-maid.js');

        const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-maid-sd-'));
        try {
            const dirs = {
                root: userRoot,
                userImages: path.join(userRoot, 'user', 'images'),
                files: path.join(userRoot, 'user', 'files'),
                chats: path.join(userRoot, 'chats'),
                groupChats: path.join(userRoot, 'group chats'),
                groups: path.join(userRoot, 'groups'),
                characters: path.join(userRoot, 'characters'),
                avatars: path.join(userRoot, 'User Avatars'),
                backgrounds: path.join(userRoot, 'backgrounds'),
                thumbnailsAvatar: path.join(userRoot, 'thumbnails', 'avatar'),
                thumbnailsBg: path.join(userRoot, 'thumbnails', 'bg'),
                thumbnailsPersona: path.join(userRoot, 'thumbnails', 'persona'),
                backups: path.join(userRoot, 'backups'),
            };
            for (const d of Object.values(dirs)) {
                fs.mkdirSync(d, { recursive: true });
            }
            fs.mkdirSync(path.join(dirs.userImages, '_references'), { recursive: true });
            fs.mkdirSync(path.join(dirs.userImages, '_style_references'), { recursive: true });
            fs.mkdirSync(path.join(dirs.userImages, '_studio'), { recursive: true });
            fs.mkdirSync(path.join(userRoot, 'states'), { recursive: true });

            const protectedCharRef = path.join(dirs.userImages, '_references', 'char_1_abcd.png');
            const protectedStyleRef = path.join(dirs.userImages, '_style_references', 'vibe_1234.png');
            const protectedStudioImg = path.join(dirs.userImages, '_studio', 'draft_1.png');
            const orphanRef = path.join(dirs.userImages, '_references', 'deleted_char_orphan.png');
            const orphanStudioImg = path.join(dirs.userImages, '_studio', 'deleted_session_orphan.png');

            for (const f of [protectedCharRef, protectedStyleRef, protectedStudioImg, orphanRef, orphanStudioImg]) {
                fs.writeFileSync(f, 'png-bytes');
            }

            // Write v2 globalStates files under states/
            fs.writeFileSync(path.join(userRoot, 'states', 'sd_character_profiles.json'), JSON.stringify({
                version: 2,
                profiles: {
                    char_1: {
                        id: 'char_1',
                        name: 'Char One',
                        description: 'Plain text visual description.',
                        referenceImages: [{ path: '/user/images/_references/char_1_abcd.png', label: 'Default' }],
                    },
                },
            }));
            fs.writeFileSync(path.join(userRoot, 'states', 'sd_studio_sessions.json'), JSON.stringify({
                sessions: {
                    sess_1: {
                        images: [{ imageUrl: '/user/images/_studio/draft_1.png' }],
                    },
                },
            }));

            // Write settings.json referencing style_references
            fs.writeFileSync(path.join(userRoot, 'settings.json'), JSON.stringify({
                extension_settings: {
                    sd: {
                        style_references: [{ imagePath: '/user/images/_style_references/vibe_1234.png', strength: 0.6 }],
                    },
                },
            }));

            const maid = new DataMaidService('default-user', dirs);
            const report = await maid.generateReport();

            expect(report.images).not.toContain(protectedCharRef);
            expect(report.images).not.toContain(protectedStyleRef);
            expect(report.images).not.toContain(protectedStudioImg);
            expect(report.images).toEqual(expect.arrayContaining([orphanRef, orphanStudioImg]));
            expect(report.images).toHaveLength(2);
        } finally {
            fs.rmSync(userRoot, { recursive: true, force: true });
        }
    });
});
