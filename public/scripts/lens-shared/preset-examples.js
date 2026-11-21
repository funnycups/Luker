/**
 * Bundled preset examples and the shared actions built around them.
 *
 * The bundled files are examples, not defaults. Callers decide which example
 * fits their slot and handle selecting the imported name in their own state.
 */

const defaultContext = () => globalThis.Luker?.getContext?.() ?? globalThis.lukerContext ?? null;
const t = (text) => defaultContext()?.translate?.(text) ?? String(text ?? '');

export const PRESET_EXAMPLES = Object.freeze({
    pluginOnly: 'plugin-only',
    agentDirector: 'agent-director',
});

const EXAMPLE_NAMES = new Set(Object.values(PRESET_EXAMPLES));

/** Director slots use the director example; every other slot uses plugin-only. */
export function exampleNameForMode(mode = '') {
    return String(mode || '').trim() === 'director'
        ? PRESET_EXAMPLES.agentDirector
        : PRESET_EXAMPLES.pluginOnly;
}

/** True when the preset library already contains `name`. */
export function isPresetInstalled(name, context = defaultContext()) {
    const target = String(name || '').trim();
    if (!target) return false;
    const manager = context?.getPresetManager?.('openai');
    if (!manager) return false;
    try {
        if (typeof manager.findPreset === 'function' && manager.findPreset(target)) return true;
        const names = manager.getAllPresets?.() || [];
        return Array.isArray(names) && names.some(n => String(n || '').trim() === target);
    } catch {
        return false;
    }
}

/**
 * Confirmation shown before replacing an existing preset with the bundled copy.
 * Kept separate so the import flow can be tested without a browser popup.
 */
async function confirmOverwrite(name) {
    const { Popup, POPUP_TYPE, POPUP_RESULT } = await import('../popup.js');
    const body = `<b>${t('Re-import example')}</b><p>${t('Re-importing replaces the current ${0} with the bundled example. Changes you made to it will be lost.').replace('${0}', name)}</p>`;
    const popup = new Popup(body, POPUP_TYPE.CONFIRM, '', {
        okButton: t('Overwrite'),
        cancelButton: t('Cancel'),
    });
    return (await popup.show()) === POPUP_RESULT.AFFIRMATIVE;
}

/**
 * Imports a bundled example and saves it into the preset library.
 * Returns false when the overwrite confirmation is declined.
 *
 * @param {string} name
 * @param {{ context?: object, fetchImpl?: Function, confirm?: (name: string) => Promise<boolean> }} [opts]
 * @returns {Promise<boolean>}
 */
export async function importPresetExample(name, {
    context = defaultContext(),
    fetchImpl = globalThis.fetch,
    confirm = confirmOverwrite,
} = {}) {
    const target = String(name || '').trim();
    if (!EXAMPLE_NAMES.has(target)) throw new Error(t('Unrecognized preset'));

    const manager = context?.getPresetManager?.('openai');
    if (!manager) throw new Error(t('Preset manager unavailable'));

    if (isPresetInstalled(target, context)) {
        const proceed = await confirm(target);
        if (!proceed) return false;
    }

    if (typeof fetchImpl !== 'function') throw new Error(t('Failed to download the preset'));
    let response;
    try {
        response = await fetchImpl(`/presets/${target}.json`);
    } catch {
        throw new Error(t('Failed to download the preset'));
    }
    if (!response?.ok) throw new Error(t('Failed to download the preset'));

    const data = await response.json();
    if (data && typeof data === 'object') data.name = target;
    await manager.savePreset(target, data);
    return true;
}

/**
 * Opens the preset workspace with the matching edit mode preselected.
 * Throws instead of silently leaving the user on the current page.
 */
export async function openPresetDerivation(mode, {
    workbench = defaultContext()?.workbench,
} = {}) {
    if (typeof workbench?.open !== 'function') throw new Error(t('Workbench is unavailable.'));
    const presetMode = String(mode || '').trim();
    const handle = await workbench.open({ page: 'ai', ws: 'preset', launch: { presetMode } });
    if (!handle) throw new Error(t('The preset workbench is unavailable.'));
    return handle;
}
