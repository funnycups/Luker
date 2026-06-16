import { buildSidecarFilename, parseSidecarFilename } from '../../../src/storage/engines/sidecar-naming.js';

describe('sidecar-naming', () => {
    test('build composes base + namespace + extension', () => {
        expect(buildSidecarFilename('chat42', 'memory-graph')).toBe('chat42.luker-state.memory-graph.json');
    });
    test('parse extracts namespace given a known base', () => {
        expect(parseSidecarFilename('preset_foo.luker-state.search-tools.json', 'preset_foo'))
            .toBe('search-tools');
        expect(parseSidecarFilename('other.luker-state.x.json', 'preset_foo')).toBeNull();
        expect(parseSidecarFilename('preset_foo.json', 'preset_foo')).toBeNull();
    });
    test('parse handles namespace containing dots', () => {
        expect(parseSidecarFilename('chat.luker-state.a.b.c.json', 'chat')).toBe('a.b.c');
    });
});
