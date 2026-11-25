// iteration-library/ui umbrella — re-export contract.
//
// This is a sanity check that the ui umbrella keeps the four canonical
// namespaces (message / diff) and the styles helper
// in its public surface. It runs against the REAL module — no mocks —
// because every dep in the chain (edits/index.js → text-diff.js,
// conflict-ui.js) is plain JS and load-bearing for the actual UI.
//
// We intentionally do NOT load the broader `iteration-library/index.js`
// umbrella here: it re-exports `runner` / `tools` /
// `proposalBus` which transitively pull browser-only modules
// (textgen-models.js touches `document` at top level). Coverage of the
// full umbrella belongs in the browser-hosted e2e suite.

describe('iteration-library/ui umbrella', () => {
    it('re-exports message / diff namespaces + ensureUiStylesheetInjected', async () => {
        const ui = await import('../../public/scripts/iteration-library/ui/index.js');
        expect(Object.keys(ui).sort()).toEqual(['diff', 'ensureUiStylesheetInjected', 'message']);
        expect(typeof ui.message.renderMessageCard).toBe('function');
        expect(typeof ui.diff.renderDiffCard).toBe('function');
        expect(typeof ui.ensureUiStylesheetInjected).toBe('function');
    });
});
