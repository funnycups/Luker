/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Preview-renderer & diff-unit tests for the Memory Graph configuration target.
 */

import { describe, test, expect } from '@jest/globals';
import { getDefaultSettingsView } from '../../public/scripts/extensions/memory-graph/config-iteration/fields.js';
import { diffUnits } from '../../public/scripts/workbench/model/units.js';
import { createMemoryConfigTarget, memoryConfigUnits } from '../../public/scripts/extensions/memory-graph/lens/iterate-targets.js';

const defaults = getDefaultSettingsView();

describe('memoryConfigUnits + diffUnits — { schema, settings } diff', () => {
    test('settings-only change produces a unit diff with registry label', () => {
        const changes = diffUnits(
            memoryConfigUnits({ schema: [{ id: 'event' }], settings: { ...defaults, recallMaxIterations: 3 } }),
            memoryConfigUnits({ schema: [{ id: 'event' }], settings: { ...defaults, recallMaxIterations: 5 } }),
        );
        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({
            key: 'settings:recallMaxIterations',
            kind: 'change',
            label: 'Recall max iterations',
            before: '3',
            after: '5',
        });
    });

    test('schema-only change produces a schema unit diff', () => {
        const changes = diffUnits(
            memoryConfigUnits({ schema: [{ id: 'event', label: 'Event' }], settings: defaults }),
            memoryConfigUnits({ schema: [{ id: 'event', label: 'Event 2' }], settings: defaults }),
        );
        expect(changes).toHaveLength(1);
        expect(changes[0].key).toBe('schema:event');
        expect(changes[0].after).toContain('Event 2');
    });

    test('added node type surfaces in unit diff', () => {
        const changes = diffUnits(
            memoryConfigUnits({ schema: [], settings: defaults }),
            memoryConfigUnits({ schema: [{ id: 'event', label: 'Event' }], settings: defaults }),
        );
        expect(changes.map(c => c.key)).toEqual(['schema:event', 'schema:__order']);
    });

    test('no effective change yields empty diff', () => {
        const changes = diffUnits(
            memoryConfigUnits({ schema: [], settings: defaults }),
            memoryConfigUnits({ schema: [], settings: defaults }),
        );
        expect(changes).toEqual([]);
    });
});

describe('memoryTarget.renderPreview — { schema, settings } preview pane', () => {
    const target = createMemoryConfigTarget(() => ({ translate: s => String(s ?? ''), getCurrentLocale: () => 'en' }));

    test('renders schema rows and changed settings key for a settings-only edit', () => {
        const before = {
            schema: [{ id: 'event', label: 'Event', tableColumns: ['summary'] }],
            settings: { ...defaults, recallMaxIterations: 3 },
        };
        const after = {
            schema: [{ id: 'event', label: 'Event', tableColumns: ['summary'] }],
            settings: { ...defaults, recallMaxIterations: 5 },
        };
        const pane = target.renderPreview({ base: before, ai: after });
        expect(pane).toBeInstanceOf(Node);
        expect(pane.textContent).toContain('Event');
        expect(pane.textContent).toContain('Recall max iterations');
        expect(pane.textContent).toContain('5');
    });

    test('an empty working schema renders the empty note instead of crashing', () => {
        const pane = target.renderPreview({
            base: { schema: [], settings: defaults },
            ai: { schema: [], settings: defaults },
        });
        expect(pane).toBeInstanceOf(Node);
        expect(pane.textContent).toContain('No schema loaded.');
    });

    test('schema edits flag the changed node type row', () => {
        const before = {
            schema: [{ id: 'event', label: 'Event' }, { id: 'character', label: 'Character' }],
            settings: defaults,
        };
        const after = {
            schema: [{ id: 'event', label: 'Event Renamed' }, { id: 'character', label: 'Character' }],
            settings: defaults,
        };
        const pane = target.renderPreview({ base: before, ai: after });
        expect(pane.textContent).toContain('Event Renamed');
        expect(pane.textContent).toContain('Character');
        expect(pane.querySelector('.is-change')).not.toBeNull();
    });
});
