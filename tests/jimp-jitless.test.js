import { test, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JIMP_URL = pathToFileURL(resolve(REPO_ROOT, 'src/jimp.js')).href;
const PNG = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');

test('jimp decodes and re-encodes a PNG under --jitless', () => {
    const code = `
        const { Jimp } = await import(${JSON.stringify(JIMP_URL)});
        const fs = await import('node:fs');
        const img = await Jimp.read(fs.readFileSync(${JSON.stringify(PNG)}));
        const out = await img.getBuffer('image/png');
        console.log(JSON.stringify({ w: img.bitmap.width, h: img.bitmap.height, bytes: out.length }));
    `;
    const out = execFileSync(process.execPath, ['--jitless', '--input-type=module', '-e', code], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
    const r = JSON.parse(out.trim().split('\n').pop());
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
    expect(r.bytes).toBeGreaterThan(0);
});

test('jimp encodes and decodes a JPEG under --jitless', () => {
    const code = `
        const { Jimp } = await import(${JSON.stringify(JIMP_URL)});
        const fs = await import('node:fs');
        const img = await Jimp.read(fs.readFileSync(${JSON.stringify(PNG)}));
        const jpeg = await img.getBuffer('image/jpeg');
        const back = await Jimp.read(jpeg);
        console.log(JSON.stringify({ w: back.bitmap.width, h: back.bitmap.height, bytes: jpeg.length }));
    `;
    const out = execFileSync(process.execPath, ['--jitless', '--input-type=module', '-e', code], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
    const r = JSON.parse(out.trim().split('\n').pop());
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
    expect(r.bytes).toBeGreaterThan(0);
});
