// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Unit coverage for `resolveCardFirstPresetName` (the pure helper shared
 * by director-runtime / director-tools / agent-resolution). The helper
 * imports nothing beyond its own module, so this suite avoids the
 * `Luker` / `lib.js` shims other orchestrator suites need.
 *
 * Stub shape note (feedback_test_stubs_match_prod_shape): the production
 * `resolveByName` (from `public/scripts/character/presets.js`,
 * `resolveCharacterBoundPresetByName`) is SYNCHRONOUS, so the injected
 * mocks are `jest.fn(() => ...)` — NOT `jest.fn(async () => ...)`.
 */

import { jest } from '@jest/globals';
import { resolveCardFirstPresetName } from '../../public/scripts/extensions/orchestrator/agent-preset-resolver.js';

function makeCharacter(avatar = 'alice.png') {
    return { avatar };
}

describe('resolveCardFirstPresetName', () => {
    test('explicit found on card → origin:"card" with preset body', () => {
        const cardPreset = { name: 'CardOnly', temperature: 0.42 };
        const resolveByName = jest.fn((_ch, name) => {
            if (name === 'CardOnly') {
                return { name: 'CardOnly', preset: cardPreset, origin: 'card' };
            }
            return null;
        });
        const result = resolveCardFirstPresetName({
            explicitName: 'CardOnly',
            fallbackName: 'GlobalFallback',
            character: makeCharacter(),
            resolveByName,
        });
        expect(result).toEqual({ name: 'CardOnly', preset: cardPreset, origin: 'card' });
        // Fallback must not be consulted when the explicit hit lands.
        expect(resolveByName).toHaveBeenCalledTimes(1);
        expect(resolveByName).toHaveBeenCalledWith(expect.any(Object), 'CardOnly');
    });

    test('explicit found in local global → origin:"global"', () => {
        const globalBody = { name: 'GlobalHit', temperature: 0.7 };
        const resolveByName = jest.fn((_ch, name) => {
            if (name === 'GlobalHit') {
                return { name: 'GlobalHit', preset: globalBody, origin: 'global' };
            }
            return null;
        });
        const result = resolveCardFirstPresetName({
            explicitName: 'GlobalHit',
            fallbackName: '',
            character: makeCharacter(),
            resolveByName,
        });
        expect(result).toEqual({ name: 'GlobalHit', preset: globalBody, origin: 'global' });
    });

    test('explicit missing everywhere → origin:null, name preserved, preset:null', () => {
        // Regression guard for the mislabeled unknown branch that
        // previously returned origin:"global" for names absent from both
        // card and local global sets. Downstream classifiers
        // (collectUnembeddedPresets) rely on `origin: null` meaning
        // "unknown", not "global".
        const resolveByName = jest.fn(() => null);
        const result = resolveCardFirstPresetName({
            explicitName: 'Ghost',
            fallbackName: 'AlsoGhost',
            character: makeCharacter(),
            resolveByName,
        });
        expect(result).toEqual({ name: 'Ghost', preset: null, origin: null });
        // Fallback must not be consulted when explicit is given, even if
        // the explicit lookup misses — the card-first binding rule says
        // an explicit request wins even when it resolves to "unknown".
        expect(resolveByName).toHaveBeenCalledTimes(1);
        expect(resolveByName).toHaveBeenCalledWith(expect.any(Object), 'Ghost');
    });

    test('no explicit but fallback found → uses fallback, correct origin', () => {
        const cardPreset = { name: 'CardFallback' };
        const resolveByName = jest.fn((_ch, name) => {
            if (name === 'CardFallback') {
                return { name: 'CardFallback', preset: cardPreset, origin: 'card' };
            }
            return null;
        });
        const result = resolveCardFirstPresetName({
            explicitName: '',
            fallbackName: 'CardFallback',
            character: makeCharacter(),
            resolveByName,
        });
        expect(result).toEqual({ name: 'CardFallback', preset: cardPreset, origin: 'card' });
    });

    test('no explicit and no fallback → returns null', () => {
        const resolveByName = jest.fn(() => null);
        const result = resolveCardFirstPresetName({
            explicitName: '',
            fallbackName: '',
            character: makeCharacter(),
            resolveByName,
        });
        expect(result).toBeNull();
        expect(resolveByName).not.toHaveBeenCalled();
    });

    test('whitespace-only names are treated as absent', () => {
        const resolveByName = jest.fn(() => null);
        const result = resolveCardFirstPresetName({
            explicitName: '   ',
            fallbackName: '\t\n',
            character: makeCharacter(),
            resolveByName,
        });
        expect(result).toBeNull();
        expect(resolveByName).not.toHaveBeenCalled();
    });

    test('missing resolveByName → returns raw name with origin:null (defensive)', () => {
        // Bootstrap edge: the ctx layer has not wired the resolver yet.
        // The helper must NOT crash; it should surface the raw name so
        // downstream logging can still report what the user asked for.
        const result = resolveCardFirstPresetName({
            explicitName: 'Something',
            fallbackName: '',
            character: makeCharacter(),
            resolveByName: null,
        });
        expect(result).toEqual({ name: 'Something', preset: null, origin: null });
    });

    test('missing character → returns raw name with origin:null (defensive)', () => {
        // No active character — cannot check card, and (per production
        // `resolveCharacterBoundPresetByName`) resolveByName would also
        // need a character to do its global lookup. The helper short-
        // circuits and marks the name unresolved.
        const resolveByName = jest.fn();
        const result = resolveCardFirstPresetName({
            explicitName: 'Something',
            fallbackName: '',
            character: null,
            resolveByName,
        });
        expect(result).toEqual({ name: 'Something', preset: null, origin: null });
        expect(resolveByName).not.toHaveBeenCalled();
    });

    test('resolveByName returning null preset field is normalized to null (not undefined)', () => {
        // Contract: `preset` is always object|null, never undefined.
        // Some resolver adapters may return `{origin, name}` without a
        // preset field — normalize to `null` so consumers can rely on
        // `preset ?? null` semantics without extra defensive coalescing.
        const resolveByName = jest.fn((_ch, name) => ({ name, origin: 'card' }));
        const result = resolveCardFirstPresetName({
            explicitName: 'Bare',
            fallbackName: '',
            character: makeCharacter(),
            resolveByName,
        });
        expect(result).toEqual({ name: 'Bare', preset: null, origin: 'card' });
    });

    test('director-runtime integration shape: card preset wins over same-named global', () => {
        // Simulates the exact scenario the C1 fix guards against: a user
        // embeds a preset named "RuntimeX" on the active card and also
        // has a local-global preset with the same name. The director's
        // `resolveAgentApiPresetName` calls this helper with the agent
        // config's explicit name; the card body must win.
        const cardBody = { name: 'RuntimeX', temperature: 0.1, __source: 'card' };
        const globalBody = { name: 'RuntimeX', temperature: 0.9, __source: 'global' };
        // Production `resolveCharacterBoundPresetByName` does card-first-
        // then-global; mock that ordering here to keep the contract
        // 1:1 with prod (stubs match production shape).
        const resolveByName = jest.fn((_ch, name) => {
            if (name !== 'RuntimeX') return null;
            // Card branch would hit first in prod; return that.
            return { name: 'RuntimeX', preset: cardBody, origin: 'card' };
        });
        const agentConfig = { apiPresetName: 'RuntimeX' };
        const settings = { llmNodeApiPresetName: 'GlobalDefault' };
        const character = makeCharacter();

        // Director's local wrapper distilled inline:
        const resolved = resolveCardFirstPresetName({
            explicitName: agentConfig.apiPresetName,
            fallbackName: settings.llmNodeApiPresetName,
            character,
            resolveByName,
        });

        expect(resolved).toEqual({ name: 'RuntimeX', preset: cardBody, origin: 'card' });
        expect(resolved.preset.__source).toBe('card');
    });
});
