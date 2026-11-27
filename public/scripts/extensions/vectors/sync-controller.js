// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure controller for vectors chat synchronization and file vectorization,
 * owning activity-guard lease acquisition and error-recovery bookkeeping.
 */
export function createVectorsSyncController({
    getSettings,
    getContext,
    getCurrentChatId,
    isSendPress,
    waitUntilCondition,
    substituteParams,
    getStringHash,
    getSavedHashes,
    summarize,
    splitByChunks,
    insertVectorItems,
    deleteVectorItems,
    getBatchSize,
    getChunkDelimiters,
    overlapChunks,
    splitRecursive,
    escapeHtml,
    fatalCauses,
    skippedHashes,
    t,
    getJQuery = () => globalThis.$,
    getToastr = () => globalThis.toastr,
    getTranslate = () => globalThis.translate,
}) {
    let syncBlocked = false;

    async function synchronizeChat(batchSize = 5) {
        const settings = getSettings();
        if (!settings.enabled_chats) {
            return -1;
        }

        try {
            await waitUntilCondition(() => !syncBlocked && !isSendPress(), 1000);
        } catch {
            console.log('Vectors: Synchronization blocked by another process');
            return -1;
        }

        try {
            syncBlocked = true;
            const context = getContext();
            const chatId = getCurrentChatId();

            if (!chatId || !Array.isArray(context.chat)) {
                console.debug('Vectors: No chat selected');
                return -1;
            }

            const runSync = async () => {
                const hashedMessages = context.chat
                    .filter(x => settings.keep_hidden || !x.is_system)
                    .map(x => ({
                        text: String(substituteParams(x.mes)),
                        hash: getStringHash(substituteParams(x.mes)),
                        index: context.chat.indexOf(x),
                    }));
                const hashesInCollection = await getSavedHashes(chatId);

                const newVectorItems = hashedMessages
                    .filter(x => !hashesInCollection.includes(x.hash))
                    .filter(x => !skippedHashes.has(x.hash));
                const deletedHashes = hashesInCollection.filter(x => !hashedMessages.some(y => y.hash === x));

                let batch = newVectorItems.slice(0, batchSize);

                if (settings.summarize) {
                    const minLength = Math.max(0, Number(settings.summary_threshold) || 0);
                    const toSummarize = minLength > 0 ? batch.filter(x => x.text.length >= minLength) : batch;
                    if (toSummarize.length > 0) {
                        await summarize(toSummarize, settings.summary_source, { skipOnFailure: true });
                        const failed = toSummarize.filter(x => x.summaryFailed);
                        if (failed.length > 0) {
                            for (const item of failed) skippedHashes.add(item.hash);
                            batch = batch.filter(x => !x.summaryFailed);
                        }
                    }
                }

                if (batch.length > 0) {
                    const chunkedBatch = splitByChunks(batch);

                    console.log(`Vectors: Found ${newVectorItems.length} new items. Processing ${batch.length}...`);
                    try {
                        await insertVectorItems(chatId, chunkedBatch);
                    } catch (insertError) {
                        if (fatalCauses.has(insertError?.cause)) {
                            throw insertError;
                        }
                        console.warn('Vectors: insert failed for batch — marking for skip', insertError);
                        for (const item of batch) skippedHashes.add(item.hash);
                    }
                }

                if (deletedHashes.length > 0) {
                    await deleteVectorItems(chatId, deletedHashes);
                    console.log(`Vectors: Deleted ${deletedHashes.length} old hashes`);
                }

                return newVectorItems.length - batchSize;
            };

            const guard = context?.activityGuard;
            return typeof guard?.run === 'function'
                ? await guard.run({
                    source: 'vectors:chat',
                    label: t`Chat vectorization`,
                    scope: 'chat',
                }, runSync)
                : await runSync();
        } catch (error) {
            function getErrorMessage(cause) {
                switch (cause) {
                    case 'profile_missing':
                        return 'Embedding profile is missing. Pick or create one in the Vector Storage settings.';
                    case 'api_key_missing':
                        return 'API key missing. Save it in the "API Connections" panel.';
                    case 'api_url_missing':
                        return 'API URL missing. Save it in the embedding profile settings.';
                    case 'api_model_missing':
                        return 'Embedding model is required, but not set on the profile.';
                    case 'webllm_not_supported':
                        return 'WebLLM extension is not installed or the model is not set.';
                    case 'account_id_missing':
                        return 'Workers AI account ID is required. Save it in the embedding profile settings.';
                    case 'summary_endpoint_invalid':
                        return 'Summarization endpoint is not supported.';
                    case 'summary_failed':
                        return 'Summarization failed after the configured number of retries.';
                    default:
                        return 'Check server console for more details';
                }
            }

            console.error('Vectors: Failed to synchronize chat', error);

            const message = getErrorMessage(error.cause);
            getToastr()?.error(message, 'Vectorization failed', { preventDuplicates: true });
            return null;
        } finally {
            syncBlocked = false;
        }
    }

    async function vectorizeFile(fileText, fileName, collectionId, chunkSize, overlapPercent) {
        const settings = getSettings();
        const run = async () => {
            const $ = getJQuery();
            const toastr = getToastr();
            let toast = $ ? $() : null;

            try {
                const translateFn = getTranslate();
                if (settings.translate_files && typeof translateFn === 'function') {
                    console.log(`Vectors: Translating file ${fileName} to English...`);
                    const translatedText = await translateFn(fileText, 'en');
                    fileText = translatedText;
                }

                const batchSize = getBatchSize();
                const toastBody = $ ? $('<span>').text('This may take a while. Please wait...') : { text: () => {} };
                toast = toastr?.info(toastBody, `Ingesting file ${escapeHtml(fileName)}`, { closeButton: false, tapToDismiss: false, escapeHtml: false, timeOut: 0, extendedTimeOut: 0 });
                const overlapSize = Math.round(chunkSize * overlapPercent / 100);
                const delimiters = getChunkDelimiters();
                chunkSize = overlapSize > 0 ? (chunkSize - overlapSize) : chunkSize;
                const applyOverlap = (x, y, z) => overlapSize > 0 ? overlapChunks(x, y, z, overlapSize) : x;
                const chunks = settings.only_custom_boundary && settings.force_chunk_delimiter
                    ? fileText.split(settings.force_chunk_delimiter).map(applyOverlap)
                    : splitRecursive(fileText, chunkSize, delimiters).map(applyOverlap);
                console.debug(`Vectors: Split file ${fileName} into ${chunks.length} chunks with ${overlapPercent}% overlap`, chunks);

                const items = chunks.map((chunk, index) => ({ hash: getStringHash(chunk), text: chunk, index: index }));

                for (let i = 0; i < items.length; i += batchSize) {
                    toastBody.text(`${i}/${items.length} (${Math.round((i / items.length) * 100)}%) chunks processed`);
                    const chunkedBatch = items.slice(i, i + batchSize);
                    await insertVectorItems(collectionId, chunkedBatch);
                }

                toastr?.clear(toast);
                console.log(`Vectors: Inserted ${chunks.length} vector items for file ${fileName} into ${collectionId}`);
                return true;
            } catch (error) {
                toastr?.clear(toast);
                toastr?.error(String(error), 'Failed to vectorize file', { preventDuplicates: true });
                console.error('Vectors: Failed to vectorize file', error);
                return false;
            }
        };

        const guard = getContext()?.activityGuard;
        if (typeof guard?.run === 'function') {
            return await guard.run({
                source: 'vectors:file',
                label: t`File vectorization`,
                scope: 'global',
            }, run);
        }
        return await run();
    }

    return {
        synchronizeChat,
        vectorizeFile,
    };
}
