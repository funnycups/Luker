import { acquireDatabase } from './database-resources.js';
import { MYSQL_ROOT_URL, PG_ROOT_URL } from './database-service.js';

export { MYSQL_ROOT_URL, PG_ROOT_URL, preflightDatabases } from './database-service.js';
export { fingerprintDatabase } from './database-fingerprint.js';

/** Case resources own fresh namespaces; reusable namespaces remain in worker custody. */
export function acquireMysqlDatabase(scope, rootUrl = MYSQL_ROOT_URL, { fresh = false, reuse = false, label = 'mysql database' } = {}) {
    return acquireDatabase(scope, rootUrl, { fresh, reuse, label }, 'mysql');
}

export function acquirePostgresDatabase(scope, rootUrl = PG_ROOT_URL, { fresh = false, label = 'postgres schema' } = {}) {
    return acquireDatabase(scope, rootUrl, { fresh, label }, 'postgres');
}
