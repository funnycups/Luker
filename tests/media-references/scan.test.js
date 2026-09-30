import path from 'node:path';
import { extractLocalMediaPaths, resolveUserImagePath } from '../../src/media-references.js';

describe('extractLocalMediaPaths', () => {
    test('finds paths in structured fields, img tags, and HTML comments', () => {
        const raw = [
            JSON.stringify({ mes: 'look', extra: { image: '/user/images/Ash/pic one.png' } }),
            JSON.stringify({ mes: '<img src="/user/images/Ash/marked.png" alt="AI generated image: x" data-prompt-id="1">' }),
            JSON.stringify({ mes: '<!-- auto-illustrator:promptId=9,imageUrl=/user/images/Ash/commented.png -->' }),
        ].join('\n');
        expect(new Set(extractLocalMediaPaths(raw))).toEqual(new Set([
            '/user/images/Ash/pic one.png',
            '/user/images/Ash/marked.png',
            '/user/images/Ash/commented.png',
        ]));
    });

    test('decodes URL-encoded paths and strips trailing markdown punctuation', () => {
        const raw = '![x](/user/images/%E8%8B%8F%E6%A0%BC/image%281%29.png) and /user/images/Ash/plain.png"';
        const paths = extractLocalMediaPaths(raw);
        expect(paths).toContain('/user/images/苏格/image(1).png'.replace(/\(1\)/, '(1)'));
        expect(paths).toContain('/user/images/Ash/plain.png');
        expect(paths.some(p => p.endsWith('.png)'))).toBe(false);
    });

    test('ignores external and data URIs', () => {
        const raw = 'https://cdn.example.com/user/images/x.png data:image/png;base64,AAAA /user/images/Ash/ok.png';
        expect(extractLocalMediaPaths(raw)).toEqual(['/user/images/Ash/ok.png']);
    });

    test('returns an empty array for empty input', () => {
        expect(extractLocalMediaPaths('')).toEqual([]);
        expect(extractLocalMediaPaths(null)).toEqual([]);
    });
});

describe('resolveUserImagePath', () => {
    const root = path.join(path.sep, 'data', 'default-user');

    test('resolves a valid client path under user/images', () => {
        expect(resolveUserImagePath(root, '/user/images/Ash/a.png'))
            .toBe(path.normalize(path.join(root, 'user', 'images', 'Ash', 'a.png')));
    });

    test('rejects traversal and foreign subtrees', () => {
        expect(resolveUserImagePath(root, '/user/images/../secrets.json')).toBeNull();
        expect(resolveUserImagePath(root, '/characters/Ash/a.png')).toBeNull();
        expect(resolveUserImagePath(root, 'user/images/Ash/a.png')).toBeNull();
        expect(resolveUserImagePath(root, 42)).toBeNull();
    });
});
