/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, jest } from '@jest/globals';

import {
    createImageAttachmentTray,
    renderMessageAttachments,
} from '../../public/scripts/lens-shared/image-attachments.js';

describe('lens-shared/image-attachments', () => {
    test('stages files in memory on add/paste/drop, commits in order, and revokes ObjectURLs on clear', async () => {
        const createdUrls = [];
        const revokedUrls = [];
        const origCreate = URL.createObjectURL;
        const origRevoke = URL.revokeObjectURL;
        URL.createObjectURL = jest.fn(() => {
            const url = `blob:mock-${createdUrls.length + 1}`;
            createdUrls.push(url);
            return url;
        });
        URL.revokeObjectURL = jest.fn((u) => { revokedUrls.push(u); });

        try {
            const composer = document.createElement('div');
            const textarea = document.createElement('textarea');
            composer.appendChild(textarea);
            document.body.appendChild(composer);

            const onError = jest.fn();
            const tray = createImageAttachmentTray({
                composerEl: composer,
                textareaEl: textarea,
                onError,
            });
            composer.appendChild(tray.trayEl);
            composer.appendChild(tray.attachButton);
            composer.appendChild(tray.fileInput);

            expect(tray.hasItems()).toBe(false);
            expect(tray.trayEl.hidden).toBe(true);

            // Restore a managed attachment (e.g. from edit/fork) + add a new file + reject non-image
            tray.setManagedItems([{ path: '/user/images/_ai_attachments/existing.png', name: 'existing.png' }], { cloneOnCommit: true });
            const newFile = new File([Uint8Array.from([1, 2, 3])], 'pasted.png', { type: 'image/png' });
            const textFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });
            tray.addFiles([newFile, textFile]);

            expect(onError).toHaveBeenCalledTimes(1);
            expect(tray.getItems()).toHaveLength(2);
            expect(tray.trayEl.hidden).toBe(false);
            expect(tray.trayEl.querySelectorAll('[data-lw-role="att-chip"]')).toHaveLength(2);

            const uploaded = await tray.commit(
                async (files) => files.map(f => ({ path: `/user/images/_ai_attachments/${f.name}`, name: f.name, mime: f.type })),
                {
                    cloneManaged: async (paths) => new Map(paths.map(p => [p, p.replace('existing', 'existing_clone')])),
                },
            );

            expect(uploaded).toEqual([
                { path: '/user/images/_ai_attachments/existing_clone.png', name: 'existing.png' },
                { path: '/user/images/_ai_attachments/pasted.png', name: 'pasted.png', mime: 'image/png' },
            ]);
            expect(tray.hasItems()).toBe(false);
            expect(revokedUrls).toEqual(['blob:mock-1']);

            tray.destroy();
            composer.remove();
        } finally {
            URL.createObjectURL = origCreate;
            URL.revokeObjectURL = origRevoke;
        }
    });

    test('renderMessageAttachments renders thumbnails and opens lightbox on click', () => {
        const grid = renderMessageAttachments([
            { path: '/user/images/_ai_attachments/one.png', name: 'one.png' },
        ]);
        expect(grid).not.toBeNull();
        document.body.appendChild(grid);
        const btn = grid.querySelector('[data-lw-role="msg-att-thumb"]');
        expect(btn).not.toBeNull();
        btn.click();
        const lightbox = document.querySelector('[data-lw-role="att-lightbox"]');
        expect(lightbox).not.toBeNull();
        lightbox.querySelector('.lw-att-lightbox-close').click();
        expect(document.querySelector('[data-lw-role="att-lightbox"]')).toBeNull();
        grid.remove();
    });
});
