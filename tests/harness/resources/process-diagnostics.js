import { StringDecoder } from 'node:string_decoder';
import { inspect, stripVTControlCharacters } from 'node:util';
import { createHash } from 'node:crypto';
import { serializeFailure } from './errors.js';

const marker = '[redacted]';
const format = 'literal-utf16le-sha256-v1';
const sha = value => createHash('sha256').update(Buffer.from(value, 'utf16le')).digest('hex');

export function normalizeReadinessLine(value) {
    return stripVTControlCharacters(value.replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, ''));
}

function validPolicy(policy) {
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const keys = (value, names) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
    return object(policy) && keys(policy, ['format', 'layers']) && policy.format === format && Array.isArray(policy.layers)
        && policy.layers.every(layer => Array.isArray(layer) && layer.length > 0 && layer.every(rule => object(rule) && keys(rule, ['length', 'sha256'])
            && Number.isSafeInteger(rule.length) && rule.length > 0 && typeof rule.sha256 === 'string' && /^[a-f0-9]{64}$/.test(rule.sha256)));
}

/** Durable matching rules replay redaction without retaining declaration values. */
export function processDiagnostics(options, append, redaction = { format, layers: [] }) {
    if (!validPolicy(redaction)) throw new TypeError(`Diagnostic redaction policy requires ${format} with typed lengths and digests; retain registry and scenario data`);
    return diagnostics(options, append, redaction.layers.map(rules => ({ rules })));
}

/** Process diagnostics share captured declarations; raw execution input is not diagnostic output. */
function diagnostics(options, append, previous) {
    const sensitive = [...new Set([...Object.values(options.env ?? {}), ...options.sensitiveValues ?? []])].filter(Boolean).sort((left, right) => right.length - left.length);
    const represented = [...new Set(sensitive.flatMap(value => [value, JSON.stringify(value).slice(1, -1), inspect(value, { maxStringLength: null, breakLength: Infinity }).slice(1, -1)]))].sort((left, right) => right.length - left.length);
    const layers = [...previous];
    if (represented.length) layers.push({ rules: represented.map(value => ({ length: value.length, sha256: sha(value) })), represented });
    const project = (input, protectedRanges) => {
        let value = input;
        let ranges = protectedRanges;
        for (const layer of layers) {
            const lengths = [...new Set(layer.rules.map(rule => rule.length))].sort((left, right) => right - left);
            const hashes = new Set(layer.rules.map(rule => rule.sha256));
            let output = '';
            const generated = [];
            let position = 0;
            let index = 0;
            while (position < value.length) {
                const protectedRange = ranges[index];
                if (protectedRange?.[0] === position) {
                    generated.push([output.length, marker.length]);
                    output += marker;
                    position += marker.length;
                    index++;
                    continue;
                }
                const boundary = protectedRange?.[0] ?? value.length;
                const length = layer.represented
                    ? layer.represented.find(secret => position + secret.length <= boundary && value.startsWith(secret, position))?.length
                    : lengths.find(length => position + length <= boundary && hashes.has(sha(value.slice(position, position + length))));
                if (length) { generated.push([output.length, marker.length]); output += marker; position += length; }
                else output += value[position++];
            }
            value = output;
            ranges = generated;
        }
        return { value, ranges };
    };
    const transform = value => project(value, []).value;
    transform.redact = project;
    const chunks = new Map();
    const flushAvailable = (stream, chunk, ending) => {
        let consumed = 0;
        let available = '';
        while (consumed < chunk.text.length) {
            const remaining = chunk.text.slice(consumed);
            if (sensitive.some(secret => secret.startsWith(remaining))) {
                if (!ending) break;
                available += '[redacted]';
                consumed = chunk.text.length;
                break;
            }
            const secret = sensitive.find(secret => remaining.startsWith(secret));
            if (secret) { available += '[redacted]'; consumed += secret.length; }
            else available += chunk.text[consumed++];
        }
        chunk.text = chunk.text.slice(consumed);
        if (available) append(stream, available);
    };
    return {
        redaction: { format, layers: layers.map(layer => layer.rules.map(rule => ({ ...rule }))) },
        extend: options => diagnostics(options, undefined, layers),
        failure: error => serializeFailure(error, new Map(), transform),
        write(stream, data) {
            if (!chunks.has(stream)) chunks.set(stream, { decoder: new StringDecoder('utf8'), text: '' });
            const chunk = chunks.get(stream);
            chunk.text += chunk.decoder.write(data);
            flushAvailable(stream, chunk, false);
        },
        flush() {
            for (const [stream, chunk] of chunks) { chunk.text += chunk.decoder.end(); flushAvailable(stream, chunk, true); }
            chunks.clear();
        },
    };
}
