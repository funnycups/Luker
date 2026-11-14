export function createImageService({ bridge, queue, getQueueConfig }) {
    return {
        configure(options) {
            queue.configure?.(options);
        },
        async generate(prompt, { characterName = '', signal = undefined } = {}) {
            if (typeof getQueueConfig === 'function') {
                queue.configure?.(getQueueConfig());
            }
            return queue.schedule(() => bridge.generateImage(prompt, { characterName, signal }));
        },
    };
}
