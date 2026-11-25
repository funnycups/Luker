export function createImageService({ bridge, queue, getQueueConfig, context = null }) {
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
                characterReferenceEnabled: false,
                characterReferenceMode: 'text_only',
                supportsCharacterTextReference: false,
                supportsCharacterReference: false,
                maxCharacterReferences: 0,
                supportsStyleReference: false,
                maxStyleReferences: 0,
                supportsSourceImage: false,
                supportsMultiCharacterPrompts: false,
                supportsDynamicAspectRatio: true,
                availableLoras,
                protocol: {
                    supportsCharacterReference: false,
                    maxCharacterReferences: 0,
                    supportsStyleReference: false,
                    maxStyleReferences: 0,
                    supportsSourceImage: false,
                    supportsMultiCharacterPrompts: false,
                    supportsDynamicAspectRatio: true,
                    sharedReferenceSlots: false,
                    maxTotalReferences: null,
                    comfyReferenceSlotCount: 0,
                    comfyWorkflowError: '',
                },
                warnings: [],
            };
        },
        async generate(prompt, options = {}) {
            if (typeof getQueueConfig === 'function') {
                queue.configure?.(getQueueConfig());
            }
            const hasIllustrationLease = typeof context?.activityGuard?.list === 'function'
                && context.activityGuard.list().some(entry => entry?.source === 'sd:illustration');
            const bridgeOptions = hasIllustrationLease && options?.skipActivityLease === undefined
                ? { ...options, skipActivityLease: true }
                : options;
            return queue.schedule(() => bridge.generateImage(prompt, bridgeOptions));
        },
    };
}
