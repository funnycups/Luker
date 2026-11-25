/**
 * Turn the `X-Luker-Export-Warning` header of a character export into
 * user-facing warning messages. The header is base64 JSON: an array of
 * `{reason, name?, error?}` warnings, or a single warning object.
 *
 * @param {string|null} header - raw header value
 * @param {(strings: TemplateStringsArray, ...values: any[]) => string} t - core i18n template tag
 * @returns {string[]} one message per warning
 */
export function describeCharacterExportWarnings(header, t) {
    if (!header) return [];
    const bytes = Uint8Array.from(atob(header), char => char.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    return (Array.isArray(decoded) ? decoded : [decoded]).map((warning) => {
        const worldName = warning?.name || '';
        switch (warning?.reason) {
            case 'skills_pack_failed':
                return t`Failed to bundle this character's skills. The card was exported without them.`;
            case 'world_not_found':
                return t`Linked world book "${worldName}" was not found. The card was exported without an embedded world book.`;
            case 'world_unreadable':
                return t`Linked world book "${worldName}" could not be read. The card was exported without an embedded world book.`;
            default:
                return t`Failed to embed world book "${worldName}". The card was exported without it.`;
        }
    });
}
