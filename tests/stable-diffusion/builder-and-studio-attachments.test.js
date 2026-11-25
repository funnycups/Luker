/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

import {
    INSPECT_IMAGE_TOOL_NAME,
    STAGE_CHARACTER_PROFILE_TOOL_NAME,
    runCharacterBuilderTurn,
} from '../../public/scripts/extensions/stable-diffusion/exploration/dialog-agent.js';
import { createCharacterDraft } from '../../public/scripts/extensions/stable-diffusion/exploration/dialog-draft.js';
import {
    appendStudioUserMessage,
    buildStudioHistoryMessages,
    createStudioSession,
    createStudioSessionStore,
} from '../../public/scripts/extensions/stable-diffusion/lens/studio-store.js';

function createMemoryProfileStore(profiles = []) {
    return {
        listProfiles: async () => profiles,
        getProfilesByIds: async (ids) => profiles.filter(p => ids.includes(p.id)),
        buildCompactProfileIndex: () => '(empty)',
    };
}

describe('SD Character Builder and Studio image attachments', () => {
    let origFetch;

    beforeEach(() => {
        origFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = origFetch;
    });

    test('dialog-agent sends user-attached images losslessly with path annotations even when visualInspection is false, and stages them into draft', async () => {
        const stagedPath = '/user/images/_sandbox_tmp/sess_1/uploaded.png';
        const exactDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';
        const draft = createCharacterDraft();
        const capturedRequests = [];

        const context = {
            generateTask: jest.fn(async (opts) => {
                capturedRequests.push(JSON.parse(JSON.stringify(opts.taskMessages)));
                if (capturedRequests.length === 1) {
                    return {
                        assistantText: '',
                        toolCalls: [{
                            id: 'call_stage',
                            name: STAGE_CHARACTER_PROFILE_TOOL_NAME,
                            args: {
                                name: 'Aria',
                                description: 'Silver bob hair, crimson scarf, navy coat.',
                                reference_images: [{ path: stagedPath, label: 'Default' }],
                            },
                        }],
                    };
                }
                return {
                    assistantText: 'Updated Aria profile from your reference image.',
                    toolCalls: [],
                };
            }),
        };

        const media = {
            sessionId: 'sess_1',
            preview: jest.fn(async (p) => {
                expect(p).toBe(stagedPath);
                return exactDataUrl;
            }),
            getCapabilities: async () => ({ availableLoras: { names: [], includeWeight: false } }),
        };

        const result = await runCharacterBuilderTurn({
            context,
            preset: { explorationPrompt: 'Build character profiles.', visualInspection: false },
            messages: [{
                role: 'user',
                content: 'Reverse-engineer her appearance and keep this image.',
                attachments: [{ path: stagedPath, name: 'aria.png', mime: 'image/png' }],
            }],
            draft,
            sourcePolicy: { kind: 'none' },
            profileStore: createMemoryProfileStore(),
            media,
        });

        expect(result.finalText).toBe('Updated Aria profile from your reference image.');
        expect(capturedRequests).toHaveLength(2);
        const userMsg = capturedRequests[0][1];
        expect(Array.isArray(userMsg.content)).toBe(true);
        expect(userMsg.content[0].type).toBe('text');
        expect(userMsg.content[0].text).toContain(`[Attached image #1: ${stagedPath}]`);
        expect(userMsg.content[1]).toEqual({
            type: 'image_url',
            image_url: { url: exactDataUrl },
        });
        // Returned persisted history stays lightweight (no data: URL)
        expect(JSON.stringify(result.messages)).not.toContain('data:image/');
        expect(result.messages[0].attachments).toEqual([{ path: stagedPath, name: 'aria.png', mime: 'image/png' }]);
        expect(draft.getSnapshot().referenceImages).toEqual([{ path: stagedPath, label: 'Default' }]);
    });

    test('inspect_image inspects draft reference images on demand regardless of visualInspection and enforces sourcePolicy boundaries', async () => {
        const draftImg = '/user/images/_sandbox_tmp/sess_2/manual.png';
        const draft = createCharacterDraft({
            id: 'char_1',
            name: 'Vesper',
            referenceImages: [{ path: draftImg, label: 'Manual upload' }],
        });
        const capturedRequests = [];

        const context = {
            generateTask: jest.fn(async (opts) => {
                capturedRequests.push(JSON.parse(JSON.stringify(opts.taskMessages)));
                if (capturedRequests.length === 1) {
                    return {
                        assistantText: '',
                        toolCalls: [
                            { id: 'c_ok', name: INSPECT_IMAGE_TOOL_NAME, args: { image_paths: [draftImg] } },
                            { id: 'c_deny', name: INSPECT_IMAGE_TOOL_NAME, args: { image_paths: ['/characters/unselected.png'] } },
                        ],
                    };
                }
                return { assistantText: 'Inspected manual reference.', toolCalls: [] };
            }),
        };

        const media = {
            sessionId: 'sess_2',
            preview: jest.fn(async (p) => `data:image/png;base64,${Buffer.from(p).toString('base64')}`),
            getCapabilities: async () => ({ availableLoras: { names: [], includeWeight: false } }),
        };

        const result = await runCharacterBuilderTurn({
            context,
            preset: { explorationPrompt: 'Build character profiles.', visualInspection: false },
            messages: [{ role: 'user', content: 'Look at the manual reference on the right.' }],
            draft,
            sourcePolicy: { kind: 'none' },
            profileStore: createMemoryProfileStore(),
            media,
        });

        expect(result.finalText).toBe('Inspected manual reference.');
        expect(capturedRequests).toHaveLength(2);
        const round2Messages = capturedRequests[1];
        const denyResultMsg = round2Messages.find(m => m.role === 'tool' && m.tool_call_id === 'c_deny');
        expect(JSON.parse(denyResultMsg.content).ok).toBe(false);
        expect(JSON.parse(denyResultMsg.content).error).toContain('not_allowed');

        const inspectPreviewMsg = round2Messages[round2Messages.length - 1];
        expect(inspectPreviewMsg.role).toBe('user');
        expect(Array.isArray(inspectPreviewMsg.content)).toBe(true);
        expect(inspectPreviewMsg.content[0].text).toContain(`[Inspected image: ${draftImg}]`);
        expect(inspectPreviewMsg.content[1].type).toBe('image_url');
    });

    test('studio-store persists attachments, copies them on fork (including image source refs), and deletes owned files on deleteSession', async () => {
        const files = new Map([
            ['/user/images/_ai_attachments/st_1.png', Buffer.from([1, 2, 3])],
        ]);
        let seq = 1;
        globalThis.fetch = jest.fn(async (url, init = {}) => {
            const body = JSON.parse(init.body || '{}');
            if (url === '/api/images/copy') {
                const copies = {};
                for (const src of body.paths) {
                    seq += 1;
                    const dst = `/user/images/_ai_attachments/st_copy_${seq}.png`;
                    files.set(dst, Buffer.from(files.get(src)));
                    copies[src] = dst;
                }
                return { ok: true, status: 200, json: async () => ({ copies, missing: [] }) };
            }
            if (url === '/api/images/delete-batch') {
                const deleted = [];
                for (const p of body.paths) {
                    if (files.delete(p)) deleted.push(p);
                }
                return { ok: true, status: 200, json: async () => ({ deleted, missing: [], failed: [] }) };
            }
            throw new Error(`Unexpected fetch ${url}`);
        });

        const state = new Map();
        const context = {
            getRequestHeaders: () => ({}),
            getGlobalState: async (ns) => ({ ok: true, state: state.has(ns) ? JSON.parse(JSON.stringify(state.get(ns))) : null }),
            updateGlobalState: async (ns, updater) => {
                const cur = state.has(ns) ? JSON.parse(JSON.stringify(state.get(ns))) : null;
                const next = await updater(cur);
                if (next === null || next === undefined) return { ok: true, state: cur };
                state.set(ns, JSON.parse(JSON.stringify(next)));
                return { ok: true, state: JSON.parse(JSON.stringify(next)) };
            },
        };

        const store = createStudioSessionStore(context);
        const sess = createStudioSession({ presetId: 'p1' });
        const userMsg = appendStudioUserMessage(sess, '', {
            attachments: [{ path: '/user/images/_ai_attachments/st_1.png', name: 'pose.png' }],
            now: 100,
        });
        expect(sess.title).toBe('[Image]');
        sess.images.push({
            id: 'img_1',
            messageId: userMsg.id,
            prompt: 'restyle',
            imageUrl: '/user/images/_studio/out.png',
            sourceImageId: '/user/images/_ai_attachments/st_1.png',
            characterImageIds: ['/user/images/_ai_attachments/st_1.png'],
            status: 'ready',
            createdAt: 101,
        });
        await store.saveSession(sess);

        const history = buildStudioHistoryMessages(sess);
        expect(history[0].attachments).toEqual([{ path: '/user/images/_ai_attachments/st_1.png', name: 'pose.png' }]);

        const forked = await store.forkSessionAt(sess.id, 1, 200);
        const forkedPath = forked.messages[0].attachments[0].path;
        expect(forkedPath).not.toBe('/user/images/_ai_attachments/st_1.png');
        expect(forked.images[0].sourceImageId).toBe(forkedPath);
        expect(forked.images[0].characterImageIds).toEqual([forkedPath]);
        expect(files.has(forkedPath)).toBe(true);

        await store.deleteSession(sess.id);
        expect(files.has('/user/images/_ai_attachments/st_1.png')).toBe(false);
        expect(files.has(forkedPath)).toBe(true);
    });
});
