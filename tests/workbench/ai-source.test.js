// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from '@jest/globals';
import { resolveAiField, resolveAiRow } from '../../public/scripts/workbench/model/ai-source.js';

describe('workbench AI source resolution', () => {
    test('a per-target value wins over plugin, shared and fallback', () => {
        expect(resolveAiField({
            own: 'OwnPreset',
            native: 'PluginPreset',
            shared: 'SharedPreset',
            fallback: { scope: 'current' },
        })).toEqual({ scope: 'target', value: 'OwnPreset' });
    });

    test('falls back to the plugin setting when the target is empty', () => {
        expect(resolveAiField({
            native: 'PluginPreset',
            shared: 'SharedPreset',
            fallback: { scope: 'current' },
        })).toEqual({ scope: 'plugin', value: 'PluginPreset' });
    });

    test('falls back to the shared setting when target and plugin are empty', () => {
        expect(resolveAiField({
            shared: 'SharedPreset',
            fallback: { scope: 'current' },
        })).toEqual({ scope: 'shared', value: 'SharedPreset' });
    });

    test('returns the implicit fallback when nothing is selected', () => {
        expect(resolveAiField({
            fallback: { scope: 'shared', value: 'plugin-only', implicit: true },
        })).toEqual({ scope: 'shared', value: 'plugin-only', implicit: true });
        expect(resolveAiField({ fallback: { scope: 'current' } }))
            .toEqual({ scope: 'current', value: '' });
    });

    test('returns null when there is no value and no fallback', () => {
        expect(resolveAiField({})).toBeNull();
    });

    test('resolves connection and preset independently', () => {
        expect(resolveAiRow({
            own: { connection: 'OwnConn' },
            native: { preset: 'PluginPreset' },
            shared: { connection: 'SharedConn', preset: 'SharedPreset' },
        })).toEqual({
            connection: { scope: 'target', value: 'OwnConn' },
            preset: { scope: 'plugin', value: 'PluginPreset' },
        });
    });
});
