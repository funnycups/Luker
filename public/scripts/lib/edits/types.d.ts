// Edits lib — JSDoc-friendly types for IDE autocomplete.
// Hand-written; not generated.

export type EditSet         = { op: 'set';         path: string; oldValue: unknown; newValue: unknown };
export type EditUnset       = { op: 'unset';       path: string; expected_value?: unknown };
export type EditStrReplace  = { op: 'str_replace'; path: string; find: string; replace: string; expected_count?: number };
export type EditStrInsert   = { op: 'str_insert';  path: string; after_text: string; insert_text: string };
export type EditStrDelete   = { op: 'str_delete';  path: string; find: string; _anchor_context?: { before: string; after: string } };
export type EditListInsert  = { op: 'list_insert'; path: string; anchor: { before_index?: number; after_index?: number; after_value?: unknown }; value: unknown; _inserted_at?: number };
export type EditListRemove  = { op: 'list_remove'; path: string; index: number; expected_value?: unknown; _removed?: unknown; _removed_at?: number };
export type EditListMove    = { op: 'list_move';   path: string; from_index: number; to_index: number; expected_value?: unknown };
export type EditCustom      = { op: string;        path?: string; [k: string]: unknown };

export type Edit =
  | EditSet | EditUnset
  | EditStrReplace | EditStrInsert | EditStrDelete
  | EditListInsert | EditListRemove | EditListMove
  | EditCustom;

export type ConflictReason =
  | 'value_drifted' | 'anchor_missing' | 'anchor_ambiguous'
  | 'duplicate' | 'already_done' | string;

export interface ConflictEntry {
    edit: Edit;
    reason: ConflictReason;
    baseline?: unknown;
    current?: unknown;
}

export interface ApplyResult<T = unknown> {
    newLive: T;
    clean: Edit[];
    conflicts: ConflictEntry[];
    alreadyDone: Edit[];
}

export interface OpHandler {
    apply: (deps: LodashDeps, edit: Edit, live: any) => any;
    inverse: (edit: Edit) => Edit;
    detectConflict: (deps: LodashDeps, edit: Edit, live: any) => ConflictEntry | null;
    renderConflict?: (entry: ConflictEntry) => HTMLElement;
}

export interface LodashDeps {
    get: typeof import('lodash').get;
    set: typeof import('lodash').set;
    unset: typeof import('lodash').unset;
    isEqual: typeof import('lodash').isEqual;
    cloneDeep: typeof import('lodash').cloneDeep;
}

export function applyEdits<T = unknown>(edits: Edit[], live: T): ApplyResult<T>;
export function inverseEdit(edit: Edit): Edit;
export function registerOp(name: string, handler: OpHandler): void;
export function getRegisteredOp(name: string): OpHandler | null;
export function listRegisteredOps(): string[];
export const BUILT_IN_OPS: readonly string[];
