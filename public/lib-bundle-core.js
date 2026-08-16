import lodash from 'lodash';
import Fuse from 'fuse.js';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import localforage from 'localforage';
import Handlebars from 'handlebars';
import css from '@adobe/css-tools';
import Bowser from 'bowser';
import DiffMatchPatch from 'diff-match-patch';
import SVGInject from '@iconfu/svg-inject';
import showdown from 'showdown';
import moment from 'moment';
import seedrandom from 'seedrandom';
import * as PopperCore from '@popperjs/core';
import droll from 'droll';
import morphdom from 'morphdom';
import { toggle as slideToggle } from 'slidetoggle';
import chalk from 'chalk';
import yaml from 'yaml';
import * as ChevrotainCore from 'chevrotain';
import { gzipSync, gzip } from 'fflate';
import { sha256 } from 'js-sha256';

// Materialize namespace imports so Webpack treats them as local values instead
// of namespace re-exports. The plain objects also match the legacy globals.
const Popper = { ...PopperCore };
const chevrotain = { ...ChevrotainCore };

const libBundle = {
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
    initialized: true,
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

export default libBundle;
