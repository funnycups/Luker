import { expect, jest, test } from '@jest/globals';
import { resolveReplayLoras } from '../public/scripts/extensions/stable-diffusion/lora/tool.js';

test('replay keeps the saved LoRAs that are still available and reports the dropped one', () => {
    const saved = [
        { name: 'a.safetensors', weight: 0.8 },
        { name: 'b.safetensors', weight: 1.2 },
    ];

    expect(resolveReplayLoras(saved, ['a.safetensors'])).toEqual({
        loras: [{ name: 'a.safetensors', weight: 0.8 }],
        dropped: ['b.safetensors'],
    });
});

test('replay drops every saved LoRA when no name is available', () => {
    const warn = jest.fn();
    const saved = [
        { name: 'a.safetensors', weight: 0.8 },
        { name: 'b.safetensors', weight: 1.2 },
    ];

    expect(resolveReplayLoras(saved, [], warn)).toEqual({
        loras: [],
        dropped: ['a.safetensors', 'b.safetensors'],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(['a.safetensors', 'b.safetensors']);
});

test('replay without saved LoRAs resolves to an empty selection', () => {
    expect(resolveReplayLoras([], ['a.safetensors'])).toEqual({
        loras: [],
        dropped: [],
    });
});

test('replay reports dropped names to the warning callback', () => {
    const warn = jest.fn();
    const saved = [
        { name: 'a.safetensors', weight: 0.8 },
        { name: 'b.safetensors', weight: 1.2 },
    ];

    resolveReplayLoras(saved, ['a.safetensors'], warn);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(['b.safetensors']);
});

test('replay reports every dropped name once in selection order', () => {
    const warn = jest.fn();
    const saved = [
        { name: 'a.safetensors', weight: 0.8 },
        { name: 'b.safetensors', weight: 1.2 },
        { name: 'c.safetensors', weight: 0.5 },
    ];

    const { dropped } = resolveReplayLoras(saved, ['b.safetensors'], warn);

    expect(dropped).toEqual(['a.safetensors', 'c.safetensors']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(['a.safetensors', 'c.safetensors']);
});

test('replay does not warn when nothing was dropped', () => {
    const warn = jest.fn();

    resolveReplayLoras([{ name: 'a.safetensors', weight: 0.8 }], ['a.safetensors'], warn);
    resolveReplayLoras([], ['a.safetensors'], warn);

    expect(warn).not.toHaveBeenCalled();
});

test('replay returns a selection detached from the saved entries', () => {
    const saved = [
        { name: 'a.safetensors', weight: 0.8 },
        { name: 'b.safetensors', weight: 1.2 },
    ];

    const { loras, dropped } = resolveReplayLoras(saved, ['a.safetensors']);

    expect(loras).not.toBe(saved);
    expect(loras[0]).not.toBe(saved[0]);
    saved[0].name = 'changed.safetensors';
    saved[1].name = 'also-changed.safetensors';
    loras[0].weight = 2;

    expect(loras).toEqual([{ name: 'a.safetensors', weight: 2 }]);
    expect(saved[0].weight).toBe(0.8);
    expect(dropped).toEqual(['b.safetensors']);
});
