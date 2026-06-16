export const SIDECAR_INFIX = '.luker-state.';
export const SIDECAR_EXT = '.json';

export function buildSidecarFilename(base, namespace) {
    return `${base}${SIDECAR_INFIX}${namespace}${SIDECAR_EXT}`;
}

export function parseSidecarFilename(entry, base) {
    const prefix = `${base}${SIDECAR_INFIX}`;
    if (!entry.startsWith(prefix) || !entry.endsWith(SIDECAR_EXT)) return null;
    return entry.slice(prefix.length, entry.length - SIDECAR_EXT.length);
}
