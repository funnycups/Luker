import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Every place that normalizes, clamps or renders the tool-call retry count.
const SITES = [
    'public/scripts/lib/iter-tool-calling.js',
    'public/scripts/extensions/search-tools/main.js',
    'public/scripts/extensions/search-tools/settings-ui.js',
    'public/scripts/extensions/memory-graph/main.js',
    'public/scripts/extensions/memory-graph/config-iteration/fields.js',
    'public/scripts/extensions/memory-graph/config-iteration/advanced-settings.js',
    'public/scripts/extensions/memory-graph/lens/settings/settings-model.js',
    'public/scripts/extensions/memory-graph/lens/settings/settings-view.js',
    'public/scripts/extensions/character-editor-assistant/settings.js',
    'public/scripts/extensions/character-editor-assistant/editor-ui.js',
    'public/scripts/extensions/completion-preset-assistant/main.js',
    'public/scripts/extensions/orchestrator/main.js',
    'public/scripts/extensions/orchestrator/ui-templates.js',
    'public/scripts/extensions/orchestrator/lens/source-write.js',
    'public/scripts/extensions/orchestrator/lens/views/settings-view.js',
    'public/scripts/extensions/orchestrator/director-runtime.js',
    'public/scripts/extensions/orchestrator/director-tools.js',
];

const RETRY_VALUE = /toolCallRetryMax|toolRetryRaw|retriesSource/;
const RETRY_INPUT_ID = /(luker_orch_tool_retries|cea_tool_retries|luker_rpg_memory_advanced_tool_retries|cpa_tool_retries|search_tools_tool_call_retry_max)/;

function offenders(source) {
    return source.split('\n')
        .map((line, i) => ({ line, no: i + 1 }))
        .filter(({ line }) => (RETRY_VALUE.test(line) && /Math\.min\(/.test(line))
            || /\bTOOL_CALL_RETRY_MAX\b/.test(line)
            || /toolCallRetryMax\s*=\s*clampInteger\(/.test(line)
            || (/toolCallRetryMax/.test(line) && /\bmax\s*:/.test(line))
            || (RETRY_INPUT_ID.test(line) && /<input\b/.test(line) && /\smax=/.test(line)))
        .map(({ line, no }) => `${no}: ${line.trim()}`);
}

describe('toolCallRetryMax has no upper bound (D3)', () => {
    test.each(SITES)('%s', (rel) => {
        expect(offenders(readFileSync(path.join(REPO_ROOT, rel), 'utf8'))).toEqual([]);
    });
});
