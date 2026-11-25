// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from '@jest/globals';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerLensSharedLocaleData } from '../../public/scripts/lens-shared/locale-data.js';
import { registerLocaleData as registerMemoryGraphLocaleData } from '../../public/scripts/extensions/memory-graph/i18n.js';
import { registerLocaleData as registerOrchestratorLocaleData } from '../../public/scripts/extensions/orchestrator/i18n.js';
import { registerWorkbenchLocaleData } from '../../public/scripts/workbench/locale-data.js';
import { SEARCH_PROVIDERS } from '../../public/scripts/extensions/search-tools/providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const PUBLIC_SCRIPTS_DIR = resolve(REPO_ROOT, 'public/scripts');

const EXPECTED_SUMMARY_MODELS = [
    'public/scripts/extensions/caption/behavior-summary-model.js',
    'public/scripts/extensions/character-editor-assistant/behavior-summary-model.js',
    'public/scripts/extensions/completion-preset-assistant/behavior-summary-model.js',
    'public/scripts/extensions/connection-manager/behavior-summary-models.js',
    'public/scripts/extensions/expressions/behavior-summary-model.js',
    'public/scripts/extensions/hook-order/behavior-summary-model.js',
    'public/scripts/extensions/memory-graph/lens/settings/behavior-summary-models.js',
    'public/scripts/extensions/orchestrator/lens/model/behavior-summary-models.js',
    'public/scripts/extensions/quick-reply/src/behavior-summary-models.js',
    'public/scripts/extensions/regex/behavior-summary-model.js',
    'public/scripts/extensions/search-tools/behavior-summary-models.js',
    'public/scripts/extensions/stable-diffusion/behavior-summary-models.js',
    'public/scripts/extensions/translate/behavior-summary-model.js',
    'public/scripts/extensions/tts/behavior-summary-models.js',
    'public/scripts/extensions/vectors/behavior-summary-models.js',
    'public/scripts/workbench/model/behavior-summary-models.js',
];

const MOUNTING_UI_FILES = {
    'public/scripts/extensions/caption/behavior-summary-model.js': [
        'public/scripts/extensions/caption/index.js',
    ],
    'public/scripts/extensions/character-editor-assistant/behavior-summary-model.js': [
        'public/scripts/extensions/character-editor-assistant/editor-ui.js',
    ],
    'public/scripts/extensions/completion-preset-assistant/behavior-summary-model.js': [
        'public/scripts/extensions/completion-preset-assistant/main.js',
    ],
    'public/scripts/extensions/connection-manager/behavior-summary-models.js': [
        'public/scripts/extensions/connection-manager/index.js',
    ],
    'public/scripts/extensions/expressions/behavior-summary-model.js': [
        'public/scripts/extensions/expressions/index.js',
    ],
    'public/scripts/extensions/hook-order/behavior-summary-model.js': [
        'public/scripts/extensions/hook-order/index.js',
    ],
    'public/scripts/extensions/memory-graph/lens/settings/behavior-summary-models.js': [
        'public/scripts/extensions/memory-graph/lens/settings/settings-view.js',
        'public/scripts/extensions/memory-graph/lens/schema/schema-view.js',
    ],
    'public/scripts/extensions/orchestrator/lens/model/behavior-summary-models.js': [
        'public/scripts/extensions/orchestrator/lens/views/settings-view.js',
        'public/scripts/extensions/orchestrator/lens/views/setup-view.js',
    ],
    'public/scripts/extensions/quick-reply/src/behavior-summary-models.js': [
        'public/scripts/extensions/quick-reply/src/ui/SettingsUi.js',
    ],
    'public/scripts/extensions/regex/behavior-summary-model.js': [
        'public/scripts/extensions/regex/index.js',
    ],
    'public/scripts/extensions/search-tools/behavior-summary-models.js': [
        'public/scripts/extensions/search-tools/settings-ui.js',
    ],
    'public/scripts/extensions/stable-diffusion/behavior-summary-models.js': [
        'public/scripts/extensions/stable-diffusion/index.js',
        'public/scripts/extensions/stable-diffusion/illustration/settings-ui.js',
    ],
    'public/scripts/extensions/translate/behavior-summary-model.js': [
        'public/scripts/extensions/translate/index.js',
    ],
    'public/scripts/extensions/tts/behavior-summary-models.js': [
        'public/scripts/extensions/tts/index.js',
    ],
    'public/scripts/extensions/vectors/behavior-summary-models.js': [
        'public/scripts/extensions/vectors/index.js',
    ],
    'public/scripts/workbench/model/behavior-summary-models.js': [
        'public/scripts/workbench/pages/settings.js',
    ],
};

const MIN_KEYS_BY_MODEL = {
    'public/scripts/extensions/caption/behavior-summary-model.js': 40,
    'public/scripts/extensions/character-editor-assistant/behavior-summary-model.js': 4,
    'public/scripts/extensions/completion-preset-assistant/behavior-summary-model.js': 4,
    'public/scripts/extensions/connection-manager/behavior-summary-models.js': 70,
    'public/scripts/extensions/expressions/behavior-summary-model.js': 25,
    'public/scripts/extensions/hook-order/behavior-summary-model.js': 4,
    'public/scripts/extensions/memory-graph/lens/settings/behavior-summary-models.js': 100,
    'public/scripts/extensions/orchestrator/lens/model/behavior-summary-models.js': 70,
    'public/scripts/extensions/quick-reply/src/behavior-summary-models.js': 25,
    'public/scripts/extensions/regex/behavior-summary-model.js': 50,
    'public/scripts/extensions/search-tools/behavior-summary-models.js': 45,
    'public/scripts/extensions/stable-diffusion/behavior-summary-models.js': 65,
    'public/scripts/extensions/translate/behavior-summary-model.js': 25,
    'public/scripts/extensions/tts/behavior-summary-models.js': 55,
    'public/scripts/extensions/vectors/behavior-summary-models.js': 75,
    'public/scripts/workbench/model/behavior-summary-models.js': 25,
};

const ALLOWED_NON_LITERAL_TRANSLATIONS = {
    'public/scripts/extensions/memory-graph/lens/settings/behavior-summary-models.js': [
        'i18n(fallbackLabelKey)',
    ],
    'public/scripts/extensions/search-tools/behavior-summary-models.js': [
        'i18n(providerDef.label)',
    ],
};

const TRANSLATOR_NAMES = new Set(['translate', 'translateSummary', 'i18n', 'i18nFormat']);
const MOUNT_FN_NAMES = new Set(['mountBehaviorSummary', 'createBehaviorSummary']);
const PLACEHOLDER_RE = /\$\{([a-zA-Z0-9_]+)\}/g;
const UNESCAPED_SEMICOLON_RE = /(?<!\\);/;
const CJK_HALF_WIDTH_PUNCT_RE = /[\u3400-\u9fff][,.;:!?()]|[,.;:!?()][\u3400-\u9fff]/;

function walkSummaryModelFiles(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'vendor') {
                continue;
            }
            found.push(...walkSummaryModelFiles(fullPath));
            continue;
        }
        if (entry.isFile() && /^behavior-summary-models?\.js$/.test(entry.name)) {
            found.push(relative(REPO_ROOT, fullPath).replaceAll('\\', '/'));
        }
    }
    return found.sort();
}

function collectViaRegister(registerFn) {
    const store = { 'zh-cn': {}, 'zh-tw': {} };
    registerFn((lang, data) => {
        store[lang] = { ...(store[lang] || {}), ...data };
    });
    return store;
}

function skipWsAndComments(src, pos) {
    let i = pos;
    while (i < src.length) {
        if (/\s/.test(src[i])) {
            i++;
            continue;
        }
        if (src[i] === '/' && src[i + 1] === '/') {
            i += 2;
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (src[i] === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        break;
    }
    return i;
}

function skipQuotedOrTemplateLiteral(src, pos) {
    const q = src[pos];
    let i = pos + 1;
    while (i < src.length) {
        if (src[i] === '\\') {
            i += 2;
            continue;
        }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
            i += 2;
            let depth = 1;
            while (i < src.length && depth > 0) {
                const next = skipWsAndComments(src, i);
                if (next !== i) {
                    i = next;
                    continue;
                }
                const ch = src[i];
                if (ch === '\'' || ch === '"' || ch === '`') {
                    i = skipQuotedOrTemplateLiteral(src, i);
                    continue;
                }
                if (ch === '{') depth++;
                else if (ch === '}') depth--;
                i++;
            }
            continue;
        }
        if (src[i] === q) {
            return i + 1;
        }
        i++;
    }
    return src.length;
}

function skipRegexLiteral(src, pos) {
    let i = pos + 1;
    let inCharClass = false;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === '[' && !inCharClass) {
            inCharClass = true;
            i++;
            continue;
        }
        if (ch === ']' && inCharClass) {
            inCharClass = false;
            i++;
            continue;
        }
        if (ch === '\n' || ch === '\r') {
            return pos + 1;
        }
        if (ch === '/' && !inCharClass) {
            i++;
            while (i < src.length && /[a-zA-Z]/.test(src[i])) i++;
            return i;
        }
        i++;
    }
    return pos + 1;
}

const REGEX_PRECEDING_KEYWORDS = new Set([
    'return', 'throw', 'case', 'in', 'instanceof', 'typeof', 'void', 'delete', 'new', 'else', 'do', 'yield', 'await',
]);

function canPrecedeRegex(src, slashIndex, lastToken) {
    if (!lastToken) return true;
    if (lastToken.type === 'word') {
        return REGEX_PRECEDING_KEYWORDS.has(lastToken.value);
    }
    return /^([([{,;:=!?&|~^+\-*%<>]|=>)$/.test(lastToken.value);
}

function readStaticStringLiteral(src, pos) {
    const q = src[pos];
    if (q !== '\'' && q !== '"' && q !== '`') return null;
    if (q === '`') {
        let j = pos + 1;
        while (j < src.length) {
            if (src[j] === '\\') {
                j += 2;
                continue;
            }
            if (src[j] === '$' && src[j + 1] === '{') return null;
            if (src[j] === '`') {
                const raw = src.slice(pos, j + 1);
                return { value: (new Function(`return ${raw};`))(), nextPos: j + 1 };
            }
            j++;
        }
        return null;
    }
    let j = pos + 1;
    while (j < src.length) {
        if (src[j] === '\\') {
            j += 2;
            continue;
        }
        if (src[j] === q) {
            j++;
            break;
        }
        j++;
    }
    const raw = src.slice(pos, j);
    return { value: (new Function(`return ${raw};`))(), nextPos: j };
}

function readBalancedSlice(src, openIndex, openChar, closeChar) {
    if (src[openIndex] !== openChar) return null;
    let i = openIndex;
    let depth = 0;
    let lastToken = null;
    while (i < src.length) {
        const wsEnd = skipWsAndComments(src, i);
        if (wsEnd !== i) {
            i = wsEnd;
            continue;
        }
        const ch = src[i];
        if (ch === '\'' || ch === '"' || ch === '`') {
            i = skipQuotedOrTemplateLiteral(src, i);
            lastToken = { type: 'literal', value: qToken(ch) };
            continue;
        }
        if (ch === '/' && canPrecedeRegex(src, i, lastToken)) {
            i = skipRegexLiteral(src, i);
            lastToken = { type: 'literal', value: '/' };
            continue;
        }
        if (ch === openChar) {
            depth++;
            lastToken = { type: 'punct', value: ch };
            i++;
            continue;
        }
        if (ch === closeChar) {
            depth--;
            i++;
            if (depth === 0) {
                return { text: src.slice(openIndex, i), endIndex: i };
            }
            lastToken = { type: 'punct', value: ch };
            continue;
        }
        if (/[a-zA-Z_$]/.test(ch)) {
            const start = i;
            while (i < src.length && /[a-zA-Z0-9_$]/.test(src[i])) i++;
            lastToken = { type: 'word', value: src.slice(start, i) };
            continue;
        }
        if (ch === '=' && src[i + 1] === '>') {
            lastToken = { type: 'punct', value: '=>' };
            i += 2;
            continue;
        }
        lastToken = { type: 'punct', value: ch };
        i++;
    }
    return null;
}

function qToken(ch) {
    return ch;
}

function readTranslatorCallAt(src, pos) {
    const start = pos;
    if (!/[a-zA-Z_$]/.test(src[pos])) return null;
    let i = pos;
    while (i < src.length && /[a-zA-Z0-9_$]/.test(src[i])) i++;
    const ident = src.slice(start, i);
    if (!TRANSLATOR_NAMES.has(ident)) return null;
    const prevPrefix = src.slice(Math.max(0, start - 20), start);
    if (/\bfunction\s+$/.test(prevPrefix)) return null;

    const afterIdent = i;
    i = skipWsAndComments(src, i);
    if (src[i] !== '(') return null;
    const openParen = i;
    i = skipWsAndComments(src, i + 1);
    const arg1 = readStaticStringLiteral(src, i);
    if (!arg1) {
        const balanced = readBalancedSlice(src, openParen, '(', ')');
        return {
            literal: false,
            raw: `${ident}${balanced ? balanced.text.replace(/\s+/g, ' ').trim() : '()'}`,
            nextPos: afterIdent,
        };
    }
    i = skipWsAndComments(src, arg1.nextPos);
    let arg2 = null;
    if (src[i] === ',') {
        i = skipWsAndComments(src, i + 1);
        const lit2 = readStaticStringLiteral(src, i);
        if (lit2) {
            arg2 = lit2.value;
            i = lit2.nextPos;
        }
    }
    return {
        literal: true,
        call: { fn: ident, arg1: arg1.value, arg2 },
        nextPos: i,
    };
}

function extractAddedLocaleDataFromSource(relPath) {
    const src = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
    const store = {};
    for (const [lang, constName] of [['zh-cn', 'ZH_CN'], ['zh-tw', 'ZH_TW']]) {
        const addMarker = new RegExp(`addLocaleData\\s*\\(\\s*['"]${lang}['"]\\s*,\\s*\\{`);
        const constMarker = new RegExp(`const\\s+${constName}\\s*=\\s*\\{`);
        const match = addMarker.exec(src) || constMarker.exec(src);
        if (!match) {
            throw new Error(`Missing locale table for '${lang}' in ${relPath}`);
        }
        const openBraceIndex = match.index + match[0].length - 1;
        const balanced = readBalancedSlice(src, openBraceIndex, '{', '}');
        if (!balanced) {
            throw new Error(`Unterminated locale table for '${lang}' in ${relPath}`);
        }
        store[lang] = (new Function(`return (${balanced.text});`))();
    }
    return store;
}

function extractTranslatorCallsFromFile(relPath) {
    const src = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
    const calls = [];
    const nonLiteralCalls = [];
    let i = 0;
    let lastToken = null;

    while (i < src.length) {
        const wsEnd = skipWsAndComments(src, i);
        if (wsEnd !== i) {
            i = wsEnd;
            continue;
        }
        const ch = src[i];
        if (ch === '\'' || ch === '"' || ch === '`') {
            i = skipQuotedOrTemplateLiteral(src, i);
            lastToken = { type: 'literal', value: ch };
            continue;
        }
        if (ch === '/' && canPrecedeRegex(src, i, lastToken)) {
            i = skipRegexLiteral(src, i);
            lastToken = { type: 'literal', value: '/' };
            continue;
        }
        if (/[a-zA-Z_$]/.test(ch) && (i === 0 || !/[a-zA-Z0-9_$.]/.test(src[i - 1]))) {
            const parsed = readTranslatorCallAt(src, i);
            if (parsed) {
                if (parsed.literal) {
                    calls.push(parsed.call);
                } else {
                    nonLiteralCalls.push(parsed.raw);
                }
                i = parsed.nextPos;
                lastToken = { type: 'word', value: 'call' };
                continue;
            }
            const start = i;
            while (i < src.length && /[a-zA-Z0-9_$]/.test(src[i])) i++;
            lastToken = { type: 'word', value: src.slice(start, i) };
            continue;
        }
        if (ch === '=' && src[i + 1] === '>') {
            lastToken = { type: 'punct', value: '=>' };
            i += 2;
            continue;
        }
        lastToken = { type: 'punct', value: ch };
        i++;
    }

    return { calls, nonLiteralCalls };
}

function extractAriaLabelFromOptionsObject(optionsObjText) {
    let i = skipWsAndComments(optionsObjText, 1);
    let depth = 1;
    let lastToken = null;

    while (i < optionsObjText.length && depth > 0) {
        const wsEnd = skipWsAndComments(optionsObjText, i);
        if (wsEnd !== i) {
            i = wsEnd;
            continue;
        }
        const ch = optionsObjText[i];
        if (ch === '\'' || ch === '"' || ch === '`') {
            i = skipQuotedOrTemplateLiteral(optionsObjText, i);
            lastToken = { type: 'literal', value: ch };
            continue;
        }
        if (ch === '/' && canPrecedeRegex(optionsObjText, i, lastToken)) {
            i = skipRegexLiteral(optionsObjText, i);
            lastToken = { type: 'literal', value: '/' };
            continue;
        }
        if (ch === '{' || ch === '(' || ch === '[') {
            depth++;
            lastToken = { type: 'punct', value: ch };
            i++;
            continue;
        }
        if (ch === '}' || ch === ')' || ch === ']') {
            depth--;
            lastToken = { type: 'punct', value: ch };
            i++;
            continue;
        }
        if (depth === 1 && /[a-zA-Z_$]/.test(ch) && (i === 1 || !/[a-zA-Z0-9_$.]/.test(optionsObjText[i - 1]))) {
            const start = i;
            while (i < optionsObjText.length && /[a-zA-Z0-9_$]/.test(optionsObjText[i])) i++;
            const ident = optionsObjText.slice(start, i);
            if (ident === 'ariaLabel') {
                const afterIdent = skipWsAndComments(optionsObjText, i);
                if (optionsObjText[afterIdent] === ':') {
                    const exprStart = skipWsAndComments(optionsObjText, afterIdent + 1);
                    const parsed = readTranslatorCallAt(optionsObjText, exprStart);
                    return parsed?.literal ? parsed.call : null;
                }
            }
            lastToken = { type: 'word', value: ident };
            continue;
        }
        lastToken = { type: 'punct', value: ch };
        i++;
    }

    return null;
}

function extractMountingAriaLabelCalls(relPath) {
    const src = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
    const rawCallCount = Array.from(
        src.matchAll(/(?<![.\w$])(?:mountBehaviorSummary|createBehaviorSummary)\s*\(/g),
    ).length;
    let totalCalls = 0;
    const ariaCalls = [];
    const missingAriaLabels = [];
    let i = 0;
    let lastToken = null;

    while (i < src.length) {
        const wsEnd = skipWsAndComments(src, i);
        if (wsEnd !== i) {
            i = wsEnd;
            continue;
        }
        const ch = src[i];
        if (ch === '\'' || ch === '"' || ch === '`') {
            i = skipQuotedOrTemplateLiteral(src, i);
            lastToken = { type: 'literal', value: ch };
            continue;
        }
        if (ch === '/' && canPrecedeRegex(src, i, lastToken)) {
            i = skipRegexLiteral(src, i);
            lastToken = { type: 'literal', value: '/' };
            continue;
        }
        if (/[a-zA-Z_$]/.test(ch) && (i === 0 || !/[a-zA-Z0-9_$.]/.test(src[i - 1]))) {
            const start = i;
            while (i < src.length && /[a-zA-Z0-9_$]/.test(src[i])) i++;
            const ident = src.slice(start, i);
            const prevPrefix = src.slice(Math.max(0, start - 20), start);
            const isDecl = /\bfunction\s+$/.test(prevPrefix);
            if (!isDecl && MOUNT_FN_NAMES.has(ident)) {
                const afterIdent = skipWsAndComments(src, i);
                if (src[afterIdent] === '(') {
                    const callSlice = readBalancedSlice(src, afterIdent, '(', ')');
                    if (callSlice) {
                        totalCalls++;
                        const objStart = skipWsAndComments(callSlice.text, 1);
                        const objSlice = callSlice.text[objStart] === '{'
                            ? readBalancedSlice(callSlice.text, objStart, '{', '}')
                            : null;
                        const ariaCall = objSlice ? extractAriaLabelFromOptionsObject(objSlice.text) : null;
                        if (ariaCall) {
                            ariaCalls.push(ariaCall);
                        } else {
                            missingAriaLabels.push({ file: relPath, callIndex: totalCalls });
                        }
                    }
                }
            }
            lastToken = { type: 'word', value: ident };
            continue;
        }
        if (ch === '=' && src[i + 1] === '>') {
            lastToken = { type: 'punct', value: '=>' };
            i += 2;
            continue;
        }
        lastToken = { type: 'punct', value: ch };
        i++;
    }

    return { file: relPath, rawCallCount, totalCalls, ariaCalls, missingAriaLabels };
}

function extractPlaceholders(templateText) {
    return Array.from(String(templateText).matchAll(PLACEHOLDER_RE), (m) => m[1]).sort();
}

function loadLocaleStores() {
    const publicZhCn = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-cn.json'), 'utf8'));
    const publicZhTw = JSON.parse(readFileSync(resolve(REPO_ROOT, 'public/locales/zh-tw.json'), 'utf8'));
    const lensSharedStore = collectViaRegister(registerLensSharedLocaleData);
    const mgStore = collectViaRegister(registerMemoryGraphLocaleData);
    const orchStore = collectViaRegister(registerOrchestratorLocaleData);
    const wbStore = collectViaRegister(registerWorkbenchLocaleData);
    const searchToolsStore = extractAddedLocaleDataFromSource('public/scripts/extensions/search-tools/i18n.js');
    const ceaStore = extractAddedLocaleDataFromSource('public/scripts/extensions/character-editor-assistant/i18n.js');
    const cpaStore = extractAddedLocaleDataFromSource('public/scripts/extensions/completion-preset-assistant/i18n.js');
    const hookOrderStore = extractAddedLocaleDataFromSource('public/scripts/extensions/hook-order/index.js');

    const jsonBacked = { 'zh-cn': publicZhCn, 'zh-tw': publicZhTw };
    const mergeCoreAndModule = (modStore) => ({
        'zh-cn': { ...publicZhCn, ...lensSharedStore['zh-cn'], ...modStore['zh-cn'] },
        'zh-tw': { ...publicZhTw, ...lensSharedStore['zh-tw'], ...modStore['zh-tw'] },
    });

    return {
        publicZhCn,
        publicZhTw,
        byModel: {
            'public/scripts/extensions/caption/behavior-summary-model.js': jsonBacked,
            'public/scripts/extensions/expressions/behavior-summary-model.js': jsonBacked,
            'public/scripts/extensions/quick-reply/src/behavior-summary-models.js': jsonBacked,
            'public/scripts/extensions/regex/behavior-summary-model.js': jsonBacked,
            'public/scripts/extensions/translate/behavior-summary-model.js': jsonBacked,
            'public/scripts/extensions/vectors/behavior-summary-models.js': jsonBacked,
            'public/scripts/extensions/connection-manager/behavior-summary-models.js': jsonBacked,
            'public/scripts/extensions/stable-diffusion/behavior-summary-models.js': jsonBacked,
            'public/scripts/extensions/tts/behavior-summary-models.js': jsonBacked,
            'public/scripts/extensions/memory-graph/lens/settings/behavior-summary-models.js': mergeCoreAndModule(mgStore),
            'public/scripts/extensions/orchestrator/lens/model/behavior-summary-models.js': mergeCoreAndModule(orchStore),
            'public/scripts/workbench/model/behavior-summary-models.js': mergeCoreAndModule(wbStore),
            'public/scripts/extensions/search-tools/behavior-summary-models.js': mergeCoreAndModule(searchToolsStore),
            'public/scripts/extensions/character-editor-assistant/behavior-summary-model.js': mergeCoreAndModule(ceaStore),
            'public/scripts/extensions/completion-preset-assistant/behavior-summary-model.js': mergeCoreAndModule(cpaStore),
            'public/scripts/extensions/hook-order/behavior-summary-model.js': hookOrderStore,
        },
    };
}

describe('behavior-summary trilingual i18n parity', () => {
    const stores = loadLocaleStores();

    test('discovers every summary builder module and verifies locale stores parse cleanly', () => {
        const discovered = walkSummaryModelFiles(PUBLIC_SCRIPTS_DIR);
        expect(discovered).toEqual(EXPECTED_SUMMARY_MODELS);
        for (const relPath of EXPECTED_SUMMARY_MODELS) {
            expect(existsSync(resolve(REPO_ROOT, relPath))).toBe(true);
            for (const mountFile of MOUNTING_UI_FILES[relPath]) {
                expect(existsSync(resolve(REPO_ROOT, mountFile))).toBe(true);
            }
        }
        expect(Object.keys(stores.publicZhCn).length).toBeGreaterThan(0);
        expect(Object.keys(stores.publicZhTw).length).toBeGreaterThan(0);
    });

    test.each(EXPECTED_SUMMARY_MODELS)('%s has complete zh-cn/zh-tw parity, safe keys, placeholders, and full-width CJK punctuation', (modelPath) => {
        const { calls, nonLiteralCalls } = extractTranslatorCallsFromFile(modelPath);
        const unexpectedDynamic = nonLiteralCalls.filter(
            (expr) => !(ALLOWED_NON_LITERAL_TRANSLATIONS[modelPath] || []).includes(expr),
        );
        expect(unexpectedDynamic).toEqual([]);

        // Expand known dynamic helper arguments cleanly.
        if (modelPath === 'public/scripts/extensions/memory-graph/lens/settings/behavior-summary-models.js') {
            calls.push(
                { fn: 'i18n', arg1: 'Current API', arg2: null },
                { fn: 'i18n', arg1: 'Current preset', arg2: null },
            );
        }
        if (modelPath === 'public/scripts/extensions/search-tools/behavior-summary-models.js') {
            for (const provider of SEARCH_PROVIDERS) {
                calls.push({ fn: 'i18n', arg1: provider.label, arg2: null });
            }
        }

        // Include mounting ariaLabel calls and enforce exact 1:1 per-file coverage per mount/create call.
        const mountResults = MOUNTING_UI_FILES[modelPath].map(extractMountingAriaLabelCalls);
        const perFileSummary = mountResults.map((res) => ({
            file: res.file,
            totalCalls: res.totalCalls,
            ariaCount: res.ariaCalls.length,
            hasCalls: res.totalCalls > 0,
        }));
        const expectedPerFileSummary = mountResults.map((res) => ({
            file: res.file,
            totalCalls: res.rawCallCount,
            ariaCount: res.rawCallCount,
            hasCalls: true,
        }));
        const missingAriaLabels = mountResults.flatMap((res) => res.missingAriaLabels);
        expect(missingAriaLabels).toEqual([]);
        expect(perFileSummary).toEqual(expectedPerFileSummary);
        const mountAriaCalls = mountResults.flatMap((res) => res.ariaCalls);
        calls.push(...mountAriaCalls);

        const uniqueKeys = new Map();
        for (const call of calls) {
            const lookupKey = (call.fn === 'translate' && call.arg2) ? call.arg2 : call.arg1;
            const dedupId = `${lookupKey}\u0000${call.arg1}`;
            if (!uniqueKeys.has(dedupId)) {
                uniqueKeys.set(dedupId, {
                    key: lookupKey,
                    englishText: call.arg1,
                });
            }
        }

        expect(uniqueKeys.size).toBeGreaterThanOrEqual(MIN_KEYS_BY_MODEL[modelPath]);

        const store = stores.byModel[modelPath];
        const semicolonViolations = [];
        const missingZhCn = [];
        const missingZhTw = [];
        const placeholderMismatches = [];
        const cjkHalfWidthViolations = [];

        for (const { key, englishText } of uniqueKeys.values()) {
            if (UNESCAPED_SEMICOLON_RE.test(key)) {
                semicolonViolations.push(key);
            }

            const cnVal = store['zh-cn']?.[key];
            const twVal = store['zh-tw']?.[key];
            if (typeof cnVal !== 'string' || cnVal.length === 0) {
                missingZhCn.push(key);
            }
            if (typeof twVal !== 'string' || twVal.length === 0) {
                missingZhTw.push(key);
            }

            const expectedPlaceholders = extractPlaceholders(englishText);
            if (typeof cnVal === 'string') {
                const cnPlaceholders = extractPlaceholders(cnVal);
                if (JSON.stringify(cnPlaceholders) !== JSON.stringify(expectedPlaceholders)) {
                    placeholderMismatches.push({
                        lang: 'zh-cn',
                        key,
                        expected: expectedPlaceholders,
                        actual: cnPlaceholders,
                    });
                }
                if (CJK_HALF_WIDTH_PUNCT_RE.test(cnVal)) {
                    cjkHalfWidthViolations.push({ lang: 'zh-cn', key, value: cnVal });
                }
            }

            if (typeof twVal === 'string') {
                const twPlaceholders = extractPlaceholders(twVal);
                if (JSON.stringify(twPlaceholders) !== JSON.stringify(expectedPlaceholders)) {
                    placeholderMismatches.push({
                        lang: 'zh-tw',
                        key,
                        expected: expectedPlaceholders,
                        actual: twPlaceholders,
                    });
                }
                if (CJK_HALF_WIDTH_PUNCT_RE.test(twVal)) {
                    cjkHalfWidthViolations.push({ lang: 'zh-tw', key, value: twVal });
                }
            }
        }

        expect(semicolonViolations).toEqual([]);
        expect(missingZhCn).toEqual([]);
        expect(missingZhTw).toEqual([]);
        expect(placeholderMismatches).toEqual([]);
        expect(cjkHalfWidthViolations).toEqual([]);
    });
});
