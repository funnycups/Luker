import { CONTRACT_HARNESSES } from '../../storage/harness/contract-harness.js';

const requirements = [
    ['FsEngine', 'filesystem fixture'], ['SqliteEngine', 'SQLite fixture'],
    ['MysqlEngine', 'LUKER_DISABLE_MYSQL_TESTS'], ['PgEngine', 'LUKER_DISABLE_POSTGRES_TESTS'],
];
const missing = requirements.filter(([name]) => !CONTRACT_HARNESSES.some(harness => harness.name === name));
if (missing.length) throw new Error(`BLOCKED: sync acceptance requires ${missing.map(([name]) => name).join(' and ')}. Remove exclusions ${missing.map(([, setting]) => setting).join(' and ')} and start the named fixtures; storage-only development selectors do not narrow sync acceptance.`);

export { CONTRACT_HARNESSES };
