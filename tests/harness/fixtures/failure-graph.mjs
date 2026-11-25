import assert from 'node:assert/strict';

/** Reader for the shared ordered payload representation, never an object-key projection. */
export function property(node, name) {
    if (!node?.properties) return undefined;
    assert.ok(Array.isArray(node.properties), 'Failure payload properties must be ordered entries');
    const entries = node.properties.filter(entry => entry.name === name);
    assert.ok(entries.length <= 1, 'Colliding displayed names must be read by their distinct ordered slots');
    return entries[0]?.value;
}

export function fields(node) {
    assert.equal(node.type, 'object');
    const result = Object.create(null);
    for (const { name, value } of node.properties) {
        assert.equal(typeof name, 'string');
        assert.equal(Object.hasOwn(result, name), false, 'Colliding displayed names have no object-key view');
        Object.defineProperty(result, name, { enumerable: true, value });
    }
    return result;
}
