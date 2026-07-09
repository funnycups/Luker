import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import fetch from 'node-fetch';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import urlJoin from 'url-join';
import mime from 'mime-types';

import { delay, getBasicAuthHeader, isValidUrl, tryParse } from '../util.js';
import { readSecret, SECRET_KEYS } from './secrets.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { AIMLAPI_HEADERS } from '../constants.js';
import { startImageInspection, completeImageInspection, failImageInspection, abortInspection, extractImageMeta, attachInspectionEndpoint } from '../request-inspector.js';
import { runLukerDispatch } from '../luker-dispatch/runner.js';
import { dispatchSdWebui } from '../luker-dispatch/providers/sd/webui.js';
import { dispatchSdComfy } from '../luker-dispatch/providers/sd/comfy.js';
import { dispatchSdTogether } from '../luker-dispatch/providers/sd/together.js';
import { dispatchSdDrawthings } from '../luker-dispatch/providers/sd/drawthings.js';
import { dispatchSdPollinations } from '../luker-dispatch/providers/sd/pollinations.js';
import { dispatchSdStability } from '../luker-dispatch/providers/sd/stability.js';
import { dispatchSdComfyRunPod } from '../luker-dispatch/providers/sd/comfyrunpod.js';
import { dispatchSdCpp } from '../luker-dispatch/providers/sd/sdcpp.js';
import { dispatchSdHuggingface } from '../luker-dispatch/providers/sd/huggingface.js';
import { dispatchSdElectronHub } from '../luker-dispatch/providers/sd/electronhub.js';
import { dispatchSdChutes } from '../luker-dispatch/providers/sd/chutes.js';
import { dispatchSdNanoGpt } from '../luker-dispatch/providers/sd/nanogpt.js';
import { dispatchSdBfl } from '../luker-dispatch/providers/sd/bfl.js';
import { dispatchSdFalai } from '../luker-dispatch/providers/sd/falai.js';
import { dispatchSdXai } from '../luker-dispatch/providers/sd/xai.js';
import { dispatchSdAimlapi } from '../luker-dispatch/providers/sd/aimlapi.js';
import { dispatchSdZai } from '../luker-dispatch/providers/sd/zai.js';
import { dispatchSdWorkersai } from '../luker-dispatch/providers/sd/workersai.js';

/**
 * Gets the comfy workflows.
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {string[]} List of comfy workflows
 */
function getComfyWorkflows(directories) {
    return fs
        .readdirSync(directories.comfyWorkflows)
        .filter(file => file[0] !== '.' && file.toLowerCase().endsWith('.json'))
        .sort(Intl.Collator().compare);
}

export const router = express.Router();

router.post('/ping', async (request, response) => {
    try {
        const url = new URL(request.body.url);
        url.pathname = '/sdapi/v1/options';

        const result = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': getBasicAuthHeader(request.body.auth),
            },
        });

        if (!result.ok) {
            throw new Error('SD WebUI returned an error.');
        }

        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/upscalers', async (request, response) => {
    try {
        async function getUpscalerModels() {
            const url = new URL(request.body.url);
            url.pathname = '/sdapi/v1/upscalers';

            const result = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': getBasicAuthHeader(request.body.auth),
                },
            });

            if (!result.ok) {
                throw new Error('SD WebUI returned an error.');
            }

            /** @type {any} */
            const data = await result.json();
            return data.map(x => x.name);
        }

        async function getLatentUpscalers() {
            const url = new URL(request.body.url);
            url.pathname = '/sdapi/v1/latent-upscale-modes';

            const result = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': getBasicAuthHeader(request.body.auth),
                },
            });

            if (!result.ok) {
                throw new Error('SD WebUI returned an error.');
            }

            /** @type {any} */
            const data = await result.json();
            return data.map(x => x.name);
        }

        const [upscalers, latentUpscalers] = await Promise.all([getUpscalerModels(), getLatentUpscalers()]);

        // 0 = None, then Latent Upscalers, then Upscalers
        upscalers.splice(1, 0, ...latentUpscalers);

        return response.send(upscalers);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/vaes', async (request, response) => {
    try {
        const autoUrl = new URL(request.body.url);
        autoUrl.pathname = '/sdapi/v1/sd-vae';
        const forgeUrl = new URL(request.body.url);
        forgeUrl.pathname = '/sdapi/v1/sd-modules';

        const requestInit = {
            method: 'GET',
            headers: {
                'Authorization': getBasicAuthHeader(request.body.auth),
            },
        };
        const results = await Promise.allSettled([
            fetch(autoUrl, requestInit).then(r => r.ok ? r.json() : Promise.reject(r.statusText)),
            fetch(forgeUrl, requestInit).then(r => r.ok ? r.json() : Promise.reject(r.statusText)),
        ]);

        const data = results.find(r => r.status === 'fulfilled')?.value;

        if (!Array.isArray(data)) {
            throw new Error('SD WebUI returned an error.');
        }

        const names = data.map(x => x.model_name);
        return response.send(names);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/samplers', async (request, response) => {
    try {
        const url = new URL(request.body.url);
        url.pathname = '/sdapi/v1/samplers';

        const result = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': getBasicAuthHeader(request.body.auth),
            },
        });

        if (!result.ok) {
            throw new Error('SD WebUI returned an error.');
        }

        /** @type {any} */
        const data = await result.json();
        const names = data.map(x => x.name);
        return response.send(names);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/schedulers', async (request, response) => {
    try {
        const url = new URL(request.body.url);
        url.pathname = '/sdapi/v1/schedulers';

        const result = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': getBasicAuthHeader(request.body.auth),
            },
        });

        if (!result.ok) {
            throw new Error('SD WebUI returned an error.');
        }

        /** @type {any} */
        const data = await result.json();
        const names = data.map(x => x.name);
        return response.send(names);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/models', async (request, response) => {
    try {
        const url = new URL(request.body.url);
        url.pathname = '/sdapi/v1/sd-models';

        const result = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': getBasicAuthHeader(request.body.auth),
            },
        });

        if (!result.ok) {
            throw new Error('SD WebUI returned an error.');
        }

        /** @type {any} */
        const data = await result.json();
        const models = data.map(x => ({ value: x.title, text: x.title }));
        return response.send(models);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/get-model', async (request, response) => {
    try {
        const url = new URL(request.body.url);
        url.pathname = '/sdapi/v1/options';

        const result = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': getBasicAuthHeader(request.body.auth),
            },
        });
        /** @type {any} */
        const data = await result.json();
        return response.send(data.sd_model_checkpoint);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/set-model', async (request, response) => {
    try {
        async function getProgress() {
            const url = new URL(request.body.url);
            url.pathname = '/sdapi/v1/progress';

            const result = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': getBasicAuthHeader(request.body.auth),
                },
            });
            return await result.json();
        }

        const url = new URL(request.body.url);
        url.pathname = '/sdapi/v1/options';

        const options = {
            sd_model_checkpoint: request.body.model,
        };

        const result = await fetch(url, {
            method: 'POST',
            body: JSON.stringify(options),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': getBasicAuthHeader(request.body.auth),
            },
        });

        if (!result.ok) {
            throw new Error('SD WebUI returned an error.');
        }

        const MAX_ATTEMPTS = 10;
        const CHECK_INTERVAL = 2000;

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            /** @type {any} */
            const progressState = await getProgress();

            const progress = progressState.progress;
            const jobCount = progressState.state.job_count;
            if (progress === 0.0 && jobCount === 0) {
                break;
            }

            console.info(`Waiting for SD WebUI to finish model loading... Progress: ${progress}; Job count: ${jobCount}`);
            await delay(CHECK_INTERVAL);
        }

        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/webui',
    select: () => dispatchSdWebui,
}));

router.post('/sd-next/upscalers', async (request, response) => {
    try {
        const url = new URL(request.body.url);
        url.pathname = '/sdapi/v1/upscalers';

        const result = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': getBasicAuthHeader(request.body.auth),
            },
        });

        if (!result.ok) {
            throw new Error('SD WebUI returned an error.');
        }

        // Vlad doesn't provide Latent Upscalers in the API, so we have to hardcode them here
        const latentUpscalers = ['Latent', 'Latent (antialiased)', 'Latent (bicubic)', 'Latent (bicubic antialiased)', 'Latent (nearest)', 'Latent (nearest-exact)'];

        /** @type {any} */
        const data = await result.json();
        const names = data.map(x => x.name);

        // 0 = None, then Latent Upscalers, then Upscalers
        names.splice(1, 0, ...latentUpscalers);

        return response.send(names);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

const comfy = express.Router();

comfy.post('/ping', async (request, response) => {
    try {
        const url = new URL(urlJoin(request.body.url, '/system_stats'));

        const result = await fetch(url);
        if (!result.ok) {
            throw new Error('ComfyUI returned an error.');
        }

        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

comfy.post('/samplers', async (request, response) => {
    try {
        const url = new URL(urlJoin(request.body.url, '/object_info'));

        const result = await fetch(url);
        if (!result.ok) {
            throw new Error('ComfyUI returned an error.');
        }

        /** @type {any} */
        const data = await result.json();
        return response.send(data.KSampler.input.required.sampler_name[0]);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

comfy.post('/models', async (request, response) => {
    try {
        const url = new URL(urlJoin(request.body.url, '/object_info'));

        const result = await fetch(url);
        if (!result.ok) {
            throw new Error('ComfyUI returned an error.');
        }
        /** @type {any} */
        const data = await result.json();

        const ckpts = data.CheckpointLoaderSimple.input.required.ckpt_name[0].map(it => ({ value: it, text: it })) || [];
        const unets = data.UNETLoader.input.required.unet_name[0].map(it => ({ value: it, text: `UNet: ${it}` })) || [];

        // load list of GGUF unets from diffusion_models if the loader node is available
        const ggufs = data.UnetLoaderGGUF?.input.required.unet_name[0].map(it => ({ value: it, text: `GGUF: ${it}` })) || [];
        const models = [...ckpts, ...unets, ...ggufs];

        // make the display names of the models somewhat presentable
        models.forEach(it => it.text = it.text.replace(/\.[^.]*$/, '').replace(/_/g, ' '));

        return response.send(models);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

comfy.post('/schedulers', async (request, response) => {
    try {
        const url = new URL(urlJoin(request.body.url, '/object_info'));

        const result = await fetch(url);
        if (!result.ok) {
            throw new Error('ComfyUI returned an error.');
        }

        /** @type {any} */
        const data = await result.json();
        return response.send(data.KSampler.input.required.scheduler[0]);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

comfy.post('/vaes', async (request, response) => {
    try {
        const url = new URL(urlJoin(request.body.url, '/object_info'));

        const result = await fetch(url);
        if (!result.ok) {
            throw new Error('ComfyUI returned an error.');
        }

        /** @type {any} */
        const data = await result.json();
        return response.send(data.VAELoader.input.required.vae_name[0]);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

comfy.post('/workflows', async (request, response) => {
    try {
        const data = getComfyWorkflows(request.user.directories);
        return response.send(data);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

comfy.post('/workflow', async (request, response) => {
    try {
        let filePath = path.join(request.user.directories.comfyWorkflows, sanitize(String(request.body.file_name)));
        if (!fs.existsSync(filePath)) {
            filePath = path.join(request.user.directories.comfyWorkflows, 'Default_Comfy_Workflow.json');
        }
        const data = fs.readFileSync(filePath, { encoding: 'utf-8' });
        return response.send(JSON.stringify(data));
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

comfy.post('/save-workflow', async (request, response) => {
    try {
        const filePath = path.join(request.user.directories.comfyWorkflows, sanitize(String(request.body.file_name)));
        writeFileAtomicSync(filePath, request.body.workflow, 'utf8');
        const data = getComfyWorkflows(request.user.directories);
        return response.send(data);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

comfy.post('/delete-workflow', async (request, response) => {
    try {
        const filePath = path.join(request.user.directories.comfyWorkflows, sanitize(String(request.body.file_name)));
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

comfy.post('/rename-workflow', getFileNameValidationFunction('old_name'), getFileNameValidationFunction('new_name'), async (request, response) => {

    try {
        const oldName = sanitize(String(request.body.old_name));
        const newName = sanitize(String(request.body.new_name));

        if (path.extname(oldName).toLowerCase() !== '.json' || path.extname(newName).toLowerCase() !== '.json') {
            return response.status(400).send('Only JSON workflow files are allowed');
        }

        const oldPath = path.join(request.user.directories.comfyWorkflows, oldName);
        const newPath = path.join(request.user.directories.comfyWorkflows, newName);

        if (!fs.existsSync(oldPath)) {
            return response.status(404).send('Workflow not found');
        }

        if (fs.existsSync(newPath)) {
            return response.status(409).send('A workflow with that name already exists');
        }

        fs.renameSync(oldPath, newPath);
        return response.sendStatus(204);
    } catch (error) {
        console.error('ComfyUI workflow rename failed', error);
        return response.sendStatus(500);
    }
});

comfy.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/comfy',
    select: () => dispatchSdComfy,
}));

const comfyRunPod = express.Router();

comfyRunPod.post('/ping', async (request, response) => {
    try {
        const key = readSecret(request.user.directories, SECRET_KEYS.COMFY_RUNPOD);

        if (!key) {
            console.warn('RunPod key not found.');
            return response.sendStatus(400);
        }

        const url = new URL(urlJoin(request.body.url, '/health'));

        const result = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${key}` },
        });
        if (!result.ok) {
            throw new Error('ComfyUI returned an error.');
        }
        /** @type {any} */
        const data = await result.json();
        if (data.workers.ready <= 0) {
            console.warn(`No workers reported as ready. ${result}`);
        }

        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

comfyRunPod.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/comfyrunpod',
    select: () => dispatchSdComfyRunPod,
}));

const together = express.Router();

together.post('/models', async (request, response) => {
    try {
        const key = readSecret(request.user.directories, SECRET_KEYS.TOGETHERAI);

        if (!key) {
            console.warn('TogetherAI key not found.');
            return response.sendStatus(400);
        }

        const modelsResponse = await fetch('https://api.together.xyz/api/models', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!modelsResponse.ok) {
            console.warn('TogetherAI returned an error.');
            return response.sendStatus(500);
        }

        const data = await modelsResponse.json();

        if (!Array.isArray(data)) {
            console.warn('TogetherAI returned invalid data.');
            return response.sendStatus(500);
        }

        const models = data
            .filter(x => x.type === 'image')
            .map(x => ({ value: x.id, text: x.display_name }));

        return response.send(models);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

together.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/together',
    select: () => dispatchSdTogether,
}));

const sdcpp = express.Router();

sdcpp.post('/ping', async (request, response) => {
    try {
        const url = new URL(urlJoin(request.body.url, '/v1/images/generations'));

        const result = await fetch(url, { method: 'OPTIONS' });
        if (!result.ok) {
            throw new Error('stable-diffusion.cpp server returned an error.');
        }

        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

sdcpp.post('/models', async (request, response) => {
    try {
        const url = new URL(urlJoin(request.body.url, '/v1/models'));

        const result = await fetch(url);
        if (!result.ok) {
            throw new Error('stable-diffusion.cpp server returned an error.');
        }

        const data = await result.json();
        return response.send(data);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

sdcpp.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/sdcpp',
    select: () => dispatchSdCpp,
}));

const drawthings = express.Router();

drawthings.post('/ping', async (request, response) => {
    try {
        const url = new URL(request.body.url);
        url.pathname = '/';

        const result = await fetch(url, {
            method: 'HEAD',
        });

        if (!result.ok) {
            throw new Error('SD DrawThings API returned an error.');
        }

        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

drawthings.post('/get-model', async (request, response) => {
    try {
        const url = new URL(request.body.url);
        url.pathname = '/';

        const result = await fetch(url, {
            method: 'GET',
        });

        /** @type {any} */
        const data = await result.json();

        return response.send(data.model);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

drawthings.post('/get-upscaler', async (request, response) => {
    try {
        const url = new URL(request.body.url);
        url.pathname = '/';

        const result = await fetch(url, {
            method: 'GET',
        });

        /** @type {any} */
        const data = await result.json();

        return response.send(data.upscaler);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

drawthings.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/drawthings',
    select: () => dispatchSdDrawthings,
}));

const pollinations = express.Router();

pollinations.post('/models', async (_request, response) => {
    try {
        const modelsUrl = new URL('https://gen.pollinations.ai/image/models');
        const result = await fetch(modelsUrl);

        if (!result.ok) {
            console.warn('Pollinations returned an error.', result.status, result.statusText);
            throw new Error('Pollinations request failed.');
        }

        const data = await result.json();

        if (!Array.isArray(data)) {
            console.warn('Pollinations returned invalid data.');
            throw new Error('Pollinations request failed.');
        }

        const models = data.map(x => ({ value: x.name, text: x.name }));
        return response.send(models);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

pollinations.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/pollinations',
    select: () => dispatchSdPollinations,
}));

const stability = express.Router();

stability.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/stability',
    select: () => dispatchSdStability,
}));

const huggingface = express.Router();

huggingface.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/huggingface',
    select: () => dispatchSdHuggingface,
}));

const electronhub = express.Router();

electronhub.post('/models', async (request, response) => {
    try {
        const key = readSecret(request.user.directories, SECRET_KEYS.ELECTRONHUB);

        if (!key) {
            console.warn('Electron Hub key not found.');
            return response.sendStatus(400);
        }

        const modelsResponse = await fetch('https://api.electronhub.ai/v1/models', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
        });

        if (!modelsResponse.ok) {
            console.warn('Electron Hub returned an error.');
            return response.sendStatus(500);
        }

        /** @type {any} */
        const data = await modelsResponse.json();

        if (!Array.isArray(data?.data)) {
            console.warn('Electron Hub returned invalid data.');
            return response.sendStatus(500);
        }

        const models = data.data
            .filter(x => x && Array.isArray(x.endpoints) && x.endpoints.includes('/v1/images/generations'))
            .map(x => ({ ...x, value: x.id, text: x.name }));
        return response.send(models);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

electronhub.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/electronhub',
    select: () => dispatchSdElectronHub,
}));

electronhub.post('/sizes', async (request, response) => {
    const result = await fetch(`https://api.electronhub.ai/v1/models/${request.body.model}`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
        },
    });

    if (!result.ok) {
        console.warn('Electron Hub returned an error.');
        return response.sendStatus(500);
    }

    /** @type {any} */
    const data = await result.json();

    const sizes = data.sizes;

    if (!sizes) {
        console.warn('Electron Hub returned invalid data.');
        return response.sendStatus(500);
    }

    return response.send({ sizes });
});

const chutes = express.Router();

chutes.post('/models', async (request, response) => {
    try {
        const key = readSecret(request.user.directories, SECRET_KEYS.CHUTES);

        if (!key) {
            console.warn('Chutes key not found.');
            return response.sendStatus(400);
        }

        const modelsResponse = await fetch('https://api.chutes.ai/chutes/?template=diffusion&include_public=true&limit=999', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
        });

        if (!modelsResponse.ok) {
            console.warn('Chutes returned an error.');
            return response.sendStatus(500);
        }

        const data = await modelsResponse.json();

        const chutesData = /** @type {{items: Array<{name: string}>}} */ (data);
        const models = chutesData.items.map(x => ({ value: x.name, text: x.name })).sort((a, b) => a?.text?.localeCompare(b?.text));
        return response.send(models);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

chutes.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/chutes',
    select: () => dispatchSdChutes,
}));

const nanogpt = express.Router();

nanogpt.post('/models', async (request, response) => {
    try {
        const key = readSecret(request.user.directories, SECRET_KEYS.NANOGPT);

        if (!key) {
            console.warn('NanoGPT key not found.');
            return response.sendStatus(400);
        }

        const modelsResponse = await fetch('https://nano-gpt.com/api/models', {
            method: 'GET',
            headers: {
                'x-api-key': key,
                'Content-Type': 'application/json',
            },
        });

        if (!modelsResponse.ok) {
            console.warn('NanoGPT returned an error.');
            return response.sendStatus(500);
        }

        /** @type {any} */
        const data = await modelsResponse.json();
        const imageModels = data?.models?.image;

        if (!imageModels || typeof imageModels !== 'object') {
            console.warn('NanoGPT returned invalid data.');
            return response.sendStatus(500);
        }

        const models = Object.values(imageModels).map(x => ({ value: x.model, text: x.name }));
        return response.send(models);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

nanogpt.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/nanogpt',
    select: () => dispatchSdNanoGpt,
}));

const bfl = express.Router();

bfl.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/bfl',
    select: () => dispatchSdBfl,
}));

const falai = express.Router();

falai.post('/models', async (_request, response) => {
    try {
        const modelsUrl = new URL('https://fal.ai/api/models?categories=text-to-image');
        let page = 1;
        /** @type {any} */
        let modelsResponse;
        let models = [];

        do {
            modelsUrl.searchParams.set('page', page.toString());
            const result = await fetch(modelsUrl);

            if (!result.ok) {
                console.warn('FAL.AI returned an error.', result.status, result.statusText);
                throw new Error('FAL.AI request failed.');
            }

            modelsResponse = await result.json();
            if (!('items' in modelsResponse) || !Array.isArray(modelsResponse.items)) {
                console.warn('FAL.AI returned invalid data.');
                throw new Error('FAL.AI request failed.');
            }

            models = models.concat(
                modelsResponse.items.filter(
                    x => (
                        !x.title.toLowerCase().includes('inpainting') &&
                        !x.title.toLowerCase().includes('control') &&
                        !x.title.toLowerCase().includes('upscale') &&
                        !x.title.toLowerCase().includes('lora')
                    ),
                ),
            );

            page = modelsResponse.page + 1;
        } while (modelsResponse != null && page < modelsResponse.pages);

        const modelOptions = models
            .sort((a, b) => a.title.localeCompare(b.title))
            .map(x => ({ value: x.modelUrl.split('fal-ai/')[1], text: x.title }))
            .map(x => ({ ...x, text: `${x.text} (${x.value})` }));
        return response.send(modelOptions);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

falai.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/falai',
    select: () => dispatchSdFalai,
}));

const xai = express.Router();

xai.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/xai',
    select: () => dispatchSdXai,
}));

const aimlapi = express.Router();

aimlapi.post('/models', async (request, response) => {
    try {
        const key = readSecret(request.user.directories, SECRET_KEYS.AIMLAPI);

        if (!key) {
            console.warn('AI/ML API key not found.');
            return response.sendStatus(400);
        }

        const modelsResponse = await fetch('https://api.aimlapi.com/v1/models', {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${key}`,
            },
        });

        if (!modelsResponse.ok) {
            console.warn('AI/ML API returned an error.');
            return response.sendStatus(500);
        }

        /** @type {any} */
        const data = await modelsResponse.json();
        const models = (data.data || [])
            .filter(model =>
                model.type === 'image' &&
                model.id !== 'triposr' &&
                model.id !== 'flux/dev/image-to-image',
            )
            .map(model => ({
                value: model.id,
                text: model.info?.name || model.id,
            }));

        return response.send({ data: models });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

aimlapi.post('/generate-image', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/aimlapi',
    select: () => dispatchSdAimlapi,
}));

const zai = express.Router();

zai.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/zai',
    select: () => dispatchSdZai,
}));

zai.post('/generate-video', async (request, response) => {
    try {
        const controller = new AbortController();
        request.socket.removeAllListeners('close');
        request.socket.on('close', function () {
            controller.abort();
        });

        const key = readSecret(request.user.directories, SECRET_KEYS.ZAI);

        if (!key) {
            console.warn('Z.AI key not found.');
            return response.sendStatus(400);
        }

        console.debug('Z.AI video request:', request.body);

        const generateResponse = await fetch('https://api.z.ai/api/paas/v4/videos/generations', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`,
            },
            body: JSON.stringify({
                prompt: request.body.prompt,
                model: request.body.model,
                quality: request.body.quality,
                size: request.body.size,
                aspect_ratio: request.body.aspect_ratio,
            }),
            signal: controller.signal,
        });

        if (!generateResponse.ok) {
            const text = await generateResponse.text();
            console.warn('Z.AI returned an error.', text);
            return response.sendStatus(500);
        }

        /** @type {any} */
        const data = await generateResponse.json();
        console.debug('Z.AI video response:', data);

        // Poll for video generation completion
        for (let attempt = 0; attempt < 30; attempt++) {
            if (controller.signal.aborted) {
                console.info('Z.AI video generation aborted by client');
                return response.status(500).send('Video generation aborted by client');
            }

            await delay(5000 + attempt * 1000);
            console.debug(`Polling Z.AI video job ${data.id}, attempt ${attempt + 1}`);

            const pollResponse = await fetch(`https://api.z.ai/api/paas/v4/async-result/${data.id}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${key}`,
                },
            });

            if (!pollResponse.ok) {
                const text = await pollResponse.text();
                console.warn('Z.AI video job polling failed', pollResponse.statusText, text);
                return response.status(500).send(text);
            }

            /** @type {any} */
            const pollResult = await pollResponse.json();
            console.debug(`Z.AI video job status: ${pollResult.task_status}`);

            if (pollResult.task_status === 'FAIL') {
                console.warn('Z.AI video generation failed', pollResult);
                return response.status(500).send('Video generation failed');
            }

            if (pollResult.task_status === 'SUCCESS') {
                console.debug('Z.AI video generation succeeded', pollResult);
                const url = pollResult?.video_result?.[0]?.url;

                if (!url || !isValidUrl(url)) {
                    console.warn('Z.AI returned an invalid video URL.');
                    return response.sendStatus(500);
                }

                const contentResponse = await fetch(url);
                if (!contentResponse.ok) {
                    const text = await contentResponse.text();
                    console.warn('Z.AI video content fetch failed', contentResponse.statusText, text);
                    return response.status(500).send(text);
                }

                const contentBuffer = await contentResponse.arrayBuffer();
                return response.send({ format: 'mp4', video: Buffer.from(contentBuffer).toString('base64') });
            }
        }
        console.warn('Z.AI video was not available after multiple attempts.');
        return response.sendStatus(500);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

const workersai = express.Router();

workersai.post('/models', async (request, response) => {
    try {
        const key = readSecret(request.user.directories, SECRET_KEYS.WORKERS_AI);

        if (!key) {
            console.warn('Cloudflare Workers AI API key not found.');
            return response.sendStatus(400);
        }

        const accountId = String(request.body.account_id || '').trim();
        if (!accountId) {
            console.warn('Cloudflare Workers AI Account ID not found.');
            return response.sendStatus(400);
        }

        const apiUrl = new URL(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search`);
        apiUrl.searchParams.set('task', 'Text-to-Image');
        apiUrl.searchParams.set('per_page', '1000');
        const result = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!result.ok) {
            console.warn('Cloudflare Workers AI returned an error.', result.statusText);
            return response.sendStatus(500);
        }

        /** @type {any} */
        const data = await result.json();

        if (!data.success || !Array.isArray(data.result)) {
            console.warn('Cloudflare Workers AI returned invalid data.');
            return response.sendStatus(500);
        }

        const models = data.result.map(x => ({ value: x.name, text: x.name }));
        return response.send(models);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

workersai.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/workersai',
    select: () => dispatchSdWorkersai,
}));

router.use('/comfy', comfy);
router.use('/comfyrunpod', comfyRunPod);
router.use('/together', together);
router.use('/sdcpp', sdcpp);
router.use('/drawthings', drawthings);
router.use('/pollinations', pollinations);
router.use('/stability', stability);
router.use('/huggingface', huggingface);
router.use('/chutes', chutes);
router.use('/electronhub', electronhub);
router.use('/nanogpt', nanogpt);
router.use('/bfl', bfl);
router.use('/falai', falai);
router.use('/xai', xai);
router.use('/aimlapi', aimlapi);
router.use('/zai', zai);
router.use('/workersai', workersai);
