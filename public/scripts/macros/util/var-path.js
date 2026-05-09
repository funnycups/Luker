/**
 * Resolve a (possibly dotted) variable name against a getter.
 *
 * If `name` contains a `.`, splits on the first `.`, reads the head segment
 * via the getter, tries to JSON.parse the head value, and walks the rest of
 * the path. On any failure (parse error, missing intermediate key, etc.)
 * falls back to a literal lookup of the full `name` via the getter.
 *
 * The contract is: callers may store JSON-stringified objects in their
 * variable store, and access nested fields via dotted macro syntax. The
 * variable store itself is not modified — this is a read-side affordance.
 *
 * @param {(name: string) => any} getter - Reads the raw stored value for a
 *     given variable name. May return strings, numbers, undefined, '', or
 *     occasionally an object (if the caller stored one directly).
 * @param {string} name - Variable name, possibly containing `.` for nested
 *     access. Empty / non-string names are returned via getter as-is.
 * @returns {any} The resolved value (raw — caller is responsible for any
 *     normalization). Returns undefined when a parsed path walks off the
 *     end of the object; getter's empty-string return is preserved when
 *     the variable does not exist.
 */
export function resolveVarPath(getter, name) {
    if (typeof name === 'string' && name.includes('.')) {
        const [head, ...rest] = name.split('.');
        const raw = getter(head);
        try {
            const parsed = (typeof raw === 'string') ? JSON.parse(raw) : raw;
            let v = parsed;
            for (const k of rest) {
                if (v == null) {
                    v = undefined;
                    break;
                }
                v = v[k];
            }
            return v;
        } catch {
            // JSON.parse failed — head value is not JSON. Fall through to
            // literal lookup so a flat key like "a.b" still resolves.
        }
    }
    return getter(name);
}
