import { STATE_ERROR_REASONS } from '../../state-errors.js';

export class UnknownTargetError extends Error {
    constructor(target) {
        super(`unknown target: ${JSON.stringify(target)}`);
        this.name = 'UnknownTargetError';
        this.target = target;
        this.reason = STATE_ERROR_REASONS.VALIDATION_ARGS;
        this.hint = `unknown target type: ${String(target?.type || 'no-type').slice(0, 80)}`;
    }
}

const handlers = new Map();

export function registerTarget(typeKey, handler) {
    if (typeof typeKey !== 'string' || !typeKey.trim()) {
        throw new Error('registerTarget: typeKey must be a non-empty string');
    }
    if (!handler || typeof handler !== 'object') {
        throw new Error('registerTarget: handler must be an object');
    }
    for (const required of ['read', 'write', 'describe']) {
        if (typeof handler[required] !== 'function') {
            throw new Error(`registerTarget: handler missing required method: ${required}`);
        }
    }
    if (handlers.has(typeKey)) {
        console.warn(`target-registry: handler for type '${typeKey}' is being overwritten`);
    }
    handlers.set(typeKey, handler);
}

export function resolveTarget(target) {
    if (!target || typeof target !== 'object' || typeof target.type !== 'string' || !target.type) {
        throw new UnknownTargetError(target);
    }
    const handler = handlers.get(target.type);
    if (!handler) throw new UnknownTargetError(target);
    return handler;
}

export function clearRegistry() {
    handlers.clear();
}
