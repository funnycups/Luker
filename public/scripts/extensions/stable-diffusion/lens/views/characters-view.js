// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, clear, put } from '../../../../lens-shared/util.js';
import {
    button,
    confirmDialog,
    emptyState,
    formField,
    iconButton,
    sectionTitle,
} from '../../../../lens-shared/ui.js';
import { createCharacterProfileStore, normalizeCharacterProfile, profileVersion } from '../../character-archive/store.js';
import { promoteLocalReferenceImage } from '../../character-sources-client.js';
import { makeIllustrationId } from '../../illustration/presets.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat } from '../i18n.js';
import { openCharacterBuilderDialog } from './character-builder-dialog.js';

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
    let draftVersion = null;
    let profileWritePending = false;
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
            draftVersion = profileVersion(savedProfileSnapshot);
        } else {
            const fallback = profiles[0] || null;
            selectedId = fallback?.id || '';
            savedProfileSnapshot = fallback ? JSON.parse(JSON.stringify(fallback)) : null;
            draftProfile = fallback ? JSON.parse(JSON.stringify(fallback)) : null;
            draftVersion = profileVersion(fallback);
        }
        paint();
        syncDirtyState();
    }

    function getCtx() {
        return app.getContext();
    }

    function getStore() {
        return createCharacterProfileStore(getCtx());
    }

    async function reload({ keepSelected = true, selectProfileId = '' } = {}) {
        const ctx = getCtx();
        if (typeof ctx?.getGlobalState !== 'function') {
            profiles = [];
            savedProfileSnapshot = null;
            draftProfile = null;
            draftVersion = null;
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
            draftVersion = profileVersion(matched);
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
        }
        paint();
        syncDirtyState();
    }

    function startNewDraftProfile() {
        if (!guardDirtySwitch()) return;
        const created = normalizeCharacterProfile({
            id: makeIllustrationId('char'),
            name: 'New Character',
            aliases: [],
            sourceWork: '',
            description: '',
            referenceImages: [],
        });
        selectedId = created.id;
        savedProfileSnapshot = null;
        draftProfile = created;
        draftVersion = null;
        paint();
        syncDirtyState();
    }

    async function saveDraftProfile() {
        if (!draftProfile || profileWritePending) return;
        const input = JSON.parse(JSON.stringify(draftProfile));
        const expectedVersion = draftVersion;
        const store = getStore();
        profileWritePending = true;
        paint();
        try {
            const before = await store.getProfile(input.id);
            const saved = await store.upsertProfile(input, Date.now(), { expectedVersion });
            const savedVersion = profileVersion(saved);
            selectedId = saved.id;
            savedProfileSnapshot = JSON.parse(JSON.stringify(saved));
            draftProfile = JSON.parse(JSON.stringify(saved));
            draftVersion = savedVersion;
            app.recordHistory?.({
                label: `${i18n('Save profile')}: ${saved.name}`,
                undo: async () => {
                    if (before) await store.upsertProfile(before, Date.now(), { expectedVersion: savedVersion });
                    else await store.deleteProfile(saved.id, { expectedVersion: savedVersion });
                    await reload({ selectProfileId: before?.id || '' });
                },
            });
            app.toast(i18n('Profile saved.'));
            await reload({ selectProfileId: saved.id });
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
        } finally {
            profileWritePending = false;
            paint();
            syncDirtyState();
        }
    }

    async function deleteDraftProfile() {
        if (!draftProfile || profileWritePending) return;
        const target = JSON.parse(JSON.stringify(draftProfile));
        const expectedVersion = draftVersion;
        const store = getStore();
        try {
            const existed = await store.getProfile(target.id);
            if (expectedVersion !== null) {
                const ok = await confirmDialog(el, {
                    title: i18n('Delete profile'),
                    message: `${target.name} (${target.id})`,
                    danger: true,
                });
                if (!ok) return;
                profileWritePending = true;
                paint();
                await store.deleteProfile(target.id, { expectedVersion });
                app.recordHistory?.({
                    label: `${i18n('Delete profile')}: ${target.name}`,
                    undo: async () => {
                        await store.upsertProfile(existed, Date.now(), { expectedVersion: null });
                        await reload({ selectProfileId: existed.id });
                    },
                });
            }
            app.toast(i18n('Profile deleted.'));
            selectedId = '';
            savedProfileSnapshot = null;
            draftProfile = null;
            draftVersion = null;
            await reload({ keepSelected: false });
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
        } finally {
            profileWritePending = false;
            paint();
        }
    }

    function appendDraftReferenceImage(imagePath, expectedProfileId = '') {
        const cleanPath = String(imagePath || '').trim();
        if (!cleanPath || !draftProfile) return;
        if (expectedProfileId && draftProfile.id !== expectedProfileId) return;
        const existing = Array.isArray(draftProfile.referenceImages) ? draftProfile.referenceImages : [];
        if (!existing.some(ref => ref.path === cleanPath)) {
            draftProfile.referenceImages = [...existing, { path: cleanPath, label: '' }];
        }
        paint();
        syncDirtyState();
    }

    async function openAiBuilder(initialProfile = null) {
        try {
            const opener = typeof app.openCharacterBuilderDialog === 'function'
                ? opts => app.openCharacterBuilderDialog(opts)
                : opts => openCharacterBuilderDialog({ app, ...opts });
            await opener({
                initialProfile,
                onSaved: async (saved) => {
                    await reload({ selectProfileId: saved?.id || '' });
                },
            });
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
        }
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

        const aiBuildBtn = button(i18n('AI Profile Builder'), () => { void openAiBuilder(null); }, {
            primary: true,
            small: true,
            iconName: 'spark',
            renderIcon: icon,
        });
        aiBuildBtn.dataset.sdRole = 'open-ai-builder';

        const addBtn = iconButton('plus', i18n('New character profile'), () => startNewDraftProfile(), {
            renderIcon: icon,
        });
        addBtn.dataset.sdRole = 'new-profile';

        return h('aside', { class: 'sdlens-chars-list-pane' },
            h('div', { class: 'sdlens-chars-list-head' }, filterInput, aiBuildBtn, addBtn),
            h('div', { class: 'sdlens-chars-cards' },
                visible.length === 0
                    ? emptyState('users', i18n('No character profiles archived yet'), '', null, { renderIcon: icon })
                    : visible.map(profile => {
                        const refs = Array.isArray(profile.referenceImages) ? profile.referenceImages : [];
                        const thumb = refs[0]?.path || '';
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
                                draftVersion = profileVersion(profile);
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
                                text: [profile.sourceWork, i18nFormat('${0} reference image(s)', refs.length)].filter(Boolean).join(' · '),
                            })));
                    })));
    }

    function renderReferenceImagesSection() {
        const refs = Array.isArray(draftProfile.referenceImages) ? draftProfile.referenceImages : [];

        const fileInput = h('input', {
            type: 'file',
            accept: 'image/*',
            hidden: true,
            dataset: { sdRole: 'upload-ref-input' },
            onChange: async (e) => {
                const file = e.target.files?.[0];
                if (!file || !draftProfile) return;
                const targetProfileId = draftProfile.id;
                try {
                    const imagePath = await uploadAndPromoteReferenceFile(file, targetProfileId, getCtx());
                    if (!draftProfile || draftProfile.id !== targetProfileId) return;
                    appendDraftReferenceImage(imagePath, targetProfileId);
                } catch (err) {
                    app.toast(String(err?.message || err), { error: true });
                } finally {
                    e.target.value = '';
                }
            },
        });

        const uploadBtn = button(i18n('Upload local reference image'), () => fileInput.click(), {
            small: true,
            iconName: 'upload',
            renderIcon: icon,
        });
        uploadBtn.dataset.sdRole = 'upload-ref';

        const refGrid = refs.length === 0
            ? h('div', { class: 'sdlens-ref-empty', text: i18n('No reference images added yet.') })
            : h('div', { class: 'sdlens-ref-strip' },
                refs.map((ref, refIdx) => {
                    const removeBtn = h('button', {
                        type: 'button',
                        class: 'sdlens-ref-remove',
                        title: i18n('Remove'),
                        'aria-label': i18n('Remove'),
                        dataset: { sdRole: 'ref-remove' },
                        onClick: () => {
                            draftProfile.referenceImages.splice(refIdx, 1);
                            paint();
                            syncDirtyState();
                        },
                    }, icon('x', { size: 12 }));

                    const labelInput = h('input', {
                        type: 'text',
                        class: 'sdlens-input sdlens-ref-label',
                        value: ref.label || '',
                        placeholder: i18n('Short label (optional)'),
                        'aria-label': i18n('Reference label'),
                        dataset: { sdField: 'ref-label', sdRole: 'ref-label' },
                        onInput: (e) => {
                            ref.label = e.target.value;
                            syncDirtyState();
                        },
                    });

                    return h('div', {
                        class: 'sdlens-ref-item',
                        dataset: { sdRole: 'ref-item', refPath: ref.path },
                    },
                    h('div', { class: 'sdlens-ref-thumb' },
                        h('img', { src: ref.path, alt: ref.label || draftProfile.name }),
                        removeBtn),
                    h('div', { class: 'sdlens-ref-body' }, labelInput));
                }));

        return h('section', { class: 'sdlens-refs-section' },
            sectionTitle(i18n('Reference images')),
            refGrid,
            h('div', { class: 'sdlens-ref-controls' }, uploadBtn, fileInput));
    }

    function renderDetailPane() {
        if (!draftProfile) {
            const emptyAiBtn = button(i18n('AI Profile Builder'), () => { void openAiBuilder(null); }, {
                primary: true,
                iconName: 'spark',
                renderIcon: icon,
            });
            emptyAiBtn.dataset.sdRole = 'open-ai-builder';
            const emptyNewBtn = button(i18n('New character profile'), () => startNewDraftProfile(), {
                iconName: 'plus',
                renderIcon: icon,
            });
            emptyNewBtn.dataset.sdRole = 'new-profile';
            return h('div', { class: 'sdlens-chars-detail' },
                emptyState(
                    'users',
                    i18n('No character profiles archived yet'),
                    i18n('Use AI Profile Builder to craft or look up character profiles through conversation, or create a blank profile manually.'),
                    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' } }, emptyAiBtn, emptyNewBtn),
                    { renderIcon: icon },
                ));
        }

        const saveBtn = button(i18n('Save profile'), () => { void saveDraftProfile(); }, {
            primary: true,
            iconName: 'check',
            renderIcon: icon,
        });
        saveBtn.dataset.sdRole = 'save-profile';

        const refineWithAiBtn = button(i18n('Refine with AI'), () => {
            if (!guardDirtySwitch()) return;
            const existing = profiles.find(p => p.id === draftProfile.id) || draftProfile;
            void openAiBuilder(existing);
        }, {
            iconName: 'spark',
            renderIcon: icon,
        });
        refineWithAiBtn.dataset.sdRole = 'refine-with-ai';

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

        const descTextarea = h('textarea', {
            class: 'sdlens-textarea sdlens-description-textarea',
            placeholder: i18n('Describe appearance, Danbooru character tag if applicable, outfits, and visual notes…'),
            dataset: { sdField: 'profile-description' },
            onInput: (e) => { draftProfile.description = e.target.value; syncDirtyState(); },
        });
        descTextarea.value = draftProfile.description || '';

        return h('div', { class: 'sdlens-chars-detail' },
            dirtyBarEl,
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                h('h3', { style: { margin: '0', fontSize: '15px' }, text: `${draftProfile.name} (${draftProfile.id})` }),
                h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, refineWithAiBtn, saveBtn, deleteBtn)),
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
                }))),
            formField(i18n('Character visual description'), descTextarea),
            renderReferenceImagesSection());
    }

    function paint() {
        dirtyBarEl = null;
        clear(el);
        put(el,
            h('div', { class: 'sdlens-chars-split' },
                renderListPane(),
                renderDetailPane()));
        if (profileWritePending) {
            for (const control of el.querySelectorAll('input, textarea, select, button')) {
                control.disabled = true;
            }
        }
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
        destroy() {},
    };
}
