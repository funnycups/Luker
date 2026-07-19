import { makeFixtureUser } from './_fixture-helper.js';
import {
    enumerateCategory,
} from '../../src/storage/inspector.js';

describe('enumerateCategory("other") · L2', () => {
    test('rich fixture returns groups + card-apps + thumbnails + secrets(sensitive)+ files', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ otherRich: true });
        try {
            const res = await enumerateCategory(userRoot, 'other');
            expect(res.path).toEqual(['other']);
            expect(res.isLeaf).toBe(true);
            const keys = res.entries.map(e => e.key);
            expect(keys).toContain('groups');
            expect(keys).toContain('card-apps');
            expect(keys).toContain('thumbnails');
            expect(keys).toContain('secrets.json');
            expect(keys).toContain('stats.json');

            const secrets = res.entries.find(e => e.key === 'secrets.json');
            expect(secrets.kind).toBe('sensitive-blob');
            expect(secrets.canDrill).toBe(false);
            expect(secrets.icon).toBe('lock');
            expect(secrets.note).toBeTruthy();
            expect(secrets.sizeBytes).toBeGreaterThan(0);

            // 排序:sizeBytes desc(secrets 相对小 · thumbnails 目录较大)
            for (let i = 0; i < res.entries.length - 1; i++) {
                expect(res.entries[i].sizeBytes).toBeGreaterThanOrEqual(res.entries[i + 1].sizeBytes);
            }
        } finally {
            await cleanup();
        }
    });

    test('empty user still shows secrets.json placeholder(sensitive always emitted)', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({});
        try {
            const res = await enumerateCategory(userRoot, 'other');
            // 敏感文件始终显示(size 可为 0)· 其它均跳过
            expect(res.entries).toHaveLength(1);
            expect(res.entries[0].key).toBe('secrets.json');
            expect(res.entries[0].kind).toBe('sensitive-blob');
            expect(res.entries[0].sizeBytes).toBe(0);
            expect(res.isLeaf).toBe(true);
        } finally {
            await cleanup();
        }
    });
});
