import { describe, test, expect } from '@jest/globals';

import {
    renderExtractionTemplate,
    resolveExtractionTemplate,
} from '../../public/scripts/extensions/memory-graph/prompt-units.js';
import {
    DEFAULT_EXTRACT_EDGE_RULES,
    DEFAULT_EXTRACT_TEMPLATE,
} from '../../public/scripts/extensions/memory-graph/default-prompts.js';
import {
    buildExtractionEdgesBlock,
    buildExtractionNodesBlock,
    EDGES_BLOCK_HEADING,
    NODES_BLOCK_HEADING,
} from '../../public/scripts/extensions/memory-graph/extraction-schedule.js';

describe('renderExtractionTemplate', () => {
    test('fills each marker with its block and leaves the rest untouched', () => {
        const out = renderExtractionTemplate('A\n{{nodes}}\nB\n{{edges}}\nC', {
            nodesBlock: 'NODES',
            edgesBlock: 'EDGES',
        });
        expect(out).toBe('A\nNODES\nB\nEDGES\nC');
    });

    test('an empty block leaves nothing behind, not an empty heading', () => {
        expect(renderExtractionTemplate('A\n{{nodes}}\nB\n{{edges}}\nC', {
            nodesBlock: '',
            edgesBlock: 'EDGES',
        })).toBe('A\n\nB\nEDGES\nC');
    });

    test('a marker the template does not carry inserts nothing', () => {
        const out = renderExtractionTemplate('A\n{{nodes}}\nC', { nodesBlock: 'NODES', edgesBlock: 'EDGES' });
        expect(out).toBe('A\nNODES\nC');
        expect(out).not.toContain('EDGES');
    });
});

describe('buildExtractionNodesBlock', () => {
    const schema = [
        { id: 'event', extractionInstructions: 'EVENT_RULES' },
        { id: 'thread', extractionInstructions: 'THREAD_RULES' },
        { id: 'quiet', extractionInstructions: '' },
    ];

    test('carries the heading and one sub-block per active type that has rules', () => {
        const out = buildExtractionNodesBlock(schema, new Set(['event', 'thread', 'quiet']));
        expect(out).toContain(NODES_BLOCK_HEADING);
        expect(out).toContain('EVENT_RULES');
        expect(out).toContain('THREAD_RULES');
        expect(out.indexOf('EVENT_RULES')).toBeLessThan(out.indexOf('THREAD_RULES'));
    });

    test('skips a type that is not active', () => {
        const out = buildExtractionNodesBlock(schema, new Set(['event']));
        expect(out).toContain('EVENT_RULES');
        expect(out).not.toContain('THREAD_RULES');
    });

    test('returns an empty string when no active type carries rules', () => {
        expect(buildExtractionNodesBlock(schema, new Set(['quiet']))).toBe('');
        expect(buildExtractionNodesBlock(schema, new Set())).toBe('');
    });
});

describe('buildExtractionEdgesBlock', () => {
    test('carries the heading and the rules', () => {
        const out = buildExtractionEdgesBlock('EDGE_RULES');
        expect(out).toContain(EDGES_BLOCK_HEADING);
        expect(out).toContain('EDGE_RULES');
    });

    test('returns an empty string when the rules are empty', () => {
        expect(buildExtractionEdgesBlock('')).toBe('');
        expect(buildExtractionEdgesBlock('   ')).toBe('');
    });
});

describe('resolveExtractionTemplate', () => {
    test('reads the template and the edge rules from their own slots', () => {
        expect(resolveExtractionTemplate({
            extractTemplate: 'TEMPLATE',
            extractEdgeRules: 'EDGES',
        })).toEqual({ template: 'TEMPLATE', edgeRules: 'EDGES' });
    });

    test('rejects missing stored prompts', () => {
        expect(() => resolveExtractionTemplate({})).toThrow();
    });

    test('ignores the retired unit slots', () => {
        const units = resolveExtractionTemplate({
            extractTemplate: DEFAULT_EXTRACT_TEMPLATE,
            extractEdgeRules: DEFAULT_EXTRACT_EDGE_RULES,
            extractMainPrompt: 'OLD_MAIN',
            extractEventSummaryRules: 'OLD_EVENT',
            extractThoughtSkeleton: 'OLD_THOUGHT',
        });
        expect(units.template).toBe(DEFAULT_EXTRACT_TEMPLATE);
        expect(units.edgeRules).toBe(DEFAULT_EXTRACT_EDGE_RULES);
    });
});
