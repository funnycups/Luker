// iteration-library/ui umbrella — re-export contract.
//
// This is a sanity check that the ui umbrella keeps the four canonical
// namespaces (toolcall / message / diff / apply) and the styles helper
// in its public surface. It runs against the REAL module — no mocks —
// because every dep in the chain (edits/index.js → text-diff.js,
// conflict-ui.js) is plain JS and load-bearing for the actual UI.
//
// We intentionally do NOT load the broader `iteration-library/index.js`
// umbrella here: it re-exports `runner` / `storage` / `tools` /
// `proposalBus` which transitively pull browser-only modules
// (textgen-models.js touches `document` at top level). Coverage of the
// full umbrella belongs in the browser-hosted e2e suite.

describe('iteration-library/ui umbrella', () => {
    it('re-exports toolcall / message / diff / apply namespaces + ensureUiStylesheetInjected', async () => {
        const ui = await import('../../public/scripts/iteration-library/ui/index.js');
        expect(ui.toolcall).toBeDefined();
        expect(ui.message).toBeDefined();
        expect(ui.diff).toBeDefined();
        expect(ui.apply).toBeDefined();
        expect(typeof ui.ensureUiStylesheetInjected).toBe('function');
    });
});
