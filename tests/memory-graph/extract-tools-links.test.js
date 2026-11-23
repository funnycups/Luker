import { beforeAll, expect, test } from '@jest/globals';
import './_mocks/main-module-stack.js';

let buildDynamicExtractTools;

beforeAll(async () => {
    ({ buildDynamicExtractTools } = await import('../../public/scripts/extensions/memory-graph/main.js'));
});

const SCHEMA = [{
    id: 'event',
    editable: true,
    tableColumns: ['title', 'summary'],
    requiredColumns: ['title'],
    extractionInstructions: '',
}];

const toolNames = (tools) => tools.map(tool => tool.function.name);
const toolNamed = (tools, name) => tools.find(tool => tool.function.name === name);

test('links on by default', () => {
    const { tools, specByToolName } = buildDynamicExtractTools(SCHEMA, { activeTypes: new Set(['event']) });
    expect(toolNames(tools)).toEqual(expect.arrayContaining([
        'luker_rpg_extract_event_create',
        'luker_rpg_extract_link_upsert',
        'luker_rpg_extract_link_delete',
        'luker_rpg_extract_done',
    ]));
    expect(specByToolName.has('luker_rpg_extract_link_upsert')).toBe(true);
    const create = toolNamed(tools, 'luker_rpg_extract_event_create');
    expect(Object.keys(create.function.parameters.properties)).toEqual(expect.arrayContaining(['ref', 'links', 'no_link_reason']));
    expect(create.function.parameters.required).toContain('links');
    expect(create.function.parameters.properties.links.items.properties.direction.description).toMatch(/outgoing/i);
    const linkUpsert = toolNamed(tools, 'luker_rpg_extract_link_upsert');
    expect(linkUpsert.function.parameters.properties.links.items.properties.direction.description).toMatch(/outgoing/i);
});

test('allowLinks false drops the link face', () => {
    const { tools, specByToolName } = buildDynamicExtractTools(SCHEMA, {
        activeTypes: new Set(['event']),
        allowLinks: false,
    });
    expect(toolNames(tools)).toContain('luker_rpg_extract_event_create');
    expect(toolNames(tools)).toContain('luker_rpg_extract_done');
    expect(toolNames(tools)).not.toContain('luker_rpg_extract_link_upsert');
    expect(toolNames(tools)).not.toContain('luker_rpg_extract_link_delete');
    expect(specByToolName.has('luker_rpg_extract_link_upsert')).toBe(false);
    expect(specByToolName.has('luker_rpg_extract_link_delete')).toBe(false);
    const create = toolNamed(tools, 'luker_rpg_extract_event_create');
    const props = Object.keys(create.function.parameters.properties);
    expect(props).toContain('ref');
    expect(props).not.toContain('links');
    expect(props).not.toContain('no_link_reason');
    expect(create.function.parameters.required).not.toContain('links');
});
