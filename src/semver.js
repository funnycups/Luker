/**
 * @typedef {{ core: number[], prerelease: Array<number | string> | null }} ParsedSemverLikeVersion
 */

/**
 * Parses a version tag or string into numeric core segments and prerelease
 * identifiers. A leading `v` and build metadata are ignored.
 * @param {string} input
 * @returns {ParsedSemverLikeVersion | null}
 */
export function parseSemverLikeVersion(input) {
    const raw = String(input || '').trim().replace(/^v/i, '');
    const match = raw.match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
    if (!match) {
        return null;
    }

    const core = match[1].split('.').map(segment => Number(segment));
    if (core.some(segment => !Number.isInteger(segment) || segment < 0)) {
        return null;
    }

    const prerelease = match[2]
        ? match[2]
            .split('.')
            .filter(Boolean)
            .map(identifier => /^\d+$/.test(identifier) ? Number(identifier) : identifier)
        : null;

    return { core, prerelease };
}

/**
 * @param {number[] | null | undefined} a
 * @param {number[] | null | undefined} b
 * @returns {number}
 */
function compareNumericSegments(a, b) {
    const maxLength = Math.max(a?.length || 0, b?.length || 0);
    for (let i = 0; i < maxLength; i++) {
        const av = a?.[i] ?? 0;
        const bv = b?.[i] ?? 0;
        if (av > bv) return 1;
        if (av < bv) return -1;
    }
    return 0;
}

/**
 * @param {Array<number | string> | null | undefined} a
 * @param {Array<number | string> | null | undefined} b
 * @returns {number}
 */
function comparePrereleaseIdentifiers(a, b) {
    const left = Array.isArray(a) ? a : null;
    const right = Array.isArray(b) ? b : null;

    if (!left?.length && !right?.length) return 0;
    if (!left?.length) return 1;
    if (!right?.length) return -1;

    const maxLength = Math.max(left.length, right.length);
    for (let i = 0; i < maxLength; i++) {
        const av = left[i];
        const bv = right[i];
        if (av === undefined) return -1;
        if (bv === undefined) return 1;
        if (av === bv) continue;

        const aIsNumber = typeof av === 'number';
        const bIsNumber = typeof bv === 'number';
        if (aIsNumber && bIsNumber) return av > bv ? 1 : -1;
        if (aIsNumber !== bIsNumber) return aIsNumber ? -1 : 1;

        const lexical = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
        if (lexical !== 0) return lexical > 0 ? 1 : -1;
    }

    return 0;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareSemver(a, b) {
    const pa = parseSemverLikeVersion(a);
    const pb = parseSemverLikeVersion(b);
    if (!pa && !pb) return 0;
    if (!pa) return -1;
    if (!pb) return 1;

    const coreComparison = compareNumericSegments(pa.core, pb.core);
    if (coreComparison !== 0) {
        return coreComparison;
    }

    return comparePrereleaseIdentifiers(pa.prerelease, pb.prerelease);
}
