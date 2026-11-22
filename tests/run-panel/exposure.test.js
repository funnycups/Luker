// tests/run-panel/exposure.test.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as runPanel from '../../public/scripts/run-panel/index.js';

test('index.js exposes the public surface', () => {
    expect(typeof runPanel.createRunStore).toBe('function');
    expect(typeof runPanel.createRunPanel).toBe('function');
    expect(typeof runPanel.withRound).toBe('function');
    expect(typeof runPanel.withStreamingSection).toBe('function');
    expect(runPanel.events.RUN_STARTED).toBe('run_started');
    expect(typeof runPanel.attachDock).toBe('function');
    expect(typeof runPanel.openRunDock).toBe('function');
    expect(typeof runPanel.toggleRunDock).toBe('function');
    expect(typeof runPanel.getRunRecorder).toBe('function');
    expect(typeof runPanel.getRunDockPrefs).toBe('function');
    expect(typeof runPanel.setRunDockPrefs).toBe('function');
    expect(typeof runPanel.resetRunDockPosition).toBe('function');
    expect(typeof runPanel.subscribeRunDockPrefs).toBe('function');
});

test('st-context.js imports and exposes the run-panel namespace', () => {
    const src = readFileSync(
        fileURLToPath(new URL('../../public/scripts/st-context.js', import.meta.url)),
        'utf8',
    );
    expect(src).toContain('import * as RUN_PANEL_API_NS from \'./run-panel/index.js\';');
    expect(src).toContain('runPanel: RUN_PANEL_API,');
    expect(src).toContain('attachDock: RUN_PANEL_API_NS.attachDock,');
    expect(src).toContain('openRunDock: RUN_PANEL_API_NS.openRunDock,');
    expect(src).toContain('toggleRunDock: RUN_PANEL_API_NS.toggleRunDock,');
    expect(src).toContain('getRunRecorder: RUN_PANEL_API_NS.getRunRecorder,');
    expect(src).toContain('getRunDockPrefs: RUN_PANEL_API_NS.getRunDockPrefs,');
    expect(src).toContain('setRunDockPrefs: RUN_PANEL_API_NS.setRunDockPrefs,');
    expect(src).toContain('resetRunDockPosition: RUN_PANEL_API_NS.resetRunDockPosition,');
    expect(src).toContain('subscribeRunDockPrefs: RUN_PANEL_API_NS.subscribeRunDockPrefs,');
});
