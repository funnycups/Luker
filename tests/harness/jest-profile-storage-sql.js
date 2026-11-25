import { preflightDatabases } from './database.js';

process.env.LUKER_TEST_PROFILE = 'storage-sql';
delete process.env.LUKER_DISABLE_MYSQL_TESTS;
delete process.env.LUKER_DISABLE_POSTGRES_TESTS;

const identities = await preflightDatabases();
globalThis.LUKER_TEST_DB_IDENTITIES = identities;
