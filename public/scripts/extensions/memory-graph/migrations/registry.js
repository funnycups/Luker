/**
 * Migration shape registry. Order matters — the driver picks the first
 * node whose `detect(input)` returns true, so earlier shapes take
 * precedence. Place "older" / more-specific shapes first.
 *
 * Each shape exports:
 *   - id:       string
 *   - detect:   (input) => boolean
 *   - migrate:  null for terminal, else (input, ctx) => Promise<input>
 *   - nextId:   string | null  (used for documentation; driver uses detect)
 */

import { v5Raw } from './shapes/v5-raw.js';
import { v8Oplog } from './shapes/v8-oplog.js';
import { v2FloorState } from './shapes/v2-floor-state.js';

export const SHAPES = [
    // 顺序:older / more-specific 在前。新版本接在末尾。
    v5Raw,           // detect: data 有 nodes 但无 opLog
    v8Oplog,         // detect: data.opLog 是 array
    v2FloorState,    // terminal
];

export function findShape(predicate) {
    return SHAPES.find(predicate) || null;
}
