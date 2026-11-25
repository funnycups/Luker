import { StringDecoder } from 'node:string_decoder';
import { RestoreDumpInvalidError } from '../errors.js';

function parseDumpRecord(line) {
    let record;
    try {
        record = JSON.parse(line);
    } catch (err) {
        throw new RestoreDumpInvalidError(err.message);
    }
    if (!record || typeof record.sql !== 'string' || !Array.isArray(record.params)) {
        throw new RestoreDumpInvalidError('record is not a {sql, params} object');
    }
    return record;
}

/**
 * Yields the `{sql, params}` records of a mysql/postgres engine dump:
 * newline-separated JSON, in stream order.
 *
 * Chunks arrive at arbitrary byte boundaries, including mid multi-byte
 * UTF-8 sequence, so text goes through `StringDecoder` and lines are
 * buffered across chunks; `chunk.toString('utf8')` would corrupt CJK and
 * emoji split across a boundary.
 *
 * Throws `RestoreDumpInvalidError` on a record that is not valid JSON or
 * lacks `sql`/`params`.
 * @param {AsyncIterable<Buffer|string>} stream
 * @returns {AsyncGenerator<{sql: string, params: unknown[]}>}
 */
export async function* readDumpRecords(stream) {
    const decoder = new StringDecoder('utf8');
    let buf = '';
    for await (const chunk of stream) {
        buf += decoder.write(chunk);
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            yield parseDumpRecord(line);
        }
    }
    buf += decoder.end();
    const tail = buf.trim();
    if (tail) yield parseDumpRecord(tail);
}

/**
 * The INSERT statement an engine dump writes for one table.
 * @param {{name: string, cols: string[]}} table
 * @param {(index: number) => string} placeholder Bind placeholder for the 0-based column index.
 */
export function dumpInsertSql(table, placeholder) {
    const placeholders = table.cols.map((_, i) => placeholder(i)).join(', ');
    return `INSERT INTO ${table.name} (${table.cols.join(', ')}) VALUES (${placeholders})`;
}

function isScalarParam(value) {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * Replays a mysql/postgres engine dump through `execute`.
 *
 * The dump is data, not SQL: a record is accepted only when its `sql` is the
 * exact INSERT the engine's own dump writer emits for one of `tables` and its
 * params are scalars matching that table's columns. The statement executed is
 * the one rebuilt from `tables`, never the uploaded text. Anything else throws
 * `RestoreDumpInvalidError` before it runs. The caller runs this inside the
 * restore transaction so any throw rolls the whole restore back.
 *
 * Every table's first column is `handle`, and the dump carries the source
 * account's handle there; it is replaced with `handle` so the rows land on
 * the account being restored. Rows the database refuses for their values make
 * the dump invalid: a value that does not fit its column type, or a row that
 * breaks a constraint, such as two rows of different accounts sharing a key.
 * `dialect.isInvalidRow` tells those errors apart from the others.
 * @param {AsyncIterable<Buffer|string>} stream
 * @param {{tables: readonly {name: string, cols: string[]}[], placeholder: (index: number) => string, isInvalidRow: (err: unknown) => boolean}} dialect
 * @param {string} handle
 * @param {(sql: string, params: unknown[]) => Promise<unknown>} execute
 */
export async function replaySqlDump(stream, dialect, handle, execute) {
    const statements = new Map();
    for (const table of dialect.tables) {
        if (table.cols[0] !== 'handle') {
            throw new Error(`dump table ${table.name} must start with the handle column`);
        }
        const sql = dumpInsertSql(table, dialect.placeholder);
        statements.set(sql, { sql, columnCount: table.cols.length });
    }
    for await (const record of readDumpRecords(stream)) {
        const statement = statements.get(record.sql);
        if (!statement) {
            throw new RestoreDumpInvalidError('record is not an INSERT written by the engine dump');
        }
        if (record.params.length !== statement.columnCount) {
            throw new RestoreDumpInvalidError(`record has ${record.params.length} params, expected ${statement.columnCount}`);
        }
        if (!record.params.every(isScalarParam)) {
            throw new RestoreDumpInvalidError('record params must be strings, numbers, booleans or null');
        }
        try {
            await execute(statement.sql, [handle, ...record.params.slice(1)]);
        } catch (err) {
            if (dialect.isInvalidRow(err)) throw new RestoreDumpInvalidError(err.message);
            throw err;
        }
    }
}
