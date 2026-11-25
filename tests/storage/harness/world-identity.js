import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { getFileVersion } from '../../../src/storage/file-version.js';
import { read, write } from '../../../src/character-card-parser.js';

export async function seedExactWorld(h, name, doc) {
    const revision = randomUUID();
    if (h.kind === 'fs') {
        fs.mkdirSync(h.dirs.worlds, { recursive: true });
        fs.writeFileSync(path.join(h.dirs.worlds, name + '.json'), JSON.stringify(doc));
    } else if (h.kind === 'sqlite') {
        await h.engine.ping(h.handle);
        h.engine._dbFor(h.handle).prepare('INSERT INTO worlds (handle,name,doc,updated_at,revision) VALUES (?,?,?,?,?)').run(h.handle, name, JSON.stringify(doc), 100, revision);
    } else if (h.kind === 'mysql') {
        await h.engine.ping(h.handle);
        await h.engine._pool.execute('INSERT INTO worlds (handle,name,doc,updated_at,revision) VALUES (?,?,?,?,?)', [h.handle, name, JSON.stringify(doc), 100, revision]);
    } else {
        await h.engine.ping(h.handle);
        await h.engine._pool.query('INSERT INTO worlds (handle,name,doc,updated_at,revision) VALUES ($1,$2,$3::jsonb,$4,$5)', [h.handle, name, JSON.stringify(doc), 100, revision]);
    }
}

export function seedReferenceCard(h, avatar, world) {
    const card = { name: avatar, description: 'Reference fixture', data: { name: avatar, extensions: { world, retained: { card: [avatar] } } } };
    fs.mkdirSync(h.dirs.characters, { recursive: true });
    fs.writeFileSync(path.join(h.dirs.characters, avatar), write(fs.readFileSync(new URL('../../../public/img/ai4.png', import.meta.url)), JSON.stringify(card)));
}

/** Read exact native rows/files, not the tolerant repository read path. */
export async function exactWorldState(h) {
    let rows;
    if (h.kind === 'fs') {
        rows = fs.existsSync(h.dirs.worlds) ? fs.readdirSync(h.dirs.worlds).filter(name => path.extname(name).toLowerCase() === '.json').map(filename => {
            const file = path.join(h.dirs.worlds, filename);
            return { name: path.parse(filename).name, doc: JSON.parse(fs.readFileSync(file, 'utf8')), revision: getFileVersion(file) };
        }) : [];
    } else if (h.kind === 'sqlite') {
        rows = h.engine._dbFor(h.handle).prepare('SELECT name,doc,revision FROM worlds WHERE handle=?').all(h.handle).map(row => ({ ...row, doc: JSON.parse(row.doc) }));
    } else if (h.kind === 'mysql') {
        [rows] = await h.engine._pool.execute('SELECT name,doc,revision FROM worlds WHERE handle=?', [h.handle]);
        rows = rows.map(row => ({ ...row, doc: typeof row.doc === 'string' ? JSON.parse(row.doc) : row.doc }));
    } else {
        ({ rows } = await h.engine._pool.query('SELECT name,doc,revision FROM worlds WHERE handle=$1', [h.handle]));
    }
    return Object.fromEntries(rows.sort((a, b) => a.name.localeCompare(b.name)).map(({ name, ...record }) => [name, record]));
}

export function referenceCardState(h) {
    return Object.fromEntries(fs.readdirSync(h.dirs.characters).filter(name => name.endsWith('.png')).sort().map(name => {
        const bytes = fs.readFileSync(path.join(h.dirs.characters, name));
        return [name, { png: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), card: JSON.parse(read(bytes)) }];
    }));
}

/** Hold only this harness's settings table; ordinary world deletion remains free. */
export async function holdSettingsRead(h) {
    const mysql = h.kind === 'mysql';
    const pool = h.engine._pool;
    const connection = mysql ? await pool.getConnection() : await pool.connect();
    let active = false;
    try {
        if (!mysql) await connection.query('BEGIN');
        await connection.query(mysql ? 'LOCK TABLES settings WRITE' : 'LOCK TABLE settings IN ACCESS EXCLUSIVE MODE');
        active = true;
        const result = await connection.query(mysql ? 'SELECT CONNECTION_ID() AS pid' : 'SELECT pg_backend_pid() AS pid');
        const pid = mysql ? result[0][0].pid : result.rows[0].pid;
        return {
            pid,
            async waits() {
                if (mysql) {
                    const [rows] = await pool.query('SELECT ID AS pid, INFO AS statement, STATE AS state FROM information_schema.PROCESSLIST WHERE DB=? AND ID<>? AND INFO LIKE \'SELECT doc FROM settings WHERE handle=%\' AND STATE LIKE \'Waiting%lock%\'', [h.dbName, pid]);
                    return rows;
                }
                const { rows } = await pool.query('SELECT pid, query AS statement, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE wait_event_type=\'Lock\' AND query LIKE \'SELECT doc FROM settings WHERE handle=%\' AND $1=ANY(pg_blocking_pids(pid))', [pid]);
                return rows;
            },
            async release() {
                if (active) { await connection.query(mysql ? 'UNLOCK TABLES' : 'COMMIT'); active = false; }
            },
            async close() {
                try { if (active) { await connection.query(mysql ? 'UNLOCK TABLES' : 'ROLLBACK'); active = false; } }
                finally { connection.release(); }
            },
        };
    } catch (error) {
        try { if (!mysql) await connection.query('ROLLBACK'); }
        finally { connection.release(); }
        throw error;
    }
}
