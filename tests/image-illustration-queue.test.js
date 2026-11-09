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

test('rejects when the image config changed before the request', async () => {
    const service = createImageService({
        bridge: { generateImage: jest.fn() },
        queue: { schedule: (fn) => fn() },
        readImageConfig: () => ({ steps: 20 }),
        fingerprint: () => 'new',
    });
    await expect(service.generate('p', { expectedFingerprint: 'old' }))
        .rejects.toThrow('configuration changed');
});

test('schedules the bridge with prompt, character and signal', async () => {
    const bridge = { generateImage: jest.fn(async () => '/user/images/a.png') };
    const queue = { schedule: (fn) => fn() };
    const service = createImageService({
        bridge, queue, readImageConfig: () => ({ steps: 20 }), fingerprint: () => 'same',
    });
    const controller = new AbortController();
    await expect(service.generate('p', {
        characterName: 'Seraphina', signal: controller.signal, expectedFingerprint: 'same',
    })).resolves.toBe('/user/images/a.png');
    expect(bridge.generateImage).toHaveBeenCalledWith('p', {
        characterName: 'Seraphina', signal: controller.signal,
    });
});
