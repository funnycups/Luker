import { jest } from '@jest/globals';

// `iteration-library/index.js` re-exports edits/index.js and conflict-ui.js,
// which transitively pull lib.js (lodash bundle) and popup.js (DOM-bound).
// Mock both at the direct-import boundary so the umbrella resolves under Jest.
jest.unstable_mockModule('../../public/scripts/lib/edits/index.js', () => ({
    applyEdits: jest.fn(),
    inverseEdit: jest.fn(),
    registerOp: jest.fn(),
    BUILT_IN_OPS: {},
}));
jest.unstable_mockModule('../../public/scripts/lib/edits/conflict-ui.js', () => ({
    showConflictResolution: jest.fn(),
}));

describe('iteration-library/ui umbrella', () => {
    it('re-exports the four ui modules as namespaces', async () => {
        const ui = await import('../../public/scripts/iteration-library/ui/index.js');
        expect(ui.toolcall).toBeDefined();
        expect(ui.message).toBeDefined();
        expect(ui.diff).toBeDefined();
        expect(ui.apply).toBeDefined();
    });

    it('iteration-library index re-exports ui', async () => {
        const lib = await import('../../public/scripts/iteration-library/index.js');
        expect(lib.ui).toBeDefined();
        expect(typeof lib.ui).toBe('object');
    });
});
