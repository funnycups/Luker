import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import fetch from 'node-fetch';

import {
    inspectReferenceSlots,
    applyReferencesToWorkflow,
} from '../public/scripts/extensions/stable-diffusion/reference/workflow.js';
import { uploadComfyReferences } from '../src/luker-dispatch/providers/sd/comfy.js';

const PNG_1X1_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeTwoSlotReferenceLatentWorkflow() {
    return {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux.safetensors' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'scene prompt', clip: ['1', 1] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'bad hands', clip: ['1', 1] } },
        '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
        '10': { class_type: 'LoadImage', inputs: { image: '%ref_image_1%' } },
        '11': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['1', 2] } },
        '12': { class_type: 'ReferenceLatent', inputs: { conditioning: ['2', 0], latent: ['11', 0] } },
        '20': { class_type: 'LoadImage', inputs: { image: '%ref_image_2%' } },
        '21': { class_type: 'VAEEncode', inputs: { pixels: ['20', 0], vae: ['1', 2] } },
        '22': { class_type: 'ReferenceLatent', inputs: { conditioning: ['12', 0], latent: ['21', 0] } },
        '30': {
            class_type: 'KSampler',
            inputs: {
                model: ['1', 0],
                positive: ['22', 0],
                negative: ['3', 0],
                latent_image: ['4', 0],
                seed: 42,
                steps: 20,
                cfg: 3.5,
                sampler_name: 'euler',
                scheduler: 'simple',
                denoise: 1,
            },
        },
        '31': { class_type: 'VAEDecode', inputs: { samples: ['30', 0], vae: ['1', 2] } },
        '32': { class_type: 'SaveImage', inputs: { images: ['31', 0], filename_prefix: 'Luker' } },
    };
}

describe('ComfyUI reference slot inspection, branch pruning, and /upload/image', () => {
    test('inspectReferenceSlots detects %ref_image% and %ref_image_N% and rejects duplicate slots', () => {
        const wf = makeTwoSlotReferenceLatentWorkflow();
        expect(inspectReferenceSlots(wf)).toMatchObject({
            slotCount: 2,
            slots: [1, 2],
        });
        expect(inspectReferenceSlots(JSON.stringify(wf))).toMatchObject({
            slotCount: 2,
            slots: [1, 2],
        });

        const singleWf = {
            '1': { class_type: 'LoadImage', inputs: { image: '%ref_image%' } },
        };
        expect(inspectReferenceSlots(singleWf)).toMatchObject({
            slotCount: 1,
            slots: [1],
        });

        const dupWf = {
            '1': { class_type: 'LoadImage', inputs: { image: '%ref_image%' } },
            '2': { class_type: 'LoadImage', inputs: { image: '%ref_image_1%' } },
        };
        expect(() => inspectReferenceSlots(dupWf)).toThrow(/duplicate/i);
    });

    test('applyReferencesToWorkflow substitutes 2, 1, and 0 references on ReferenceLatent chains cleanly', () => {
        const baseWf = makeTwoSlotReferenceLatentWorkflow();

        const withTwo = applyReferencesToWorkflow(baseWf, ['char_a.png', 'char_b.png']);
        expect(withTwo['10'].inputs.image).toBe('char_a.png');
        expect(withTwo['20'].inputs.image).toBe('char_b.png');
        expect(withTwo['30'].inputs.positive).toEqual(['22', 0]);

        const withOne = applyReferencesToWorkflow(baseWf, ['char_a.png']);
        expect(withOne['10'].inputs.image).toBe('char_a.png');
        expect(withOne['20']).toBeUndefined();
        expect(withOne['21']).toBeUndefined();
        expect(withOne['22']).toBeUndefined();
        expect(withOne['30'].inputs.positive).toEqual(['12', 0]);

        const withZero = applyReferencesToWorkflow(baseWf, []);
        expect(withZero['10']).toBeUndefined();
        expect(withZero['11']).toBeUndefined();
        expect(withZero['12']).toBeUndefined();
        expect(withZero['20']).toBeUndefined();
        expect(withZero['21']).toBeUndefined();
        expect(withZero['22']).toBeUndefined();
        expect(withZero['30'].inputs.positive).toEqual(['2', 0]);
    });

    test('applyReferencesToWorkflow rewires IPAdapter model trunk and ImageStitch single surviving image', () => {
        const ipAdapterWf = {
            '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
            '2': { class_type: 'LoadImage', inputs: { image: '%ref_image%' } },
            '3': { class_type: 'PrepImageForClipVision', inputs: { image: ['2', 0] } },
            '4': { class_type: 'IPAdapterAdvanced', inputs: { model: ['1', 0], image: ['3', 0], weight: 0.8 } },
            '5': { class_type: 'KSampler', inputs: { model: ['4', 0], latent_image: ['6', 0] } },
            '6': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
        };
        const ipPruned = applyReferencesToWorkflow(ipAdapterWf, []);
        expect(ipPruned['2']).toBeUndefined();
        expect(ipPruned['3']).toBeUndefined();
        expect(ipPruned['4']).toBeUndefined();
        expect(ipPruned['5'].inputs.model).toEqual(['1', 0]);

        const stitchWf = {
            '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux.safetensors' } },
            '2': { class_type: 'CLIPTextEncode', inputs: { text: 'hello', clip: ['1', 1] } },
            '10': { class_type: 'LoadImage', inputs: { image: '%ref_image_1%' } },
            '11': { class_type: 'LoadImage', inputs: { image: '%ref_image_2%' } },
            '12': { class_type: 'ImageStitch', inputs: { image1: ['10', 0], image2: ['11', 0], direction: 'right' } },
            '13': { class_type: 'VAEEncode', inputs: { pixels: ['12', 0], vae: ['1', 2] } },
            '14': { class_type: 'ReferenceLatent', inputs: { conditioning: ['2', 0], latent: ['13', 0] } },
            '15': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['14', 0], latent_image: ['16', 0] } },
            '16': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
        };
        const stitchOne = applyReferencesToWorkflow(stitchWf, ['only_one.png']);
        expect(stitchOne['10'].inputs.image).toBe('only_one.png');
        expect(stitchOne['11']).toBeUndefined();
        expect(stitchOne['12']).toBeUndefined();
        expect(stitchOne['13'].inputs.pixels).toEqual(['10', 0]);
        expect(stitchOne['15'].inputs.positive).toEqual(['14', 0]);
    });

    test('applyReferencesToWorkflow throws ref_template_required_slot_missing when sole latent source is omitted and ref_template_missing when no template exists', () => {
        const img2imgOnlyWf = {
            '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
            '2': { class_type: 'LoadImage', inputs: { image: '%ref_image%' } },
            '3': { class_type: 'VAEEncode', inputs: { pixels: ['2', 0], vae: ['1', 2] } },
            '4': { class_type: 'KSampler', inputs: { model: ['1', 0], latent_image: ['3', 0] } },
        };
        expect(() => applyReferencesToWorkflow(img2imgOnlyWf, [])).toThrow(
            expect.objectContaining({ code: 'ref_template_required_slot_missing' }),
        );

        const plainWf = {
            '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
        };
        expect(() => applyReferencesToWorkflow(plainWf, ['some_ref.png'])).toThrow(
            expect.objectContaining({ code: 'ref_template_missing' }),
        );
    });

    test('uploadComfyReferences posts managed files as multipart/form-data to ComfyUI /upload/image', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-comfy-ref-'));
        const directories = {
            root: tmpRoot,
            userImages: path.join(tmpRoot, 'user', 'images'),
            characters: path.join(tmpRoot, 'characters'),
            avatars: path.join(tmpRoot, 'User Avatars'),
        };
        fs.mkdirSync(path.join(directories.userImages, '_references'), { recursive: true });
        fs.writeFileSync(path.join(directories.userImages, '_references', 'ref_a.png'), Buffer.from(PNG_1X1_B64, 'base64'));
        fs.writeFileSync(path.join(directories.userImages, '_references', 'ref_b.png'), Buffer.from(PNG_1X1_B64, 'base64'));

        const uploads = [];
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                uploads.push({ url: req.url, headers: req.headers, raw });
                const idx = uploads.length;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    name: `uploaded_${idx}.png`,
                    subfolder: idx === 2 ? 'refs' : '',
                    type: 'input',
                }));
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const comfyUrl = `http://127.0.0.1:${server.address().port}`;

        try {
            const filenames = await uploadComfyReferences({
                directories,
                baseUrl: comfyUrl,
                references: [
                    { imagePath: '/user/images/_references/ref_a.png', role: 'character' },
                    { imagePath: '/user/images/_references/ref_b.png', role: 'style' },
                ],
                fetchFn: fetch,
            });
            expect(filenames).toEqual(['uploaded_1.png', 'refs/uploaded_2.png']);
            expect(uploads).toHaveLength(2);
            expect(uploads[0].url).toBe('/upload/image');
            expect(uploads[0].headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
            expect(uploads[0].raw).toContain('name="overwrite"');
            expect(uploads[0].raw).toContain('name="image"');
        } finally {
            await new Promise(resolve => server.close(resolve));
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });
});
