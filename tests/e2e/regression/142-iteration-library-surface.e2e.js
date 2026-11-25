// #142 — ctx.iterationLibrary member set
//
// ctx.iterationLibrary is a documented Layer 2 / Layer 3 surface
// (docs/development/extension-api/iteration-studio.md). Boot a real server,
// load the app, and read the surface the way a third-party extension does,
// so a namespace that silently loses or gains a member fails here.

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI } from '../_lib/page.js';

let server;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'regression', scenarioId: '142-iteration-library-surface' });
    markOnboarded({ dataRoot: server.dataRoot });
});



test('ctx.iterationLibrary exposes exactly the documented members', async ({ page }) => {
    await awaitMainUI(page, server.baseURL);
    const s = await page.evaluate(() => {
        const lib = window.Luker.getContext().iterationLibrary;
        const keys = (o) => Object.keys(o || {}).sort();
        return {
            frozen: Object.isFrozen(lib),
            sameAsLayer2: window.lukerContext.iterationLibrary === lib,
            top: keys(lib),
            render: keys(lib.render),
            runner: keys(lib.runner),
            abortUtils: keys(lib.runner.abortUtils),
            textDiff: keys(lib.textDiff),
            zoomOverlay: keys(lib.zoomOverlay),
            ui: keys(lib.ui),
            uiMessage: keys(lib.ui.message),
            uiDiff: keys(lib.ui.diff),
            tools: keys(lib.tools),
            lorebookReads: keys(lib.tools.lorebookReads),
            lorebookWrites: keys(lib.tools.lorebookWrites),
            characterPresetsReads: keys(lib.tools.characterPresetsReads),
            skillIterStudio: keys(lib.tools.skillIterStudio),
            ctxAndDocsDiscovery: keys(lib.tools.ctxAndDocsDiscovery),
            proposalBus: keys(lib.proposalBus),
        };
    });
    const sorted = (a) => [...a].sort();
    expect(s.frozen).toBe(true);
    expect(s.sameAsLayer2).toBe(true);
    expect(s.top).toEqual(sorted(['applyEdits', 'inverseEdit', 'registerOp', 'BUILT_IN_OPS', 'showConflictResolution', 'render', 'runner', 'textDiff', 'zoomOverlay', 'ui', 'tools', 'proposalBus', 'bindIterWorkspaceResizer']));
    expect(s.render).toEqual(sorted(['_resetMarkdownCacheForTests', 'ensureMarkdownDeps', 'renderMessageMarkdown']));
    expect(s.runner).toEqual(sorted(['abortUtils', 'buildExecutionToolCalls', 'buildPendingToolResults', 'buildPersistentToolCallsFromRawCalls', 'buildPersistentToolHistoryMessages', 'collectIterToolCallIds', 'createPersistentToolTurnMessage', 'makeAiIterationMessageId', 'requestToolCallsWithRetry']));
    expect(s.abortUtils).toEqual(sorted(['createAbortError', 'isAbortError', 'isAbortSignalLike', 'isStrictAbortError', 'linkAbortSignals', 'raceAbortSignal', 'throwIfAborted']));
    expect(s.textDiff).toEqual(sorted(['STYLESHEET_HREF', 'STYLESHEET_ID', '_testOnly_refreshNarrowViewport', 'ensureStylesheetInjected', 'formatDiffValue', 'renderInlineTextDiffElement', 'renderInlineTextDiffHtml', 'sanitizeDiffPlaceholderValue']));
    expect(s.zoomOverlay).toEqual(['attachZoomOverlay', 'openExpandedDiff']);
    expect(s.ui).toEqual(['diff', 'ensureUiStylesheetInjected', 'message']);
    expect(s.uiMessage).toEqual(['bindChainBrokenBanner', 'renderMessageCard']);
    expect(s.uiDiff).toEqual(['renderDiffCard']);
    expect(s.tools).toEqual(sorted(['characterPresetsReads', 'ctxAndDocsDiscovery', 'lorebookReads', 'lorebookWrites', 'skillIterStudio']));
    expect(s.lorebookReads).toEqual(sorted(['LOREBOOK_READ_TOOL_DEFS', 'LOREBOOK_READ_TOOL_NAMES', 'isLorebookReadTool', 'runLorebookReadTool']));
    expect(s.lorebookWrites).toEqual(sorted(['LOREBOOK_WRITE_TOOL_DEFS', 'LOREBOOK_WRITE_TOOL_NAMES', 'isLorebookWriteTool', 'runLorebookWriteTool']));
    expect(s.characterPresetsReads).toEqual(sorted(['CHARACTER_PRESET_READ_TOOL_DEFS', 'CHARACTER_PRESET_READ_TOOL_NAMES', 'isCharacterPresetReadTool', 'runCharacterPresetReadTool']));
    expect(s.skillIterStudio).toEqual(sorted(['SKILL_ITER_STUDIO_TOOL_DEFS', 'SKILL_ITER_STUDIO_TOOL_NAMES', 'SkillProposalError', 'applyFrontmatterPatch', 'buildSkillVisibilityChange', 'commitApprovedSkillProposal', 'ensureSkillRegistryTarget', 'isSkillIterStudioTool', 'runSkillIterStudioTool']));
    expect(s.ctxAndDocsDiscovery).toEqual(sorted(['describeCtxPath', 'listCtxKeys', 'listLukerDocs', 'readLukerDoc']));
    expect(s.proposalBus).toEqual(sorted(['createCustomToolAuthorHandler', 'createLorebookWriteHandler', 'createPresetCloneHandler', 'createProfileEditHandler', 'createProposalBus', 'createSkillAuthorHandler', 'customToolAuthor', 'lorebookWrite', 'presetClone', 'profileEdit', 'skillAuthor']));
});
