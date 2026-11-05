/**
 * Structural conflict changes.
 *
 * This module answers one question: which parts of two JSON documents
 * differ? It deliberately has no display bounds and no UI vocabulary.
 * Values stay on the nodes so a renderer can decide how to present them;
 * the view builder never serializes them into the navigation tree.
 */

export const MISSING = Symbol('missing');

const DEFAULT_ID_FIELDS = ['id', 'identifier', 'uid'];

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function idOf(value, idFields) {
    if (!isPlainObject(value)) return null;
    for (const field of idFields) {
        if (!Object.hasOwn(value, field)) continue;
        const raw = value[field];
        if ((typeof raw === 'string' || typeof raw === 'number') && String(raw).length > 0) return String(raw);
    }
    return null;
}

/**
 * Unique ids for every element, or null when alignment is unsafe.
 * A single duplicate or missing id makes the whole array positional:
 * pairing unrelated entries is worse than showing more rows.
 *
 * @param {unknown[]} items
 * @param {string[]} idFields
 * @returns {string[] | null}
 */
function alignedIds(items, idFields) {
    const ids = [];
    for (const item of items) {
        const id = idOf(item, idFields);
        if (id === null) return null;
        ids.push(id);
    }
    return new Set(ids).size === ids.length ? ids : null;
}

function allObjects(items) {
    return items.every(isPlainObject);
}

function objectPath(pathKey, key) {
    return pathKey ? `${pathKey}.${key}` : String(key);
}

function itemPath(pathKey, key, aligned) {
    return aligned ? `${pathKey}[${JSON.stringify(key)}]` : `${pathKey}[${key}]`;
}

/** Indices of one longest strictly increasing subsequence. */
function longestIncreasingSubsequence(values) {
    const tails = [];
    const previous = new Array(values.length).fill(-1);
    for (let index = 0; index < values.length; index++) {
        let low = 0;
        let high = tails.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (values[tails[middle]] < values[index]) low = middle + 1;
            else high = middle;
        }
        if (low > 0) previous[index] = tails[low - 1];
        tails[low] = index;
    }
    const result = [];
    let cursor = tails.length > 0 ? tails[tails.length - 1] : -1;
    while (cursor >= 0) {
        result.push(cursor);
        cursor = previous[cursor];
    }
    return result.reverse();
}

function makeNode(type, key, path, status, { before, after, children, move } = {}) {
    const node = { type, key, path, status };
    if (before !== undefined) node.before = before;
    if (after !== undefined) node.after = after;
    if (children !== undefined) node.children = children;
    if (move !== undefined) node.move = move;
    return node;
}

function diffObjects(left, right, pathKey, key, idFields) {
    const leftMissing = left === MISSING;
    const rightMissing = right === MISSING;
    const leftObject = leftMissing ? {} : left;
    const rightObject = rightMissing ? {} : right;
    const keys = [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])].sort();
    const children = [];
    for (const childKey of keys) {
        const child = collectChanges(
            Object.hasOwn(leftObject, childKey) ? leftObject[childKey] : MISSING,
            Object.hasOwn(rightObject, childKey) ? rightObject[childKey] : MISSING,
            { path: objectPath(pathKey, childKey), key: childKey, idFields },
        );
        if (child) children.push(child);
    }
    if (!leftMissing && !rightMissing && children.length === 0) return null;
    return makeNode('object', key, pathKey, leftMissing ? 'added' : rightMissing ? 'removed' : 'changed', {
        before: leftMissing ? undefined : left,
        after: rightMissing ? undefined : right,
        children,
    });
}

function diffItem(left, right, pathKey, key, idFields, aligned, move) {
    const leftMissing = left === MISSING;
    const rightMissing = right === MISSING;
    const leftObject = isPlainObject(left);
    const rightObject = isPlainObject(right);

    if ((leftObject || leftMissing) && (rightObject || rightMissing)) {
        const children = diffObjects(left, right, pathKey, key, idFields)?.children ?? [];
        if (!leftMissing && !rightMissing && children.length === 0) {
            return move ? makeNode('item', key, pathKey, 'moved', { move }) : null;
        }
        return makeNode('item', key, pathKey, leftMissing ? 'added' : rightMissing ? 'removed' : 'changed', {
            before: leftMissing ? undefined : left,
            after: rightMissing ? undefined : right,
            children,
            move,
        });
    }

    if (leftObject || rightObject) {
        return makeNode('item', key, pathKey, leftMissing ? 'added' : rightMissing ? 'removed' : 'changed', {
            before: leftMissing ? undefined : left,
            after: rightMissing ? undefined : right,
            move,
        });
    }

    if (!leftMissing && !rightMissing && Object.is(left, right)) {
        return move ? makeNode('item', key, pathKey, 'moved', { move }) : null;
    }

    return makeNode('item', key, pathKey, leftMissing ? 'added' : rightMissing ? 'removed' : 'changed', {
        before: leftMissing ? undefined : left,
        after: rightMissing ? undefined : right,
        move,
    });
}

function diffAlignedArrays(left, right, pathKey, key, idFields) {
    const leftMissing = left === MISSING;
    const rightMissing = right === MISSING;
    const leftItems = leftMissing ? [] : left;
    const rightItems = rightMissing ? [] : right;
    const leftIds = alignedIds(leftItems, idFields);
    const rightIds = alignedIds(rightItems, idFields);
    const leftById = new Map(leftItems.map((item, index) => [leftIds[index], item]));
    const rightById = new Map(rightItems.map((item, index) => [rightIds[index], item]));
    const leftIndexById = new Map(leftIds.map((id, index) => [id, index]));
    const rightIndexById = new Map(rightIds.map((id, index) => [id, index]));
    const children = [];

    for (const id of leftIds) {
        if (rightById.has(id)) continue;
        const item = diffItem(leftById.get(id), MISSING, itemPath(pathKey, id, true), id, idFields, true);
        if (item) children.push(item);
    }
    for (const id of rightIds) {
        if (leftById.has(id)) continue;
        const item = diffItem(MISSING, rightById.get(id), itemPath(pathKey, id, true), id, idFields, true);
        if (item) children.push(item);
    }

    const commonLeft = leftIds.filter(id => rightById.has(id));
    const commonRight = rightIds.filter(id => leftById.has(id));
    const canCompareOrder = commonLeft.length === commonRight.length;
    let stable = new Set();
    if (canCompareOrder) {
        const rightPosition = new Map(commonRight.map((id, index) => [id, index]));
        const positions = commonLeft.map(id => rightPosition.get(id));
        stable = new Set(longestIncreasingSubsequence(positions).map(index => commonLeft[index]));
    }

    for (const id of commonLeft) {
        const from = leftIndexById.get(id) + 1;
        const to = rightIndexById.get(id) + 1;
        const move = canCompareOrder && !stable.has(id) && from !== to ? { from, to } : undefined;
        const item = diffItem(leftById.get(id), rightById.get(id), itemPath(pathKey, id, true), id, idFields, true, move);
        if (item) children.push(item);
    }

    if (!leftMissing && !rightMissing && children.length === 0) return null;
    return makeNode('array', key, pathKey, leftMissing ? 'added' : rightMissing ? 'removed' : 'changed', {
        before: leftMissing ? undefined : left,
        after: rightMissing ? undefined : right,
        children,
    });
}

function diffPositionalArrays(left, right, pathKey, key, idFields) {
    const leftMissing = left === MISSING;
    const rightMissing = right === MISSING;
    const leftItems = leftMissing ? [] : left;
    const rightItems = rightMissing ? [] : right;
    const length = Math.max(leftItems.length, rightItems.length);
    const children = [];
    for (let index = 0; index < length; index++) {
        const item = diffItem(
            index < leftItems.length ? leftItems[index] : MISSING,
            index < rightItems.length ? rightItems[index] : MISSING,
            itemPath(pathKey, index, false),
            index,
            idFields,
            false,
        );
        if (item) children.push(item);
    }
    if (!leftMissing && !rightMissing && children.length === 0) return null;
    return makeNode('array', key, pathKey, leftMissing ? 'added' : rightMissing ? 'removed' : 'changed', {
        before: leftMissing ? undefined : left,
        after: rightMissing ? undefined : right,
        children,
    });
}

function diffArrays(left, right, pathKey, key, idFields) {
    const leftMissing = left === MISSING;
    const rightMissing = right === MISSING;
    if (!leftMissing && !rightMissing && left.length === 0 && right.length === 0) return null;
    const leftItems = leftMissing ? [] : left;
    const rightItems = rightMissing ? [] : right;
    const objects = allObjects(leftItems) && allObjects(rightItems);
    if (!objects) {
        return collectField(left, right, pathKey, key);
    }
    const aligned = alignedIds(leftItems, idFields) !== null && alignedIds(rightItems, idFields) !== null;
    return aligned
        ? diffAlignedArrays(left, right, pathKey, key, idFields)
        : diffPositionalArrays(left, right, pathKey, key, idFields);
}

function sameArrayValues(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => {
        const other = right[index];
        if (Object.is(value, other)) return true;
        if (value === null || other === null || typeof value !== 'object' || typeof other !== 'object') return false;
        try {
            return JSON.stringify(value) === JSON.stringify(other);
        } catch {
            return false;
        }
    });
}

function collectField(left, right, pathKey, key) {
    const leftMissing = left === MISSING;
    const rightMissing = right === MISSING;
    if (!leftMissing && !rightMissing && Object.is(left, right)) return null;
    if (!leftMissing && !rightMissing && sameArrayValues(left, right)) return null;
    return makeNode('field', key, pathKey, leftMissing ? 'added' : rightMissing ? 'removed' : 'changed', {
        before: leftMissing ? undefined : left,
        after: rightMissing ? undefined : right,
    });
}

/**
 * Compare two JSON values.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @param {{ path?: string, key?: string, idFields?: string[] }} [options]
 * @returns {{ type: 'object'|'array'|'item'|'field', key: string|number, path: string, status: 'added'|'removed'|'changed'|'moved', before?: unknown, after?: unknown, children?: unknown[], move?: { from: number, to: number } } | null}
 */
export function collectChanges(left, right, { path = '', key = '', idFields = DEFAULT_ID_FIELDS } = {}) {
    const leftMissing = left === MISSING;
    const rightMissing = right === MISSING;
    if (leftMissing && rightMissing) return null;
    if (!leftMissing && !rightMissing && Object.is(left, right)) return null;

    if ((!leftMissing && isPlainObject(left)) || (!rightMissing && isPlainObject(right))) {
        if ((leftMissing || isPlainObject(left)) && (rightMissing || isPlainObject(right))) {
            return diffObjects(left, right, path, key, idFields);
        }
    }

    if ((!leftMissing && Array.isArray(left)) || (!rightMissing && Array.isArray(right))) {
        if ((leftMissing || Array.isArray(left)) && (rightMissing || Array.isArray(right))) {
            return diffArrays(left, right, path, key, idFields);
        }
    }

    return collectField(left, right, path, key);
}
