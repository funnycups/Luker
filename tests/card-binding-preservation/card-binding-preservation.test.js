// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { jest } from '@jest/globals';

const mockReadBound = jest.fn();
const mockWriteBound = jest.fn(async () => {});
const mockReadPersonas = jest.fn();
const mockWritePersonas = jest.fn(async () => {});
const mockMaybeApply = jest.fn(async () => {});

let lastPopup = null;
const mockPopupShow = jest.fn(async () => 1);

jest.unstable_mockModule('/scripts/character/presets.js', () => ({
    readCharacterBoundStateRaw: mockReadBound,
    writeCharacterBoundStateById: mockWriteBound,
}));
jest.unstable_mockModule('/scripts/personas.js', () => ({
    getDedicatedPersonaEntriesFromCharacter: mockReadPersonas,
    setCharacterDedicatedPersonaEntries: mockWritePersonas,
}));
jest.unstable_mockModule('/scripts/openai.js', () => ({
    maybeApplyCharacterBoundPreset: mockMaybeApply,
}));
jest.unstable_mockModule('/scripts/st-context.js', () => ({
    getContext: () => mockContext,
}));
jest.unstable_mockModule('/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce(
        (acc, part, index) => acc + part + (values[index] !== undefined ? String(values[index]) : ''),
        '',
    ),
}));
jest.unstable_mockModule('/scripts/popup.js', () => ({
    POPUP_RESULT: { AFFIRMATIVE: 1, CANCELLED: null },
    POPUP_TYPE: { CONFIRM: 2 },
    Popup: class {
        constructor(content, type, value, options) {
            lastPopup = this;
            this.content = content;
            this.options = options || {};
            this.inputResults = new Map(
                (this.options.customInputs || []).map(input => [input.id, input.defaultState === true]),
            );
        }
        async show() {
            return mockPopupShow(this);
        }
    },
    PopupUtils: { BuildTextWithHeader: (header, text) => `${header}\n${text ?? ''}` },
}));

const mockContext = { characters: [{ avatar: 'old.png', data: { extensions: {} } }] };

const {
    registerCardBindingSlot,
    listCardBindingSlots,
    computeCardBindingPreservation,
    applyCardBindingPreservation,
    handlePostReplaceBindings,
} = await import('/scripts/character/card-binding-preservation.js');

const makeSlot = (id, overrides = {}) => ({
    id,
    label: () => `Label ${id}`,
    read: () => null,
    isPresent: () => false,
    summarize: () => `Summary ${id}`,
    write: jest.fn(async () => {}),
    ...overrides,
});

beforeEach(() => {
    mockReadBound.mockReset().mockReturnValue({ presets: [], defaultPresetName: null });
    mockWriteBound.mockReset().mockResolvedValue(undefined);
    mockReadPersonas.mockReset().mockReturnValue([]);
    mockWritePersonas.mockReset().mockResolvedValue(undefined);
    mockMaybeApply.mockReset().mockResolvedValue(undefined);
    mockPopupShow.mockReset().mockResolvedValue(1);
    lastPopup = null;
});

test('core registers the bound-presets and dedicated-personas slots', () => {
    const ids = listCardBindingSlots().map(slot => slot.id);
    expect(ids).toEqual(expect.arrayContaining(['bound-presets', 'dedicated-personas']));
});

test('registry rejects descriptors without the required functions', () => {
    expect(() => registerCardBindingSlot({ id: 'incomplete' })).toThrow(/requires/);
    expect(() => registerCardBindingSlot(null)).toThrow(/descriptor/);
});

test('registry rejects ids that are unsafe in DOM ids and keeps valid ids', () => {
    for (const id of ['bad.id', 'bad:id', 'bad[id]', 'bad id', '1bad', 'bad/slot']) {
        let error = null;
        try {
            registerCardBindingSlot(makeSlot(id));
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(TypeError);
        expect(error.message).toContain('card-binding-preservation');
        expect(error.message).toContain(id);
    }
    const valid = makeSlot('safe-slot_1');
    registerCardBindingSlot(valid);
    expect(listCardBindingSlots()).toContain(valid);
});

test('registry warns and replaces duplicate ids', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const first = makeSlot('dup-slot');
    const second = makeSlot('dup-slot');
    registerCardBindingSlot(first);
    registerCardBindingSlot(second);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('\'dup-slot\''));
    const matches = listCardBindingSlots().filter(slot => slot.id === 'dup-slot');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(second);
    warn.mockRestore();
});

test('listCardBindingSlots preserves registration order', () => {
    registerCardBindingSlot(makeSlot('order-a'));
    registerCardBindingSlot(makeSlot('order-b'));
    const ids = listCardBindingSlots().map(slot => slot.id);
    expect(ids.indexOf('order-a')).toBeLessThan(ids.indexOf('order-b'));
});

test('compute is silent when only the previous card has the binding', () => {
    const value = { marker: 'silent' };
    registerCardBindingSlot(makeSlot('t-silent', { read: ch => ch?.mine, isPresent: Boolean }));
    const result = computeCardBindingPreservation({ mine: value }, {});
    expect(result.silent.filter(entry => entry.slotId === 't-silent')).toEqual([
        expect.objectContaining({ slotId: 't-silent', value }),
    ]);
    expect(result.conflicts.filter(entry => entry.slotId === 't-silent')).toHaveLength(0);
});

test('compute reports a conflict when both cards define the binding differently', () => {
    registerCardBindingSlot(makeSlot('t-conflict', { read: ch => ch?.mine, isPresent: Boolean }));
    const result = computeCardBindingPreservation({ mine: { a: 1 } }, { mine: { a: 2 } });
    const conflict = result.conflicts.find(entry => entry.slotId === 't-conflict');
    expect(conflict).toEqual(expect.objectContaining({
        slotId: 't-conflict',
        label: 'Label t-conflict',
        localSummary: 'Summary t-conflict',
        localValue: { a: 1 },
        cardValue: { a: 2 },
    }));
});

test('compute skips deep-equal bindings on both cards', () => {
    registerCardBindingSlot(makeSlot('t-equal', { read: ch => ch?.mine, isPresent: Boolean }));
    const result = computeCardBindingPreservation({ mine: { a: [1, 2] } }, { mine: { a: [1, 2] } });
    expect(result.silent.filter(entry => entry.slotId === 't-equal')).toHaveLength(0);
    expect(result.conflicts.filter(entry => entry.slotId === 't-equal')).toHaveLength(0);
});

test('compute ignores bindings only the new card has', () => {
    registerCardBindingSlot(makeSlot('t-new-only', { read: ch => ch?.mine, isPresent: Boolean }));
    const result = computeCardBindingPreservation({}, { mine: { a: 1 } });
    expect(result.silent.filter(entry => entry.slotId === 't-new-only')).toHaveLength(0);
    expect(result.conflicts.filter(entry => entry.slotId === 't-new-only')).toHaveLength(0);
});

test('compute survives a throwing slot read', () => {
    registerCardBindingSlot(makeSlot('t-throw', { read: () => { throw new Error('boom'); } }));
    registerCardBindingSlot(makeSlot('t-after-throw', { read: ch => ch?.mine, isPresent: Boolean }));
    const result = computeCardBindingPreservation({ mine: { a: 1 } }, {});
    expect(result.silent.filter(entry => entry.slotId === 't-after-throw')).toHaveLength(1);
});

test('compute skips a slot whose isPresent throws and still processes healthy slots', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    registerCardBindingSlot(makeSlot('t-isPresent-throw', {
        read: ch => ch?.mine,
        isPresent: () => { throw new Error('detect boom'); },
    }));
    registerCardBindingSlot(makeSlot('t-after-isPresent-throw', { read: ch => ch?.mine, isPresent: Boolean }));
    const result = computeCardBindingPreservation({ mine: { a: 1 } }, {});
    expect(result.silent.filter(entry => entry.slotId === 't-after-isPresent-throw')).toHaveLength(1);
    expect(result.silent.filter(entry => entry.slotId === 't-isPresent-throw')).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('t-isPresent-throw'), expect.any(Error));
    warn.mockRestore();
});

test('compute skips a slot whose summarize throws and still processes healthy slots', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    registerCardBindingSlot(makeSlot('t-summarize-throw', {
        read: ch => ch?.mine,
        isPresent: Boolean,
        summarize: () => { throw new Error('summary boom'); },
    }));
    registerCardBindingSlot(makeSlot('t-after-summarize-throw', { read: ch => ch?.mine, isPresent: Boolean }));
    const result = computeCardBindingPreservation({ mine: { a: 1 } }, { mine: { a: 2 } });
    const conflict = result.conflicts.find(entry => entry.slotId === 't-after-summarize-throw');
    expect(conflict).toEqual(expect.objectContaining({ localValue: { a: 1 }, cardValue: { a: 2 } }));
    expect(result.conflicts.find(entry => entry.slotId === 't-summarize-throw')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('t-summarize-throw'), expect.any(Error));
    warn.mockRestore();
});

test('apply isolates a failing write and keeps going', async () => {
    const ok = makeSlot('t-ok');
    const bad = makeSlot('t-bad', { write: jest.fn(async () => { throw new Error('disk full'); }) });
    const ok2 = makeSlot('t-ok-2');
    const result = await applyCardBindingPreservation(0, [
        { slot: ok, slotId: 't-ok', value: 1 },
        { slot: bad, slotId: 't-bad', value: 2 },
        { slot: ok2, slotId: 't-ok-2', value: 3 },
    ]);
    expect(result.applied).toEqual(['t-ok', 't-ok-2']);
    expect(result.failed.map(entry => entry.slotId)).toEqual(['t-bad']);
    expect(bad.write).toHaveBeenCalledWith(0, 2);
    expect(ok2.write).toHaveBeenCalledWith(0, 3);
});

test('apply falls back to the slot id when a failing slot label throws', async () => {
    const bad = makeSlot('t-bad-label', {
        label: () => { throw new Error('label boom'); },
        write: jest.fn(async () => { throw new Error('disk full'); }),
    });
    const ok = makeSlot('t-after-bad-label');
    const result = await applyCardBindingPreservation(0, [
        { slot: bad, slotId: 't-bad-label', value: 1 },
        { slot: ok, slotId: 't-after-bad-label', value: 2 },
    ]);
    expect(result.applied).toEqual(['t-after-bad-label']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toEqual(expect.objectContaining({ slotId: 't-bad-label', label: 't-bad-label' }));
    expect(ok.write).toHaveBeenCalledWith(0, 2);
});

test('handle silently writes missed bindings without a dialog and refreshes the preset runtime', async () => {
    mockReadBound.mockImplementation(ch => ch?.isOld
        ? { presets: [{ name: 'Kept', preset: {} }], defaultPresetName: 'Kept' }
        : { presets: [], defaultPresetName: null });
    const result = await handlePostReplaceBindings({
        context: mockContext,
        characterId: 0,
        previousCharacter: { isOld: true },
        newCharacter: mockContext.characters[0],
    });
    expect(mockWriteBound).toHaveBeenCalledWith(0, expect.objectContaining({ defaultPresetName: 'Kept' }));
    expect(mockMaybeApply).toHaveBeenCalledTimes(1);
    expect(lastPopup).toBeNull();
    expect(result).toEqual({ wrotePresets: true });
});

test('handle asks per category on conflicts and honors unchecked rows', async () => {
    mockReadBound.mockImplementation(ch => ch?.isOld
        ? { presets: [{ name: 'Local', preset: {} }], defaultPresetName: 'Local' }
        : { presets: [{ name: 'Incoming', preset: {} }], defaultPresetName: 'Incoming' });
    mockReadPersonas.mockImplementation(ch => ch?.isOld
        ? [{ avatar: 'local.png', name: 'Local' }]
        : [{ avatar: 'incoming.png', name: 'Incoming' }]);
    mockPopupShow.mockImplementation(async (popup) => {
        popup.inputResults.set('card-binding-keep-bound-presets', false);
        popup.inputResults.set('card-binding-keep-dedicated-personas', true);
        return 1;
    });
    await handlePostReplaceBindings({
        context: mockContext,
        characterId: 0,
        previousCharacter: { isOld: true },
        newCharacter: { isOld: false },
    });
    expect(lastPopup).not.toBeNull();
    expect(mockWriteBound).not.toHaveBeenCalled();
    expect(mockWritePersonas).toHaveBeenCalledTimes(1);
    expect(mockWritePersonas).toHaveBeenCalledWith(
        mockContext.characters[0].avatar,
        [{ avatar: 'local.png', name: 'Local' }],
        { restoreRemovedToGlobal: false },
    );
    expect(mockMaybeApply).not.toHaveBeenCalled();
});
