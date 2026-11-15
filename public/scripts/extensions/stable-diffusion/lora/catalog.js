import { inspectLoraTemplate } from './workflow.js';

function emptyState() {
    return { names: [], includeWeight: false, template: false };
}

function copyState(state) {
    return {
        names: [...state.names],
        includeWeight: state.includeWeight,
        template: state.template,
    };
}

/**
 * Builds the LoRA catalog for the selected workflow and backend.
 *
 * @param {object} options
 * @param {() => { source: string, comfyType: string, url: string, workflow: string }} options.readConfig Returns the current generation settings.
 * @param {(name: string) => Promise<object>} options.requestWorkflow Loads and parses the named workflow.
 * @param {(url: string) => Promise<string[]>} options.requestLoras Loads the available LoRA names from the given backend URL.
 * @returns {{ refresh: (options?: { force?: boolean }) => Promise<{ names: string[], includeWeight: boolean, template: boolean }>, getCached: () => { names: string[], includeWeight: boolean, template: boolean }, invalidate: () => void }}
 */
export function createLoraCatalog({ readConfig, requestWorkflow, requestLoras }) {
    let state = emptyState();
    /** @type {{ url: string, names: string[] } | null} */
    let nameCache = null;
    let refreshToken = 0;

    async function loadNames(url, token) {
        if (nameCache?.url === url) {
            return nameCache.names;
        }
        const names = await requestLoras(url);
        // A superseded refresh must not repopulate the name cache.
        if (token === refreshToken) {
            nameCache = { url, names };
        }
        return names;
    }

    async function refresh({ force = false } = {}) {
        const token = ++refreshToken;
        const config = readConfig();
        if (config.source !== 'comfy' || config.comfyType !== 'standard') {
            state = emptyState();
            return copyState(state);
        }

        if (!config.workflow) {
            state = emptyState();
            return copyState(state);
        }

        // A forced refresh drops the cached names so the same backend URL is
        // requested again.
        if (force) {
            nameCache = null;
        }

        const workflow = await requestWorkflow(config.workflow);
        // A superseded refresh returns the current state without publishing its own.
        if (token !== refreshToken) {
            return copyState(state);
        }

        const template = inspectLoraTemplate(workflow);
        if (!template) {
            state = emptyState();
            return copyState(state);
        }

        const names = await loadNames(config.url, token);
        if (token !== refreshToken) {
            return copyState(state);
        }

        state = {
            names: [...names],
            includeWeight: template.hasModelStrength || template.hasClipStrength,
            template: true,
        };
        return copyState(state);
    }

    return {
        refresh,
        getCached: () => copyState(state),
        invalidate: () => {
            refreshToken++;
            nameCache = null;
            state = emptyState();
        },
    };
}
