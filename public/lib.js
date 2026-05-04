/**
 * Library facade for Luker frontend modules.
 *
 * Core libraries are bundled into /lib.core.bundle.js and loaded synchronously.
 * Heavier or less common libraries live in /lib.optional.bundle.js and are
 * loaded on demand via async helpers.
 */
import coreBundle, {
    lodash,
    Fuse,
    DOMPurify,
    hljs,
    localforage,
    Handlebars,
    css,
    Bowser,
    DiffMatchPatch,
    SVGInject,
    showdown,
    moment,
    seedrandom,
    Popper,
    droll,
    morphdom,
    slideToggle,
    chalk,
    yaml,
    chevrotain,
    gzipSync,
    gzip,
    sha256,
} from './lib.core.bundle.js';

let optionalBundlePromise = null;

async function loadOptionalBundle() {
    if (optionalBundlePromise) {
        return optionalBundlePromise;
    }

    optionalBundlePromise = import('./lib.optional.bundle.js');
    return optionalBundlePromise;
}

export async function getReadability() {
    const { Readability, isProbablyReaderable } = await loadOptionalBundle();
    return { Readability, isProbablyReaderable };
}

export async function getDiff2Html() {
    const { diff2htmlHtml } = await loadOptionalBundle();
    return diff2htmlHtml;
}

/**
 * Expose the libraries to the 'window' object.
 * Needed for compatibility with old extensions.
 * Note: New extensions are encouraged to import the libraries directly from lib.js.
 */
export function initLibraryShims() {
    if (!window) {
        return;
    }
    if (!('Fuse' in window)) {
        // @ts-ignore
        window.Fuse = Fuse;
    }
    if (!('DOMPurify' in window)) {
        // @ts-ignore
        window.DOMPurify = DOMPurify;
    }
    if (!('hljs' in window)) {
        // @ts-ignore
        window.hljs = hljs;
    }
    if (!('localforage' in window)) {
        // @ts-ignore
        window.localforage = localforage;
    }
    if (!('Handlebars' in window)) {
        // @ts-ignore
        window.Handlebars = Handlebars;
    }
    if (!('diff_match_patch' in window)) {
        // @ts-ignore
        window.diff_match_patch = DiffMatchPatch;
    }
    if (!('SVGInject' in window)) {
        // @ts-ignore
        window.SVGInject = SVGInject;
    }
    if (!('showdown' in window)) {
        // @ts-ignore
        window.showdown = showdown;
    }
    if (!('moment' in window)) {
        // @ts-ignore
        window.moment = moment;
    }
    if (!('Popper' in window)) {
        // @ts-ignore
        window.Popper = Popper;
    }
    if (!('droll' in window)) {
        // @ts-ignore
        window.droll = droll;
    }
}

export default {
    ...coreBundle,
    getReadability,
    getDiff2Html,
    gzipSync,
    gzip,
    sha256,
};

export {
    lodash,
    Fuse,
    DOMPurify,
    hljs,
    localforage,
    Handlebars,
    css,
    Bowser,
    DiffMatchPatch,
    SVGInject,
    showdown,
    moment,
    seedrandom,
    Popper,
    droll,
    morphdom,
    slideToggle,
    chalk,
    yaml,
    chevrotain,
    gzipSync,
    gzip,
    sha256,
};
