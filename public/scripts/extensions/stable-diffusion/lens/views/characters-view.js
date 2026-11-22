// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, clear, put } from '../../../../lens-shared/util.js';
import {
    button,
    confirmDialog,
    emptyState,
    formField,
    iconButton,
    sectionTitle,
    segmented,
    selectInput,
} from '../../../../lens-shared/ui.js';
import { createCharacterProfileStore, normalizeCharacterProfile } from '../../character-archive/store.js';
import { promoteLocalReferenceImage } from '../../character-sources-client.js';
import { runExplorationAgent } from '../../exploration/agent.js';
import { makeIllustrationId } from '../../illustration/presets.js';
import { getPresetById } from '../../illustration/settings.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat } from '../i18n.js';

function parseCsvList(text) {
    return String(text || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return typeof btoa === 'function'
        ? btoa(binary)
        : globalThis.Buffer.from(buf).toString('base64');
}

async function uploadAndPromoteReferenceFile(file, profileId, context) {
    const base64 = await fileToBase64(file);
    const ext = (String(file.name || '').split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const uploadRes = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context?.getRequestHeaders?.() || { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            image: base64,
            format: ext,
            ch_name: '_references_staging',
        }),
    });
    if (!uploadRes.ok) {
        const detail = await uploadRes.text();
        throw new Error(`Failed to upload local image (${uploadRes.status}): ${detail}`);
    }
    const uploaded = await uploadRes.json();
    const stagedPath = String(uploaded?.path || '').trim();
    if (!stagedPath) {
        throw new Error('Image upload succeeded without returning a managed path.');
    }
    const promoted = await promoteLocalReferenceImage({
        context,
        sourcePath: stagedPath,
        profileId: profileId || 'char',
    });
    return promoted.imagePath;
}

export function createCharactersView(app) {
    const el = h('div', { class: 'sdlens-chars', dataset: { sdView: 'characters' } });
    let profiles = [];
    let selectedId = '';
    let draftProfile = null;
    let savedProfileSnapshot = null;
    let lastNotifiedDirty = false;
    let dirtyBarEl = null;
    let filterQuery = '';

    function profileSnapshotKey(profile) {
        if (!profile) return '';
        const norm = normalizeCharacterProfile(profile, 0);
        if (!norm) {
            return JSON.stringify({ ...profile, createdAt: 0, updatedAt: 0 });
        }
        return JSON.stringify({ ...norm, createdAt: 0, updatedAt: 0 });
    }

    function isDirty() {
        if (!draftProfile) return false;
        if (!savedProfileSnapshot) return true;
        return profileSnapshotKey(draftProfile) !== profileSnapshotKey(savedProfileSnapshot);
    }

    function syncDirtyState() {
        const dirty = isDirty();
        if (dirtyBarEl) {
            dirtyBarEl.hidden = !dirty;
        }
        if (dirty !== lastNotifiedDirty) {
            lastNotifiedDirty = dirty;
            app.notifyDirty?.(dirty);
        }
    }

    function guardDirtySwitch() {
        if (!isDirty()) return true;
        app.toast(i18n('Save or discard your edits first.'), { error: true });
        return false;
    }

    function discardDraftProfile() {
        if (savedProfileSnapshot) {
            selectedId = savedProfileSnapshot.id;
            draftProfile = JSON.parse(JSON.stringify(savedProfileSnapshot));
        } else {
            const fallback = profiles[0] || null;
            selectedId = fallback?.id || '';
            savedProfileSnapshot = fallback ? JSON.parse(JSON.stringify(fallback)) : null;
            draftProfile = fallback ? JSON.parse(JSON.stringify(fallback)) : null;
        }
        paint();
        syncDirtyState();
    }
    // Per-invocation mode only — intentionally ephemeral and never persisted to settings or card extensions.
    let launchMode = 'fanwork';
    let launchTargetText = '';
    let launchCardAvatar = '';
    let exploring = false;
    let exploreAbort = null;
    let localAssetsCache = new Map();

    function getCtx() {
        return app.getContext();
    }

    function getStore() {
        return createCharacterProfileStore(getCtx());
    }

    function listCardOptions() {
        const ctx = getCtx();
        const chars = Array.isArray(ctx?.characters) ? ctx.characters : [];
        const opts = [{ value: '', label: i18n('No card selected') }];
        for (const ch of chars) {
            const avatar = String(ch?.avatar || '').trim();
            if (!avatar) continue;
            const name = String(ch?.name || avatar).trim();
            opts.push({ value: avatar, label: `${name} (${avatar})` });
        }
        return opts;
    }

    async function loadLocalCardAssets(avatar) {
        const cleanAvatar = String(avatar || '').trim();
        if (!cleanAvatar) return [];
        if (localAssetsCache.has(cleanAvatar)) return localAssetsCache.get(cleanAvatar);
        const ctx = getCtx();
        const chars = Array.isArray(ctx?.characters) ? ctx.characters : [];
        const card = chars.find(c => String(c?.avatar || '') === cleanAvatar);
        const items = [{
            value: `/characters/${cleanAvatar}`,
            label: `${card?.name || cleanAvatar} — Avatar (/characters/${cleanAvatar})`,
        }];
        const folder = cleanAvatar.replace(/\.[^.]+$/, '');
        if (folder && typeof fetch === 'function') {
            try {
                const res = await fetch(`/api/sprites/get?name=${encodeURIComponent(folder)}`, {
                    method: 'GET',
                    headers: ctx?.getRequestHeaders?.() || {},
                });
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data)) {
                        for (const sp of data) {
                            const spPath = String(sp?.path || '').trim();
                            if (spPath) {
                                items.push({
                                    value: spPath,
                                    label: `${sp?.label || 'Sprite'} (${spPath})`,
                                });
                            }
                        }
                    }
                }
            } catch {
                // Optional sprite lookup; primary card avatar remains selectable.
            }
        }
        localAssetsCache.set(cleanAvatar, items);
        return items;
    }

    async function reload({ keepSelected = true, selectProfileId = '' } = {}) {
        const ctx = getCtx();
        if (typeof ctx?.getGlobalState !== 'function') {
            profiles = [];
            savedProfileSnapshot = null;
            draftProfile = null;
            paint();
            syncDirtyState();
            return;
        }
        try {
            profiles = await getStore().listProfiles();
            const targetId = selectProfileId || (keepSelected ? selectedId : '');
            const matched = profiles.find(p => p.id === targetId) || profiles[0] || null;
            selectedId = matched?.id || '';
            savedProfileSnapshot = matched ? JSON.parse(JSON.stringify(matched)) : null;
            draftProfile = matched ? JSON.parse(JSON.stringify(matched)) : null;
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
        }
        paint();
        syncDirtyState();
    }

    async function handleLaunchSubmit() {
        if (launchMode === 'oc') {
            const nameHint = launchTargetText.split(',')[0]?.trim() || '';
            app.openStudioForCharacterDesign({
                profileId: '',
                characterName: nameHint,
                cardAvatar: launchCardAvatar,
                initialBrief: launchTargetText.trim(),
            });
            return;
        }

        if (exploring) {
            exploreAbort?.abort('Stopped by user');
            return;
        }

        const ctx = getCtx();
        const sdSettings = ctx?.extensionSettings?.sd;
        const illSettings = sdSettings?.illustration;
        const preset = getPresetById(illSettings, illSettings?.currentPresetId) || illSettings?.presets?.[0] || {};
        const targets = parseCsvList(launchTargetText).map(name => ({ name }));

        exploring = true;
        exploreAbort = new AbortController();
        paint();

        let activeRunId = null;
        const runStore = app.getRunStore?.();
        if (runStore && !runStore.getCurrentRun()?.status?.includes('running')) {
            try {
                activeRunId = runStore.startRun({
                    mode: 'image',
                    chatKey: String(ctx?.chatId || ''),
                    stopFn: () => exploreAbort?.abort('Stopped'),
                });
            } catch {
                activeRunId = null;
            }
        }

        try {
            const result = await runExplorationAgent({
                context: ctx,
                profileStore: getStore(),
                targets,
                cardAvatar: launchCardAvatar,
                userHint: launchTargetText,
                preset,
                runStore: activeRunId ? runStore : null,
                runId: activeRunId || '',
                abortSignal: exploreAbort.signal,
            });
            if (activeRunId && runStore) {
                runStore.finishRun({ runId: activeRunId, status: 'committed' });
            }
            const count = result.savedProfiles.length;
            app.toast(count > 0
                ? i18nFormat('Archived ${0} character profile(s).', count)
                : i18n('Exploration finished with no new profiles.'));
            const newestId = result.savedProfiles[0]?.id || selectedId;
            launchTargetText = '';
            if (isDirty()) {
                try {
                    profiles = await getStore().listProfiles();
                } catch (refreshErr) {
                    app.toast(String(refreshErr?.message || refreshErr), { error: true });
                }
            } else {
                await reload({ selectProfileId: newestId });
            }
        } catch (err) {
            if (activeRunId && runStore) {
                runStore.finishRun({
                    runId: activeRunId,
                    status: exploreAbort?.signal?.aborted ? 'aborted' : 'error',
                    error: String(err?.message || err),
                });
            }
            if (!exploreAbort?.signal?.aborted) {
                app.toast(String(err?.message || err), { error: true });
            }
        } finally {
            exploring = false;
            exploreAbort = null;
            paint();
        }
    }

    function startNewDraftProfile() {
        if (!guardDirtySwitch()) return;
        const created = normalizeCharacterProfile({
            id: makeIllustrationId('char'),
            name: 'New Character',
            sourceCardAvatars: launchCardAvatar ? [launchCardAvatar] : [],
            outfits: [{ id: 'outfit_default', name: 'Default', tags: [], prose: '', referenceImages: [] }],
            defaultOutfitId: 'outfit_default',
        });
        selectedId = created.id;
        savedProfileSnapshot = null;
        draftProfile = created;
        paint();
        syncDirtyState();
    }

    async function saveDraftProfile() {
        if (!draftProfile) return;
        const store = getStore();
        const before = await store.getProfile(draftProfile.id);
        const saved = await store.upsertProfile(draftProfile);
        selectedId = saved.id;
        savedProfileSnapshot = JSON.parse(JSON.stringify(saved));
        draftProfile = JSON.parse(JSON.stringify(saved));
        app.recordHistory?.({
            label: `${i18n('Save profile')}: ${saved.name}`,
            undo: async () => {
                if (before) await store.upsertProfile(before);
                else await store.deleteProfile(saved.id);
                await reload({ selectProfileId: before?.id || '' });
            },
        });
        app.toast(i18n('Profile saved.'));
        await reload({ selectProfileId: saved.id });
    }

    async function deleteDraftProfile() {
        if (!draftProfile) return;
        const target = JSON.parse(JSON.stringify(draftProfile));
        const store = getStore();
        const existed = await store.getProfile(target.id);
        if (existed) {
            const ok = await confirmDialog(el, {
                title: i18n('Delete profile'),
                message: `${target.name} (${target.id})`,
                danger: true,
            });
            if (!ok) return;
            await store.deleteProfile(target.id);
            app.recordHistory?.({
                label: `${i18n('Delete profile')}: ${target.name}`,
                undo: async () => {
                    await store.upsertProfile(existed);
                    await reload({ selectProfileId: existed.id });
                },
            });
        }
        app.toast(i18n('Profile deleted.'));
        selectedId = '';
        draftProfile = null;
        await reload({ keepSelected: false });
    }

    function renderLauncher() {
        const modeOptions = [
            { value: 'fanwork', label: i18n('Fanwork exploration'), iconName: 'search' },
            { value: 'oc', label: i18n('OC design in studio'), iconName: 'spark' },
        ];
        const segEl = segmented(modeOptions, launchMode, (next) => {
            launchMode = next;
            paint();
        }, {
            ariaLabel: i18n('Launch mode for this character creation'),
            renderIcon: icon,
        });
        const segBtns = segEl.querySelectorAll('.lw-seg-btn');
        modeOptions.forEach((opt, idx) => {
            if (segBtns[idx]) segBtns[idx].dataset.sdLaunchMode = opt.value;
        });

        const targetInput = h('input', {
            type: 'text',
            class: 'sdlens-input',
            placeholder: i18n('Character names or hints (comma-separated)'),
            value: launchTargetText,
            dataset: { sdRole: 'launch-target-input' },
            onInput: (e) => { launchTargetText = e.target.value; },
            onKeydown: (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleLaunchSubmit();
                }
            },
        });

        const cardSelect = selectInput(listCardOptions(), launchCardAvatar, (val) => {
            launchCardAvatar = val;
        }, { ariaLabel: i18n('Source character card') });
        cardSelect.dataset.sdRole = 'launch-card-select';

        const submitLabel = launchMode === 'oc'
            ? i18n('Design OC in studio')
            : (exploring ? i18n('Exploring character canon…') : i18n('Start exploration'));
        const submitBtn = button(submitLabel, () => { void handleLaunchSubmit(); }, {
            primary: !exploring,
            danger: exploring,
            iconName: launchMode === 'oc' ? 'spark' : (exploring ? 'stop' : 'search'),
            renderIcon: icon,
        });
        submitBtn.dataset.sdRole = 'launch-submit';

        return h('div', { class: 'sdlens-launcher' }, segEl, targetInput, cardSelect, submitBtn);
    }

    function renderListPane() {
        const needle = filterQuery.trim().toLowerCase();
        const visible = needle
            ? profiles.filter(p => (
                p.name.toLowerCase().includes(needle)
                || p.sourceWork.toLowerCase().includes(needle)
                || p.aliases.some(a => a.toLowerCase().includes(needle))
            ))
            : profiles;

        const filterInput = h('input', {
            type: 'search',
            class: 'sdlens-input',
            placeholder: i18n('Filter characters by name, alias, or work…'),
            value: filterQuery,
            onInput: (e) => {
                filterQuery = e.target.value;
                paint();
            },
        });

        const addBtn = iconButton('plus', i18n('New character profile'), () => startNewDraftProfile(), {
            renderIcon: icon,
        });
        addBtn.dataset.sdRole = 'new-profile';

        return h('aside', { class: 'sdlens-chars-list-pane' },
            h('div', { class: 'sdlens-chars-list-head' }, filterInput, addBtn),
            h('div', { class: 'sdlens-chars-cards' },
                visible.length === 0
                    ? emptyState('users', i18n('No character profiles archived yet'), '', null, { renderIcon: icon })
                    : visible.map(profile => {
                        const defaultOutfit = profile.outfits.find(o => o.id === profile.defaultOutfitId) || profile.outfits[0];
                        const thumb = defaultOutfit?.referenceImages?.[0] || '';
                        return h('button', {
                            type: 'button',
                            class: `sdlens-char-card ${profile.id === selectedId ? 'is-active' : ''}`.trim(),
                            dataset: { profileId: profile.id },
                            onClick: () => {
                                if (profile.id === selectedId) return;
                                if (!guardDirtySwitch()) return;
                                selectedId = profile.id;
                                savedProfileSnapshot = JSON.parse(JSON.stringify(profile));
                                draftProfile = JSON.parse(JSON.stringify(profile));
                                paint();
                                syncDirtyState();
                            },
                        },
                        thumb
                            ? h('img', { class: 'sdlens-char-thumb', src: thumb, alt: profile.name })
                            : h('div', { class: 'sdlens-char-thumb' }),
                        h('div', { class: 'sdlens-char-meta' },
                            h('div', { class: 'sdlens-char-name', text: profile.name }),
                            h('div', {
                                class: 'sdlens-char-sub',
                                text: [profile.sourceWork, i18nFormat('${0} outfit(s)', profile.outfits.length)].filter(Boolean).join(' · '),
                            })));
                    })));
    }

    function renderOutfitEditor(outfit, index) {
        const isDefault = draftProfile.defaultOutfitId === outfit.id;
        const cardOptions = listCardOptions();
        const selectedCardForBind = draftProfile.sourceCardAvatars?.[0] || launchCardAvatar || (cardOptions[1]?.value || '');

        const assetPickerWrap = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } });
        void loadLocalCardAssets(selectedCardForBind).then((assets) => {
            if (!assetPickerWrap.isConnected) return;
            clear(assetPickerWrap);
            const pickerOpts = [
                { value: '', label: i18n('Select a local character asset…') },
                ...assets,
            ];
            let chosenAsset = '';
            const sel = selectInput(pickerOpts, '', (v) => { chosenAsset = v; }, {
                ariaLabel: i18n('Bind card avatar or expression sprite'),
            });
            sel.style.flex = '1 1 200px';
            const bindBtn = button(i18n('Bind asset'), async () => {
                if (!chosenAsset) return;
                try {
                    const promoted = await promoteLocalReferenceImage({
                        context: getCtx(),
                        sourcePath: chosenAsset,
                        profileId: draftProfile.id,
                    });
                    if (!outfit.referenceImages.includes(promoted.imagePath)) {
                        outfit.referenceImages.push(promoted.imagePath);
                    }
                    paint();
                    syncDirtyState();
                } catch (err) {
                    app.toast(String(err?.message || err), { error: true });
                }
            }, { small: true, renderIcon: icon });
            put(assetPickerWrap, sel, bindBtn);
        });

        const fileInput = h('input', {
            type: 'file',
            accept: 'image/*',
            hidden: true,
            onChange: async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                    const imagePath = await uploadAndPromoteReferenceFile(file, draftProfile.id, getCtx());
                    if (!outfit.referenceImages.includes(imagePath)) {
                        outfit.referenceImages.push(imagePath);
                    }
                    paint();
                    syncDirtyState();
                } catch (err) {
                    app.toast(String(err?.message || err), { error: true });
                }
            },
        });

        return h('div', { class: 'sdlens-outfit-card', dataset: { outfitId: outfit.id } },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
                h('strong', { text: `${outfit.name} (${outfit.id})` }),
                h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                    isDefault
                        ? h('span', { class: 'lw-pilltag is-ok', text: i18n('Default outfit') })
                        : button(i18n('Set as default outfit'), () => {
                            draftProfile.defaultOutfitId = outfit.id;
                            paint();
                            syncDirtyState();
                        }, { small: true, ghost: true }),
                    draftProfile.outfits.length > 1
                        ? iconButton('trash', i18n('Delete'), () => {
                            draftProfile.outfits.splice(index, 1);
                            if (draftProfile.defaultOutfitId === outfit.id) {
                                draftProfile.defaultOutfitId = draftProfile.outfits[0]?.id || '';
                            }
                            paint();
                            syncDirtyState();
                        }, { className: 'is-sm', renderIcon: icon })
                        : null)),
            h('div', { class: 'sdlens-grid-2' },
                formField(i18n('Outfit name'), h('input', {
                    type: 'text',
                    class: 'sdlens-input',
                    value: outfit.name,
                    onInput: (e) => { outfit.name = e.target.value; syncDirtyState(); },
                })),
                formField(i18n('Outfit tags (comma-separated)'), h('input', {
                    type: 'text',
                    class: 'sdlens-input',
                    value: outfit.tags.join(', '),
                    onInput: (e) => { outfit.tags = parseCsvList(e.target.value); syncDirtyState(); },
                }))),
            formField(i18n('Outfit prose description'), (() => {
                const ta = h('textarea', {
                    class: 'sdlens-textarea',
                    onInput: (e) => { outfit.prose = e.target.value; syncDirtyState(); },
                });
                ta.value = outfit.prose || '';
                return ta;
            })()),
            h('div', { class: 'sdlens-ref-strip' },
                (outfit.referenceImages || []).map((imgPath, refIdx) => h('div', { class: 'sdlens-ref-item' },
                    h('img', { src: imgPath, alt: outfit.name }),
                    h('button', {
                        type: 'button',
                        class: 'sdlens-ref-remove',
                        title: i18n('Remove'),
                        onClick: () => {
                            outfit.referenceImages.splice(refIdx, 1);
                            paint();
                            syncDirtyState();
                        },
                    }, icon('x', { size: 12 }))))),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
                button(i18n('Upload local reference image'), () => fileInput.click(), {
                    small: true,
                    iconName: 'upload',
                    renderIcon: icon,
                }),
                fileInput),
            assetPickerWrap);
    }

    function renderDetailPane() {
        if (!draftProfile) {
            return h('div', { class: 'sdlens-chars-detail' },
                emptyState(
                    'users',
                    i18n('No character profiles archived yet'),
                    i18n('Use Fanwork exploration above to look up public-work characters, or switch to OC design in studio to craft original character reference sheets interactively.'),
                    button(i18n('New character profile'), () => startNewDraftProfile(), {
                        primary: true,
                        iconName: 'plus',
                        renderIcon: icon,
                    }),
                    { renderIcon: icon },
                ));
        }

        const cardOpts = listCardOptions();
        const boundCardValue = draftProfile.sourceCardAvatars?.[0] || '';

        const saveBtn = button(i18n('Save profile'), () => { void saveDraftProfile(); }, {
            primary: true,
            iconName: 'check',
            renderIcon: icon,
        });
        saveBtn.dataset.sdRole = 'save-profile';

        const refineBtn = button(i18n('Refine in OC studio'), () => {
            if (!guardDirtySwitch()) return;
            app.openStudioForCharacterDesign({
                profileId: draftProfile.id,
                characterName: draftProfile.name,
                cardAvatar: boundCardValue,
                initialBrief: '',
            });
        }, {
            iconName: 'spark',
            renderIcon: icon,
        });
        refineBtn.dataset.sdRole = 'refine-in-studio';

        const deleteBtn = button(i18n('Delete profile'), () => { void deleteDraftProfile(); }, {
            danger: true,
            iconName: 'trash',
            renderIcon: icon,
        });
        deleteBtn.dataset.sdRole = 'delete-profile';

        const discardBtn = button(i18n('Discard changes'), () => discardDraftProfile(), {
            small: true,
            ghost: true,
        });
        discardBtn.dataset.sdRole = 'discard-profile';

        const bannerSaveBtn = button(i18n('Save profile'), () => { void saveDraftProfile(); }, {
            small: true,
            primary: true,
            iconName: 'check',
            renderIcon: icon,
        });

        dirtyBarEl = h('div', { class: 'sdlens-dirty-bar', role: 'status', hidden: !isDirty() },
            h('span', { class: 'sdlens-dirty-dot', 'aria-hidden': 'true' }),
            h('span', { class: 'sdlens-dirty-text', text: i18n('Unsaved profile changes') }),
            discardBtn,
            bannerSaveBtn);

        return h('div', { class: 'sdlens-chars-detail' },
            dirtyBarEl,
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                h('h3', { style: { margin: '0', fontSize: '15px' }, text: `${draftProfile.name} (${draftProfile.id})` }),
                h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, refineBtn, saveBtn, deleteBtn)),
            h('div', { class: 'sdlens-grid-2' },
                formField(i18n('Canonical display name'), h('input', {
                    type: 'text',
                    class: 'sdlens-input',
                    dataset: { sdField: 'profile-name' },
                    value: draftProfile.name,
                    onInput: (e) => { draftProfile.name = e.target.value; syncDirtyState(); },
                })),
                formField(i18n('Aliases (comma-separated)'), h('input', {
                    type: 'text',
                    class: 'sdlens-input',
                    value: draftProfile.aliases.join(', '),
                    onInput: (e) => { draftProfile.aliases = parseCsvList(e.target.value); syncDirtyState(); },
                })),
                formField(i18n('Source work or franchise'), h('input', {
                    type: 'text',
                    class: 'sdlens-input',
                    value: draftProfile.sourceWork,
                    onInput: (e) => { draftProfile.sourceWork = e.target.value; syncDirtyState(); },
                })),
                formField(i18n('Source character card'), selectInput(cardOpts, boundCardValue, (val) => {
                    draftProfile.sourceCardAvatars = val ? [val] : [];
                    paint();
                    syncDirtyState();
                }, { ariaLabel: i18n('Source character card') }))),
            h('div', { class: 'sdlens-grid-2' },
                formField(i18n('Core appearance tags (comma-separated)'), h('input', {
                    type: 'text',
                    class: 'sdlens-input',
                    dataset: { sdField: 'canonical-tags' },
                    value: draftProfile.canonicalTags.join(', '),
                    onInput: (e) => { draftProfile.canonicalTags = parseCsvList(e.target.value); syncDirtyState(); },
                })),
                formField(i18n('Negative tags (comma-separated)'), h('input', {
                    type: 'text',
                    class: 'sdlens-input',
                    value: draftProfile.negativeTags.join(', '),
                    onInput: (e) => { draftProfile.negativeTags = parseCsvList(e.target.value); syncDirtyState(); },
                }))),
            formField(i18n('Natural language appearance description'), (() => {
                const ta = h('textarea', {
                    class: 'sdlens-textarea',
                    onInput: (e) => { draftProfile.proseDescription = e.target.value; syncDirtyState(); },
                });
                ta.value = draftProfile.proseDescription || '';
                return ta;
            })()),
            sectionTitle(
                i18n('Outfits & reference sheets'),
                button(i18n('Add outfit'), () => {
                    draftProfile.outfits.push({
                        id: makeIllustrationId('outfit'),
                        name: `Outfit ${draftProfile.outfits.length + 1}`,
                        tags: [],
                        prose: '',
                        referenceImages: [],
                    });
                    paint();
                    syncDirtyState();
                }, { small: true, iconName: 'plus', renderIcon: icon }),
            ),
            ...draftProfile.outfits.map((outfit, idx) => renderOutfitEditor(outfit, idx)));
    }

    function paint() {
        dirtyBarEl = null;
        clear(el);
        put(el,
            renderLauncher(),
            h('div', { class: 'sdlens-chars-split' },
                renderListPane(),
                renderDetailPane()));
    }

    return {
        el,
        isDirty,
        show(opts = {}) {
            const focusProfileId = opts?.focusId ? String(opts.focusId) : '';
            if (isDirty() && (!focusProfileId || focusProfileId === selectedId)) {
                return;
            }
            void reload({ selectProfileId: focusProfileId });
        },
        reload,
        destroy() {
            exploreAbort?.abort('Workspace closed');
        },
    };
}
