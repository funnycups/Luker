export function createImageService({ bridge, queue, readImageConfig, fingerprint, getQueueConfig }) {
    return {
        configure(options) {
            queue.configure?.(options);
        },
        async generate(prompt, { characterName = '', signal = undefined, expectedFingerprint = '' } = {}) {
            if (typeof getQueueConfig === 'function') {
                queue.configure?.(getQueueConfig());
            }
            return queue.schedule(async () => {
                const actual = fingerprint(readImageConfig());
                if (actual !== expectedFingerprint) {
                    const error = new Error('Image generation configuration changed.');
                    error.code = 'image_config_changed';
                    throw error;
                }
                return bridge.generateImage(prompt, { characterName, signal });
            });
        },
    };
}
