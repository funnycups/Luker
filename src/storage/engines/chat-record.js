export function parseChatJson(raw, location) {
    try {
        return JSON.parse(raw);
    } catch {
        throw new Error(`Unreadable chat data at ${location}: invalid JSON`);
    }
}

export function chatLocation(key, namespace) {
    const address = `${key.handle}/${key.charDir ?? ''}/${key.name ?? key.groupId}`;
    return namespace === undefined ? address : `${address} namespace ${namespace}`;
}

export function parseChatDocument(raw, key) {
    const location = chatLocation(key);
    const parsed = parseChatJson(raw, location);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !parsed.header || typeof parsed.header !== 'object' || Array.isArray(parsed.header)
        || !Array.isArray(parsed.body)) {
        throw new Error(`Unreadable chat document at ${location}: expected an object header and message array`);
    }
    return parsed;
}

export function chatHeaderWithIntegrity(record) {
    return {
        ...record.header,
        chat_metadata: { ...(record.header.chat_metadata ?? {}), integrity: record.integrity },
    };
}
