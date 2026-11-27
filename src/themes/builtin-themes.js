import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { serverDirectory } from '../server-directory.js';

const BUILTIN_THEMES_DIR = path.join(serverDirectory, 'default/content/themes');
const PUBLIC_DIR = path.join(serverDirectory, 'public');
const BUILTIN_STYLESHEETS_DIR = path.join(PUBLIC_DIR, 'css/themes');
const BUILTIN_STYLESHEET_PREFIX = 'css/themes/';

// SHA-256 digests of every historically shipped built-in Lens `custom_css` payload
// before Lens moved to a static managed stylesheet (`public/css/themes/lens.css`).
export const LEGACY_LENS_CSS_SHA256 = Object.freeze(new Set([
    // v2.9.0-rc.4 (60c5fe57c)
    '1b05a59f2e8f228110bb6eb68548b73c432d3957b5e226213990b571a56be93c',
    // PR #75 stop-button centering fix (0694aad71)
    'e1750df01e32153710518588622a700e114ace8aba4e0295d2879f592e01f766',
]));

/** @type {{ byName: Map<string, Record<string, any>>, sortedNames: string[] } | null} */
let cachedRegistry = null;

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function deepEqualJson(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!deepEqualJson(a[i], b[i])) return false;
        }
        return true;
    }
    if (isPlainObject(a) && isPlainObject(b)) {
        const aKeys = Object.keys(a).filter(k => a[k] !== undefined);
        const bKeys = Object.keys(b).filter(k => b[k] !== undefined);
        if (aKeys.length !== bKeys.length) return false;
        for (const key of aKeys) {
            if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
            if (!deepEqualJson(a[key], b[key])) return false;
        }
        return true;
    }
    return false;
}

export function hashThemeCss(css) {
    return crypto.createHash('sha256').update(String(css ?? ''), 'utf8').digest('hex');
}

export function isLegacyShippedLensCss(css) {
    if (typeof css !== 'string' || css.length === 0) {
        return false;
    }
    return LEGACY_LENS_CSS_SHA256.has(hashThemeCss(css));
}

export function isValidBuiltinStylesheetPath(relPath) {
    if (typeof relPath !== 'string' || !relPath.startsWith(BUILTIN_STYLESHEET_PREFIX) || !relPath.endsWith('.css')) {
        return false;
    }
    const normalized = path.posix.normalize(relPath);
    if (normalized !== relPath || normalized.includes('..')) {
        return false;
    }
    const resolved = path.resolve(PUBLIC_DIR, normalized);
    const relativeToDir = path.relative(BUILTIN_STYLESHEETS_DIR, resolved);
    return Boolean(relativeToDir) && !relativeToDir.startsWith('..') && !path.isAbsolute(relativeToDir);
}

/**
 * Strips server-managed built-in metadata before persisting a user theme so
 * derived and imported themes remain completely independent and self-contained.
 * @param {Record<string, any>} doc
 * @returns {Record<string, any>}
 */
export function stripInternalThemeFields(doc) {
    if (!isPlainObject(doc)) {
        return {};
    }
    const copy = { ...doc };
    delete copy.builtin;
    delete copy.builtin_stylesheet;
    return copy;
}

function loadRegistry() {
    if (cachedRegistry) {
        return cachedRegistry;
    }
    const byName = new Map();
    if (fs.existsSync(BUILTIN_THEMES_DIR)) {
        const files = fs.readdirSync(BUILTIN_THEMES_DIR)
            .filter(file => file.endsWith('.json'))
            .sort((a, b) => a.localeCompare(b));
        for (const file of files) {
            const fullPath = path.join(BUILTIN_THEMES_DIR, file);
            const raw = fs.readFileSync(fullPath, 'utf8');
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (err) {
                throw new Error(`Invalid built-in theme JSON at ${fullPath}: ${err.message}`, { cause: err });
            }
            if (!isPlainObject(parsed)) {
                throw new Error(`Built-in theme ${fullPath} must contain a JSON object`);
            }
            const name = typeof parsed.name === 'string' && parsed.name.trim()
                ? parsed.name.trim()
                : path.parse(file).name;
            const doc = { ...parsed, name, builtin: true };
            if (doc.builtin_stylesheet !== undefined && !isValidBuiltinStylesheetPath(doc.builtin_stylesheet)) {
                throw new Error(`Invalid builtin_stylesheet "${doc.builtin_stylesheet}" in built-in theme "${name}" (${fullPath})`);
            }
            byName.set(name, doc);
        }
    }
    const sortedNames = [...byName.keys()].sort((a, b) => a.localeCompare(b));
    cachedRegistry = { byName, sortedNames };
    return cachedRegistry;
}

// Warm the built-in theme registry at module load so single-document reads never
// trigger directory scans on request paths.
loadRegistry();

export function listBuiltinThemeNames() {
    return [...loadRegistry().sortedNames];
}

export function isBuiltinThemeName(name) {
    if (typeof name !== 'string' || !name) {
        return false;
    }
    return loadRegistry().byName.has(name);
}

export function getBuiltinTheme(name) {
    if (typeof name !== 'string' || !name) {
        return null;
    }
    const doc = loadRegistry().byName.get(name);
    return doc ? JSON.parse(JSON.stringify(doc)) : null;
}

export function listBuiltinThemes() {
    const { byName, sortedNames } = loadRegistry();
    return sortedNames.map(name => JSON.parse(JSON.stringify(byName.get(name))));
}

export function getBuiltinThemeStylesheetText(themeDoc) {
    const relPath = themeDoc?.builtin_stylesheet;
    if (relPath === undefined || relPath === null || relPath === '') {
        return '';
    }
    if (!isValidBuiltinStylesheetPath(relPath)) {
        throw new Error(`Invalid built-in theme stylesheet path "${relPath}"`);
    }
    const fullPath = path.resolve(PUBLIC_DIR, relPath);
    return fs.readFileSync(fullPath, 'utf8');
}

/**
 * Checks whether a theme document stored inside a user's `themes` bucket with a
 * built-in theme's name is an unmodified copy of an older seeded built-in theme.
 * @param {string} name Built-in theme name
 * @param {unknown} userDoc Document read from NamedDocRepo
 * @returns {boolean}
 */
export function isUnmodifiedLegacyBuiltinTheme(name, userDoc) {
    const builtin = getBuiltinTheme(name);
    if (!builtin || !isPlainObject(userDoc)) {
        return false;
    }

    const userComparable = stripInternalThemeFields(userDoc);
    const builtinComparable = stripInternalThemeFields(builtin);
    const userCss = typeof userComparable.custom_css === 'string' ? userComparable.custom_css : '';
    const builtinCss = typeof builtinComparable.custom_css === 'string' ? builtinComparable.custom_css : '';

    delete userComparable.custom_css;
    delete builtinComparable.custom_css;

    if (!deepEqualJson(userComparable, builtinComparable)) {
        return false;
    }

    if (builtin.builtin_stylesheet) {
        if (userCss === '' || isLegacyShippedLensCss(userCss)) {
            return true;
        }
        const currentStylesheet = getBuiltinThemeStylesheetText(builtin);
        return Boolean(currentStylesheet) && userCss === currentStylesheet;
    }

    return userCss === builtinCss;
}
