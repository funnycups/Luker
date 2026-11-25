// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Structured error thrown by the shared protocol parser whenever a wire payload
 * or SSE stream violates the declared request protocol, fails JSON parsing,
 * breaks tool correlation, ends before protocol completion, or reports an
 * upstream provider error inside an HTTP 200 payload.
 */
export class ProtocolParseError extends Error {
    /**
     * @param {object} options
     * @param {string} options.protocol Declared wire protocol identifier
     * @param {'frame'|'json'|'protocol_mismatch'|'payload'|'tool_correlation'|'eof'|'provider_error'} options.stage Failure stage
     * @param {string} [options.location] Frame index, event name, or field path
     * @param {string} options.message Actionable error description
     * @param {*} [options.cause] Underlying error
     * @param {*} [options.providerError] Raw upstream provider error object when stage is 'provider_error'
     * @param {*} [options.rawDiagnostic] Raw payload or event excerpt preserved strictly for diagnostics
     */
    constructor({
        protocol,
        stage,
        location = '',
        message,
        cause = undefined,
        providerError = undefined,
        rawDiagnostic = undefined,
    }) {
        super(message || `Protocol parse error (${protocol}/${stage})`, cause !== undefined ? { cause } : undefined);
        this.name = 'ProtocolParseError';
        this.protocol = String(protocol || 'unknown');
        this.stage = String(stage || 'payload');
        this.location = String(location || '');
        if (providerError !== undefined) {
            this.providerError = providerError;
        }
        if (rawDiagnostic !== undefined) {
            this.rawDiagnostic = rawDiagnostic;
        }
    }

    toDiagnostic() {
        return {
            protocol: this.protocol,
            stage: this.stage,
            location: this.location,
            message: this.message,
        };
    }
}

/**
 * Extract a readable message from an upstream provider error value without
 * ever producing "[object Object]" or an empty string.
 * @param {*} err
 * @returns {string}
 */
export function extractProviderErrorMessage(err) {
    if (err == null) return 'error';
    if (typeof err === 'string') return err.trim() ? err : 'error';
    if (typeof err !== 'object') return String(err);
    if (typeof err.message === 'string' && err.message) return err.message;
    if (err.error && typeof err.error === 'object') {
        const nested = extractProviderErrorMessage(err.error);
        if (nested && nested !== 'error') return nested;
    }
    if (typeof err.code === 'string' && err.code) return err.code;
    if (typeof err.type === 'string' && err.type) return err.type;
    try {
        const serialized = JSON.stringify(err);
        return serialized && serialized !== '{}' ? serialized : 'error';
    } catch {
        return 'error';
    }
}
