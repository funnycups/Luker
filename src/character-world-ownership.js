import fs from 'node:fs';
import path from 'node:path';
import { read } from './character-card-parser.js';
import { ConflictError, InvalidArgumentError } from './storage/errors.js';
import { getAuxiliaryWorldReferences, resolveWorldIdentityKey } from './storage/world-reference-coordination.js';

export function validateBindingPrecondition(condition) {
    if (condition === undefined) return undefined;
    if (!condition || typeof condition.characterVersion !== 'string' || !condition.characterVersion
        || !condition.world || typeof condition.world.name !== 'string' || !condition.world.name.trim()
        || typeof condition.world.version !== 'string' || !condition.world.version) {
        throw new InvalidArgumentError('ifMatch requires characterVersion and world.name/world.version from the original writes');
    }
    return { characterVersion: condition.characterVersion, world: { name: condition.world.name.trim(), version: condition.world.version } };
}

/** Inspect persisted character references inside the coordinated commit scope. */
export async function assertWorldNotBound(charactersDirectory, worldName, exceptAvatar, settings, resolveName) {
    const targetIdentity = await resolveWorldIdentityKey(resolveName, worldName);
    if (targetIdentity === null) return;
    for (const reference of getAuxiliaryWorldReferences(settings)) {
        if (await resolveWorldIdentityKey(resolveName, reference) === targetIdentity) {
            throw new ConflictError('world_in_use', { name: worldName, reference: 'auxiliary' });
        }
    }
    let exceptIdentity = null;
    if (exceptAvatar) {
        try {
            const stat = fs.lstatSync(path.join(charactersDirectory, exceptAvatar), { bigint: true });
            exceptIdentity = `${stat.dev}:${stat.ino}`;
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    for (const entry of fs.readdirSync(charactersDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.png' || entry.name === exceptAvatar) continue;
        const entryPath = path.join(charactersDirectory, entry.name);
        if (exceptIdentity !== null) {
            try {
                const entryStat = fs.lstatSync(entryPath, { bigint: true });
                if (`${entryStat.dev}:${entryStat.ino}` === exceptIdentity) continue;
            } catch (error) {
                if (error?.code === 'ENOENT') continue;
                throw error;
            }
        }
        let character;
        try {
            character = JSON.parse(read(fs.readFileSync(entryPath)));
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw new Error(`Cannot inspect world book binding in character '${entry.name}': ${error.message}`, { cause: error });
        }
        if (await resolveWorldIdentityKey(resolveName, character.data?.extensions?.world) === targetIdentity) {
            throw new ConflictError('world_in_use', { name: worldName, avatar: entry.name });
        }
    }
}
