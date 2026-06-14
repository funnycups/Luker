/**
 * Jest stub for public/lib.js.
 *
 * The real lib.js eagerly evaluates UMD bundles that touch `window` and
 * `document.createElement` at module-load time (notably @iconfu/svg-inject),
 * which throws under jest's node env. We can't stub `document` globally
 * without breaking other libraries (@agnai/web-tokenizers picks a runtime
 * branch based on whether `document` exists), so we redirect `public/lib.js`
 * through `moduleNameMapper` to this file instead.
 *
 * Re-exports the same surface as public/lib.js but pulls each library
 * directly from npm and omits the DOM-only ones (SVGInject is the only
 * outright unsafe one; the rest are pulled in transitively but never
 * actually evaluate their UMD initialiser without `document`).
 *
 * Tests that need a specific export tweaked can still
 * `jest.unstable_mockModule('../../public/lib.js', ...)` to override.
 */

import lodash from 'lodash';
import Fuse from 'fuse.js';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import localforage from 'localforage';
import Handlebars from 'handlebars';
import css from '@adobe/css-tools';
import Bowser from 'bowser';
import DiffMatchPatch from 'diff-match-patch';
import showdown from 'showdown';
import moment from 'moment';
import seedrandom from 'seedrandom';
import * as Popper from '@popperjs/core';
import droll from 'droll';
import chalk from 'chalk';
import yaml from 'yaml';
import * as chevrotain from 'chevrotain';
import { gzipSync, gzip } from 'fflate';
import { sha256 } from 'js-sha256';

// SVGInject + slideToggle + morphdom touch the DOM at module-load. Provide
// no-op stubs so tests that only import the symbol don't fail; nothing under
// test exercises their behaviour.
const SVGInject = () => {};
const slideToggle = () => {};
const morphdom = (from, to) => to;

const libBundle = {
    lodash, Fuse, DOMPurify, hljs, localforage, Handlebars, css, Bowser,
    DiffMatchPatch, SVGInject, showdown, moment, seedrandom, Popper, droll,
    morphdom, slideToggle, chalk, yaml, chevrotain, gzipSync, gzip, sha256,
    initialized: true,
};

export {
    lodash, Fuse, DOMPurify, hljs, localforage, Handlebars, css, Bowser,
    DiffMatchPatch, SVGInject, showdown, moment, seedrandom, Popper, droll,
    morphdom, slideToggle, chalk, yaml, chevrotain, gzipSync, gzip, sha256,
};

export default libBundle;

// Mirror lib.js's async optional-bundle helpers; nothing in tests exercises
// these, but we keep the signature so anything that grabs the reference
// at module load doesn't crash.
export async function getReadability() { return { Readability: null, isProbablyReaderable: () => false }; }
export async function getDiff2Html() { return () => ''; }
export function initLibraryShims() {}
