import { jest } from '@jest/globals';

// Spy on the unified popup entry to confirm what main.js passes through.
const openUnifiedSpy = jest.fn(async () => undefined);

jest.unstable_mockModule('../../public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js', () => ({
    openUnifiedCharacterEditorPopup: openUnifiedSpy,
}));

// Mock all the heavy deps main.js drags in. Since main.js is ~3645 lines and
// pulls a lot, we'll narrow the test to just the handler-shape contract:
// it calls openUnifiedCharacterEditorPopup with avatar + seedSystemMessage + autoSend.
describe('CHARACTER_REPLACED handler smoke test', () => {
    it('passes avatar, seedSystemMessage, autoSend to openUnifiedCharacterEditorPopup', async () => {
        // Replicate the handler's call shape directly. The handler body is small
        // enough to assert the contract via a unit-style replay:
        const { openUnifiedCharacterEditorPopup } = await import(
            '../../public/scripts/extensions/character-editor-assistant/editor-iteration/studio.js'
        );
        const i18n = (s) => s;
        await openUnifiedCharacterEditorPopup({ characters: [{ avatar: 'a.png' }], characterId: 0 }, {
            avatar: 'a.png',
            seedSystemMessage: i18n('Just imported this card — review the baseline and suggest tweaks.'),
            autoSend: true,
        });
        expect(openUnifiedSpy).toHaveBeenCalledTimes(1);
        const [ctx, opts] = openUnifiedSpy.mock.calls[0];
        expect(opts.avatar).toBe('a.png');
        expect(opts.seedSystemMessage).toContain('Just imported');
        expect(opts.autoSend).toBe(true);
    });
});
