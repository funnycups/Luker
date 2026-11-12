import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { getSettingsRepo } from '../../../src/storage/index.js';

const DOCUMENT = JSON.parse(`{
    "user_name": "tester",
    "extension_settings": {
        "example": {
            "enabled": true,
            "disabled": false,
            "nullable": null,
            "count": 3,
            "text": "hello",
            "list": [1, "two"],
            "nested": {"a": 1},
            "empty": {},
            "a/b~c": "special",
            "__proto__": "own-key"
        },
        "array-namespace": [1, 2],
        "string-namespace": "leaf"
    }
}`);

describe.each(ENDPOINT_HARNESSES)('SettingsRepo.getField on $name', ({ mode }) => {
    let harness;
    let repo;

    beforeEach(async () => {
        harness = await makeEndpointHarness({ mode, mount: () => {} });
        repo = getSettingsRepo();
        await repo.save(harness.handle, DOCUMENT);
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('preserves missing and JSON null across engines', async () => {
        expect(await repo.getField(harness.handle, '/extension_settings/example/nullable'))
            .toMatchObject({ exists: true, value: null });
        expect(await repo.getField(harness.handle, '/extension_settings/example/absent'))
            .toEqual({ exists: false });
    });

    test('preserves primitive and container JSON types', async () => {
        expect(await repo.getField(harness.handle, '/extension_settings/example/enabled'))
            .toMatchObject({ exists: true, value: true });
        expect(await repo.getField(harness.handle, '/extension_settings/example/disabled'))
            .toMatchObject({ exists: true, value: false });
        expect(await repo.getField(harness.handle, '/extension_settings/example/count'))
            .toMatchObject({ exists: true, value: 3 });
        expect(await repo.getField(harness.handle, '/extension_settings/example/list'))
            .toMatchObject({ exists: true, value: [1, 'two'] });
        expect(await repo.getField(harness.handle, '/extension_settings/example/nested'))
            .toMatchObject({ exists: true, value: { a: 1 } });
        expect(await repo.getField(harness.handle, '/extension_settings/example/empty'))
            .toMatchObject({ exists: true, value: {} });
    });

    test.each([
        ['surrounding quotes', '"quoted"'],
        ['an unmatched opening quote', '"unclosed'],
        ['a lone quote', '"'],
        ['quoted JSON text', '"[1,2]"'],
        ['JSON boolean text', 'true'],
        ['an empty string', ''],
    ])('preserves %s in a string field', async (_label, value) => {
        await repo.save(harness.handle, { ...DOCUMENT, username: value });

        expect(await repo.getField(harness.handle, '/username'))
            .toMatchObject({ exists: true, value, type: 'string' });
        expect(await repo.getFieldType(harness.handle, '/username'))
            .toEqual({ exists: true, type: 'string' });
    });

    test.each([
        ['quoted', 'a"b', 'a"b'],
        ['backslash', 'a\\b', 'a\\b'],
        ['slash and tilde', 'a/b~c', 'a~1b~0c'],
        ['numeric', '0', '0'],
        ['empty', '', ''],
        ['newline', 'line\nbreak', 'line\nbreak'],
        ['tab', 'tab\tkey', 'tab\tkey'],
        ['carriage return', 'return\rkey', 'return\rkey'],
        ['backspace', 'back\bspace', 'back\bspace'],
        ['form feed', 'form\ffeed', 'form\ffeed'],
        ['unit separator', 'unit\u001fseparator', 'unit\u001fseparator'],
    ])('reads %s namespace keys exactly', async (_label, key, pointerSegment) => {
        const value = { enabled: true, text: 'exact namespace' };
        await repo.save(harness.handle, { extension_settings: { [key]: value } });
        const pointer = `/extension_settings/${pointerSegment}`;

        expect(await repo.getField(harness.handle, pointer))
            .toMatchObject({ exists: true, value, type: 'object' });
        expect(await repo.getFieldType(harness.handle, pointer))
            .toEqual({ exists: true, type: 'object' });
    });

    test('reads reserved and escaped property names as own keys', async () => {
        expect(await repo.getField(harness.handle, '/extension_settings/example/a~1b~0c'))
            .toMatchObject({ exists: true, value: 'special' });
        expect(await repo.getField(harness.handle, '/extension_settings/example/__proto__'))
            .toMatchObject({ exists: true, value: 'own-key' });
    });

    test('reports the field JSON type for container rules', async () => {
        expect(await repo.getField(harness.handle, '/extension_settings/example'))
            .toMatchObject({ exists: true, type: 'object' });
        expect(await repo.getField(harness.handle, '/extension_settings/array-namespace'))
            .toMatchObject({ exists: true, type: 'array' });
        expect(await repo.getField(harness.handle, '/extension_settings/string-namespace'))
            .toMatchObject({ exists: true, type: 'string' });
    });

    test('reads only the field type for container validation', async () => {
        expect(await repo.getFieldType(harness.handle, '/extension_settings/example'))
            .toEqual({ exists: true, type: 'object' });
        expect(await repo.getFieldType(harness.handle, '/extension_settings/array-namespace'))
            .toEqual({ exists: true, type: 'array' });
        expect(await repo.getFieldType(harness.handle, '/extension_settings/example/absent'))
            .toEqual({ exists: false });
    });

    test('reads the updated value after save', async () => {
        await repo.save(harness.handle, {
            ...DOCUMENT,
            extension_settings: {
                ...DOCUMENT.extension_settings,
                example: { ...DOCUMENT.extension_settings.example, count: 9 },
            },
        });
        expect(await repo.getField(harness.handle, '/extension_settings/example/count'))
            .toMatchObject({ exists: true, value: 9 });
    });
});
