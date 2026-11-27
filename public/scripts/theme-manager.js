import { invalidateThemeResourceReads, readThemeDocument } from './named-resource-read.js';
import { normalizeThemePalettes } from './theme-palettes.js';

export const BUILTIN_THEME_STYLE_ID = 'builtin-theme-style';
export const CUSTOM_STYLE_ID = 'custom-style';

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stripInternalFields(doc) {
    if (!isPlainObject(doc)) {
        return {};
    }
    const copy = { ...doc };
    delete copy.builtin;
    delete copy.builtin_stylesheet;
    delete copy._summary;
    return copy;
}

async function defaultFetchStylesheetText(stylesheetPath) {
    if (typeof stylesheetPath !== 'string' || !stylesheetPath) {
        return '';
    }
    const response = await fetch(stylesheetPath, {
        credentials: 'same-origin',
        cache: 'default',
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch built-in stylesheet "${stylesheetPath}" (${response.status})`);
    }
    return await response.text();
}

/**
 * Creates a client-side Theme Manager that:
 * - tracks built-in (read-only) vs user/external themes without pre-loading all bodies
 * - lazy-loads theme bodies via `/api/themes/get` on demand
 * - mounts built-in stylesheets via `<link id="builtin-theme-style">` before `<style id="custom-style">`
 * - proxies `power_user.custom_css` and `power_user.palettes` directly to the active theme
 *   with automatic Theme API writeback and zero persistence into `settings.json`
 * - creates completely independent derived copies for both built-in and non-built-in themes
 */
export function createThemeManager({
    readTheme = (name) => readThemeDocument(name),
    fetchStylesheet = defaultFetchStylesheetText,
    patchTheme = null,
    invalidateReads = invalidateThemeResourceReads,
    normalizePalettes = normalizeThemePalettes,
    onCustomCssApplied = null,
    onPalettesApplied = null,
    onBuiltinWriteBlocked = null,
    onStylesheetLoaded = null,
    onPatchError = null,
    patchDelayMs = 300,
    getDocument = () => (typeof document !== 'undefined' ? document : null),
} = {}) {
    /** @type {Map<string, { name: string, builtin: boolean }>} */
    const directory = new Map();
    /** @type {Map<string, Record<string, any>>} */
    const docCache = new Map();
    /** @type {Record<string, any> | null} */
    let activeThemeDoc = null;
    // Detached in-memory fallback used only before any theme is active or when
    // power_user.theme references a missing theme name. Never persisted to settings.json.
    let detachedCustomCss = '';
    let detachedPalettes = null;

    /** @type {{ name: string, patch: Record<string, any>, prev: Record<string, { had: boolean, value: any }>, timer: any } | null} */
    let pendingPatch = null;
    /** @type {Promise<void>} */
    let patchChain = Promise.resolve();
    /** @type {Promise<void> | null} */
    let inFlightPatch = null;

    function upsertDirectoryEntry(name, builtin) {
        if (typeof name !== 'string' || !name) return;
        const existing = directory.get(name);
        directory.set(name, {
            name,
            builtin: builtin !== undefined ? Boolean(builtin) : Boolean(existing?.builtin),
        });
    }

    function isBuiltin(name) {
        return directory.get(name)?.builtin === true;
    }

    function isActiveThemeBuiltin() {
        return Boolean(activeThemeDoc && (activeThemeDoc.builtin === true || isBuiltin(activeThemeDoc.name)));
    }

    function hydrateFromSettingsData(data) {
        if (!data || typeof data !== 'object') {
            return;
        }
        const incomingDir = data.theme_directory;
        if (incomingDir && Array.isArray(incomingDir.names)) {
            directory.clear();
            const builtinSet = new Set(Array.isArray(incomingDir.builtin) ? incomingDir.builtin : []);
            for (const name of incomingDir.names) {
                upsertDirectoryEntry(name, builtinSet.has(name));
            }
        } else if (Array.isArray(data.themes)) {
            directory.clear();
            for (const item of data.themes) {
                if (typeof item?.name === 'string' && item.name) {
                    upsertDirectoryEntry(item.name, Boolean(item.builtin));
                }
            }
        }

        if (Array.isArray(data.themes)) {
            for (const item of data.themes) {
                if (isPlainObject(item) && typeof item.name === 'string' && item.name && item._summary !== true) {
                    docCache.set(item.name, cloneJson(item));
                    upsertDirectoryEntry(item.name, Boolean(item.builtin));
                }
            }
        }

        if (isPlainObject(data.active_theme) && typeof data.active_theme.name === 'string' && data.active_theme.name) {
            docCache.set(data.active_theme.name, cloneJson(data.active_theme));
            upsertDirectoryEntry(data.active_theme.name, Boolean(data.active_theme.builtin));
        }
    }

    function listThemeEntries() {
        return [...directory.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    function listThemeNames() {
        return listThemeEntries().map(entry => entry.name);
    }

    function hasTheme(name) {
        return directory.has(name);
    }

    function getCachedTheme(name) {
        return docCache.get(name) ?? null;
    }

    function getActiveTheme() {
        return activeThemeDoc;
    }

    async function ensureThemeLoaded(name, { forceRefresh = false } = {}) {
        if (typeof name !== 'string' || !name) {
            return null;
        }
        if (!forceRefresh && docCache.has(name)) {
            return docCache.get(name);
        }
        const loaded = await readTheme(name);
        if (!isPlainObject(loaded)) {
            return null;
        }
        const normalized = typeof loaded.name === 'string' && loaded.name ? loaded : { ...loaded, name };
        const doc = cloneJson(normalized);
        docCache.set(doc.name, doc);
        upsertDirectoryEntry(doc.name, Boolean(doc.builtin));
        return doc;
    }

    function setActiveTheme(doc) {
        if (isPlainObject(doc) && typeof doc.name === 'string' && doc.name) {
            const stored = docCache.get(doc.name) === doc ? doc : cloneJson(doc);
            docCache.set(stored.name, stored);
            upsertDirectoryEntry(stored.name, Boolean(stored.builtin));
            activeThemeDoc = stored;
            detachedCustomCss = '';
            detachedPalettes = null;
        } else {
            activeThemeDoc = null;
        }
    }

    function registerSavedTheme(doc) {
        if (!isPlainObject(doc) || typeof doc.name !== 'string' || !doc.name) {
            return null;
        }
        const clean = stripInternalFields(doc);
        clean.name = doc.name;
        const stored = cloneJson(clean);
        directory.set(stored.name, { name: stored.name, builtin: false });
        docCache.set(stored.name, stored);
        if (activeThemeDoc && activeThemeDoc.name === stored.name) {
            activeThemeDoc = stored;
        }
        invalidateReads();
        return stored;
    }

    function removeDeletedTheme(name) {
        if (pendingPatch && pendingPatch.name === name) {
            clearTimeout(pendingPatch.timer);
            pendingPatch = null;
        }
        directory.delete(name);
        docCache.delete(name);
        if (activeThemeDoc && activeThemeDoc.name === name) {
            activeThemeDoc = null;
        }
        invalidateReads();
    }

    function rollbackFailedPatch(batch) {
        const cached = docCache.get(batch.name);
        if (cached && isPlainObject(cached)) {
            for (const [key, prev] of Object.entries(batch.prev)) {
                const pendingValue = batch.patch[key];
                const currentMatchesFailed = pendingValue === null
                    ? cached[key] === undefined
                    : JSON.stringify(cached[key]) === JSON.stringify(pendingValue);
                if (!currentMatchesFailed) continue;
                if (prev.had) {
                    cached[key] = cloneJson(prev.value);
                } else {
                    delete cached[key];
                }
                if (activeThemeDoc && activeThemeDoc.name === batch.name) {
                    if (key === 'custom_css') {
                        onCustomCssApplied?.(typeof cached.custom_css === 'string' ? cached.custom_css : '');
                    } else if (key === 'palettes') {
                        onPalettesApplied?.(batch.name, normalizePalettes(cached.palettes));
                    }
                }
            }
        }
        invalidateReads();
    }

    function flushPendingPatch() {
        if (pendingPatch) {
            const batch = pendingPatch;
            clearTimeout(batch.timer);
            pendingPatch = null;
            if (typeof patchTheme === 'function' && !isBuiltin(batch.name)) {
                const attempt = patchChain.then(async () => {
                    try {
                        await patchTheme(batch.name, batch.patch);
                        invalidateReads();
                    } catch (error) {
                        rollbackFailedPatch(batch);
                        console.error(`Failed to persist theme "${batch.name}" patch:`, error);
                        onPatchError?.(error, batch.name, batch.patch);
                        throw error;
                    }
                });
                inFlightPatch = attempt;
                patchChain = attempt.then(
                    () => { if (inFlightPatch === attempt) inFlightPatch = null; },
                    () => { if (inFlightPatch === attempt) inFlightPatch = null; },
                );
                return attempt;
            }
        }
        return inFlightPatch ?? patchChain;
    }

    function queuePatch(themeName, fields, prevFields) {
        if (typeof patchTheme !== 'function' || !themeName || isBuiltin(themeName)) {
            return;
        }
        if (pendingPatch && pendingPatch.name !== themeName) {
            void flushPendingPatch().catch(() => {});
        }
        if (!pendingPatch) {
            pendingPatch = {
                name: themeName,
                patch: { ...fields },
                prev: { ...prevFields },
                timer: null,
            };
        } else {
            for (const [key, snap] of Object.entries(prevFields)) {
                if (!Object.prototype.hasOwnProperty.call(pendingPatch.prev, key)) {
                    pendingPatch.prev[key] = snap;
                }
            }
            Object.assign(pendingPatch.patch, fields);
            clearTimeout(pendingPatch.timer);
        }
        pendingPatch.timer = setTimeout(() => {
            void flushPendingPatch().catch(() => {});
        }, patchDelayMs);
    }

    function installPowerUserProxies(powerUserObj) {
        if (!powerUserObj || typeof powerUserObj !== 'object') {
            return;
        }
        delete powerUserObj.custom_css;
        delete powerUserObj.palettes;

        Object.defineProperty(powerUserObj, 'custom_css', {
            enumerable: false,
            configurable: true,
            get() {
                if (activeThemeDoc) {
                    return typeof activeThemeDoc.custom_css === 'string' ? activeThemeDoc.custom_css : '';
                }
                return detachedCustomCss;
            },
            set(value) {
                const nextCss = String(value ?? '');
                if (activeThemeDoc) {
                    if (isActiveThemeBuiltin()) {
                        const currentCss = typeof activeThemeDoc.custom_css === 'string' ? activeThemeDoc.custom_css : '';
                        if (nextCss !== currentCss) {
                            onBuiltinWriteBlocked?.('custom_css', activeThemeDoc.name);
                        }
                        return;
                    }
                    const hadPrevCss = Object.prototype.hasOwnProperty.call(activeThemeDoc, 'custom_css');
                    const prevRawCss = activeThemeDoc.custom_css;
                    const prevCss = typeof prevRawCss === 'string' ? prevRawCss : '';
                    activeThemeDoc.custom_css = nextCss;
                    docCache.set(activeThemeDoc.name, activeThemeDoc);
                    onCustomCssApplied?.(nextCss);
                    if (prevCss !== nextCss) {
                        queuePatch(
                            activeThemeDoc.name,
                            { custom_css: nextCss },
                            { custom_css: { had: hadPrevCss, value: prevRawCss } },
                        );
                    }
                    return;
                }
                detachedCustomCss = nextCss;
                onCustomCssApplied?.(nextCss);
            },
        });

        Object.defineProperty(powerUserObj, 'palettes', {
            enumerable: false,
            configurable: true,
            get() {
                if (activeThemeDoc) {
                    return normalizePalettes(activeThemeDoc.palettes);
                }
                return detachedPalettes;
            },
            set(value) {
                const nextPalettes = normalizePalettes(value);
                if (activeThemeDoc) {
                    if (isActiveThemeBuiltin()) {
                        const prevStr = JSON.stringify(normalizePalettes(activeThemeDoc.palettes));
                        const nextStr = JSON.stringify(nextPalettes);
                        if (prevStr !== nextStr) {
                            onBuiltinWriteBlocked?.('palettes', activeThemeDoc.name);
                        }
                        return;
                    }
                    const hadPrevPalettes = Object.prototype.hasOwnProperty.call(activeThemeDoc, 'palettes');
                    const prevRawPalettes = hadPrevPalettes ? cloneJson(activeThemeDoc.palettes) : undefined;
                    const prevStr = JSON.stringify(normalizePalettes(activeThemeDoc.palettes));
                    const nextStr = JSON.stringify(nextPalettes);
                    if (nextPalettes) {
                        activeThemeDoc.palettes = cloneJson(nextPalettes);
                    } else {
                        delete activeThemeDoc.palettes;
                    }
                    docCache.set(activeThemeDoc.name, activeThemeDoc);
                    onPalettesApplied?.(activeThemeDoc.name, nextPalettes);
                    if (prevStr !== nextStr) {
                        queuePatch(
                            activeThemeDoc.name,
                            { palettes: nextPalettes ?? null },
                            { palettes: { had: hadPrevPalettes, value: prevRawPalettes } },
                        );
                    }
                    return;
                }
                detachedPalettes = nextPalettes;
                onPalettesApplied?.('', nextPalettes);
            },
        });
    }

    function applyCustomStyleTag(cssText) {
        const doc = getDocument();
        if (!doc?.head || typeof doc.getElementById !== 'function') {
            return;
        }
        let style = doc.getElementById(CUSTOM_STYLE_ID);
        if (!style) {
            style = doc.createElement('style');
            style.setAttribute('type', 'text/css');
            style.setAttribute('id', CUSTOM_STYLE_ID);
            doc.head.appendChild(style);
        }
        const nextText = String(cssText ?? '');
        if (style.textContent !== nextText) {
            style.textContent = nextText;
        }
    }

    function mountBuiltinStylesheet(stylesheetPath) {
        const doc = getDocument();
        if (!doc?.head || typeof doc.getElementById !== 'function') {
            return Promise.resolve();
        }
        const existing = doc.getElementById(BUILTIN_THEME_STYLE_ID);
        if (typeof stylesheetPath !== 'string' || !stylesheetPath) {
            if (existing) {
                existing.remove();
            }
            return Promise.resolve();
        }

        const customStyle = doc.getElementById(CUSTOM_STYLE_ID);
        if (existing && existing.getAttribute('href') === stylesheetPath) {
            if (customStyle && existing.nextSibling !== customStyle) {
                doc.head.insertBefore(existing, customStyle);
            }
            return Promise.resolve();
        }

        if (existing) {
            existing.remove();
        }

        const link = doc.createElement('link');
        link.setAttribute('id', BUILTIN_THEME_STYLE_ID);
        link.setAttribute('rel', 'stylesheet');
        link.setAttribute('type', 'text/css');
        link.setAttribute('href', stylesheetPath);

        const loadPromise = new Promise((resolve, reject) => {
            if (typeof link.addEventListener !== 'function') {
                resolve();
                return;
            }
            link.addEventListener('load', () => {
                onStylesheetLoaded?.(stylesheetPath);
                resolve();
            }, { once: true });
            link.addEventListener('error', () => {
                link.remove();
                reject(new Error(`Failed to load built-in theme stylesheet "${stylesheetPath}"`));
            }, { once: true });
        });

        if (customStyle) {
            doc.head.insertBefore(link, customStyle);
        } else {
            doc.head.appendChild(link);
        }
        return loadPromise;
    }

    function suggestDerivedThemeName(sourceName, suffix = 'Copy') {
        const cleanBase = String(sourceName || 'Theme').trim() || 'Theme';
        let candidate = `${cleanBase} (${suffix})`;
        let counter = 2;
        while (directory.has(candidate)) {
            candidate = `${cleanBase} (${suffix} ${counter})`;
            counter += 1;
        }
        return candidate;
    }

    /**
     * Builds a completely independent, self-contained theme object from a source
     * theme (whether built-in or external/user). Built-in stylesheets are
     * snapshotted into `custom_css` and all built-in metadata is stripped so the
     * derived theme never stays coupled to its source.
     */
    async function buildIndependentThemeSnapshot({ name, baseFields, sourceTheme }) {
        const snapshot = {
            ...stripInternalFields(baseFields),
            name,
        };

        let resolvedCss = '';
        if (sourceTheme?.builtin_stylesheet) {
            resolvedCss = await fetchStylesheet(sourceTheme.builtin_stylesheet);
        } else if (typeof sourceTheme?.custom_css === 'string') {
            resolvedCss = sourceTheme.custom_css;
        } else if (typeof baseFields?.custom_css === 'string') {
            resolvedCss = baseFields.custom_css;
        }
        snapshot.custom_css = resolvedCss;

        const normalizedPalettes = normalizePalettes(sourceTheme?.palettes ?? baseFields?.palettes);
        if (normalizedPalettes) {
            snapshot.palettes = cloneJson(normalizedPalettes);
        } else {
            delete snapshot.palettes;
        }

        return snapshot;
    }

    return {
        hydrateFromSettingsData,
        listThemeEntries,
        listThemeNames,
        hasTheme,
        isBuiltin,
        isActiveThemeBuiltin,
        getCachedTheme,
        getActiveTheme,
        ensureThemeLoaded,
        setActiveTheme,
        registerSavedTheme,
        removeDeletedTheme,
        flushPendingPatch,
        installPowerUserProxies,
        applyCustomStyleTag,
        mountBuiltinStylesheet,
        suggestDerivedThemeName,
        buildIndependentThemeSnapshot,
    };
}
