import _ from 'lodash';

import { PatchTestFailedError, PatchMissingParentError, UnsupportedPatchOpError } from '../errors.js';

export function applyJsonPatch(doc, ops) {
    const result = _.cloneDeep(doc);
    for (const op of ops) {
        const segs = op.path.split('/').slice(1).map(decode);
        if (op.op === 'test') {
            if (!_.isEqual(getAt(result, segs), op.value)) {
                throw new PatchTestFailedError(op.path);
            }
            continue;
        }
        if (op.op === 'replace') { setAt(result, segs, op.value, op.path); continue; }
        if (op.op === 'add')     { addAt(result, segs, op.value); continue; }
        if (op.op === 'remove')  { removeAt(result, segs, op.path); continue; }
        throw new UnsupportedPatchOpError(op.op);
    }
    return result;
}

function decode(s) { return s.replace(/~1/g, '/').replace(/~0/g, '~'); }
function getAt(o, segs) { return segs.reduce((c, s) => (c == null ? c : c[s]), o); }
function setAt(o, segs, v, path) {
    const p = getAt(o, segs.slice(0, -1));
    if (p == null) throw new PatchMissingParentError('replace', path);
    p[segs[segs.length - 1]] = v;
}
function addAt(o, segs, v) {
    const p = ensureParent(o, segs);
    const k = segs[segs.length - 1];
    if (Array.isArray(p)) { const i = k === '-' ? p.length : Number(k); p.splice(i, 0, v); } else p[k] = v;
}
function ensureParent(o, segs) {
    let c = o;
    for (let i = 0; i < segs.length - 1; i++) {
        if (c[segs[i]] == null) c[segs[i]] = {};
        c = c[segs[i]];
    }
    return c;
}
function removeAt(o, segs, path) {
    const p = getAt(o, segs.slice(0, -1));
    if (p == null) throw new PatchMissingParentError('remove', path);
    const k = segs[segs.length - 1];
    if (Array.isArray(p)) p.splice(Number(k), 1); else delete p[k];
}
