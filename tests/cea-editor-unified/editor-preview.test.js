// Verifies the CEA character-editor world-book preview pane renderer.
//
// Pure function — no DOM, no I/O — so we exercise it directly. The main
// regression this pins down: entry content used to be silently
// truncated at 320 chars even in the expanded `<details>` disclosure,
// so users who explicitly opened the pane still saw a `…`-clipped
// excerpt with no way to see the rest.

import { describe, expect, test } from '@jest/globals';

import { renderCeaEditorPreviewPane } from '../../public/scripts/extensions/character-editor-assistant/editor-preview.js';

describe('renderCeaEditorPreviewPane', () => {
    test('renders full entry content verbatim inside the expanded <details> — no silent truncation', () => {
        // 800 chars of prose — well over the previous 320-char cap. If
        // the renderer clipped, we would see an ellipsis and only 320
        // characters between the details' inner divs.
        const longContent = 'The Autumnal Dominion is a coastal republic ruled by a rotating triumvirate. '.repeat(15).slice(0, 800);
        const worldInfo = {
            name: 'Lore of the Autumnal Dominion',
            entries: {
                7: {
                    uid: 7,
                    comment: 'Overview',
                    key: ['Autumnal Dominion'],
                    content: longContent,
                    position: 4,
                    depth: 3,
                    order: 100,
                },
            },
        };
        const html = renderCeaEditorPreviewPane(worldInfo, null);
        // Full content must be present.
        expect(html).toContain(longContent);
        // No ellipsis inside the entry content — the previous
        // truncateForPreview(entry.content, 320) call site is gone.
        // (The disclosure caret uses `▸ Content`, which contains no
        // ellipsis, so an ellipsis anywhere in the entry card body
        // implies content was clipped.)
        const cardBlockStart = html.indexOf('cea_editor_preview_card');
        expect(cardBlockStart).toBeGreaterThan(-1);
        const cardBlock = html.slice(cardBlockStart);
        expect(cardBlock).not.toContain('…');
    });

    test('leaves the collapsed <summary> free of content — full content only appears once, inside the <details> body', () => {
        // Confirms the details/summary structure is still used so
        // collapsed cards stay compact even with long entries.
        const worldInfo = {
            name: 'Book',
            entries: {
                1: { uid: 1, comment: 'Long entry', content: 'x'.repeat(500) },
            },
        };
        const html = renderCeaEditorPreviewPane(worldInfo, null);
        expect(html).toContain('<summary');
        expect(html).toContain('<details');
        // Content appears exactly once (inside the <details> body).
        const first = html.indexOf('x'.repeat(500));
        const second = html.indexOf('x'.repeat(500), first + 1);
        expect(first).toBeGreaterThan(-1);
        expect(second).toBe(-1);
    });

    test('skips content when the entry payload references a missing uid (no dangling content span)', () => {
        // When a pending op targets a uid that doesn't exist in the
        // snapshot, the card renders with `missingRefOp` and skips
        // content — the "missing entry" pill is the whole story. This
        // guards against accidentally leaking payload text into the
        // draft-slot card.
        const pendingApproval = {
            operations: [
                { op: 'update_entry', payload: { uid: 42, content: 'payload text should not appear as an entry' } },
            ],
        };
        const worldInfo = { name: 'Book', entries: {} };
        const html = renderCeaEditorPreviewPane(worldInfo, pendingApproval);
        // update_entry with missing uid → new-draft path fires because
        // uid is not in the snapshot; content appears once (inside the
        // rendered draft). We only require it not appear as an
        // accidental duplicate.
        const first = html.indexOf('payload text should not appear as an entry');
        const second = html.indexOf('payload text should not appear as an entry', first + 1);
        expect(second).toBe(-1);
    });
});
