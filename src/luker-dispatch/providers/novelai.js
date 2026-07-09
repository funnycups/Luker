// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Pure dispatch for NovelAI text generation. Extracted from
// src/endpoints/novelai.js:175-323.
//
// Consumes a DispatchContext (see src/luker-dispatch/context.js) and emits
// chunk/end/error events; never touches Express request/response.
//
// Preserved from the legacy handler:
//   • API key resolved via ctx.secrets.read(SECRET_KEYS.NOVEL); missing key
//     emits error
//   • Model-family URL branch:
//       model contains 'kayra' | 'erato' → TEXT_NOVELAI
//       otherwise                       → API_NOVELAI
//   • Streaming vs non-streaming suffix:
//       stream    → `${base}/ai/generate-stream`
//       non-stream→ `${base}/ai/generate`
//   • Special-case: prefix === 'theme_textadventure' sets
//     parameters.eos_token_id (49405 for clio/kayra; 29 for erato)
//   • bad_words / logit_bias / rep_pen_whitelist tables (previously
//     module-level in src/endpoints/novelai.js) inlined here since only
//     /generate consumed them. Behavior identical: helpers `.slice()`
//     their tables per call, so no cross-request mutation hazard exists
//     (legacy behavior preserved as-is).
//   • Upstream 4xx/5xx: legacy path returned HTTP 500 with body
//     `{error:{message}}` regardless of upstream status (inconsistent
//     with kobold's 400). Dispatch preserves the reshape logic: the
//     upstream JSON body's `message` field is surfaced through
//     ctx.emit.error; the runner then translates that error event to
//     the outgoing HTTP status. Runner-level status coding is out of
//     scope here.

import { SECRET_KEYS } from '../../endpoints/secrets.js';
import { pipeResponseBodyToEmit } from '../response-stream.js';

const API_NOVELAI = 'https://api.novelai.net';
const TEXT_NOVELAI = 'https://text.novelai.net';

// ---------------------------------------------------------------------------
// bad-word / logit-bias / rep-penalty tables — moved from
// src/endpoints/novelai.js (previously module-level there). Only /generate
// consumed them, so they live with the dispatch now. Behavior identical.
// ---------------------------------------------------------------------------

const badWordsListBase = [
    [3], [49356], [1431], [31715], [34387], [20765], [30702], [10691], [49333], [1266],
    [19438], [43145], [26523], [41471], [2936], [85, 85], [49332], [7286], [1115], [24],
];

const eratoBadWordsList = [
    [16067], [933, 11144], [25106, 11144], [58, 106901, 16073, 33710, 25, 109933],
    [933, 58, 11144], [128030], [58, 30591, 33503, 17663, 100204, 25, 11144],
];

const hypeBotBadWordsList = [
    [58], [60], [90], [92], [685], [1391], [1782], [2361], [3693], [4083], [4357], [4895],
    [5512], [5974], [7131], [8183], [8351], [8762], [8964], [8973], [9063], [11208],
    [11709], [11907], [11919], [12878], [12962], [13018], [13412], [14631], [14692],
    [14980], [15090], [15437], [16151], [16410], [16589], [17241], [17414], [17635],
    [17816], [17912], [18083], [18161], [18477], [19629], [19779], [19953], [20520],
    [20598], [20662], [20740], [21476], [21737], [22133], [22241], [22345], [22935],
    [23330], [23785], [23834], [23884], [25295], [25597], [25719], [25787], [25915],
    [26076], [26358], [26398], [26894], [26933], [27007], [27422], [28013], [29164],
    [29225], [29342], [29565], [29795], [30072], [30109], [30138], [30866], [31161],
    [31478], [32092], [32239], [32509], [33116], [33250], [33761], [34171], [34758],
    [34949], [35944], [36338], [36463], [36563], [36786], [36796], [36937], [37250],
    [37913], [37981], [38165], [38362], [38381], [38430], [38892], [39850], [39893],
    [41832], [41888], [42535], [42669], [42785], [42924], [43839], [44438], [44587],
    [44926], [45144], [45297], [46110], [46570], [46581], [46956], [47175], [47182],
    [47527], [47715], [48600], [48683], [48688], [48874], [48999], [49074], [49082],
    [49146], [49946], [10221], [4841], [1427], [2602, 834], [29343], [37405], [35780], [2602], [50256],
];

const repPenaltyAllowList = [
    [49256, 49264, 49231, 49230, 49287, 85, 49255, 49399, 49262, 336, 333, 432, 363, 468, 492, 745, 401, 426, 623, 794,
        1096, 2919, 2072, 7379, 1259, 2110, 620, 526, 487, 16562, 603, 805, 761, 2681, 942, 8917, 653, 3513, 506, 5301,
        562, 5010, 614, 10942, 539, 2976, 462, 5189, 567, 2032, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 588,
        803, 1040, 49209, 4, 5, 6, 7, 8, 9, 10, 11, 12],
];

const eratoRepPenWhitelist = [
    6, 1, 11, 13, 25, 198, 12, 9, 8, 279, 264, 459, 323, 477, 539, 912, 374, 574, 1051, 1550, 1587, 4536, 5828, 15058,
    3287, 3250, 1461, 1077, 813, 11074, 872, 1202, 1436, 7846, 1288, 13434, 1053, 8434, 617, 9167, 1047, 19117, 706,
    12775, 649, 4250, 527, 7784, 690, 2834, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 1210, 1359, 608, 220, 596, 956,
    3077, 44886, 4265, 3358, 2351, 2846, 311, 389, 315, 304, 520, 505, 430,
];

// Ban the dinkus and asterism
const logitBiasExp = [
    { 'sequence': [23], 'bias': -0.08, 'ensure_sequence_finish': false, 'generate_once': false },
    { 'sequence': [21], 'bias': -0.08, 'ensure_sequence_finish': false, 'generate_once': false },
];

const eratoLogitBiasExp = [
    { 'sequence': [12488], 'bias': -0.08, 'ensure_sequence_finish': false, 'generate_once': false },
    { 'sequence': [128041], 'bias': -0.08, 'ensure_sequence_finish': false, 'generate_once': false },
];

function getBadWordsList(model) {
    const m = String(model || '');
    let list = [];
    if (m.includes('hypebot')) list = hypeBotBadWordsList;
    if (m.includes('clio') || m.includes('kayra')) list = badWordsListBase;
    if (m.includes('erato')) list = eratoBadWordsList;
    // Clone so the caller doesn't mutate the shared table.
    return list.slice();
}

function getLogitBiasList(model) {
    const m = String(model || '');
    let list = [];
    if (m.includes('erato')) list = eratoLogitBiasExp;
    if (m.includes('clio') || m.includes('kayra')) list = logitBiasExp;
    return list.slice();
}

function getRepPenaltyWhitelist(model) {
    const m = String(model || '');
    if (m.includes('clio') || m.includes('kayra')) return repPenaltyAllowList.flat();
    if (m.includes('erato')) return eratoRepPenWhitelist.flat();
    return null;
}

/**
 * Dispatch a NovelAI /generate request through the transport-agnostic
 * event bus.
 *
 * @param {object} ctx DispatchContext (see src/luker-dispatch/context.js)
 * @returns {Promise<void>}
 */
export async function dispatchNovelAI(ctx) {
    const body = ctx.body || {};

    const apiKey = ctx.secrets.read(SECRET_KEYS.NOVEL) || '';
    if (!apiKey) {
        console.warn('NovelAI Access Token is missing.');
        ctx.emit.error(new Error('NovelAI Access Token is missing'));
        return;
    }

    ctx.inspection.start();

    // ---- bad words / logit bias / rep-pen whitelist assembly ----
    // Mirrors novelai.js:197-221. Helpers already .slice() their module-
    // level tables, so appending here does not leak to sibling requests.
    const badWordsList = getBadWordsList(body.model);
    if (Array.isArray(badWordsList) && Array.isArray(body.bad_words_ids)) {
        for (const badWord of body.bad_words_ids) {
            if (Array.isArray(badWord) && badWord.every(x => Number.isInteger(x))) {
                badWordsList.push(badWord);
            }
        }
    }
    for (let i = badWordsList.length - 1; i >= 0; i--) {
        if (Array.isArray(badWordsList[i]) && badWordsList[i].length === 0) {
            badWordsList.splice(i, 1);
        }
    }

    const logitBiasList = getLogitBiasList(body.model);
    if (Array.isArray(logitBiasList) && Array.isArray(body.logit_bias_exp)) {
        logitBiasList.push(...body.logit_bias_exp);
    }

    const repPenWhitelist = getRepPenaltyWhitelist(body.model);

    // ---- request body (mirrors novelai.js:223-259) ----
    /** @type {any} */
    const data = {
        'input': body.input,
        'model': body.model,
        'parameters': {
            'use_string': body.use_string ?? true,
            'temperature': body.temperature,
            'max_length': body.max_length,
            'min_length': body.min_length,
            'tail_free_sampling': body.tail_free_sampling,
            'repetition_penalty': body.repetition_penalty,
            'repetition_penalty_range': body.repetition_penalty_range,
            'repetition_penalty_slope': body.repetition_penalty_slope,
            'repetition_penalty_frequency': body.repetition_penalty_frequency,
            'repetition_penalty_presence': body.repetition_penalty_presence,
            'repetition_penalty_whitelist': repPenWhitelist,
            'top_a': body.top_a,
            'top_p': body.top_p,
            'top_k': body.top_k,
            'typical_p': body.typical_p,
            'mirostat_lr': body.mirostat_lr,
            'mirostat_tau': body.mirostat_tau,
            'phrase_rep_pen': body.phrase_rep_pen,
            'stop_sequences': body.stop_sequences,
            'bad_words_ids': badWordsList.length ? badWordsList : null,
            'logit_bias_exp': logitBiasList,
            'generate_until_sentence': body.generate_until_sentence,
            'use_cache': body.use_cache,
            'return_full_text': body.return_full_text,
            'prefix': body.prefix,
            'order': body.order,
            'num_logprobs': body.num_logprobs,
            'min_p': body.min_p,
            'math1_temp': body.math1_temp,
            'math1_quad': body.math1_quad,
            'math1_quad_entropy_scale': body.math1_quad_entropy_scale,
        },
    };

    // Tells the model to stop generation at '>' for theme_textadventure
    // (novelai.js:262-269).
    if (body.prefix === 'theme_textadventure') {
        if (typeof body.model === 'string' && (body.model.includes('clio') || body.model.includes('kayra'))) {
            data.parameters.eos_token_id = 49405;
        }
        if (typeof body.model === 'string' && body.model.includes('erato')) {
            data.parameters.eos_token_id = 29;
        }
    }

    try {
        const model = String(body.model || '');
        const baseURL = (model.includes('kayra') || model.includes('erato')) ? TEXT_NOVELAI : API_NOVELAI;
        const url = body.streaming ? `${baseURL}/ai/generate-stream` : `${baseURL}/ai/generate`;

        ctx.inspection.attach(url);
        const resp = await ctx.fetch(url, {
            method: 'POST',
            body: JSON.stringify(data),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            signal: ctx.signal,
            timeout: 0,
        });

        if (body.streaming) {
            // Streaming: forward raw SSE bytes verbatim.
            await pipeResponseBodyToEmit(resp, ctx);
            return;
        }

        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            console.warn(`Novel API returned error: ${resp.status} ${resp.statusText} ${text}`);
            let message = text;
            try {
                const parsed = JSON.parse(text);
                if (parsed?.message) {
                    message = parsed.message;
                }
            } catch { /* not JSON */ }
            const err = new Error(String(message));
            ctx.inspection.fail(err);
            ctx.emit.error(err);
            return;
        }

        /** @type {any} */
        const respData = await resp.json();
        const encoder = new TextEncoder();
        ctx.emit.chunk(encoder.encode(JSON.stringify(respData)));
        ctx.emit.end();
    } catch (err) {
        try { ctx.inspection.fail(err); } catch { /* inspection best-effort */ }
        ctx.emit.error(err);
    }
}
