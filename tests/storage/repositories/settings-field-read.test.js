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
