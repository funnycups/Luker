import { expect, test, jest } from '@jest/globals';
import { GenerationQueue } from '../public/scripts/extensions/stable-diffusion/illustration/queue.js';
import { createImageService } from '../public/scripts/extensions/stable-diffusion/illustration/image-service.js';

test('respects max concurrency and starts queued work after completion', async () => {
    const queue = new GenerationQueue({ maxConcurrent: 1, minInterval: 0 });
    let release;
    const first = queue.schedule(() => new Promise((resolve) => { release = resolve; }));
    const second = queue.schedule(async () => 'second');
    expect(queue.activeCount).toBe(1);
    expect(queue.pendingCount).toBe(1);
    release('first');
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
});

test('uses the configured minimum interval between starts', async () => {
    jest.useFakeTimers();
    const starts = [];
    const queue = new GenerationQueue({ maxConcurrent: 2, minInterval: 100, setTimeoutFn: setTimeout });
    queue.schedule(async () => starts.push(0));
    queue.schedule(async () => starts.push(1));
    expect(starts).toEqual([0]);
    await jest.advanceTimersByTimeAsync(100);
    expect(starts).toEqual([0, 1]);
    jest.useRealTimers();
});

test('a rejected task does not stall the queue', async () => {
    const queue = new GenerationQueue({ maxConcurrent: 1, minInterval: 0 });
    await expect(queue.schedule(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(queue.schedule(async () => 'ok')).resolves.toBe('ok');
});

test('schedules the bridge with prompt, character and signal', async () => {
    const bridge = { generateImage: jest.fn(async () => '/user/images/a.png') };
    const queue = { schedule: (fn) => fn() };
    const service = createImageService({ bridge, queue });
    const controller = new AbortController();
    await expect(service.generate('p', {
        characterName: 'Seraphina', signal: controller.signal,
    })).resolves.toBe('/user/images/a.png');
    expect(bridge.generateImage).toHaveBeenCalledWith('p', {
        characterName: 'Seraphina', signal: controller.signal,
    });
});

test('aborting a queued task rejects immediately without waiting for active work', async () => {
    const queue = new GenerationQueue({ maxConcurrent: 1, minInterval: 0 });
    let releaseFirst;
    const first = queue.schedule(() => new Promise(resolve => { releaseFirst = resolve; }));
    const controller = new AbortController();
    const secondWork = jest.fn(async () => 'second');
    const second = queue.schedule(secondWork, { signal: controller.signal });
    expect(queue.activeCount).toBe(1);
    expect(queue.pendingCount).toBe(1);

    controller.abort('cancelled');
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(queue.pendingCount).toBe(0);
    expect(secondWork).not.toHaveBeenCalled();

    releaseFirst('first');
    await expect(first).resolves.toBe('first');
});

test('getCapabilitiesSnapshot delegates to bridge snapshot without calling async getCapabilities', () => {
    const snapshot = { supportsSourceImage: true, supportsCharacterReference: false };
    const bridge = {
        getCapabilities: jest.fn(async () => { throw new Error('must not call async'); }),
        getCapabilitiesSnapshot: jest.fn(() => snapshot),
        generateImage: jest.fn(),
    };
    const service = createImageService({ bridge, queue: new GenerationQueue() });
    expect(service.getCapabilitiesSnapshot()).toBe(snapshot);
    expect(bridge.getCapabilities).not.toHaveBeenCalled();
});
