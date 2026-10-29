/**
 * Names a JSON value the same way across storage engines.
 */
export function jsonTypeOf(value) {
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return 'array';
    }
    return typeof value;
}
