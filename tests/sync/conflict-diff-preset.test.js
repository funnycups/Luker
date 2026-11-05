import { describe, test, expect } from '@jest/globals';

import { renderPreset } from '../../src/sync/conflict-diff/preset.js';
import { createBuilder } from '../../src/sync/conflict-diff/tree.js';

const prompt = (identifier, name, content = 'content', enabled = true) => ({
    identifier,
    name,
    content,
    role: 'system',
    enabled,
});

function preset(overrides = {}) {
    const prompts = [
        prompt('main', 'Main', 'Line one\nLine two'),
        prompt('jailbreak', 'Jailbreak'),
        prompt('nsfw', 'NSFW'),
        ...Array.from({ length: 7 }, (_, index) => prompt(`extra${index}`, `Extra ${index}`)),
    ];
    return {
        temperature: 0.8,
        frequency_penalty: 0,
        presence_penalty: 0,
        prompts,
        prompt_order: [{
            character_id: 100001,
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'jailbreak', enabled: true },
                { identifier: 'nsfw', enabled: true },
            ],
        }],
        extensions: {
            regex_scripts: [
                { id: 'r1', scriptName: 'Script A', findRegex: 'a', replaceString: 'b', disabled: false },
                { id: 'r2', scriptName: 'Script B', findRegex: 'c', replaceString: 'd', disabled: false },
            ],
        },
        ...overrides,
    };
}

const section = (sections, label) => sections.find(item => item.label === label);
const item = (parent, label) => parent.children.find(child => child.label === label);

function build(left, right) {
    const builder = createBuilder();
    const sections = renderPreset(left, right, builder);
    return builder.finalize(sections);
}

describe('preset conflict renderer', () => {
    test('groups parameters, prompts, order and extensions by their own labels', () => {
        const left = preset();
        const right = preset();
        right.temperature = 1.2;
        right.frequency_penalty = 0.5;
        right.prompts[0].content = 'Line one\nChanged line';
        right.prompts[1].name = 'Jailbreak v2';
        right.prompts[2].enabled = false;
        right.prompts.push(prompt('new', 'New prompt'));
        right.prompt_order[0].order = [
            { identifier: 'jailbreak', enabled: true },
            { identifier: 'main', enabled: true },
            { identifier: 'nsfw', enabled: false },
        ];
        right.extensions.regex_scripts[0].replaceString = 'B';

        const { sections, values } = build(left, right);
        const parameters = section(sections, 'Parameters');
        expect(parameters.children.map(child => child.label).sort()).toEqual(['Frequency penalty', 'Temperature']);
        expect(parameters.children.every(child => child.translateLabel)).toBe(true);

        const prompts = section(sections, 'Prompts');
        expect(prompts.children).toHaveLength(4);
        expect(prompts.children.map(child => child.label).sort()).toEqual(['Jailbreak v2', 'Main', 'NSFW', 'New prompt']);
        expect(prompts.children.every(child => child.translateLabel === false)).toBe(true);
        const main = item(prompts, 'Main');
        const content = item(main, 'Content');
        expect(content).toMatchObject({ type: 'field', status: 'changed', value: { kind: 'text' } });
        expect(content.translateLabel).toBe(true);
        expect(values.get(content.id)()).toMatchObject({ mode: 'lines' });

        const order = section(sections, 'Prompt order');
        const defaultOrder = item(order, 'Default order');
        expect(defaultOrder).toBeTruthy();
        const moved = item(defaultOrder, 'Main');
        expect(moved).toMatchObject({ status: 'moved', meta: { move: { from: 1, to: 2 } } });
        const nsfw = item(defaultOrder, 'NSFW');
        const enabled = item(nsfw, 'Enabled');
        expect(enabled).toMatchObject({ type: 'field', status: 'changed' });
        expect(values.get(enabled.id)()).toEqual({ mode: 'cells', before: 'true', after: 'false' });

        const extensions = section(sections, 'Regex scripts');
        const script = item(extensions, 'Script A');
        const replace = item(script, 'Replace string');
        expect(replace).toMatchObject({ type: 'field', status: 'changed' });
        expect(values.get(replace.id)()).toEqual({ mode: 'cells', before: 'b', after: 'B' });
    });

    test('keeps an added prompt as one entry with its fields', () => {
        const left = preset();
        const right = preset();
        right.prompts.push({ identifier: 'new', name: 'New prompt', content: 'New\nBody', role: 'system', enabled: true });
        const { sections, values } = build(left, right);
        const prompts = section(sections, 'Prompts');
        expect(prompts.children).toHaveLength(1);
        expect(prompts.children[0]).toMatchObject({ label: 'New prompt', status: 'added' });
        const content = item(prompts.children[0], 'Content');
        expect(content).toMatchObject({ status: 'added', value: { kind: 'scalar' } });
        expect(values.get(content.id)()).toMatchObject({ mode: 'cells', after: 'New\nBody' });
    });

    test('labels a non-default order group with its character id', () => {
        const left = preset();
        const right = preset();
        right.prompt_order.push({
            character_id: 42,
            order: [{ identifier: 'main', enabled: false }],
        });
        const { sections } = build(left, right);
        const order = section(sections, 'Prompt order');
        const group = order.children.find(child => child.meta?.characterId === '42');
        expect(group).toMatchObject({ label: 'Order for character', meta: { characterId: '42' } });
        expect(item(group, 'Main')).toMatchObject({ status: 'added' });
    });

    test('returns no sections for identical presets', () => {
        expect(build(preset(), preset()).sections).toEqual([]);
    });
});
