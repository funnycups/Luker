// SPDX-License-Identifier: AGPL-3.0-or-later
//
// localStorage scoped to the signed-in account. Run and change history can be
// large, so it stays out of the settings file, but one browser can serve
// several accounts. With no known account nothing is read or stored.

/** @param {{ getItem, setItem, removeItem }} storage  @param {() => string|null} getHandle */
export function accountScopedStorage(storage, getHandle) {
    const scoped = (key) => {
        const handle = getHandle();
        return handle ? `${key}::${handle}` : null;
    };
    return {
        getHandle,
        getItem(key) {
            const name = scoped(key);
            return name ? storage?.getItem(name) ?? null : null;
        },
        setItem(key, value) {
            const name = scoped(key);
            if (name) storage?.setItem(name, value);
        },
        removeItem(key) {
            const name = scoped(key);
            if (name) storage?.removeItem(name);
        },
    };
}
