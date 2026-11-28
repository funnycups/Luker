import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import { router as cardAppRouter, extractCardAppFiles, packCardAppFiles, deleteCardAppFiles } from '../src/endpoints/card-app.js';

// Use a temp directory for tests
let tmpDir;
let cardAppsDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-app-test-'));
    cardAppsDir = path.join(tmpDir, 'card-apps');
    fs.mkdirSync(cardAppsDir, { recursive: true });
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('extractCardAppFiles', () => {
    test('should return false when no card_app data exists', () => {
        const charData = { data: { extensions: {} } };
        expect(extractCardAppFiles(charData, 'test-char', cardAppsDir)).toBe(false);
    });

    test('should return false when card_app has no files', () => {
        const charData = {
            data: {
                extensions: {
                    card_app: { enabled: true },
                },
            },
        };
        expect(extractCardAppFiles(charData, 'test-char', cardAppsDir)).toBe(false);
    });

    test('should return false when files object is empty', () => {
        const charData = {
            data: {
                extensions: {
                    card_app: { enabled: true, files: {} },
                },
            },
        };
        expect(extractCardAppFiles(charData, 'test-char', cardAppsDir)).toBe(false);
    });

    test('should extract text files to the correct directory', () => {
        const charData = {
            data: {
                extensions: {
                    card_app: {
                        enabled: true,
                        entry: 'index.js',
                        files: {
                            'index.js': 'export function init(ctx) { console.log("hello"); }',
                            'style.css': 'body { color: red; }',
                        },
                    },
                },
            },
        };

        const result = extractCardAppFiles(charData, 'test-char', cardAppsDir);
        expect(result).toBe(true);

        // Files should be written
        const indexPath = path.join(cardAppsDir, 'test-char', 'index.js');
        const stylePath = path.join(cardAppsDir, 'test-char', 'style.css');
        expect(fs.existsSync(indexPath)).toBe(true);
        expect(fs.existsSync(stylePath)).toBe(true);
        expect(fs.readFileSync(indexPath, 'utf8')).toBe('export function init(ctx) { console.log("hello"); }');
        expect(fs.readFileSync(stylePath, 'utf8')).toBe('body { color: red; }');

        // files should be removed from charData
        expect(charData.data.extensions.card_app.files).toBeUndefined();
        // But other card_app fields should remain
        expect(charData.data.extensions.card_app.enabled).toBe(true);
        expect(charData.data.extensions.card_app.entry).toBe('index.js');
    });

    test('should extract files with subdirectory paths', () => {
        const charData = {
            data: {
                extensions: {
                    card_app: {
                        enabled: true,
                        files: {
                            'components/battle.js': 'export class Battle {}',
                            'assets/bg.txt': 'background data',
                        },
                    },
                },
            },
        };

        const result = extractCardAppFiles(charData, 'my-char', cardAppsDir);
        expect(result).toBe(true);

        expect(fs.existsSync(path.join(cardAppsDir, 'my-char', 'components', 'battle.js'))).toBe(true);
        expect(fs.existsSync(path.join(cardAppsDir, 'my-char', 'assets', 'bg.txt'))).toBe(true);
    });

    test('should handle base64 data URL content', () => {
        const pngData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const charData = {
            data: {
                extensions: {
                    card_app: {
                        enabled: true,
                        files: {
                            'icon.png': `data:image/png;base64,${pngData}`,
                        },
                    },
                },
            },
        };

        const result = extractCardAppFiles(charData, 'test-char', cardAppsDir);
        expect(result).toBe(true);

        const iconPath = path.join(cardAppsDir, 'test-char', 'icon.png');
        expect(fs.existsSync(iconPath)).toBe(true);

        // Should be binary, not the data URL string
        const content = fs.readFileSync(iconPath);
        expect(Buffer.isBuffer(content)).toBe(true);
        expect(content.toString('base64')).toBe(pngData);
    });
});

describe('packCardAppFiles', () => {
    test('should return false when no card_app config exists', () => {
        const charData = { data: { extensions: {} } };
        expect(packCardAppFiles(charData, 'test-char', cardAppsDir)).toBe(false);
    });

    test('should return false when card_app is not enabled', () => {
        const charData = {
            data: {
                extensions: {
                    card_app: { enabled: false },
                },
            },
        };
        expect(packCardAppFiles(charData, 'test-char', cardAppsDir)).toBe(false);
    });

    test('should return false when no files directory exists', () => {
        const charData = {
            data: {
                extensions: {
                    card_app: { enabled: true },
                },
            },
        };
        expect(packCardAppFiles(charData, 'nonexistent', cardAppsDir)).toBe(false);
    });

    test('should pack text files as plain strings', () => {
        const charId = 'pack-test';
        const charDir = path.join(cardAppsDir, charId);
        fs.mkdirSync(charDir, { recursive: true });
        fs.writeFileSync(path.join(charDir, 'index.js'), 'console.log("hi")');
        fs.writeFileSync(path.join(charDir, 'style.css'), '.foo { color: blue; }');

        const charData = {
            data: {
                extensions: {
                    card_app: { enabled: true, entry: 'index.js' },
                },
            },
        };

        const result = packCardAppFiles(charData, charId, cardAppsDir);
        expect(result).toBe(true);
        expect(charData.data.extensions.card_app.files).toBeDefined();
        expect(charData.data.extensions.card_app.files['index.js']).toBe('console.log("hi")');
        expect(charData.data.extensions.card_app.files['style.css']).toBe('.foo { color: blue; }');
    });

    test('should pack binary files as data URLs', () => {
        const charId = 'pack-binary';
        const charDir = path.join(cardAppsDir, charId);
        fs.mkdirSync(charDir, { recursive: true });

        const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
        fs.writeFileSync(path.join(charDir, 'icon.png'), pngBuffer);

        const charData = {
            data: {
                extensions: {
                    card_app: { enabled: true },
                },
            },
        };

        const result = packCardAppFiles(charData, charId, cardAppsDir);
        expect(result).toBe(true);
        expect(charData.data.extensions.card_app.files['icon.png']).toMatch(/^data:image\/png;base64,/);
    });

    test('should pack files in subdirectories', () => {
        const charId = 'pack-subdir';
        const charDir = path.join(cardAppsDir, charId);
        fs.mkdirSync(path.join(charDir, 'components'), { recursive: true });
        fs.writeFileSync(path.join(charDir, 'index.js'), 'main');
        fs.writeFileSync(path.join(charDir, 'components', 'ui.js'), 'ui code');

        const charData = {
            data: {
                extensions: {
                    card_app: { enabled: true },
                },
            },
        };

        const result = packCardAppFiles(charData, charId, cardAppsDir);
        expect(result).toBe(true);
        expect(charData.data.extensions.card_app.files['index.js']).toBe('main');
        expect(charData.data.extensions.card_app.files['components/ui.js']).toBe('ui code');
    });

    test('extract then pack should roundtrip correctly', () => {
        const originalFiles = {
            'index.js': 'export function init() {}',
            'style.css': '.container { display: flex; }',
        };

        const charData = {
            data: {
                extensions: {
                    card_app: {
                        enabled: true,
                        entry: 'index.js',
                        files: { ...originalFiles },
                    },
                },
            },
        };

        // Extract
        extractCardAppFiles(charData, 'roundtrip', cardAppsDir);
        expect(charData.data.extensions.card_app.files).toBeUndefined();

        // Pack
        packCardAppFiles(charData, 'roundtrip', cardAppsDir);
        expect(charData.data.extensions.card_app.files).toEqual(originalFiles);
    });
});

describe('extractCardAppFiles - edge cases', () => {
    test('should handle null/undefined charData gracefully', () => {
        expect(extractCardAppFiles(null, 'test', cardAppsDir)).toBe(false);
        expect(extractCardAppFiles(undefined, 'test', cardAppsDir)).toBe(false);
        expect(extractCardAppFiles({}, 'test', cardAppsDir)).toBe(false);
    });

    test('should skip files with path traversal attempts', () => {
        const charData = {
            data: {
                extensions: {
                    card_app: {
                        enabled: true,
                        files: {
                            '../outside/passwd': 'malicious content',
                            'safe.js': 'safe content',
                        },
                    },
                },
            },
        };

        const result = extractCardAppFiles(charData, 'traversal-test', cardAppsDir);
        expect(result).toBe(true);

        // Safe file should exist
        expect(fs.existsSync(path.join(cardAppsDir, 'traversal-test', 'safe.js'))).toBe(true);

        // Malicious path should NOT have created files outside the char directory
        expect(fs.existsSync(path.join(cardAppsDir, 'outside', 'passwd'))).toBe(false);
    });

    test('should handle non-string file content gracefully', () => {
        const charData = {
            data: {
                extensions: {
                    card_app: {
                        enabled: true,
                        files: {
                            'number.js': 12345,
                            'null.js': null,
                            'valid.js': 'valid content',
                        },
                    },
                },
            },
        };

        // Should not throw
        const result = extractCardAppFiles(charData, 'type-test', cardAppsDir);
        expect(result).toBe(true);

        // Valid file should exist
        expect(fs.existsSync(path.join(cardAppsDir, 'type-test', 'valid.js'))).toBe(true);
    });

    test('should skip .git directory, .git pointer file, case/dot/space variants, and sanitize-mangled .git paths', () => {
        const charData = {
            data: {
                extensions: {
                    card_app: {
                        enabled: true,
                        files: {
                            '.git/config': '[core]\n\tfsmonitor = evil\n',
                            '.git': 'gitdir: /tmp/evil\n',
                            'nested/.git/HEAD': 'ref: refs/heads/main\n',
                            '.GIT/config': 'upper',
                            '.git./config': 'trailing-dot',
                            '.git /config': 'trailing-space',
                            '.g:it/config': 'colon-mangled',
                            '.g*it/config': 'star-mangled',
                            '.g?it/config': 'qmark-mangled',
                            '.gitignore': 'node_modules\n',
                            '.github/info.txt': 'ok',
                            'safe.js': 'export const ok = true;',
                        },
                    },
                },
            },
        };

        const result = extractCardAppFiles(charData, 'git-filter-test', cardAppsDir);
        expect(result).toBe(true);

        const charDir = path.join(cardAppsDir, 'git-filter-test');
        expect(fs.existsSync(path.join(charDir, 'safe.js'))).toBe(true);
        expect(fs.existsSync(path.join(charDir, '.gitignore'))).toBe(true);
        expect(fs.existsSync(path.join(charDir, '.github', 'info.txt'))).toBe(true);

        const entries = fs.readdirSync(charDir);
        expect(entries.some(name => /^\.git[. ]*$/i.test(name))).toBe(false);
        expect(fs.existsSync(path.join(charDir, 'nested', '.git'))).toBe(false);
    });
});

describe('card-app HTTP routes security', () => {
    function buildApp() {
        const app = express();
        app.use((req, _res, next) => {
            req.user = {
                profile: { handle: 'alice', admin: false },
                directories: { cardApps: cardAppsDir },
            };
            next();
        });
        app.use('/api/card-app', cardAppRouter);
        return app;
    }

    test('rejects reading, writing, deleting, renaming, and creating .git paths with 400', async () => {
        const app = buildApp();
        const charId = 'sec-char';

        const putOk = await request(app)
            .put(`/api/card-app/${charId}/index.js`)
            .send({ content: 'export const v = 1;\n' });
        expect(putOk.status).toBe(200);

        const hist = await request(app).get(`/api/card-app/${charId}/history`);
        expect(hist.status).toBe(200);

        const gitConfigPath = path.join(cardAppsDir, charId, '.git', 'config');
        const originalConfig = fs.readFileSync(gitConfigPath, 'utf8');

        const blockedPaths = [
            '.git/config',
            '.git/HEAD',
            '.git',
            '.GIT/config',
            '.git./config',
            'sub/.git/config',
            'a/../.git/config',
        ];

        for (const badPath of blockedPaths) {
            const encoded = badPath.split('/').map(encodeURIComponent).join('/');
            const getRes = await request(app).get(`/api/card-app/${charId}/${encoded}`);
            expect(getRes.status).toBe(400);

            const putRes = await request(app)
                .put(`/api/card-app/${charId}/${encoded}`)
                .send({ content: '[core]\n\tfsmonitor = evil\n' });
            expect(putRes.status).toBe(400);

            const delRes = await request(app).delete(`/api/card-app/${charId}/${encoded}`);
            expect(delRes.status).toBe(400);

            const mkdirRes = await request(app)
                .post(`/api/card-app/${charId}/mkdir`)
                .send({ path: badPath });
            expect(mkdirRes.status).toBe(400);

            const renameFromRes = await request(app)
                .post(`/api/card-app/${charId}/rename`)
                .send({ from: badPath, to: 'escaped.txt' });
            expect(renameFromRes.status).toBe(400);

            const renameToRes = await request(app)
                .post(`/api/card-app/${charId}/rename`)
                .send({ from: 'index.js', to: badPath });
            expect(renameToRes.status).toBe(400);
        }

        // Deleting charDir root itself ('.') must also be rejected.
        const delRootRes = await request(app).delete(`/api/card-app/${charId}/.`);
        expect(delRootRes.status).toBe(400);

        expect(fs.readFileSync(gitConfigPath, 'utf8')).toBe(originalConfig);
        expect(fs.existsSync(path.join(cardAppsDir, charId, 'index.js'))).toBe(true);
    });

    test('rejects option-like or non-hex commit hashes on diff and rollback with 400', async () => {
        const app = buildApp();
        const charId = 'hash-char';

        await request(app).put(`/api/card-app/${charId}/index.js`).send({ content: 'v1\n' });
        const hist1 = await request(app).get(`/api/card-app/${charId}/history`);
        expect(hist1.status).toBe(200);
        const validHash = hist1.body.commits[0].fullHash;

        for (const badHash of ['--stat', '--output=pwn.txt', '-q', 'HEAD', 'abc', 'zzzz1234']) {
            const diffRes = await request(app).get(`/api/card-app/${charId}/diff/${encodeURIComponent(badHash)}`);
            expect(diffRes.status).toBe(400);

            const rollbackRes = await request(app)
                .post(`/api/card-app/${charId}/rollback`)
                .send({ hash: badHash });
            expect(rollbackRes.status).toBe(400);
        }

        expect(fs.existsSync(path.join(cardAppsDir, charId, 'pwn.txt'))).toBe(false);

        const validDiff = await request(app).get(`/api/card-app/${charId}/diff/${validHash}`);
        expect(validDiff.status).toBe(200);
        const validRollback = await request(app)
            .post(`/api/card-app/${charId}/rollback`)
            .send({ hash: validHash });
        expect(validRollback.status).toBe(200);
    });

    test('honors git.backend=builtin configuration for history and diff', async () => {
        const prevBackend = process.env.LUKER_GIT_BACKEND;
        process.env.LUKER_GIT_BACKEND = 'builtin';
        try {
            const app = buildApp();
            const charId = 'builtin-char';

            const putRes = await request(app)
                .put(`/api/card-app/${charId}/index.js`)
                .send({ content: 'export const n = 1;\n' });
            expect(putRes.status).toBe(200);

            const hist = await request(app).get(`/api/card-app/${charId}/history`);
            expect(hist.status).toBe(200);
            expect(hist.body.commits).toHaveLength(1);

            // Builtin diff returns '(initial commit)' for root commit, proving
            // the builtin IsomorphicGitClient handled the request instead of system git.
            const diffRes = await request(app).get(`/api/card-app/${charId}/diff/${hist.body.commits[0].fullHash}`);
            expect(diffRes.status).toBe(200);
            expect(diffRes.body.diff).toBe('(initial commit)');
        } finally {
            if (prevBackend === undefined) {
                delete process.env.LUKER_GIT_BACKEND;
            } else {
                process.env.LUKER_GIT_BACKEND = prevBackend;
            }
        }
    });
});

describe('deleteCardAppFiles', () => {
    test('should delete the character card-app directory', () => {
        const charId = 'delete-test';
        const charDir = path.join(cardAppsDir, charId);
        fs.mkdirSync(charDir, { recursive: true });
        fs.writeFileSync(path.join(charDir, 'index.js'), 'test');

        expect(fs.existsSync(charDir)).toBe(true);
        deleteCardAppFiles(charId, cardAppsDir);
        expect(fs.existsSync(charDir)).toBe(false);
    });

    test('should not throw when directory does not exist', () => {
        expect(() => deleteCardAppFiles('nonexistent', cardAppsDir)).not.toThrow();
    });
});
