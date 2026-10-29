/**
 * Builds a SQLite/MySQL JSON path from RFC 6901 segments.
 */
export function toSqlJsonPath(segments) {
    return '$' + segments.map((segment) => {
        const quoted = String(segment).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `."${quoted}"`;
    }).join('');
}
