import { buildSettingsFieldStructure, assembleJsonFields, decodeResourcePointer } from '../../public/scripts/util/resource-fields.js';

function extensionDocument() {
    return JSON.parse(`{
        "user_name": "A",
        "extension_settings": {
            "example": {
                "enabled": true,
                "history": {"entries": [1, 2, 3]},
                "nullable": null,
                "empty": {},
                "a/b~c": "special",
                "__proto__": "own-key"
            },
            "primitive-namespace": "kept-as-leaf",
            "array-namespace": [1, 2]
        }
    }`);
}

test('builds one leaf per extension namespace', () => {
    const document = extensionDocument();
    const { containers, values } = buildSettingsFieldStructure(document);

    expect(containers).toEqual([
        { path: '', keys: ['user_name', 'extension_settings'] },
        { path: '/extension_settings', keys: ['example', 'primitive-namespace', 'array-namespace'] },
    ]);
    expect([...values.keys()]).toEqual([
        '/user_name',
        '/extension_settings/example',
        '/extension_settings/primitive-namespace',
        '/extension_settings/array-namespace',
    ]);
    expect(JSON.stringify(values.get('/extension_settings/example')))
        .toBe(JSON.stringify(document.extension_settings.example));
});

test('keeps an empty extension namespace as one leaf', () => {
    const document = { extension_settings: { empty: {} } };
    const { containers, values } = buildSettingsFieldStructure(document);

    expect(containers).toEqual([
        { path: '', keys: ['extension_settings'] },
        { path: '/extension_settings', keys: ['empty'] },
    ]);
    expect([...values.keys()]).toEqual(['/extension_settings/empty']);
    expect(values.get('/extension_settings/empty')).toEqual({});
});

test('assembles the original object, order and JSON types exactly', () => {
    const document = extensionDocument();
    const { containers, values } = buildSettingsFieldStructure(document);
    const directory = {
        containers,
        fields: [...values.keys()].map(path => ({ path, etag: `etag:${path}` })),
    };

    const rebuilt = assembleJsonFields(directory, values);

    expect(rebuilt).toEqual(document);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(document));
    expect(Object.keys(rebuilt.extension_settings.example)).toEqual(Object.keys(document.extension_settings.example));
    expect(Object.prototype.hasOwnProperty.call(rebuilt.extension_settings.example, '__proto__')).toBe(true);
});

test('does not refill a field missing from the current directory', () => {
    const document = extensionDocument();
    delete document.extension_settings.example.history;
    const { containers, values } = buildSettingsFieldStructure(document);
    const directory = {
        containers,
        fields: [...values.keys()].map(path => ({ path, etag: 'etag' })),
    };

    const rebuilt = assembleJsonFields(directory, values);

    expect(rebuilt.extension_settings.example).not.toHaveProperty('history');
    expect(Object.keys(rebuilt.extension_settings.example)).toEqual(['enabled', 'nullable', 'empty', 'a/b~c', '__proto__']);
});

test('decodes RFC 6901 pointers and rejects malformed escapes', () => {
    expect(decodeResourcePointer('')).toEqual([]);
    expect(decodeResourcePointer('/a~1b/~0c')).toEqual(['a/b', '~c']);
    expect(() => decodeResourcePointer('a/b')).toThrow('Invalid JSON Pointer');
    expect(() => decodeResourcePointer('/a~2b')).toThrow('Invalid JSON Pointer escape');
});
