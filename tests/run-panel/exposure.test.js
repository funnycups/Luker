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
});

test('st-context.js imports and exposes the run-panel namespace', () => {
    const src = readFileSync(
        fileURLToPath(new URL('../../public/scripts/st-context.js', import.meta.url)),
        'utf8',
    );
    expect(src).toContain("import * as RUN_PANEL_API_NS from './run-panel/index.js';");
    expect(src).toContain('runPanel: RUN_PANEL_API,');
});
