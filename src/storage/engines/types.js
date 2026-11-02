/**
 * @typedef {Object} StorageEngine
 * @property {'fs' | 'sqlite' | 'mysql' | 'postgres'} kind
 * @property {<T>(fn: (tx: StorageTransaction) => Promise<T>) => Promise<T>} withTransaction
 * @property {() => Promise<void>} ping
 * @property {(handle: string) => Promise<void>} deleteUser
 * @property {(handle: string) => Promise<import('node:stream').Readable | null>} dumpUser
 * @property {(handle: string, stream: import('node:stream').Readable) => Promise<void>} restoreUser
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
 * @property {(resource: ResourceKey) => Promise<boolean>} hasChatResource
 *   Structural chat occupancy independent of document readability.
 * @property {(resource: ResourceKey, namespace: string, options?: {required?: boolean}) => Promise<any>} getChatState
 *   Read JSON state; required enumerated records must remain present and readable.
 * @property {(resource: ResourceKey, namespace: string, doc: any, options?: {ifAbsent?: boolean}) => Promise<void>} putChatState
 *   Publish state without replacing occupied namespaces when ifAbsent is true.
 * @property {(resource: ResourceKey, record: ResourceRecord) => Promise<void>} putResource
 *   Write or replace a single resource. Caller must do OCC checks via getResource first if needed.
 * @property {(resource: ResourceKey, expectedIntegrity: string | null, record: ResourceRecord) => Promise<{updated: boolean}>} putResourceIfMatch
 *   Atomic OCC write: succeeds only if the stored integrity matches expectedIntegrity.
 *   expectedIntegrity=null means "must not currently exist".
 *   Chat creation also requires empty owned state.
 * @property {(source: ResourceKey) => Promise<object | null>} captureChatMove
 *   Capture validated parent/state values and native representations in a transaction-private opaque token.
 * @property {(destination: ResourceKey, token: object) => Promise<{updated: boolean}>} publishChatMove
 *   Publish the captured native parent/state without encoding parsed values or replacing occupied entries.
 * @property {(token: object) => Promise<void>} deleteChatMoveSource
 *   Verify the captured parent and complete state inventory before deleting only the copied source.
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
