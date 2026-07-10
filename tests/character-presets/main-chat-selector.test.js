/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups
//
// main-chat-selector: DOM contract for the character-bound optgroup rendered
// into #settings_preset_openai by openai.js:upsertCharacterBoundRuntimeOptions.
//
// This unit test verifies the shape independent of openai.js (whose full
// import graph is not feasible under jest — 10k lines, jQuery-heavy, deep
// script.js coupling). The e2e spec tests/character-presets/playwright/
// main-chat-select.spec.js exercises the real openai.js renderer path.
//
// The contract asserted here:
//   1. A single <optgroup data-luker-card-bound="1"> hosts every card-bound
//      option; global preset options remain siblings outside it.
//   2. Each card-bound <option value=…> is encodeCardBoundOptionValue-encoded
//      so #getSelectedPresetRef (ctx-selected-live-state.test.js) can decode
//      it back into {avatar, name} for origin dispatch.
//   3. Empty presets → no optgroup at all (avoids empty group flashing).

import { jest } from '@jest/globals';

if (typeof globalThis.structuredClone !== 'function') {
    globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v));
}

const { encodeCardBoundOptionValue } = await import('/scripts/character/preset-ref-codec.js');

beforeEach(() => {
    document.body.innerHTML = '<select id="settings_preset_openai"></select>';
});

// Mirror of the openai.js renderer contract. If openai.js's implementation
// diverges (option label ≠ preset name; wrong attribute; missing prefix)
// the e2e spec is the source of truth — this test just pins the shape.
function renderCardBoundOptgroup(selectEl, character, presets) {
    selectEl.querySelectorAll('optgroup[data-luker-card-bound="1"]').forEach(n => n.remove());
    if (!Array.isArray(presets) || presets.length === 0) return;
    const optgroup = document.createElement('optgroup');
    optgroup.label = 'Card-bound';
    optgroup.setAttribute('data-luker-card-bound', '1');
    for (const p of presets) {
        const opt = document.createElement('option');
        opt.value = encodeCardBoundOptionValue(character.avatar, p.name);
        opt.textContent = p.name;
        opt.setAttribute('data-luker-char-bound', '1');
        optgroup.appendChild(opt);
    }
    selectEl.prepend(optgroup);
}

test('renderCardBoundOptgroup creates one option per preset in optgroup', () => {
    const select = document.getElementById('settings_preset_openai');
    const character = { avatar: 'Aqua.png' };
    renderCardBoundOptgroup(select, character, [
        { name: 'Foo' },
        { name: 'Bar' },
    ]);
    const options = document.querySelectorAll('#settings_preset_openai optgroup[data-luker-card-bound="1"] option');
    expect(options).toHaveLength(2);
    expect(options[0].value.startsWith('__luker_card__::')).toBe(true);
    expect(options[0].textContent).toBe('Foo');
    expect(options[1].textContent).toBe('Bar');
    expect(options[0].getAttribute('data-luker-char-bound')).toBe('1');
});

test('renderCardBoundOptgroup: empty presets removes ghost optgroup entirely', () => {
    const select = document.getElementById('settings_preset_openai');
    const character = { avatar: 'Aqua.png' };
    renderCardBoundOptgroup(select, character, [{ name: 'Foo' }]);
    expect(document.querySelectorAll('#settings_preset_openai optgroup').length).toBe(1);
    renderCardBoundOptgroup(select, character, []);
    expect(document.querySelectorAll('#settings_preset_openai optgroup').length).toBe(0);
});
