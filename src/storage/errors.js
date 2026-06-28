export class ConflictError extends Error {
    constructor(code, details = undefined) {
        super(`storage conflict: ${code}`);
        this.name = 'ConflictError';
        this.code = code;
        this.details = details;
    }
}

export class NotFoundError extends Error {
    constructor(resource, details = undefined) {
        super(`storage not found: ${resource}`);
        this.name = 'NotFoundError';
        this.resource = resource;
        this.details = details;
    }
}

export class PatchTestFailedError extends Error {
    constructor(path) {
        super(`json patch test failed at ${path}`);
        this.name = 'PatchTestFailedError';
        this.code = 'patch_test_failed';
        this.path = path;
    }
}

export class PatchMissingParentError extends Error {
    constructor(op, path) {
        super(`json patch ${op} failed: missing parent at ${path}`);
        this.name = 'PatchMissingParentError';
        this.code = 'patch_missing_parent';
        this.op = op;
        this.path = path;
    }
}

export class UnsupportedPatchOpError extends Error {
    constructor(op) {
        super(`unsupported json patch op: ${op}`);
        this.name = 'UnsupportedPatchOpError';
        this.code = 'patch_unsupported_op';
        this.op = op;
    }
}

export class StorageReadOnlyError extends Error {
    constructor() {
        super('storage is read-only: a migration is in progress');
        this.name = 'StorageReadOnlyError';
        this.code = 'storage_read_only';
    }
}

export class InvalidArgumentError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidArgumentError';
        this.code = 'invalid_argument';
    }
}
