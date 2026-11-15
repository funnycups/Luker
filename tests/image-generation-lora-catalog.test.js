import { expect, jest, test } from '@jest/globals';
import {
    LORA_CLIP_STRENGTH_PLACEHOLDER,
    LORA_MODEL_STRENGTH_PLACEHOLDER,
    LORA_NAME_PLACEHOLDER,
} from '../public/scripts/extensions/stable-diffusion/lora/workflow.js';
import { createLoraCatalog } from '../public/scripts/extensions/stable-diffusion/lora/catalog.js';

const COMFY_CONFIG = {
    source: 'comfy',
    comfyType: 'standard',
    url: 'http://127.0.0.1:8188',
    workflow: 'workflow.json',
};

const EMPTY_STATE = { names: [], includeWeight: false, template: false };

function makeWorkflow({
    strengthModel = LORA_MODEL_STRENGTH_PLACEHOLDER,
    strengthClip = LORA_CLIP_STRENGTH_PLACEHOLDER,
} = {}) {
    return {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
        '2': {
            class_type: 'LoraLoader',
            inputs: {
                lora_name: LORA_NAME_PLACEHOLDER,
                strength_model: strengthModel,
                strength_clip: strengthClip,
                model: ['1', 0],
                clip: ['1', 1],
            },
        },
    };
}

function makeWorkflowWithoutTemplate() {
    return {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
    };
}

function makeCatalog(overrides = {}) {
    const config = { ...COMFY_CONFIG, ...overrides.config };
    const readConfig = overrides.readConfig ?? jest.fn(() => ({ ...config }));
    const requestWorkflow = overrides.requestWorkflow ?? jest.fn(async () => makeWorkflow());
    const requestLoras = overrides.requestLoras ?? jest.fn(async () => ['a.safetensors', 'b.safetensors']);
    const catalog = createLoraCatalog({ readConfig, requestWorkflow, requestLoras });
    return { config, catalog, readConfig, requestWorkflow, requestLoras };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function flushPending() {
    await new Promise(resolve => setImmediate(resolve));
}

test('returns an empty catalog for a non-ComfyUI source without making requests', async () => {
    const { catalog, requestWorkflow, requestLoras } = makeCatalog({ config: { source: 'openai' } });
    await expect(catalog.refresh()).resolves.toEqual(EMPTY_STATE);
    expect(requestWorkflow).not.toHaveBeenCalled();
    expect(requestLoras).not.toHaveBeenCalled();
});

test('returns an empty catalog for a non-standard ComfyUI service type without making requests', async () => {
    const { catalog, requestWorkflow, requestLoras } = makeCatalog({ config: { comfyType: 'runpod_serverless' } });
    await expect(catalog.refresh()).resolves.toEqual(EMPTY_STATE);
    expect(requestWorkflow).not.toHaveBeenCalled();
    expect(requestLoras).not.toHaveBeenCalled();
});

test('returns an empty catalog when no workflow is configured without requesting the workflow', async () => {
    const { catalog, requestWorkflow, requestLoras } = makeCatalog({ config: { workflow: '' } });
    await expect(catalog.refresh()).resolves.toEqual(EMPTY_STATE);
    expect(requestWorkflow).not.toHaveBeenCalled();
    expect(requestLoras).not.toHaveBeenCalled();
});

test('returns an empty catalog when the workflow has no LoRA template node', async () => {
    const { catalog, requestWorkflow, requestLoras } = makeCatalog({
        requestWorkflow: jest.fn(async () => makeWorkflowWithoutTemplate()),
    });
    await expect(catalog.refresh()).resolves.toEqual({ names: [], includeWeight: false, template: false });
    expect(catalog.getCached()).toEqual(EMPTY_STATE);
    expect(requestWorkflow).toHaveBeenCalledWith('workflow.json');
    expect(requestLoras).not.toHaveBeenCalled();
});

test('returns the LoRA names and enables the weight when the template has a strength placeholder', async () => {
    const { catalog, requestWorkflow, requestLoras } = makeCatalog();
    await expect(catalog.refresh()).resolves.toEqual({
        names: ['a.safetensors', 'b.safetensors'],
        includeWeight: true,
        template: true,
    });
    expect(requestWorkflow).toHaveBeenCalledWith('workflow.json');
    expect(requestLoras).toHaveBeenCalledWith('http://127.0.0.1:8188');
});

test('enables the weight when only the model strength is a placeholder', async () => {
    const { catalog } = makeCatalog({
        requestWorkflow: jest.fn(async () => makeWorkflow({ strengthClip: 0.8 })),
    });
    await expect(catalog.refresh()).resolves.toEqual({
        names: ['a.safetensors', 'b.safetensors'],
        includeWeight: true,
        template: true,
    });
});

test('enables the weight when only the clip strength is a placeholder', async () => {
    const { catalog } = makeCatalog({
        requestWorkflow: jest.fn(async () => makeWorkflow({ strengthModel: 0.8 })),
    });
    await expect(catalog.refresh()).resolves.toEqual({
        names: ['a.safetensors', 'b.safetensors'],
        includeWeight: true,
        template: true,
    });
});

test('disables the weight when the template has no strength placeholder', async () => {
    const { catalog } = makeCatalog({
        requestWorkflow: jest.fn(async () => makeWorkflow({ strengthModel: 0.8, strengthClip: 0.6 })),
    });
    await expect(catalog.refresh()).resolves.toEqual({
        names: ['a.safetensors', 'b.safetensors'],
        includeWeight: false,
        template: true,
    });
});

test('a second refresh for the same url reuses the LoRA names and re-reads the workflow', async () => {
    const { catalog, requestWorkflow, requestLoras } = makeCatalog();
    await catalog.refresh();
    await catalog.refresh();
    expect(requestWorkflow).toHaveBeenCalledTimes(2);
    expect(requestLoras).toHaveBeenCalledTimes(1);
});

test('a forced refresh re-reads the LoRA names for the same url and a later cached refresh reuses the new list', async () => {
    const requestLoras = jest.fn()
        .mockResolvedValueOnce(['a.safetensors'])
        .mockResolvedValueOnce(['b.safetensors']);
    const { catalog } = makeCatalog({ requestLoras });

    await expect(catalog.refresh()).resolves.toEqual({
        names: ['a.safetensors'],
        includeWeight: true,
        template: true,
    });

    await expect(catalog.refresh({ force: true })).resolves.toEqual({
        names: ['b.safetensors'],
        includeWeight: true,
        template: true,
    });
    expect(requestLoras).toHaveBeenCalledTimes(2);
    expect(requestLoras).toHaveBeenLastCalledWith('http://127.0.0.1:8188');

    await expect(catalog.refresh()).resolves.toEqual({
        names: ['b.safetensors'],
        includeWeight: true,
        template: true,
    });
    expect(requestLoras).toHaveBeenCalledTimes(2);
});

test('a failed forced refresh keeps the previous state and drops the name cache', async () => {
    const error = new Error('object info unavailable');
    const requestLoras = jest.fn()
        .mockResolvedValueOnce(['a.safetensors'])
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(['b.safetensors']);
    const { catalog } = makeCatalog({ requestLoras });

    await catalog.refresh();
    await expect(catalog.refresh({ force: true })).rejects.toBe(error);
    expect(catalog.getCached()).toEqual({
        names: ['a.safetensors'],
        includeWeight: true,
        template: true,
    });

    await expect(catalog.refresh()).resolves.toEqual({
        names: ['b.safetensors'],
        includeWeight: true,
        template: true,
    });
    expect(requestLoras).toHaveBeenCalledTimes(3);
});

test('a different url loads the LoRA names again', async () => {
    const config = { ...COMFY_CONFIG };
    const { catalog, requestLoras } = makeCatalog({
        readConfig: jest.fn(() => ({ ...config })),
    });
    await catalog.refresh();
    config.url = 'http://127.0.0.1:9999';
    await catalog.refresh();
    expect(requestLoras).toHaveBeenCalledTimes(2);
    expect(requestLoras).toHaveBeenLastCalledWith('http://127.0.0.1:9999');
});

test('a workflow change re-detects the template without re-requesting the LoRA names', async () => {
    const config = { ...COMFY_CONFIG };
    const requestWorkflow = jest.fn()
        .mockResolvedValueOnce(makeWorkflow())
        .mockResolvedValueOnce(makeWorkflow({ strengthModel: 0.8, strengthClip: 0.6 }));
    const { catalog, requestLoras } = makeCatalog({
        config,
        readConfig: jest.fn(() => ({ ...config })),
        requestWorkflow,
    });

    await catalog.refresh();
    expect(catalog.getCached()).toEqual({
        names: ['a.safetensors', 'b.safetensors'],
        includeWeight: true,
        template: true,
    });

    config.workflow = 'other.json';
    await expect(catalog.refresh()).resolves.toEqual({
        names: ['a.safetensors', 'b.safetensors'],
        includeWeight: false,
        template: true,
    });
    expect(catalog.getCached()).toEqual({
        names: ['a.safetensors', 'b.safetensors'],
        includeWeight: false,
        template: true,
    });
    expect(requestWorkflow).toHaveBeenNthCalledWith(1, 'workflow.json');
    expect(requestWorkflow).toHaveBeenNthCalledWith(2, 'other.json');
    expect(requestLoras).toHaveBeenCalledTimes(1);
});

test('invalidate clears the LoRA name cache and the current state', async () => {
    const { catalog, requestLoras } = makeCatalog();
    await catalog.refresh();
    catalog.invalidate();
    expect(catalog.getCached()).toEqual(EMPTY_STATE);
    await catalog.refresh();
    expect(requestLoras).toHaveBeenCalledTimes(2);
});

test('a superseded refresh does not overwrite a newer catalog state', async () => {
    const config = { ...COMFY_CONFIG };
    const slowWorkflow = deferred();
    const requestWorkflow = jest.fn(name => name === 'slow.json'
        ? slowWorkflow.promise
        : Promise.resolve(makeWorkflow({ strengthModel: 0.8, strengthClip: 0.6 })));
    const requestLoras = jest.fn(async () => ['newer.safetensors']);
    const { catalog } = makeCatalog({
        readConfig: jest.fn(() => ({ ...config })),
        requestWorkflow,
        requestLoras,
    });

    config.workflow = 'slow.json';
    config.url = 'http://127.0.0.1:1111';
    const slowRefresh = catalog.refresh();

    config.workflow = 'fast.json';
    config.url = 'http://127.0.0.1:2222';
    await expect(catalog.refresh()).resolves.toEqual({
        names: ['newer.safetensors'],
        includeWeight: false,
        template: true,
    });

    slowWorkflow.resolve(makeWorkflow());
    await expect(slowRefresh).resolves.toEqual({
        names: ['newer.safetensors'],
        includeWeight: false,
        template: true,
    });
    expect(catalog.getCached()).toEqual({
        names: ['newer.safetensors'],
        includeWeight: false,
        template: true,
    });
    expect(requestLoras).toHaveBeenCalledTimes(1);
    expect(requestLoras).toHaveBeenCalledWith('http://127.0.0.1:2222');
});

test('invalidate during an in-flight refresh keeps the catalog empty', async () => {
    const loras = deferred();
    const requestLoras = jest.fn(() => loras.promise);
    const { catalog } = makeCatalog({ requestLoras });

    const refresh = catalog.refresh();
    await flushPending();
    expect(requestLoras).toHaveBeenCalledTimes(1);

    catalog.invalidate();
    expect(catalog.getCached()).toEqual(EMPTY_STATE);

    loras.resolve(['a.safetensors', 'b.safetensors']);
    await expect(refresh).resolves.toEqual(EMPTY_STATE);
    expect(catalog.getCached()).toEqual(EMPTY_STATE);

    await catalog.refresh();
    expect(requestLoras).toHaveBeenCalledTimes(2);
});

test('getCached returns the empty state before the first refresh', () => {
    const { catalog, readConfig, requestWorkflow, requestLoras } = makeCatalog();
    expect(catalog.getCached()).toEqual(EMPTY_STATE);
    expect(readConfig).not.toHaveBeenCalled();
    expect(requestWorkflow).not.toHaveBeenCalled();
    expect(requestLoras).not.toHaveBeenCalled();
});

test('getCached returns a copy whose names array is not shared with the catalog', async () => {
    const { catalog } = makeCatalog();
    await catalog.refresh();

    const first = catalog.getCached();
    first.names.push('injected.safetensors');
    first.includeWeight = false;

    const second = catalog.getCached();
    expect(second).toEqual({
        names: ['a.safetensors', 'b.safetensors'],
        includeWeight: true,
        template: true,
    });
    expect(second.names).not.toBe(first.names);
    expect(catalog.getCached().names).not.toBe(second.names);
});

test('a refresh result does not share its names array with the cached state', async () => {
    const { catalog } = makeCatalog();
    const refreshed = await catalog.refresh();
    refreshed.names.push('injected.safetensors');
    expect(catalog.getCached().names).toEqual(['a.safetensors', 'b.safetensors']);
});

test('a workflow request failure propagates', async () => {
    const error = new Error('workflow unavailable');
    const { catalog } = makeCatalog({
        requestWorkflow: jest.fn(async () => {
            throw error;
        }),
    });
    await expect(catalog.refresh()).rejects.toBe(error);
});

test('a LoRA list request failure propagates', async () => {
    const error = new Error('object info unavailable');
    const { catalog } = makeCatalog({
        requestLoras: jest.fn(async () => {
            throw error;
        }),
    });
    await expect(catalog.refresh()).rejects.toBe(error);
});

test('an invalid template propagates the inspection error', async () => {
    const workflow = makeWorkflow();
    workflow['3'] = {
        class_type: 'LoraLoader',
        inputs: { ...workflow['2'].inputs },
    };
    const { catalog } = makeCatalog({
        requestWorkflow: jest.fn(async () => workflow),
    });
    await expect(catalog.refresh()).rejects.toMatchObject({ code: 'lora_template_multiple' });
});

test('a failed refresh keeps the previous cached state', async () => {
    const config = { ...COMFY_CONFIG };
    const error = new Error('object info unavailable');
    const requestLoras = jest.fn()
        .mockResolvedValueOnce(['a.safetensors', 'b.safetensors'])
        .mockRejectedValueOnce(error);
    const { catalog } = makeCatalog({
        readConfig: jest.fn(() => ({ ...config })),
        requestLoras,
    });

    await catalog.refresh();
    config.url = 'http://127.0.0.1:9999';
    await expect(catalog.refresh()).rejects.toBe(error);
    expect(catalog.getCached()).toEqual({
        names: ['a.safetensors', 'b.safetensors'],
        includeWeight: true,
        template: true,
    });
});
