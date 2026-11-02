import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';

// setServers replaces Node's default resolver and its exported functions.
// Refresh built-in ESM bindings before loading the production consumer.
dns.setServers([process.argv[2]]);
syncBuiltinESMExports();
const { createSyncFetch } = await import('../../../src/sync/net-guard.js');
const fetch = createSyncFetch({ enableAccounts: true, owner: { getCurrentProfile: async () => ({ enabled: true, admin: process.argv[4] === 'admin' }) } });
try {
    const response = await fetch(process.argv[3]);
    console.log(JSON.stringify({ status: response.status, body: await response.text() }));
} catch (error) {
    console.log(JSON.stringify({ code: error.code }));
}
