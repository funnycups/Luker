import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const chat_metadata = { variables: {} };

// Mock script.js and the heavier modules variables.js pulls in transitively.
// Without these stubs the import chain reaches public/lib.js, which expects a
// webpack-bundled lib.core.bundle.js that does not exist in the test env.
jest.unstable_mockModule('../../public/script.js', () => ({
    chat_metadata,
    getCurrentChatId: () => 'test',
    saveSettingsDebounced: () => {},
    eventSource: { on: () => {}, off: () => {}, emit: () => {} },
    event_types: {},
    characters: [],
    this_chid: null,
    user_avatar: null,
    getRequestHeaders: () => ({}),
    processDroppedFiles: () => {},
    substituteParams: (s) => s,
    substituteParamsExtended: (s) => s,
}));
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: { variables: { global: {} } },
    saveMetadataDebounced: () => {},
    getContext: () => ({}),
    registerExtensionApi: () => {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands.js', () => ({ executeSlashCommandsWithOptions: async () => ({}) }));

// SlashCommand* — variables.js imports a bunch of these directly. Several of
// them transitively import lib.js, so we stub the surface to no-op classes.
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommand.js', () => ({
    SlashCommand: class { static fromProps() { return new this(); } },
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandAbortController.js', () => ({
    SlashCommandAbortController: class {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandArgument.js', () => ({
    ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', LIST: 'list', BOOLEAN: 'boolean', DICTIONARY: 'dictionary', VARIABLE_NAME: 'variable_name' },
    SlashCommandArgument: class { static fromProps() { return new this(); } },
    SlashCommandNamedArgument: class { static fromProps() { return new this(); } },
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandBreakController.js', () => ({
    SlashCommandBreakController: class {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandClosure.js', () => ({
    SlashCommandClosure: class {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandClosureResult.js', () => ({
    SlashCommandClosureResult: class {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js', () => ({
    commonEnumProviders: {
        variables: () => [],
        boolean: () => [],
    },
    enumIcons: { default: '' },
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandEnumValue.js', () => ({
    SlashCommandEnumValue: class {},
    enumTypes: {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandParser.js', () => ({
    SlashCommandParser: { addCommandObject: () => {} },
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandReturnHelper.js', () => ({
    slashCommandReturnHelper: {},
}));
jest.unstable_mockModule('../../public/scripts/slash-commands/SlashCommandScope.js', () => ({
    SlashCommandScope: class {},
}));
jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    isFalseBoolean: (v) => v === 'false' || v === false,
    isTrueBoolean: (v) => v === 'true' || v === true,
    convertValueType: (v, _as) => v,
}));

const variables = await import('../../public/scripts/variables.js');

describe('setLocalVariable: path support', () => {
    beforeEach(() => {
        for (const k of Object.keys(chat_metadata.variables)) delete chat_metadata.variables[k];
    });

    test('flat key still writes to top level', () => {
        variables.setLocalVariable('hp', '50');
        expect(chat_metadata.variables.hp).toBe('50');
    });

    test('dotted name writes into structured value', () => {
        variables.setLocalVariable('roster.alice.hp', '50');
        expect(JSON.parse(chat_metadata.variables.roster)).toEqual({ alice: { hp: 50 } });
    });

    test('dotted name updates existing structured value', () => {
        chat_metadata.variables.roster = JSON.stringify({ alice: { hp: 40 }, bob: { hp: 30 } });
        variables.setLocalVariable('roster.alice.hp', '50');
        expect(JSON.parse(chat_metadata.variables.roster)).toEqual({ alice: { hp: 50 }, bob: { hp: 30 } });
    });

    test('args.index single-layer behavior preserved', () => {
        variables.setLocalVariable('costumes', 'red', { index: 0 });
        expect(JSON.parse(chat_metadata.variables.costumes)).toEqual(['red']);
    });
});

describe('deleteLocalVariable: path support', () => {
    beforeEach(() => {
        for (const k of Object.keys(chat_metadata.variables)) delete chat_metadata.variables[k];
    });

    test('flat key deletes top level', () => {
        chat_metadata.variables.hp = '50';
        variables.deleteLocalVariable('hp');
        expect('hp' in chat_metadata.variables).toBe(false);
    });

    test('dotted name deletes a leaf', () => {
        chat_metadata.variables.roster = JSON.stringify({ alice: { hp: 50 }, bob: { hp: 30 } });
        variables.deleteLocalVariable('roster.bob');
        expect(JSON.parse(chat_metadata.variables.roster)).toEqual({ alice: { hp: 50 } });
    });

    test('missing path is a no-op (no throw)', () => {
        chat_metadata.variables.roster = JSON.stringify({ alice: { hp: 50 } });
        expect(() => variables.deleteLocalVariable('roster.charlie')).not.toThrow();
        expect(JSON.parse(chat_metadata.variables.roster)).toEqual({ alice: { hp: 50 } });
    });
});

describe('getLocalVariable: path support', () => {
    beforeEach(() => {
        for (const k of Object.keys(chat_metadata.variables)) delete chat_metadata.variables[k];
    });

    test('flat key returns value', () => {
        chat_metadata.variables.hp = '50';
        // Numeric-string is coerced to number by the existing helper.
        expect(variables.getLocalVariable('hp')).toBe(50);
    });

    test('dotted name returns nested value', () => {
        chat_metadata.variables.roster = JSON.stringify({ alice: { hp: 50 } });
        expect(variables.getLocalVariable('roster.alice.hp')).toBe(50);
    });

    test('dotted name with literal flat key fallback still works', () => {
        chat_metadata.variables['a.b'] = 'hi';
        expect(variables.getLocalVariable('a.b')).toBe('hi');
    });
});

describe('pushLocalVariable / popLocalVariable', () => {
    beforeEach(() => {
        for (const k of Object.keys(chat_metadata.variables)) delete chat_metadata.variables[k];
    });

    test('pushLocalVariable creates root array', () => {
        variables.pushLocalVariable('queue', 'first');
        expect(JSON.parse(chat_metadata.variables.queue)).toEqual(['first']);
    });

    test('pushLocalVariable at path', () => {
        variables.pushLocalVariable('roster.alice.inv', 'sword');
        expect(JSON.parse(chat_metadata.variables.roster)).toEqual({ alice: { inv: ['sword'] } });
    });

    test('popLocalVariable pops from root', () => {
        chat_metadata.variables.queue = JSON.stringify(['a', 'b']);
        variables.popLocalVariable('queue');
        expect(JSON.parse(chat_metadata.variables.queue)).toEqual(['a']);
    });

    test('popLocalVariable from missing key is no-op', () => {
        expect(() => variables.popLocalVariable('queue')).not.toThrow();
        expect(chat_metadata.variables.queue).toBeUndefined();
    });
});
