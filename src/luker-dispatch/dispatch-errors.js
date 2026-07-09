// SPDX-License-Identifier: AGPL-3.0-or-later
export class DispatchBadRequest extends Error {
    constructor(message) { super(message); this.name = 'DispatchBadRequest'; this.status = 400; }
}
