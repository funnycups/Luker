// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, jest } from '@jest/globals';

function createMemoryGlobalStateContext() {
    const bucket = new Map();
    return {
        bucket,
        context: {
            getGlobalState: async (ns) => ({
                ok: true,
                state: bucket.has(ns) ? structuredClone(bucket.get(ns)) : null,
            }),
            updateGlobalState: async (ns, updater) => {
                const current = bucket.has(ns) ? structuredClone(bucket.get(ns)) : {};
                const next = await updater(current, { attempt: 0, namespace: ns });
                if (next && typeof next === 'object') {
                    bucket.set(ns, structuredClone(next));
                }
                return { ok: true, state: bucket.get(ns) ?? current, updated: true };
            },
        },
    };
}

describe('character-archive/store, lens/studio-store, and DataMaidService image protection', () => {
    test('removesCardBindingsFromProfiles', async () => {
        const { normalizeCharacterProfile } = await import('../public/scripts/extensions/stable-diffusion/character-archive/store.js');
        const profile = normalizeCharacterProfile({
            id: 'profile_visual',
            name: 'Visual profile',
            sourceWork: 'Supplied setting',
            sourceCardAvatars: ['unrelated-card.png'],
            proseDescription: 'Appearance supplied by the user.',
        }, 100);
        expect(profile).not.toHaveProperty('sourceCardAvatars');
        expect(profile.sourceWork).toBe('Supplied setting');
        expect(profile.proseDescription).toBe('Appearance supplied by the user.');
    });

    test('profile versions use canonical normalized data', async () => {
        const store = await import('../public/scripts/extensions/stable-diffusion/character-archive/store.js');
        expect(typeof store.profileVersion).toBe('function');
        const profile = store.normalizeCharacterProfile({
            id: 'profile_visual',
            name: 'Visual profile',
            proseDescription: 'Appearance supplied by the user.',
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
        expect(store.profileVersion({ ...profile, proseDescription: 'A revised appearance.' }))
            .not.toBe(store.profileVersion(profile));
    });

    test('an absent profile has no version', async () => {
        const store = await import('../public/scripts/extensions/stable-diffusion/character-archive/store.js');
        expect(typeof store.profileVersion).toBe('function');
        expect(store.profileVersion(null)).toBeNull();
    });

    test('character profile store performs CRUD, resolves outfits, and formats compact grep-style index without arbitrary caps', async () => {
        const {
            CHARACTER_PROFILES_NAMESPACE,
            createCharacterProfileStore,
            resolveProfileAssets,
        } = await import('../public/scripts/extensions/stable-diffusion/character-archive/store.js');

        const { bucket, context } = createMemoryGlobalStateContext();
        const store = createCharacterProfileStore(context);

        expect(await store.listProfiles()).toEqual([]);

        const created = await store.upsertProfile({
            name: 'Celeste Vance',
            aliases: ['Silver Navigator', 'Celeste'],
            sourceWork: 'Sky Chronicles',
            sourceCardAvatars: ['Seraphina.png'],
            canonicalTags: ['1girl', 'silver_hair', 'amber_eyes'],
            negativeTags: ['extra_arms'],
            proseDescription: 'Tall navigator with silver hair and amber eyes.',
            outfits: [
                {
                    id: 'outfit_coat',
                    name: 'Captain Coat',
                    tags: ['navy_coat', 'brass_goggles'],
                    prose: 'Double-breasted navy coat with brass goggles.',
                    referenceImages: ['/user/images/_references/char_celeste_aabbccddeeff0011.png'],
                },
                {
                    id: 'outfit_casual',
                    name: 'Casual Shirt',
                    tags: ['white_shirt'],
                    prose: 'Rolled-sleeve linen shirt.',
                    referenceImages: ['/user/images/_references/char_celeste_2233445566778899.png'],
                },
            ],
            defaultOutfitId: 'outfit_coat',
        });

        expect(created.id).toMatch(/^char_/);
        expect(bucket.get(CHARACTER_PROFILES_NAMESPACE)?.profiles?.[created.id]).toBeTruthy();

        const listed = await store.listProfiles();
        expect(listed).toHaveLength(1);
        const indexText = store.buildCompactProfileIndex(listed);
        expect(indexText).toContain(`1: id=${created.id}`);
        expect(indexText).toContain('name=Celeste Vance');
        expect(indexText).toContain('outfit_coat:Captain Coat(refs=1)');
        expect(indexText).toContain('outfit_casual:Casual Shirt(refs=1)');

        const defaultAssets = resolveProfileAssets(created);
        expect(defaultAssets.outfitId).toBe('outfit_coat');
        expect(defaultAssets.referenceImages).toEqual(['/user/images/_references/char_celeste_aabbccddeeff0011.png']);
        expect(defaultAssets.negativeTags).toEqual(['extra_arms']);

        const casualAssets = resolveProfileAssets(created, { outfitId: 'outfit_casual' });
        expect(casualAssets.outfitId).toBe('outfit_casual');
        expect(casualAssets.referenceImages).toEqual(['/user/images/_references/char_celeste_2233445566778899.png']);

        const byIds = await store.getProfilesByIds([created.id, 'missing_id']);
        expect(byIds).toHaveLength(1);
        expect(byIds[0].id).toBe(created.id);

        await store.deleteProfile(created.id);
        expect(await store.listProfiles()).toEqual([]);
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
            images: [{ id: 'img_1', prompt: 'lighthouse, dusk', imageUrl: '/user/images/_studio/s1.png', loras: [{ name: 'a.safetensors', weight: 0.7 }] }],
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

            // Write globalStates files under states/
            fs.writeFileSync(path.join(userRoot, 'states', 'sd_character_profiles.json'), JSON.stringify({
                profiles: {
                    char_1: {
                        outfits: [{ referenceImages: ['/user/images/_references/char_1_abcd.png'] }],
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
