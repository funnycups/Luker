/**
 * Builds a SQLite/MySQL JSON path from RFC 6901 segments.
 */
export function toSqlJsonPath(segments) {
    return '$' + segments.map(segment => `.${JSON.stringify(String(segment))}`).join('');
}
