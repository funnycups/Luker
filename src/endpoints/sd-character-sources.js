// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import express from 'express';
import fetch from 'node-fetch';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import '../fetch-patch.js';
import { Jimp, JimpMime } from '../jimp.js';
import { loadManagedMediaInput } from '../media-input-loader.js';
import { getUntrustedRequestAgent } from '../private-request-filter.js';
import { validateVisitUrl } from './search.js';
import {
    assertTransientMediaRead,
    completeTransientPromotion,
    getTransientSession,
    promoteTransientImages,
    rollbackTransientPromotion,
    trackTransientOperation,
    TransientSessionError,
    writeTransientImage,
} from '../transient-sessions.js';

export const router = express.Router();

const MIN_REFERENCE_DIMENSION_PX = 64; // cap-ok: rejects <64px UI icons unusable as model reference inputs
const MAX_REFERENCE_DOWNLOAD_BYTES = 25 * 1024 * 1024; // cap-ok: bounds untrusted remote image buffering in server RAM to 25 MiB
const SHA256_FILENAME_PREFIX_LEN = 16; // cap-ok: 64-bit SHA-256 hex prefix keeps _references filenames under OS 255-byte path limits
const DEFAULT_BOORU_POST_FETCH_COUNT = 20; // cap-ok: upstream Safebooru/Danbooru single-page API batch size for tag frequency aggregation

const SOURCE_USER_AGENT = 'Luker-Character-Reference/1.0';

const BOORU_NOISE_TAGS = new Set([
    '1girl', '2girls', '3girls', 'multiple_girls',
    '1boy', '2boys', '3boys', 'multiple_boys',
    'solo', 'solo_focus', 'highres', 'absurdres', 'incredibly_absurdres',
    'lowres', 'commentary', 'commentary_request', 'translated', 'translation_request',
    'symbol-only_commentary', 'english_commentary', 'japanese_commentary',
    'simple_background', 'white_background', 'transparent_background', 'grey_background',
    'gradient_background', 'looking_at_viewer', 'smile', 'open_mouth', 'closed_mouth',
    'standing', 'sitting', 'upper_body', 'cowboy_shot', 'full_body', 'portrait',
    'blush', 'official_art', 'character_name', 'watermark', 'signature', 'artist_name',
]);

class CharacterSourceError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function normalizeSpace(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function looksLikeAntiBotChallenge(status, text = '') {
    if (status === 403 || status === 429 || status === 503) {
        return true;
    }
    const sample = String(text || '');
    return /cf-chl|g-recaptcha|h-captcha|cf-turnstile|Just a moment\.\.\.|Enable JavaScript and cookies to continue/i.test(sample);
}

async function fetchPublicJson(url, init = {}, sourceLabel = 'source') {
    const response = await fetch(url, {
        ...init,
        headers: {
            'Accept': 'application/json',
            'User-Agent': SOURCE_USER_AGENT,
            ...(init.headers || {}),
        },
        agent: getUntrustedRequestAgent(),
    });

    if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        if (looksLikeAntiBotChallenge(response.status, errBody)) {
            throw new CharacterSourceError(
                502,
                'UPSTREAM_CHALLENGE_OR_FORBIDDEN',
                `Upstream ${sourceLabel} returned HTTP ${response.status} or an access challenge; switch to another character source.`,
            );
        }
        throw new CharacterSourceError(
            502,
            'UPSTREAM_HTTP_ERROR',
            `Upstream ${sourceLabel} failed with HTTP ${response.status}.`,
        );
    }

    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
        const htmlBody = await response.text().catch(() => '');
        if (looksLikeAntiBotChallenge(200, htmlBody)) {
            throw new CharacterSourceError(
                502,
                'UPSTREAM_CHALLENGE_OR_FORBIDDEN',
                `Upstream ${sourceLabel} returned an HTML access challenge instead of JSON; switch to another character source.`,
            );
        }
    }

    return await response.json();
}

export function formatCandidatesAsGrepLines(source, candidates = []) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return '';
    }
    return candidates.map((item, idx) => {
        const fields = [`${idx + 1}: [${source}] ${normalizeSpace(item.name || 'Unknown')}`];
        if (item.work) fields.push(`work=${normalizeSpace(item.work)}`);
        if (item.characterTag) fields.push(`character_tag=${normalizeSpace(item.characterTag)}`);
        if (Array.isArray(item.aliases) && item.aliases.length > 0) {
            fields.push(`aliases=${item.aliases.join(',')}`);
        }
        if (Array.isArray(item.tags) && item.tags.length > 0) {
            fields.push(`tags=${item.tags.join(',')}`);
        }
        if (Array.isArray(item.imageUrls) && item.imageUrls.length > 0) {
            fields.push(`images=${item.imageUrls.join(',')}`);
        }
        if (item.pageUrl) fields.push(`page=${item.pageUrl}`);
        if (item.summary) fields.push(normalizeSpace(item.summary));
        return fields.join(' | ');
    }).join('\n');
}

async function searchBangumiCharacters({ query, work = '' }) {
    const keyword = work ? `${query} ${work}`.trim() : query;
    const data = await fetchPublicJson('https://api.bgm.tv/v0/search/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword }),
    }, 'Bangumi');

    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows.map((row) => {
        const aliases = [];
        if (Array.isArray(row?.infobox)) {
            for (const entry of row.infobox) {
                const k = String(entry?.key || '');
                if (k === '简体中文名' || k === '别名' || k === '日文名') {
                    if (typeof entry.value === 'string' && entry.value.trim()) {
                        aliases.push(entry.value.trim());
                    } else if (Array.isArray(entry.value)) {
                        for (const sub of entry.value) {
                            const val = typeof sub === 'string' ? sub : sub?.v;
                            if (val && String(val).trim()) aliases.push(String(val).trim());
                        }
                    }
                }
            }
        }
        const uniqueAliases = [...new Set(aliases.filter(a => a !== row.name))];
        const imageUrls = [
            row?.images?.large,
            row?.images?.medium,
            row?.images?.grid,
        ].filter(u => typeof u === 'string' && /^https?:\/\//i.test(u));

        return {
            name: String(row?.name || query),
            aliases: uniqueAliases,
            work: String(work || ''),
            tags: [],
            imageUrls: [...new Set(imageUrls)],
            pageUrl: row?.id ? `https://bgm.tv/character/${row.id}` : '',
            summary: normalizeSpace(row?.summary || ''),
        };
    });
}

function resolveMediaWikiApiEndpoint(rawHost) {
    const host = String(rawHost || 'en.wikipedia.org').trim().toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
        throw new CharacterSourceError(400, 'INVALID_WIKI_HOST', `Invalid MediaWiki hostname: "${rawHost}".`);
    }
    const apiPath = /\.(?:wikipedia|wikimedia|wiktionary|wikibooks|wikisource)\.org$/i.test(host)
        ? '/w/api.php'
        : '/api.php';
    const fullUrl = `https://${host}${apiPath}`;
    try {
        validateVisitUrl(fullUrl);
    } catch (err) {
        throw new CharacterSourceError(400, 'INVALID_WIKI_HOST', `Disallowed MediaWiki hostname: ${err.message}`);
    }
    return { host, fullUrl };
}

async function searchMediaWikiCharacters({ query, work = '', wikiHost = 'en.wikipedia.org' }) {
    const { host, fullUrl } = resolveMediaWikiApiEndpoint(wikiHost);
    const url = new URL(fullUrl);
    url.searchParams.set('action', 'query');
    url.searchParams.set('generator', 'search');
    url.searchParams.set('gsrsearch', work ? `${query} ${work}`.trim() : query);
    url.searchParams.set('gsrlimit', '8');
    url.searchParams.set('prop', 'pageimages|extracts|info');
    url.searchParams.set('piprop', 'original|thumbnail');
    url.searchParams.set('pithumbsize', '1000');
    url.searchParams.set('exintro', '1');
    url.searchParams.set('explaintext', '1');
    url.searchParams.set('inprop', 'url');
    url.searchParams.set('format', 'json');

    const data = await fetchPublicJson(url.toString(), { method: 'GET' }, `MediaWiki (${host})`);
    const pagesObj = data?.query?.pages;
    if (!pagesObj || typeof pagesObj !== 'object') {
        return [];
    }

    return Object.values(pagesObj).map((page) => {
        const imageUrls = [
            page?.original?.source,
            page?.thumbnail?.source,
        ].filter(u => typeof u === 'string' && /^https?:\/\//i.test(u));

        return {
            name: String(page?.title || query),
            aliases: [],
            work: String(work || host),
            tags: [],
            imageUrls: [...new Set(imageUrls)],
            pageUrl: String(page?.fullurl || `https://${host}/wiki/${encodeURIComponent(String(page?.title || '').replace(/\s+/g, '_'))}`),
            summary: normalizeSpace(page?.extract || ''),
        };
    });
}

function normalizeBooruTagToken(raw) {
    return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_()+-]/g, '');
}

async function searchBooruCharacters({ query, work = '', booruSite = 'safebooru' }) {
    const charTag = normalizeBooruTagToken(query);
    if (!charTag) {
        throw new CharacterSourceError(400, 'INVALID_BOORU_QUERY', 'Booru character query cannot be empty.');
    }
    const searchTags = `${charTag} solo`;
    const isDanbooru = String(booruSite || '').toLowerCase() === 'danbooru';

    let endpointUrl;
    if (isDanbooru) {
        const u = new URL('https://danbooru.donmai.us/posts.json');
        u.searchParams.set('tags', searchTags);
        u.searchParams.set('limit', String(DEFAULT_BOORU_POST_FETCH_COUNT));
        endpointUrl = u.toString();
    } else {
        const u = new URL('https://safebooru.org/index.php');
        u.searchParams.set('page', 'dapi');
        u.searchParams.set('s', 'post');
        u.searchParams.set('q', 'index');
        u.searchParams.set('json', '1');
        u.searchParams.set('limit', String(DEFAULT_BOORU_POST_FETCH_COUNT));
        u.searchParams.set('tags', searchTags);
        endpointUrl = u.toString();
    }

    const raw = await fetchPublicJson(endpointUrl, { method: 'GET' }, isDanbooru ? 'Danbooru' : 'Safebooru');
    const posts = Array.isArray(raw) ? raw : [];
    if (posts.length === 0) {
        return [];
    }

    const tagCounts = new Map();
    const copyrightCounts = new Map();
    const imageUrls = [];

    for (const post of posts) {
        const fileUrl = post?.file_url || post?.sample_url || post?.large_file_url || '';
        if (typeof fileUrl === 'string' && /^https?:\/\//i.test(fileUrl) && !imageUrls.includes(fileUrl)) {
            imageUrls.push(fileUrl);
        }

        const copyrightRaw = typeof post?.tag_string_copyright === 'string' ? post.tag_string_copyright : '';
        for (const cTag of copyrightRaw.split(/\s+/).filter(Boolean)) {
            copyrightCounts.set(cTag, (copyrightCounts.get(cTag) || 0) + 1);
        }

        const generalRaw = typeof post?.tag_string_general === 'string'
            ? post.tag_string_general
            : (typeof post?.tags === 'string' ? post.tags : '');

        for (const tag of generalRaw.split(/\s+/).filter(Boolean)) {
            const lower = tag.toLowerCase();
            if (lower === charTag || BOORU_NOISE_TAGS.has(lower)) {
                continue;
            }
            tagCounts.set(lower, (tagCounts.get(lower) || 0) + 1);
        }
    }

    const minOccurrences = posts.length >= 2 ? 2 : 1;
    const tags = [...tagCounts.entries()]
        .filter(([, count]) => count >= minOccurrences)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([tag]) => tag);

    const detectedWork = work || ([...copyrightCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '');
    const pageUrl = isDanbooru
        ? `https://danbooru.donmai.us/posts?tags=${encodeURIComponent(charTag)}`
        : `https://safebooru.org/index.php?page=post&s=list&tags=${encodeURIComponent(charTag)}`;

    return [{
        name: query,
        aliases: charTag !== query ? [charTag] : [],
        work: detectedWork,
        characterTag: charTag,
        tags,
        imageUrls,
        pageUrl,
        summary: `Aggregated from ${posts.length} ${isDanbooru ? 'Danbooru' : 'Safebooru'} solo posts.`,
    }];
}

function extensionFromMime(mimeType) {
    const lower = String(mimeType || '').toLowerCase();
    if (lower === 'image/jpeg' || lower === 'image/jpg') return 'jpg';
    if (lower === 'image/webp') return 'webp';
    return 'png';
}

async function decodeAndPersistReferenceImage({ directories, buffer, profileId, transientSession = null }) {
    if (!directories?.userImages) {
        throw new CharacterSourceError(500, 'USER_IMAGES_DIR_UNAVAILABLE', 'User images directory is unavailable.');
    }

    let decoded;
    try {
        decoded = await Jimp.read(Buffer.from(buffer));
    } catch {
        throw new CharacterSourceError(422, 'INVALID_IMAGE_DATA', 'Resource is not a valid decodable image.');
    }

    const width = Number(decoded?.bitmap?.width || 0);
    const height = Number(decoded?.bitmap?.height || 0);
    if (width < MIN_REFERENCE_DIMENSION_PX || height < MIN_REFERENCE_DIMENSION_PX) {
        throw new CharacterSourceError(
            422,
            'IMAGE_TOO_SMALL',
            `Reference image dimensions (${width}x${height}) are smaller than ${MIN_REFERENCE_DIMENSION_PX}x${MIN_REFERENCE_DIMENSION_PX}.`,
        );
    }

    const detectedMime = decoded.mime || JimpMime.png;
    const ext = extensionFromMime(detectedMime);
    const outBuffer = (detectedMime === JimpMime.png || detectedMime === JimpMime.jpeg)
        ? Buffer.from(buffer)
        : Buffer.from(await decoded.getBuffer(JimpMime.png));
    const finalExt = (detectedMime === JimpMime.png || detectedMime === JimpMime.jpeg) ? ext : 'png';
    const finalMime = finalExt === 'jpg' ? 'image/jpeg' : 'image/png';

    const sha256 = crypto.createHash('sha256').update(outBuffer).digest('hex');
    const safeStem = sanitize(String(profileId || 'char'))
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'char';
    const filename = `${safeStem}_${sha256.slice(0, SHA256_FILENAME_PREFIX_LEN)}.${finalExt}`; // cap-ok: 64-bit SHA-256 hex prefix keeps _references filenames under OS 255-byte path limits

    let imagePath;
    if (transientSession) {
        imagePath = await writeTransientImage(transientSession, filename, outBuffer);
    } else {
        const refDir = path.join(directories.userImages, '_references');
        fs.mkdirSync(refDir, { recursive: true });
        writeFileAtomicSync(path.join(refDir, filename), outBuffer);
        imagePath = `/user/images/_references/${filename}`;
    }

    return {
        imagePath,
        width,
        height,
        mimeType: finalMime,
        sha256,
    };
}

router.post('/search', async (req, res) => {
    try {
        const source = String(req.body?.source || '').trim().toLowerCase();
        const query = normalizeSpace(req.body?.query || '');
        const work = normalizeSpace(req.body?.work || '');
        if (!query) {
            return res.status(400).json({ error: 'query is required.', code: 'QUERY_REQUIRED' });
        }

        let candidates;
        if (source === 'bangumi') {
            candidates = await searchBangumiCharacters({ query, work });
        } else if (source === 'mediawiki') {
            candidates = await searchMediaWikiCharacters({
                query,
                work,
                wikiHost: req.body?.wikiHost,
            });
        } else if (source === 'booru') {
            candidates = await searchBooruCharacters({
                query,
                work,
                booruSite: req.body?.booruSite,
            });
        } else {
            return res.status(400).json({
                error: `Unsupported character art source: "${source}". Expected bangumi, mediawiki, or booru.`,
                code: 'UNSUPPORTED_CHARACTER_SOURCE',
            });
        }

        return res.json({
            source,
            query,
            candidates,
            formattedLines: formatCandidatesAsGrepLines(source, candidates),
        });
    } catch (error) {
        const status = Number(error?.status) || 500;
        return res.status(status).json({
            error: error?.message || 'Character source search failed.',
            code: error?.code || 'CHARACTER_SOURCE_ERROR',
        });
    }
});

function runReferenceOperation(request, run) {
    const session = getTransientSession(request);
    if (request.body.staging !== undefined && typeof request.body.staging !== 'boolean') {
        throw new TransientSessionError(400, 'INVALID_STAGING_MODE', 'staging must be a boolean.');
    }
    if (request.body.staging && !session) {
        throw new TransientSessionError(403, 'TRANSIENT_SESSION_REQUIRED', 'Staging reference images requires an owned temporary session.');
    }
    if (session && request.body.staging === false) {
        throw new TransientSessionError(400, 'INVALID_STAGING_MODE', 'A temporary session cannot save a formal reference image.');
    }
    const controller = new AbortController();
    const pending = run(session, controller.signal);
    return session
        ? trackTransientOperation(session, pending, { abort: () => controller.abort() })
        : pending;
}

router.post('/fetch-image', async (req, res) => {
    try {
        return await runReferenceOperation(req, async (session, signal) => {
            const imageUrl = String(req.body?.imageUrl || '').trim();
            const refererUrl = String(req.body?.refererUrl || '').trim();
            const profileId = String(req.body?.profileId || 'char').trim();

            if (!imageUrl) {
                return res.status(400).json({ error: 'imageUrl is required.', code: 'IMAGE_URL_REQUIRED' });
            }

            try {
                validateVisitUrl(imageUrl);
                if (refererUrl) {
                    validateVisitUrl(refererUrl);
                }
            } catch (err) {
                return res.status(400).json({ error: `Invalid URL: ${err.message}`, code: 'INVALID_URL' });
            }

            const response = await fetch(imageUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/*,*/*;q=0.8',
                    'User-Agent': SOURCE_USER_AGENT,
                    ...(refererUrl ? { Referer: refererUrl } : {}),
                },
                agent: getUntrustedRequestAgent(),
                signal,
            });

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                if (looksLikeAntiBotChallenge(response.status, errText)) {
                    return res.status(502).json({
                        error: `Upstream image host returned HTTP ${response.status} or anti-bot challenge; pick another image URL.`,
                        code: 'UPSTREAM_CHALLENGE_OR_FORBIDDEN',
                    });
                }
                return res.status(502).json({
                    error: `Image download failed with HTTP ${response.status}.`,
                    code: 'IMAGE_DOWNLOAD_FAILED',
                });
            }

            const rawBytes = Buffer.from(await response.arrayBuffer());
            if (rawBytes.length === 0) {
                return res.status(422).json({ error: 'Downloaded image body is empty.', code: 'INVALID_IMAGE_DATA' });
            }
            if (rawBytes.length > MAX_REFERENCE_DOWNLOAD_BYTES) {
                return res.status(413).json({ error: 'Downloaded image exceeds 25 MiB limit.', code: 'IMAGE_TOO_LARGE' });
            }

            const saved = await decodeAndPersistReferenceImage({
                directories: req.user?.directories,
                buffer: rawBytes,
                profileId,
                transientSession: session,
            });
            return res.json(saved);
        });
    } catch (error) {
        const status = Number(error?.status) || 500;
        return res.status(status).json({
            error: error?.message || 'Failed to fetch and store reference image.',
            code: error?.code || 'FETCH_IMAGE_ERROR',
        });
    }
});

router.post('/promote-local-image', async (req, res) => {
    try {
        return await runReferenceOperation(req, async (session) => {
            const sourcePath = String(req.body?.sourcePath || '').trim();
            const profileId = String(req.body?.profileId || 'char').trim();
            if (!sourcePath) {
                return res.status(400).json({ error: 'sourcePath is required.', code: 'SOURCE_PATH_REQUIRED' });
            }
            assertTransientMediaRead(req, sourcePath);

            let loaded;
            try {
                loaded = await loadManagedMediaInput(req.user?.directories, sourcePath);
            } catch (err) {
                return res.status(400).json({ error: err.message, code: 'INVALID_LOCAL_MEDIA_PATH' });
            }

            const saved = await decodeAndPersistReferenceImage({
                directories: req.user?.directories,
                buffer: loaded.buffer,
                profileId,
                transientSession: session,
            });
            return res.json(saved);
        });
    } catch (error) {
        const status = Number(error?.status) || 500;
        return res.status(status).json({
            error: error?.message || 'Failed to promote local reference image.',
            code: error?.code || 'PROMOTE_IMAGE_ERROR',
        });
    }
});

for (const [route, execute] of [
    ['/promote-staged', (session, body) => promoteTransientImages(session, body.paths, { namespace: body.namespace })],
    ['/rollback-staged-promotion', (session, body) => rollbackTransientPromotion(session, body.promotionId)],
    ['/complete-staged-promotion', (session, body) => completeTransientPromotion(session, body.promotionId)],
]) {
    router.post(route, async (req, res) => {
        try {
            const session = getTransientSession(req);
            if (!session) {
                throw new TransientSessionError(403, 'TRANSIENT_SESSION_REQUIRED', 'An owned temporary media session is required.');
            }
            return res.json(await execute(session, req.body));
        } catch (error) {
            console.error('Temporary reference image promotion failed:', error);
            return res.status(error.status || 500).json({
                error: error.message,
                code: error.code || 'TRANSIENT_PROMOTION_FAILED',
            });
        }
    });
}
