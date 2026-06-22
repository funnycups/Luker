// Regression: orchestrator's `assistantMsg.edits` write at studio.js
// was the last adapter still persisting legacy v2-shape edits
// (`[{op:'set', path:'', oldValue, newValue}]`). The diff body is
// rendered by the bus card from `entry.meta.before/after`, so the
// v2 payload was dead weight; the ONLY consumer of `m.edits` is the
// `renderPendingEditCard` hook that surfaces a skill-visibility
// context strip when an edit carries `skillVisibilityChange`.
//
// After this fix, `m.edits` is a slim sidecar holding only the
// skill-visibility blob (and only for skill policy-binding turns).
// Pure profile edits don't write `m.edits` at all.
import { describe, test, expect } from '@jest/globals';
import { normalizeMessageShape } from '../../public/scripts/extensions/orchestrator/iter-studio/session-store.js';

describe('Orchestrator — assistantMsg.edits is v3-clean (no legacy v2 oldValue/newValue)', () => {
    test('normalizeMessageShape passes the slim skillVisibilityChange sidecar through unchanged', () => {
        const change = {
            kind: 'agent',
            agentId: 'a1',
            list: 'visible',
            before: { mode: ['*'], agent: ['+', 'foo'] },
            after: { mode: ['*'], agent: ['+', 'foo', 'bar'] },
        };
        const msg = {
            id: 'm1',
            role: 'assistant',
            content: 'bind skill',
            edits: [{ skillVisibilityChange: change }],
        };
        const out = normalizeMessageShape(msg);
        expect(Array.isArray(out.edits)).toBe(true);
        expect(out.edits).toHaveLength(1);
        // The slim shape: NO v2 `op`, `path`, `oldValue`, `newValue`.
        const e = out.edits[0];
        expect(e).toHaveProperty('skillVisibilityChange', change);
        expect(e).not.toHaveProperty('op');
        expect(e).not.toHaveProperty('oldValue');
        expect(e).not.toHaveProperty('newValue');
    });

    test('omits the edits field entirely on a message that only carries content + toolCalls', () => {
        const msg = {
            id: 'm2',
            role: 'assistant',
            content: 'pure prose with no edit',
            toolCalls: [{ id: 'c1', name: 'read', args: {} }],
        };
        const out = normalizeMessageShape(msg);
        expect(out).not.toHaveProperty('edits');
    });

    test('an empty edits array is also stripped (matches the original normalizer guard)', () => {
        const msg = { id: 'm3', role: 'assistant', content: '', edits: [] };
        const out = normalizeMessageShape(msg);
        expect(out).not.toHaveProperty('edits');
    });
});
