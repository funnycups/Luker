import { expect, test } from '@jest/globals';
import {
    buildLorasProperty,
    parseSlashLoras,
    resolveRecordLoras,
    validateLorasArg,
} from '../public/scripts/extensions/stable-diffusion/lora/tool.js';

const NAMES = ['a.safetensors', 'b.safetensors'];

test('buildLorasProperty returns null when no name is available', () => {
    expect(buildLorasProperty([])).toBeNull();
});

test('buildLorasProperty describes an array of objects whose name must come from the available names', () => {
    expect(buildLorasProperty(NAMES)).toEqual({
        type: 'array',
        description: expect.any(String),
        items: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    enum: NAMES,
                    description: expect.any(String),
                },
            },
            required: ['name'],
        },
    });
});

test('buildLorasProperty omits the weight when includeWeight is false', () => {
    const property = buildLorasProperty(NAMES, { includeWeight: false });
    expect(property.items.properties).not.toHaveProperty('weight');
});

test('buildLorasProperty offers a numeric weight when includeWeight is true', () => {
    const property = buildLorasProperty(NAMES, { includeWeight: true });
    expect(property.items.properties.weight).toEqual({
        type: 'number',
        description: expect.any(String),
    });
    expect(property.items.required).toEqual(['name']);
});

test('validateLorasArg treats an omitted argument as an empty selection', () => {
    expect(validateLorasArg(undefined)).toEqual({ ok: true, value: [] });
});

test('validateLorasArg skips the availability check when no available list is supplied', () => {
    expect(validateLorasArg([{ name: 'anything.safetensors' }])).toEqual({
        ok: true,
        value: [{ name: 'anything.safetensors', weight: 1 }],
    });
});

test('validateLorasArg rejects an unknown name and names the offending value', () => {
    expect(validateLorasArg([{ name: 'c.safetensors' }], { available: NAMES })).toEqual({
        ok: false,
        error: 'unknown LoRA \'c.safetensors\'',
    });
});

test('validateLorasArg matches names exactly', () => {
    expect(validateLorasArg([{ name: 'A.safetensors' }], { available: NAMES })).toEqual({
        ok: false,
        error: 'unknown LoRA \'A.safetensors\'',
    });
});

test('validateLorasArg rejects every name when the available list is empty', () => {
    expect(validateLorasArg([{ name: 'a.safetensors' }], { available: [] })).toEqual({
        ok: false,
        error: 'unknown LoRA \'a.safetensors\'',
    });
});

test('validateLorasArg accepts an empty array', () => {
    expect(validateLorasArg([], { available: [] })).toEqual({ ok: true, value: [] });
});

test('validateLorasArg rejects a value that is not an array', () => {
    expect(validateLorasArg('a.safetensors')).toEqual({
        ok: false,
        error: 'loras must be an array',
    });
    expect(validateLorasArg(null)).toEqual({
        ok: false,
        error: 'loras must be an array',
    });
});

test('validateLorasArg rejects an entry without a usable name', () => {
    expect(validateLorasArg(['a.safetensors'])).toEqual({
        ok: false,
        error: 'loras entry must be an object with a name',
    });
    expect(validateLorasArg([{ weight: 0.5 }])).toEqual({
        ok: false,
        error: 'loras entry name must be a non-empty string',
    });
    expect(validateLorasArg([{ name: '' }])).toEqual({
        ok: false,
        error: 'loras entry name must be a non-empty string',
    });
});

test('validateLorasArg rejects a weight that is not a finite number', () => {
    for (const weight of [Infinity, -Infinity, Number.NaN, '0.8', null]) {
        expect(validateLorasArg([{ name: 'a.safetensors', weight }], {
            available: NAMES,
            includeWeight: true,
        })).toEqual({
            ok: false,
            error: 'LoRA \'a.safetensors\' weight must be a finite number',
        });
    }
});

test('validateLorasArg rejects a weight when the parameter does not include one', () => {
    const options = { available: NAMES, includeWeight: false };
    expect(validateLorasArg([{ name: 'a.safetensors', weight: 0.8 }], options)).toEqual({
        ok: false,
        error: 'LoRA \'a.safetensors\' does not accept a weight',
    });
    expect(validateLorasArg([{ name: 'a.safetensors', weight: 0.8 }], { available: NAMES })).toEqual({
        ok: false,
        error: 'LoRA \'a.safetensors\' does not accept a weight',
    });
});

test('validateLorasArg rejects duplicate names', () => {
    expect(validateLorasArg([
        { name: 'a.safetensors' },
        { name: 'a.safetensors', weight: 0.5 },
    ], { available: NAMES, includeWeight: true })).toEqual({
        ok: false,
        error: 'duplicate LoRA \'a.safetensors\'',
    });
});

test('validateLorasArg defaults a missing weight to 1 and keeps negative weights in order', () => {
    expect(validateLorasArg([
        { name: 'b.safetensors', weight: -0.5 },
        { name: 'a.safetensors' },
    ], { available: NAMES, includeWeight: true })).toEqual({
        ok: true,
        value: [
            { name: 'b.safetensors', weight: -0.5 },
            { name: 'a.safetensors', weight: 1 },
        ],
    });
});

test('parseSlashLoras reads a trailing numeric suffix as the weight', () => {
    expect(parseSlashLoras('a.safetensors:0.8')).toEqual({
        ok: true,
        value: [{ name: 'a.safetensors', weight: 0.8 }],
    });
    expect(parseSlashLoras('a.safetensors:-1')).toEqual({
        ok: true,
        value: [{ name: 'a.safetensors', weight: -1 }],
    });
});

test('parseSlashLoras omits the weight when no numeric suffix is present', () => {
    expect(parseSlashLoras('a.safetensors')).toEqual({
        ok: true,
        value: [{ name: 'a.safetensors' }],
    });
});

test('parseSlashLoras keeps a non-numeric suffix as part of the name without a weight', () => {
    expect(parseSlashLoras('a.safetensors:soft')).toEqual({
        ok: true,
        value: [{ name: 'a.safetensors:soft' }],
    });
});

test('parseSlashLoras splits on the last colon so names may contain colons', () => {
    expect(parseSlashLoras('style:neon:1.25')).toEqual({
        ok: true,
        value: [{ name: 'style:neon', weight: 1.25 }],
    });
    expect(parseSlashLoras('style:neon')).toEqual({
        ok: true,
        value: [{ name: 'style:neon' }],
    });
});

test('parseSlashLoras accepts an array in order', () => {
    expect(parseSlashLoras(['b.safetensors:0.5', 'a.safetensors'])).toEqual({
        ok: true,
        value: [
            { name: 'b.safetensors', weight: 0.5 },
            { name: 'a.safetensors' },
        ],
    });
});

test('a parsed bare name takes the default weight on a weighted template', () => {
    const parsed = parseSlashLoras('a.safetensors');
    expect(validateLorasArg(parsed.value, { available: NAMES, includeWeight: true })).toEqual({
        ok: true,
        value: [{ name: 'a.safetensors', weight: 1 }],
    });
    expect(validateLorasArg(parsed.value, { available: NAMES, includeWeight: false })).toEqual({
        ok: true,
        value: [{ name: 'a.safetensors', weight: 1 }],
    });
});

test('a parsed explicit weight is rejected on a literal-strength template', () => {
    const parsed = parseSlashLoras('a.safetensors:0.8');
    expect(validateLorasArg(parsed.value, { available: NAMES, includeWeight: false })).toEqual({
        ok: false,
        error: 'LoRA \'a.safetensors\' does not accept a weight',
    });
});

test('parseSlashLoras accepts an empty array', () => {
    expect(parseSlashLoras([])).toEqual({ ok: true, value: [] });
});

test('parseSlashLoras rejects values that are not strings', () => {
    const error = 'loras must be a string or an array of strings';
    expect(parseSlashLoras(5)).toEqual({ ok: false, error });
    expect(parseSlashLoras(undefined)).toEqual({ ok: false, error });
    expect(parseSlashLoras(['a.safetensors', 5])).toEqual({ ok: false, error });
});

test('parseSlashLoras rejects an entry without a name', () => {
    const error = 'LoRA name must not be empty';
    expect(parseSlashLoras('')).toEqual({ ok: false, error });
    expect(parseSlashLoras(':0.8')).toEqual({ ok: false, error });
});

test('parseSlashLoras rejects duplicate names', () => {
    expect(parseSlashLoras(['a.safetensors', 'a.safetensors:0.5'])).toEqual({
        ok: false,
        error: 'duplicate LoRA \'a.safetensors\'',
    });
});

test('resolveRecordLoras keeps available names and reports the dropped ones', () => {
    const saved = [
        { name: 'b.safetensors', weight: 0.5 },
        { name: 'c.safetensors', weight: -1 },
        { name: 'a.safetensors', weight: 2 },
    ];
    expect(resolveRecordLoras(saved, NAMES)).toEqual({
        loras: [
            { name: 'b.safetensors', weight: 0.5 },
            { name: 'a.safetensors', weight: 2 },
        ],
        dropped: ['c.safetensors'],
    });
});

test('resolveRecordLoras keeps every entry when the available list is omitted', () => {
    const saved = [
        { name: 'c.safetensors', weight: 0.5 },
        { name: 'a.safetensors', weight: -2 },
    ];
    expect(resolveRecordLoras(saved)).toEqual({
        loras: [
            { name: 'c.safetensors', weight: 0.5 },
            { name: 'a.safetensors', weight: -2 },
        ],
        dropped: [],
    });
});

test('resolveRecordLoras drops every entry when the available list is empty', () => {
    const saved = [{ name: 'a.safetensors', weight: 0.5 }];
    expect(resolveRecordLoras(saved, [])).toEqual({
        loras: [],
        dropped: ['a.safetensors'],
    });
});

test('resolveRecordLoras matches names exactly', () => {
    expect(resolveRecordLoras([{ name: 'A.safetensors', weight: 1 }], NAMES)).toEqual({
        loras: [],
        dropped: ['A.safetensors'],
    });
});
