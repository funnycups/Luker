/**
 * URL-based skill import.
 *
 * Single-file SKILL.md fetcher. For multi-file or binary skills, the caller
 * should use the regular zip-upload import path instead.
 *
 * Security: HTTPS-only. The fetched payload must begin with a YAML
 * frontmatter delimiter (`---\n` or `---\r\n`); plain HTML pages or
 * arbitrary content are rejected before reaching the repository.
 */

const MAX_SKILL_MD_BYTES = 512 * 1024;

/**
 * Import a single SKILL.md file from an HTTPS raw URL.
 * @param {object} opts
 * @param {string} opts.url - HTTPS URL of the raw SKILL.md.
 * @param {object} opts.targetScope - destination scope.
 * @param {object} opts.repository - SkillRepository instance.
 * @returns {Promise<{name:string, conflict:'new'|'same'|'different'}>}
 */
export async function importFromUrl({ url, targetScope, repository }) {
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
        throw new Error('only https:// URLs are allowed');
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_SKILL_MD_BYTES) {
        throw new Error(`fetched SKILL.md exceeds ${MAX_SKILL_MD_BYTES} bytes`);
    }
    if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
        throw new Error('URL did not return SKILL.md (no YAML frontmatter)');
    }
    const result = await repository.install({
        scope: targetScope,
        payload: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: text }] },
    });
    return {
        name: result.name,
        conflict: result.action === 'installed' ? 'new'
            : result.action === 'replaced' ? 'different'
                : 'same',
    };
}
