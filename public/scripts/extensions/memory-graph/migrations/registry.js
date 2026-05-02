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

export const SHAPES = [];

export function findShape(predicate) {
    return SHAPES.find(predicate) || null;
}
