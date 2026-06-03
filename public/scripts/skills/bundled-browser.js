/**
 * Plan 2 Unit 6 — "Browse bundled" tab.
 *
 * Renders a table of every skill in `default/skills/global/` (returned by
 * `context.skills.listBundledManifest()`), tagged with one of three install
 * states based on whether the user has installed it locally:
 *   - installed_match  (the local copy's installedHash equals the bundled hash)
 *   - installed_differ (local copy exists but its hash differs — was edited
 *                       locally, or a newer bundled version shipped)
 *   - not_installed    (no global-scope skill with that name)
 *
 * The bundled-vs-local comparison only considers GLOBAL scope: a same-named
 * preset/character skill must not mask a missing global install. That mirrors
 * `bundled.js` import target, which always lands skills under `global`.
 *
 * The component is mounted by `openSkillManagerPanel` when the user clicks the
 * "Browse bundled" tab. Pure helpers (`computeInstallStates`,
 * `sortBundledRows`, `buildBundledTableHtml`) are exported for tests without a
 * DOM. The interactive `renderBundledBrowser` entry point handles event wiring
 * and invokes `context.skills.importBundled()` for both bulk and per-row
 * install. The bundled mirror runs with `conflictStrategy: 'replace'` and is
 * idempotent (same hash → `already_installed`), so reusing it for the per-row
 * "Install this" button is functionally correct: clicking on a not_installed
 * row will install all bundled skills (which the toast wording surfaces), then
 * re-render with the row flipping to installed_match. A future iteration could
 * add a server route for install-one-bundled if users push back, but right now
 * the simpler shared route avoids divergence between two install paths.
 */

// ── Pure helpers (exported for tests) ─────────────────────────────────────

/**
 * Compute per-row install state for the bundled browser.
 *
 * For each bundled manifest entry, look for a same-named GLOBAL-scope skill in
 * `installedSkills`. If found and `installedHash` matches → installed_match;
 * if found but differs → installed_differ; otherwise → not_installed.
 *
 * @param {Array<{name:string, installedHash:string, fileCount:number, totalBytes:number, description:string}>} bundled
 * @param {Array<{name:string, scope:object, installedHash:string}>} installedSkills
 * @returns {Array<{name:string, state:'installed_match'|'installed_differ'|'not_installed', description:string, fileCount:number, totalBytes:number, installedHash:string, localHash?:string}>}
 */
export function computeInstallStates(bundled, installedSkills) {
    if (!Array.isArray(bundled)) return [];
    // Build a name → local hash map, restricted to global scope. We use Map
    // for stable lookup and to avoid silently shadowing entries via Object
    // prototype keys when bundle authors choose an unfortunate name.
    const localByName = new Map();
    for (const s of Array.isArray(installedSkills) ? installedSkills : []) {
        if (!s || typeof s !== 'object') continue;
        if (!s.scope || s.scope.kind !== 'global') continue;
        localByName.set(String(s.name), String(s.installedHash || ''));
    }
    const out = [];
    for (const entry of bundled) {
        if (!entry || !entry.name) continue;
        const local = localByName.get(String(entry.name));
        let state;
        let localHash;
        if (local === undefined) {
            state = 'not_installed';
        } else if (local === String(entry.installedHash || '')) {
            state = 'installed_match';
        } else {
            state = 'installed_differ';
            localHash = local;
        }
        const row = {
            name: String(entry.name),
            state,
            description: String(entry.description || ''),
            fileCount: Number(entry.fileCount || 0),
            totalBytes: Number(entry.totalBytes || 0),
            installedHash: String(entry.installedHash || ''),
        };
        if (localHash !== undefined) row.localHash = localHash;
        out.push(row);
    }
    return out;
}

/**
 * Sort bundled rows for display. We surface actionable rows first
 * (not_installed → installed_differ) and pin already-installed rows to the
 * bottom so the user's eye lands on what they might want to install rather
 * than on rows that already match.
 *
 * @param {Array<{name:string, state:string}>} rows
 * @returns {Array}
 */
export function sortBundledRows(rows) {
    const order = { not_installed: 0, installed_differ: 1, installed_match: 2 };
    return Array.from(Array.isArray(rows) ? rows : []).sort((a, b) => {
        const oa = order[a.state] ?? 99;
        const ob = order[b.state] ?? 99;
        if (oa !== ob) return oa - ob;
        return String(a.name).localeCompare(String(b.name));
    });
}

/**
 * Build the bundled-browser HTML body. Caller wires events via delegation on
 * the root container.
 *
 * @param {Array} rows - output of sortBundledRows(computeInstallStates(...))
 * @param {(s:string)=>string} t - i18n helper
 * @param {(s:string)=>string} esc - html-escape helper
 * @returns {string}
 */
export function buildBundledTableHtml(rows, t, esc) {
    const items = Array.isArray(rows) ? rows : [];
    const stateBadge = (state) => {
        if (state === 'installed_match') {
            return `<span class="luker_bundled_state luker_bundled_state_match">${esc(t('Installed'))}</span>`;
        }
        if (state === 'installed_differ') {
            return `<span class="luker_bundled_state luker_bundled_state_differ">${esc(t('Differs'))}</span>`;
        }
        return `<span class="luker_bundled_state luker_bundled_state_new">${esc(t('Not installed'))}</span>`;
    };
    const renderRow = (row) => {
        const safeName = esc(row.name);
        const sizeKb = (row.totalBytes / 1024).toFixed(1);
        // installed_match rows hide the per-row install button — the bundled
        // copy is already on disk. The "Install all" toolbar action still
        // re-runs the bundled mirror, which is the right escape hatch if the
        // user truly wants to force a re-install.
        const action = row.state === 'installed_match'
            ? ''
            : `<div class="menu_button menu_button_small" data-bundled-action="install" data-bundled-name="${safeName}">${esc(t('Install this'))}</div>`;
        return `
            <tr class="luker_bundled_row" data-bundled-row data-bundled-name="${safeName}" data-bundled-state="${esc(row.state)}">
                <td class="luker_bundled_col_name">${safeName}</td>
                <td class="luker_bundled_col_state">${stateBadge(row.state)}</td>
                <td class="luker_bundled_col_desc">${esc(row.description || t('(no description)'))}</td>
                <td class="luker_bundled_col_meta">${esc(t('${0} files, ${1} KB').replace('${0}', String(row.fileCount)).replace('${1}', sizeKb))}</td>
                <td class="luker_bundled_col_action">${action}</td>
            </tr>
        `;
    };
    const body = items.length === 0
        ? `<div class="luker_bundled_empty">${esc(t('No bundled skills available.'))}</div>`
        : `
        <table class="luker_bundled_table">
            <thead>
                <tr>
                    <th>${esc(t('Name'))}</th>
                    <th>${esc(t('State'))}</th>
                    <th>${esc(t('Description'))}</th>
                    <th>${esc(t('Size'))}</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>${items.map(renderRow).join('')}</tbody>
        </table>
        `;
    return `
<div class="luker_bundled_browser">
    <div class="luker_bundled_browser_toolbar">
        <div class="luker_bundled_browser_hint">${esc(t('Skills shipped with the server. Install any to add them under the Global scope.'))}</div>
        <div class="luker_bundled_browser_actions">
            <div class="menu_button menu_button_small" data-bundled-toolbar="install-all">${esc(t('Install all bundled'))}</div>
            <div class="menu_button menu_button_small" data-bundled-toolbar="refresh">${esc(t('Refresh'))}</div>
        </div>
    </div>
    <div class="luker_bundled_browser_body">${body}</div>
</div>
    `;
}

// ── Interactive renderer ──────────────────────────────────────────────────

/**
 * Render and wire the Browse-bundled view into the supplied mount element.
 *
 * Caller (skill-manager-panel.js) is responsible for placing the mount inside
 * the popup body and swapping it out when the user clicks a different tab.
 *
 * @param {object} opts
 * @param {object} opts.context - SillyTavern context (must expose
 *   `context.skills.list`, `context.skills.listBundledManifest`,
 *   `context.skills.importBundled`).
 * @param {object} opts.mount - target DOM element (innerHTML will be replaced).
 * @param {(s:string)=>string} [opts.t] - i18n helper; defaults to identity.
 * @returns {Promise<void>}
 */
export async function renderBundledBrowser({ context, mount, t = (s) => s } = {}) {
    if (!context || !context.skills) {
        throw new Error('renderBundledBrowser: context.skills missing');
    }
    if (!mount || typeof mount !== 'object') {
        throw new Error('renderBundledBrowser: mount element missing');
    }
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
    })[c]);

    async function refresh() {
        let bundled = [];
        let installed = [];
        try {
            bundled = await context.skills.listBundledManifest();
        } catch (e) {
            bundled = [];
            toast(t('Failed to load bundled manifest: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
        try {
            installed = await context.skills.list({ scope: { kind: 'global' } });
        } catch (e) {
            installed = [];
            toast(t('Failed to list installed skills: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
        const rows = sortBundledRows(computeInstallStates(bundled, installed));
        mount.innerHTML = buildBundledTableHtml(rows, t, esc);
        bindEvents();
    }

    function bindEvents() {
        mount.querySelectorAll('[data-bundled-toolbar]').forEach((el) => {
            el.addEventListener('click', async (ev) => {
                ev.preventDefault();
                const action = el.getAttribute('data-bundled-toolbar');
                if (action === 'install-all') {
                    await handleInstallAll();
                } else if (action === 'refresh') {
                    await refresh();
                }
            });
        });
        mount.querySelectorAll('[data-bundled-action="install"]').forEach((el) => {
            el.addEventListener('click', async (ev) => {
                ev.preventDefault();
                const name = el.getAttribute('data-bundled-name');
                await handleInstallOne(name);
            });
        });
    }

    async function handleInstallAll() {
        try {
            const result = await context.skills.importBundled();
            const installed = Number(result?.installed || 0);
            const replaced = Number(result?.replaced || 0);
            toast(t('Bundled install: ${0} installed, ${1} replaced.')
                .replace('${0}', String(installed))
                .replace('${1}', String(replaced)), 'success');
            await refresh();
        } catch (e) {
            toast(t('Install all failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    async function handleInstallOne(name) {
        // The bundled mirror is the only install path that knows how to read
        // default/skills/global/<name>/. There's no server route to install
        // just one bundled skill today; the bundled importer is idempotent
        // (already-installed entries report `replaced=0,installed=0`), so
        // reusing it for the per-row case keeps the install path single. The
        // success toast surfaces totals so the user understands the side
        // effect of the click.
        try {
            const result = await context.skills.importBundled();
            const installed = Number(result?.installed || 0);
            const replaced = Number(result?.replaced || 0);
            toast(t('Installed bundled skills (target: ${0}). ${1} new, ${2} replaced.')
                .replace('${0}', String(name || ''))
                .replace('${1}', String(installed))
                .replace('${2}', String(replaced)), 'success');
            await refresh();
        } catch (e) {
            toast(t('Install failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    function toast(message, level) {
        if (typeof toastr === 'undefined') {
            console.warn('[bundled-browser]', message);
            return;
        }
        if (level === 'error') toastr.error(String(message));
        else if (level === 'success') toastr.success(String(message));
        else toastr.info(String(message));
    }

    await refresh();
}
