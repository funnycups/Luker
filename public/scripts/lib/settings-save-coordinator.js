// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure serialized settings persistence coordinator and first-run completion
 * rollback helper extracted from `public/script.js`.
 */

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function parseNormalizedSettingsObject(serialized) {
    if (typeof serialized !== 'string' || !serialized) {
        return {};
    }
    const parsed = JSON.parse(serialized);
    return isPlainObject(parsed) ? parsed : {};
}

/**
 * Persist completion of first-run onboarding while ensuring `firstRun` is
 * rolled back to `true` ONLY when persistence actually fails before the server
 * acknowledges the write — never when deferred (`status === 'deferred'`) or
 * when a post-save `SETTINGS_UPDATED` listener throws after `onSaved` ran.
 *
 * @param {{ setFirstRun: (value: boolean) => void, saveSettings: (loopCounter: number, options: object) => Promise<any> }} deps
 */
export async function persistFirstRunCompletion({ setFirstRun, saveSettings }) {
    setFirstRun(false);
    let persisted = false;
    try {
        const outcome = await saveSettings(0, {
            directSave: true,
            onSaved: () => {
                persisted = true;
            },
        });
        if (!outcome?.ok && outcome?.status !== 'deferred') {
            setFirstRun(true);
            console.error('Failed to persist firstRun completion', outcome);
        }
        return outcome;
    } catch (error) {
        if (!persisted) {
            setFirstRun(true);
        }
        console.error('Failed to persist firstRun completion', error);
        return null;
    }
}

/**
 * Create a serialized settings save coordinator managing patch-vs-full-save
 * transport, snapshot authority invalidation, `onSaved` acknowledgement order,
 * and post-save `SETTINGS_UPDATED` emission after releasing the in-flight lock.
 *
 * @param {object} deps
 */
export function createSettingsSaveCoordinator({
    isBlockedForImport = () => false,
    isSettingsReady = () => true,
    scheduleDebouncedSave = () => {},
    isTempResponseLengthCustomized = () => false,
    restoreTempResponseLength = () => {},
    normalizeOptions = (options = null) => ({
        onSaved: options?.onSaved,
        asyncDiff: options?.asyncDiff !== false && options?.diffMode !== 'sync',
        directSave: options?.directSave === true,
    }),
    buildSettingsPayload,
    captureCharacterBoundSettingsSave = () => null,
    getSettingsSnapshot = () => null,
    rememberSettingsSnapshot = () => {},
    onSettingsPersisted = () => {},
    diffSerializedSettingsWithWorker = null,
    buildObjectPatchOperations = () => [],
    applyCommittedSnapshotOperations = (previousSnapshot) => previousSnapshot,
    shouldUseSettingsPatch = () => false,
    getRequestHeaders = () => ({ 'Content-Type': 'application/json' }),
    incrementReadPublication = () => {},
    emitSettingsUpdated = async () => {},
    notifySaveError = () => {},
}) {
    let settingsSaveInFlight = null;

    async function saveSettingsInternal(payload, options = {}) {
        async function rejectDeletedWorldReference(response) {
            let refusal;
            try {
                refusal = await response.json();
            } catch {
                return;
            }
            if (refusal?.code === 'world_deleted' || refusal?.code === 'world_deletion_unknown') {
                const reason = refusal.code === 'world_deleted' ? 'deleted' : 'whose deletion outcome is unconfirmed';
                throw Object.assign(new Error(`Settings reference a world book ${reason} during this write: ${refusal.details?.name ?? 'unknown'}. Reload the world book list before retrying.`), refusal);
            }
        }

        let workerDiff = null;
        try {
            const serializedPayload = JSON.stringify(payload);
            let nextSnapshot = null;
            let saved = false;
            const previousSnapshot = getSettingsSnapshot();

            if (!options.directSave && isPlainObject(previousSnapshot)) {
                if (options.asyncDiff && typeof diffSerializedSettingsWithWorker === 'function') {
                    try {
                        workerDiff = await diffSerializedSettingsWithWorker(previousSnapshot, serializedPayload, { maxOperations: 4000 });
                    } catch (error) {
                        console.warn('Falling back to synchronous object patch diff', error);
                        workerDiff = null;
                    }
                }

                let operations;
                if (workerDiff) {
                    operations = workerDiff.operations;
                } else {
                    nextSnapshot = parseNormalizedSettingsObject(serializedPayload);
                    operations = buildObjectPatchOperations(previousSnapshot, nextSnapshot, { maxOperations: 4000 });
                }

                if (operations.length === 0) {
                    workerDiff?.discard();
                    workerDiff = null;
                    return { ok: true, status: 'saved', payload: structuredClone(previousSnapshot) };
                } else if (shouldUseSettingsPatch(operations)) {
                    incrementReadPublication();
                    const patchResult = await fetch('/api/settings/patch', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({ operations }),
                        cache: 'no-cache',
                    });
                    saved = patchResult.ok;
                    if (patchResult.status === 409) await rejectDeletedWorldReference(patchResult);
                    if (saved) {
                        workerDiff?.commit();
                        nextSnapshot = nextSnapshot ?? applyCommittedSnapshotOperations(previousSnapshot, operations);
                    } else {
                        workerDiff?.discard();
                        workerDiff = null;
                    }
                }
            }

            if (!saved) {
                incrementReadPublication();
                const result = await fetch('/api/settings/save', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: serializedPayload,
                    cache: 'no-cache',
                });
                if (result.status === 409) await rejectDeletedWorldReference(result);
                if (!result.ok) throw new Error(`Failed to save settings: HTTP ${result.status} ${result.statusText}`);
                workerDiff?.commit();
                nextSnapshot = nextSnapshot ?? parseNormalizedSettingsObject(serializedPayload);
            }

            onSettingsPersisted(structuredClone(nextSnapshot));
            rememberSettingsSnapshot(nextSnapshot, { serialized: serializedPayload, syncWorker: !workerDiff });
            return { ok: true, status: 'saved', payload: structuredClone(nextSnapshot) };
        } catch (error) {
            workerDiff?.discard();
            if (error?.code !== 'world_deleted' && error?.code !== 'world_deletion_unknown') {
                rememberSettingsSnapshot(null);
            }
            console.error('Error saving settings:', error);
            notifySaveError(error);
            return { ok: false, status: 'failed', error: String(error?.message || error) };
        }
    }

    async function saveSettings(loopCounter = 0, options = null) {
        if (isBlockedForImport()) {
            return { ok: false, status: 'deferred', reason: 'data_import' };
        }
        const normalizedOptions = normalizeOptions(options);
        if (!isSettingsReady()) {
            console.warn('Settings not ready, scheduling another save');
            scheduleDebouncedSave(loopCounter, normalizedOptions);
            return { ok: false, status: 'deferred', reason: 'not_ready' };
        }

        const MAX_RETRIES = 3; // cap-ok: existing temporary-generation override recovery policy, not a request retry limit.
        if (isTempResponseLengthCustomized()) {
            if (loopCounter < MAX_RETRIES) {
                console.warn('Response length is currently being overridden, scheduling another save');
                scheduleDebouncedSave(++loopCounter, normalizedOptions);
                return { ok: false, status: 'deferred', reason: 'temporary_response_length' };
            }
            console.error('Response length is currently being overridden, but the save loop has reached the maximum number of retries');
            restoreTempResponseLength();
        }

        let payload;
        let cardPresetSave;
        try {
            payload = buildSettingsPayload();
            cardPresetSave = captureCharacterBoundSettingsSave(payload.oai_settings, options?.cardPresetOwner);
        } catch (error) {
            console.error('Error capturing settings:', error);
            notifySaveError(error);
            return { ok: false, status: 'failed', error: String(error?.message || error) };
        }

        const previous = settingsSaveInFlight;
        const attempt = (async () => {
            if (previous) await previous;
            return saveSettingsInternal(payload, normalizedOptions);
        })();
        settingsSaveInFlight = attempt;
        const outcome = await attempt;
        if (settingsSaveInFlight === attempt) settingsSaveInFlight = null;
        if (outcome.ok) {
            normalizedOptions.onSaved?.();
            await emitSettingsUpdated({ cardPresetSave });
        }
        return outcome;
    }

    return {
        saveSettings,
        saveSettingsInternal,
        getInFlightPromise: () => settingsSaveInFlight,
    };
}
