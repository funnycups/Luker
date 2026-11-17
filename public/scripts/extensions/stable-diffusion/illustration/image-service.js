export function createImageService({ bridge, queue, getQueueConfig }) {
    return {
        configure(options) {
            queue.configure?.(options);
        },
        async getAvailableLoras() {
            return bridge.getAvailableLoras();
        },
        async getCapabilities() {
            if (typeof bridge.getCapabilities === 'function') {
                return await bridge.getCapabilities();
            }
            const availableLoras = await bridge.getAvailableLoras();
            return {
                source: '',
                model: '',
                supportsCharacterReference: false,
                maxCharacterReferences: 0,
                supportsStyleReference: false,
                maxStyleReferences: 0,
                supportsSourceImage: false,
                supportsMultiCharacterPrompts: false,
                supportsDynamicAspectRatio: true,
                availableLoras,
            };
        },
        async generate(prompt, options = {}) {
            if (typeof getQueueConfig === 'function') {
                queue.configure?.(getQueueConfig());
            }
            return queue.schedule(() => bridge.generateImage(prompt, options));
        },
    };
}
