// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolveVarPath } from './var-path.js';

export function readVariableValue(data, name, args = {}, { dotted = false } = {}) {
    let value;
    if (dotted && typeof name === 'string' && name.includes('.') && args.index === undefined && !args.key) {
        value = resolveVarPath(key => Object.hasOwn(data, key) ? data[key] : '', name);
    } else {
        value = data[args.key ?? name];
        if (args.index !== undefined) {
            try {
                value = JSON.parse(value);
                const index = Number(args.index);
                value = value[Number.isNaN(index) ? args.index : index];
                if (typeof value === 'object') value = JSON.stringify(value);
            } catch {
                // A non-JSON value retains the ordinary scalar read behavior.
            }
        }
    }
    return (value?.trim?.() === '' || isNaN(Number(value))) ? (value || '') : Number(value);
}
