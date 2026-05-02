/**
 * Memory-graph chat-state migration pipeline driver.
 *
 * Reads a three-tuple snapshot of (data, meta, log) chat-state namespaces
 * and walks a registry of shape nodes until reaching a terminal node.
 * Each non-terminal node's `migrate` returns the same three-tuple shape;
 * the driver calls `detect` again on the result and follows whichever
 * registered shape matches next.
 *
 * The driver does NO IO. The caller (`migrateLegacyMemoryGraphState`)
 * reads chat-state, calls this, and writes the result back.
 */

import { SHAPES } from './registry.js';

const MAX_HOPS = 16;

export async function runMigrationPipeline(input, ctx, shapes = SHAPES) {
    if (!input || typeof input !== 'object') {
        return { data: null, meta: null, log: null, migrations: [], changed: false };
    }
    let current = { data: input.data ?? null, meta: input.meta ?? null, log: input.log ?? null };
    const migrations = [];
    for (let hop = 0; hop < MAX_HOPS; hop++) {
        const node = shapes.find(s => safeDetect(s, current));
        if (!node) {
            return { ...current, migrations, changed: migrations.length > 0 };
        }
        if (node.migrate === null || node.migrate === undefined) {
            return { ...current, migrations, changed: migrations.length > 0 };
        }
        try {
            current = await node.migrate(current, ctx);
            migrations.push(node.id);
        } catch (error) {
            console.warn(`[memory-graph] migration step '${node.id}' failed`, error);
            migrations.push(`${node.id}:error`);
            return { ...input, migrations, changed: false };
        }
    }
    throw new Error(`[memory-graph/migrations] pipeline exceeded MAX_HOPS=${MAX_HOPS} — registry cycle?`);
}

function safeDetect(shape, input) {
    try {
        return Boolean(shape.detect?.(input));
    } catch (error) {
        console.warn(`[memory-graph] migration shape '${shape.id}' detect threw`, error);
        return false;
    }
}
