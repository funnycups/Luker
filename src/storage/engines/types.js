/**
 * @typedef {Object} StorageEngine
 * @property {'fs' | 'sqlite' | 'mysql' | 'postgres'} kind
 * @property {<T>(fn: (tx: StorageTransaction) => Promise<T>) => Promise<T>} withTransaction
 * @property {() => Promise<void>} ping
 * @property {() => Promise<void>} close
 */

/**
 * The transaction is the only object Repos use to talk to storage.
 *
 * In SqlEngine, every method runs inside a real BEGIN/COMMIT/ROLLBACK.
 * In FsEngine, methods run sequentially on the filesystem; if one throws,
 * earlier writes inside the same withTransaction() call are NOT rolled back.
 * Cross-resource atomicity is therefore best-effort on FsEngine and strict
 * on SqlEngine — Repos that need strict atomicity should document the
 * degradation when running under FsEngine.
 *
 * @typedef {Object} StorageTransaction
 * @property {(resource: ResourceKey) => Promise<ResourceRecord | null>} getResource
 *   Read a single resource by its key. Returns null if not found.
 * @property {(resource: ResourceKey, record: ResourceRecord) => Promise<void>} putResource
 *   Write or replace a single resource. Caller must do OCC checks via getResource first if needed.
 * @property {(resource: ResourceKey, expectedIntegrity: string | null, record: ResourceRecord) => Promise<{updated: boolean}>} putResourceIfMatch
 *   Atomic OCC write: succeeds only if the stored integrity matches expectedIntegrity.
 *   expectedIntegrity=null means "must not currently exist".
 * @property {(resource: ResourceKey) => Promise<void>} deleteResource
 *   Delete a resource. Cascades any sub-records (sidecars in FsEngine; FK CASCADE in SqlEngine).
 * @property {(filter: ResourceListFilter) => Promise<ResourceRecord[]>} listResources
 *   List resources matching the filter. Supports limit / orderBy.
 */

/**
 * Resource key — identifies a single addressable thing.
 *
 * For chats:  { kind: 'chat',  handle, charDir, name, isGroup, groupId }
 * For chat_state (one per namespace per chat): the state operations live on
 *   StorageTransaction.getChatState / patchChatState / deleteChatState (see
 *   FsTransaction). State has its own keying so the chat-key stays clean.
 *
 * @typedef {{
 *   kind: string,
 *   [key: string]: any,
 * }} ResourceKey
 */

/**
 * @typedef {{
 *   key: ResourceKey,
 *   header: object,
 *   body: object[],
 *   integrity: string,
 *   updatedAt: number,
 *   createdAt: number,
 * }} ResourceRecord
 */

/**
 * @typedef {{
 *   kind: string,
 *   handle: string,
 *   orderBy?: 'updatedAt' | 'name',
 *   limit?: number,
 * }} ResourceListFilter
 */

export {};
