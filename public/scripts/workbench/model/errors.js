// SPDX-License-Identifier: AGPL-3.0-or-later

export class SourceError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}
