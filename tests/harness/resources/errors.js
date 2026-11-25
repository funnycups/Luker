import { types } from 'node:util';

const propagationGroups = new WeakSet();

/**
 * Preserve Error instances (including cross-realm Node errors in Jest VM contexts)
 * and wrap non-Error rejections.
 */
export function failureFrom(value, message = 'Non-Error rejection') {
    return value instanceof Error || types.isNativeError(value) ? value : new Error(message, { cause: value });
}

export function failureGroup(errors, message) {
    const group = new AggregateError(errors, message);
    propagationGroups.add(group);
    return group;
}

export function failureEvents(error) {
    return propagationGroups.has(error) ? error.errors.flatMap(failureEvents) : [error];
}
