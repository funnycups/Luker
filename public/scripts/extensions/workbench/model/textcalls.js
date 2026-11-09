// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fallback for models that answer with Luker's plain-text tool protocol
// (<Function_XXXX_Start/> + <function_calls> XML) when Luker's own parser
// gave up — usually because the JSON inside <args_json> has raw newlines
// or a stray control character. Recovers the calls and the visible text.
// Pure.

const TRIGGER = /<Function_[A-Za-z0-9]{2,8}_Start\/>/g;

function unwrap(s) {
    const t = String(s || '').trim();
    const m = t.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    return (m ? m[1] : t).replaceAll(']]]]><![CDATA[>', ']]>');
}

/** JSON.parse that tolerates raw newlines / tabs inside strings. */
export function lenientJson(text) {
    const src = String(text || '').trim();
    if (!src) return {};
    try { return JSON.parse(src); } catch { /* repair below */ }
    let out = '';
    let inStr = false;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (inStr) {
            if (c === '\\') { out += c + (src[i + 1] ?? ''); i++; continue; }
            if (c === '"') inStr = false;
            if (c === '\n') { out += '\\n'; continue; }
            if (c === '\r') continue;
            if (c === '\t') { out += '\\t'; continue; }
            if (c < ' ') continue;
        } else if (c === '"') inStr = true;
        out += c;
    }
    try { return JSON.parse(out); } catch { return null; }
}

/** Pulls one string field out of broken JSON as a last resort. */
function pickString(raw, key) {
    const m = String(raw).match(new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"\\s*(,\\s*"[a-z_]+"\\s*:|\\}\\s*$)`));
    if (!m) return null;
    try { return JSON.parse(`"${m[1].replace(/\n/g, '\\n')}"`); } catch { return m[1].replace(/\\n/g, '\n'); }
}

export const hasTextCalls = (text) => /<function_calls>/i.test(String(text || ''));

/**
 * @param {string} text  raw assistant text
 * @param {string[]} allowed  tool names to keep
 * @returns {{ text: string, calls: { id, name, args }[] }}
 */
export function salvageTextCalls(text, allowed = []) {
    const src = String(text || '');
    const keep = new Set(allowed);
    const calls = [];
    const blockRe = /<function_call>([\s\S]*?)<\/function_call>/gi;
    let m;
    while ((m = blockRe.exec(src))) {
        const name = (m[1].match(/<tool>([\s\S]*?)<\/tool>/i)?.[1] || '').trim();
        if (!name || (keep.size && !keep.has(name))) continue;
        const raw = unwrap(m[1].match(/<args_json>([\s\S]*?)<\/args_json>/i)?.[1] || '');
        let args = lenientJson(raw);
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            const t = pickString(raw, 'text');
            if (t == null) continue;
            args = { text: t };
        }
        calls.push({ id: `wb_txt_${calls.length}_${Date.now().toString(36)}`, name, args });
    }
    return { text: visibleText(src), calls };
}

/** Text before the tool protocol starts. */
export function visibleText(text) {
    let src = String(text || '');
    const trig = [...src.matchAll(TRIGGER)].pop();
    if (trig) src = src.slice(0, trig.index);
    const at = src.search(/<function_calls>/i);
    if (at >= 0) src = src.slice(0, at);
    return src.trim();
}
