export function createImageService({ bridge, queue, getQueueConfig }) {
    return {
        configure(options) {
            queue.configure?.(options);
        },
        async getAvailableLoras() {
            return bridge.getAvailableLoras();
        },
        async generate(prompt, { characterName = '', signal = undefined, loras } = {}) {
            if (typeof getQueueConfig === 'function') {
                queue.configure?.(getQueueConfig());
            }
            return queue.schedule(() => bridge.generateImage(prompt, { characterName, signal, loras }));
        },
    };
}
