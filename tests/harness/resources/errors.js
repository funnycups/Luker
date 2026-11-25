import { createHash } from 'node:crypto';
import { types } from 'node:util';

const propagationGroups = new WeakSet();
const receivedGraphs = new WeakMap();
const receivedEvents = new WeakMap();

/** Trusted receivers bind the retained original to its actual transport event. */
export function bindFailureEvent(error, event) {
    receivedEvents.set(error, Object.freeze({ id: event.id, fingerprint: event.fingerprint }));
    return error;
}

/**
 * Keep original Error objects; convert other rejection values at the admission
 * boundary. Jest evaluates these modules in a VM context, so errors raised by
 * host-realm APIs such as node:fs do not satisfy `instanceof Error`.
 */
export function failureFrom(value, message = 'Non-Error rejection') {
    return value instanceof Error || types.isNativeError(value) ? value : new Error(message, { cause: value });
}

/** Only aggregates created to propagate already-recorded events are transparent. */
export function failureGroup(errors, message) {
    const group = new AggregateError(errors, message);
    propagationGroups.add(group);
    return group;
}

export function failureEvents(error) {
    return propagationGroups.has(error) ? error.errors.flatMap(failureEvents) : [error];
}

/** Explicit durable values preserve Error context, non-Error causes and object references. */
export function serializeFailure(value, seen = new Map(), transform = value => value) {
    const visit = value => {
        if (typeof value === 'string') return transform(value);
        if (!value || typeof value !== 'object') return value;
        const previous = value.redactions ?? [];
        const redactions = [];
        delete value.redactions;
        for (const { container, key, path } of payloadSlots(value)) {
            const payload = container[key];
            if (typeof payload !== 'string') { container[key] = visit(payload); continue; }
            const ranges = previous.find(entry => JSON.stringify(entry.path) === JSON.stringify(path))?.ranges ?? [];
            const result = transform.redact ? transform.redact(payload, ranges) : { value: transform(payload), ranges };
            container[key] = result.value;
            if (result.ranges.length) redactions.push({ path, ranges: result.ranges });
        }
        if (redactions.length) value.redactions = redactions;
        return value;
    };
    return visit(encodeFailure(value, seen));
}

function encodeFailure(value, seen) {
    const received = receivedGraphs.get(value);
    if (received) return importFailureGraph(value, received, seen);
    const encode = value => encodeFailure(value, seen);
    const properties = excluded => Reflect.ownKeys(value).filter(name => !excluded.includes(name)).map(name => {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        return { name: typeof name === 'string' ? name : encode(name), value: 'value' in descriptor ? encode(descriptor.value) : { type: 'accessor', get: descriptor.get && descriptor.get.name, set: descriptor.set && descriptor.set.name } };
    });
    if (typeof value === 'string') return value;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : { type: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
    if (typeof value === 'undefined') return { type: 'undefined' };
    if (typeof value === 'bigint') return { type: 'bigint', value: String(value) };
    if (typeof value === 'symbol') return { type: 'symbol', description: value.description, key: Symbol.keyFor(value) };
    if (seen.has(value)) return { type: 'reference', ref: seen.get(value) };
    const id = seen.size + 1;
    seen.set(value, id);
    if (value instanceof Error) {
        const result = { type: 'error', id, name: encode(value.name), message: encode(value.message), stack: encode(value.stack) };
        if (receivedEvents.has(value)) result.event = receivedEvents.get(value);
        if ('cause' in value) result.cause = encode(value.cause);
        if (value instanceof AggregateError) result.errors = value.errors.map(encode);
        if (value.code !== undefined) result.code = encode(value.code);
        if (value.resource !== undefined) result.resource = encode(value.resource);
        if (value.publication !== undefined) result.publication = encode(value.publication);
        const entries = properties(['name', 'message', 'stack', 'cause', 'errors', 'code', 'resource', 'publication']);
        if (entries.length) result.properties = entries;
        return result;
    }
    if (typeof value === 'function') return { type: 'function', id, source: Function.prototype.toString.call(value) };
    if (Array.isArray(value)) return { type: 'array', id, values: value.map(encode) };
    return { type: 'object', id, properties: properties([]) };
}

function importFailureGraph(value, context, seen) {
    const encode = value => importFailureGraph(value, context, seen);
    if (typeof value === 'string') return value;
    if (value === null || typeof value !== 'object') return value;
    if (value.type === 'reference') return encode(context.identities.get(value.ref));
    let id;
    if (Object.hasOwn(value, 'id')) {
        if (seen.has(value)) return { type: 'reference', ref: seen.get(value) };
        id = seen.size + 1;
        seen.set(value, id);
    }
    const result = { type: value.type };
    if (id !== undefined) result.id = id;
    const fields = names => { for (const name of names) if (Object.hasOwn(value, name)) result[name] = encode(value[name]); };
    if (value.type === 'error') {
        fields(['name', 'message', 'stack']);
        if (value.event) result.event = { ...value.event };
        fields(['cause']);
        if (value.errors) result.errors = value.errors.map(encode);
        fields(['code', 'resource', 'publication']);
    } else if (value.type === 'array') result.values = value.values.map(encode);
    else if (value.type === 'number') result.value = value.value;
    else if (value.type === 'bigint') result.value = value.value;
    else if (value.type === 'function') result.source = value.source;
    else if (value.type === 'symbol') fields(['description', 'key']);
    else if (value.type === 'accessor') fields(['get', 'set']);
    if (value.properties) result.properties = value.properties.map(entry => ({ name: encode(entry.name), value: encode(entry.value) }));
    if (value.redactions) result.redactions = structuredClone(value.redactions);
    return result;
}

/** Only payload slots, never representation vocabulary or trusted event bindings. */
function payloadSlots(value) {
    const result = [];
    const fields = names => { for (const key of names) if (Object.hasOwn(value, key)) result.push({ container: value, key, path: [key] }); };
    if (value.type === 'error') {
        fields(['name', 'message', 'stack', 'cause', 'code', 'resource', 'publication']);
        if (value.errors) for (const key of value.errors.keys()) result.push({ container: value.errors, key, path: ['errors', key] });
    } else if (value.type === 'array') for (const key of value.values.keys()) result.push({ container: value.values, key, path: ['values', key] });
    else if (value.type === 'bigint') fields(['value']);
    else if (value.type === 'function') fields(['source']);
    else if (value.type === 'symbol') fields(['description', 'key']);
    else if (value.type === 'accessor') fields(['get', 'set']);
    if (value.properties) for (const [index, entry] of value.properties.entries()) for (const key of ['name', 'value']) result.push({ container: entry, key, path: ['properties', index, key] });
    return result;
}

/** Only actual transport receivers grant provenance; caller shape resemblance grants none. */
export function receiveFailureGraph(graph) {
    validateFailureGraph(graph);
    const copy = structuredClone(graph);
    const context = { identities: new Map() };
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (Object.hasOwn(value, 'type')) receivedGraphs.set(value, context);
        if (Object.hasOwn(value, 'id')) context.identities.set(value.id, value);
        for (const child of Object.values(value)) visit(child);
        Object.freeze(value);
    };
    visit(copy);
    return copy;
}

/** Canonical identity numbering binds observation to the complete received payload. */
export function failureFingerprint(graph) {
    if (!receivedGraphs.has(graph)) throw new TypeError('Failure fingerprint requires a validated received graph');
    return createHash('sha256').update(JSON.stringify(serializeFailure(graph))).digest('hex');
}

/** Validate persisted representation before acknowledging its complete failure outcome. */
export function validateFailureGraph(graph) {
    const identities = new Set();
    const references = [];
    const require = (condition, location, message) => {
        if (!condition) throw new TypeError(`Failure graph ${location}: ${message}`);
    };
    const visit = (value, location) => {
        if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return;
        require(value && typeof value === 'object' && !Array.isArray(value), location, 'expected a serialized value');
        const properties = () => {
            require(Array.isArray(value.properties), location, 'missing ordered payload entries');
            for (const [index, entry] of value.properties.entries()) {
                require(entry && (typeof entry.name === 'string' || entry.name?.type === 'symbol') && Object.hasOwn(entry, 'value'), `${location}.properties[${index}]`, 'incomplete payload slot');
                require(Object.keys(entry).every(name => ['name', 'value'].includes(name)), `${location}.properties[${index}]`, 'unknown payload slot field');
                visit(entry.name, `${location}.properties[${index}].name`);
                visit(entry.value, `${location}.properties[${index}].value`);
            }
        };
        const schema = {
            error: ['type', 'id', 'name', 'message', 'stack', 'cause', 'errors', 'code', 'resource', 'publication', 'properties', 'event'],
            object: ['type', 'id', 'properties'], array: ['type', 'id', 'values'], reference: ['type', 'ref'],
            function: ['type', 'id', 'source'], number: ['type', 'value'], bigint: ['type', 'value'],
            symbol: ['type', 'description', 'key'], accessor: ['type', 'get', 'set'], undefined: ['type'],
        };
        require(Object.hasOwn(schema, value.type) && Object.keys(value).every(name => schema[value.type].includes(name) || name === 'redactions'), location, 'unknown representation field or type');
        if (['error', 'object', 'array', 'function'].includes(value.type)) {
            require(Number.isSafeInteger(value.id) && value.id > 0 && !identities.has(value.id), location, 'missing or duplicate identity');
            identities.add(value.id);
        }
        switch (value.type) {
            case 'error':
                if (Object.hasOwn(value, 'event')) require(value.event && /^[a-f0-9-]{36}$/.test(value.event.id) && /^[a-f0-9]{64}$/.test(value.event.fingerprint) && Object.keys(value.event).every(name => ['id', 'fingerprint'].includes(name)) && ['error', 'reference'].includes(value.cause?.type), location, 'invalid received event binding');
                for (const field of ['name', 'message', 'stack']) require(Object.hasOwn(value, field), location, `missing ${field}`);
                for (const field of ['name', 'message', 'stack', 'cause', 'code', 'resource', 'publication']) if (Object.hasOwn(value, field)) visit(value[field], `${location}.${field}`);
                if (Object.hasOwn(value, 'errors')) {
                    require(Array.isArray(value.errors), location, 'invalid aggregate members');
                    value.errors.forEach((error, index) => visit(error, `${location}.errors[${index}]`));
                }
                if (Object.hasOwn(value, 'properties')) properties();
                break;
            case 'object': properties(); break;
            case 'array':
                require(Array.isArray(value.values), location, 'missing array values');
                value.values.forEach((item, index) => visit(item, `${location}.values[${index}]`));
                break;
            case 'reference':
                require(Number.isSafeInteger(value.ref) && value.ref > 0, location, 'invalid reference');
                references.push({ ref: value.ref, location });
                break;
            case 'function': require(typeof value.source === 'string', location, 'missing function source'); break;
            case 'number': require(['-0', 'NaN', 'Infinity', '-Infinity'].includes(value.value), location, 'invalid numeric representation'); break;
            case 'bigint': require(typeof value.value === 'string', location, 'missing bigint payload'); break;
            case 'symbol':
                for (const field of ['description', 'key']) require(value[field] === undefined || typeof value[field] === 'string', location, `invalid symbol ${field}`);
                break;
            case 'accessor':
                for (const field of ['get', 'set']) require(value[field] === undefined || typeof value[field] === 'string', location, `invalid accessor ${field}`);
                break;
            case 'undefined': break;
            default: throw new TypeError(`Failure graph ${location}: unknown type ${value.type}`);
        }
        if (Object.hasOwn(value, 'redactions')) {
            require(Array.isArray(value.redactions) && value.redactions.length > 0, location, 'invalid redaction provenance');
            const slots = payloadSlots(value);
            const paths = new Set();
            for (const entry of value.redactions) {
                require(entry && Array.isArray(entry.path) && Object.keys(entry).every(name => ['path', 'ranges'].includes(name)), location, 'invalid redaction slot');
                const key = JSON.stringify(entry.path);
                const slot = slots.find(slot => JSON.stringify(slot.path) === key);
                require(slot && typeof slot.container[slot.key] === 'string' && !paths.has(key) && Array.isArray(entry.ranges) && entry.ranges.length > 0, location, 'redaction does not identify a unique payload string');
                paths.add(key);
                let end = 0;
                for (const range of entry.ranges) {
                    require(Array.isArray(range) && range.length === 2 && Number.isSafeInteger(range[0]) && range[0] >= end && range[1] === '[redacted]'.length && slot.container[slot.key].slice(range[0], range[0] + range[1]) === '[redacted]', location, 'redaction range does not identify generated replacement text');
                    end = range[0] + range[1];
                }
            }
        }
    };
    visit(graph, 'root');
    for (const { ref, location } of references) require(identities.has(ref), location, `reference ${ref} has no identity`);
}
