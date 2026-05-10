import {
    eventSource,
    event_types,
    extension_prompt_types,
    extension_prompt_roles,
    getCurrentChatId,
    getRequestHeaders,
    is_send_press,
    saveSettingsDebounced,
    setExtensionPrompt,
    substituteParams,
    generateRaw,
    substituteParamsExtended,
} from '../../../script.js';
import {
    ModuleWorkerWrapper,
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
    openThirdPartyExtensionMenu,
} from '../../extensions.js';
import { collapseNewlines, registerDebugFunction } from '../../power-user.js';
import { getDataBankAttachments, getDataBankAttachmentsForSource, getFileAttachment } from '../../chats.js';
import { debounce, getStringHash as calculateHash, waitUntilCondition, onlyUnique, splitRecursive, trimToStartSentence, trimToEndSentence, escapeHtml, isTrueBoolean, uuidv4 } from '../../utils.js';
import { debounce_timeout } from '../../constants.js';
import { getSortedEntries } from '../../world-info.js';
import { textgen_types, textgenerationwebui_settings } from '../../textgen-settings.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue, enumTypes } from '../../slash-commands/SlashCommandEnumValue.js';
import { commonEnumProviders } from '../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { slashCommandReturnHelper } from '../../slash-commands/SlashCommandReturnHelper.js';
import { generateWebLlmChatPrompt, isWebLlmSupported } from '../shared.js';
import { WebLlmVectorProvider } from './webllm.js';
import { removeReasoningFromString } from '../../reasoning.js';
import { oai_settings } from '../../openai.js';
import {
    listEmbeddingProfiles,
    getEmbeddingProfileById,
    listRerankProfiles,
    getRerankProfileById,
    upsertEmbeddingProfile,
    upsertRerankProfile,
    renderProfileSelect,
} from '../connection-manager/embed-rerank.js';
import { EmbeddingService } from '../../embedding-service.js';

/**
 * @typedef {object} HashedMessage
 * @property {string} text - The hashed message text
 * @property {number} hash - The hash used as the vector key
 * @property {number} index - The index of the message in the chat
 * @property {boolean} [summaryFailed] - Whether summarization failed for this message (used internally to skip messages that fail summarization)
 */

const MODULE_NAME = 'vectors';

export const EXTENSION_PROMPT_TAG = '3_vectors';
export const EXTENSION_PROMPT_TAG_DB = '4_vectors_data_bank';

// Force solo chunks for sources that don't support batching.
const getBatchSize = () => {
    const profile = getActiveEmbedProfile();
    if (!profile) return 5;
    return ['transformers', 'ollama'].includes(profile.source) ? 1 : 5;
};

const settings = {
    // Embedding & rerank — shared profiles managed by Connection Manager.
    embeddingProfileId: '',
    rerankProfileId: '',
    rerank_enabled: false,

    // Shared:
    include_wi: false,
    summarize: false,
    summarize_sent: false,
    summary_source: 'main',
    summary_prompt: 'Ignore previous instructions. Summarize the most important parts of the message. Limit yourself to 250 words or less. Your response should include nothing but the summary.',
    summary_retries: 2,
    summary_threshold: 200,
    force_chunk_delimiter: '',

    // For chats
    enabled_chats: false,
    keep_hidden: false,
    template: 'Past events:\n{{text}}',
    depth: 2,
    position: extension_prompt_types.IN_PROMPT,
    protect: 5,
    insert: 3,
    query: 2,
    message_chunk_size: 400,
    score_threshold: 0.25,

    // For files
    enabled_files: false,
    translate_files: false,
    size_threshold: 10,
    chunk_size: 5000,
    chunk_count: 2,
    overlap_percent: 0,
    only_custom_boundary: false,

    // For Data Bank
    size_threshold_db: 5,
    chunk_size_db: 2500,
    chunk_count_db: 5,
    overlap_percent_db: 0,
    file_template_db: 'Related information:\n{{text}}',
    file_position_db: extension_prompt_types.IN_PROMPT,
    file_depth_db: 4,
    file_depth_role_db: extension_prompt_roles.SYSTEM,

    // For World Info
    enabled_world_info: false,
    enabled_for_all: false,
    max_entries: 5,
};

const moduleWorker = new ModuleWorkerWrapper(synchronizeChat);
const webllmProvider = new WebLlmVectorProvider();
/**
 * Cache for storing summaries of messages by their hash.
 * @type {Map<number, string>}
 */
const cachedSummaries = new Map();
/**
 * Hashes skipped this Vectorize All session (summary or embed failure). Cleared on next Vectorize All click.
 * @type {Set<number>}
 */
const skippedHashes = new Set();
/**
 * Error causes treated as fatal — abort Vectorize All rather than skip.
 * @type {Set<string>}
 */
const FATAL_CAUSES = new Set(['account_id_missing', 'api_key_missing', 'api_url_missing', 'api_model_missing', 'extras_module_missing', 'webllm_not_supported', 'summary_endpoint_invalid', 'profile_missing']);

/**
 * Resolves the currently selected embedding profile, or null when none is selected.
 * @returns {object|null}
 */
function getActiveEmbedProfile() {
    return getEmbeddingProfileById(settings.embeddingProfileId);
}

/**
 * Resolves the currently selected rerank profile, only when rerank is enabled.
 * @returns {object|null}
 */
function getActiveRerankProfile() {
    if (!settings.rerank_enabled) return null;
    return getRerankProfileById(settings.rerankProfileId);
}

/**
 * Throws if the active embedding profile is missing or unusable for synchronisation.
 */
function throwIfEmbeddingProfileMissing() {
    const profile = getActiveEmbedProfile();
    if (!profile) {
        throw new Error('No embedding profile selected', { cause: 'profile_missing' });
    }
    return profile;
}

/**
 * Gets the Collection ID for a file embedded in the chat.
 * @param {string} fileUrl URL of the file
 * @returns {string} Collection ID
 */
function getFileCollectionId(fileUrl) {
    return `file_${getStringHash(fileUrl)}`;
}

async function onVectorizeAllClick() {
    try {
        if (!settings.enabled_chats) {
            return;
        }

        const chatId = getCurrentChatId();

        if (!chatId) {
            toastr.info('No chat selected', 'Vectorization aborted');
            return;
        }

        cachedSummaries.clear();
        skippedHashes.clear();

        const batchSize = getBatchSize();
        const elapsedLog = [];
        let finished = false;
        let initialPending = null;
        $('#vectorize_progress').show();
        $('#vectorize_progress_percent').text('0');
        $('#vectorize_progress_eta').text('...');

        while (!finished) {
            if (is_send_press) {
                toastr.info('Message generation is in progress.', 'Vectorization aborted');
                throw new Error('Message generation is in progress.');
            }

            const startTime = Date.now();
            const remaining = await synchronizeChat(batchSize);
            const elapsed = Date.now() - startTime;

            if (remaining === null) {
                throw new Error('Vectorization aborted');
            }

            elapsedLog.push(elapsed);
            finished = remaining <= 0;

            if (initialPending === null) {
                initialPending = Math.max(0, remaining + batchSize);
            }
            const pending = Math.max(0, remaining);
            const processed = Math.max(0, initialPending - pending);
            const processedPercent = initialPending > 0
                ? Math.min(100, Math.round((processed / initialPending) * 100))
                : 100;
            const lastElapsed = elapsedLog.slice(-5);
            const averageElapsed = lastElapsed.reduce((a, b) => a + b, 0) / lastElapsed.length;
            const pace = averageElapsed / batchSize;
            const remainingTime = Math.round(pace * pending / 1000);

            $('#vectorize_progress_percent').text(processedPercent);
            $('#vectorize_progress_eta').text(remainingTime);

            if (chatId !== getCurrentChatId()) {
                throw new Error('Chat changed');
            }
        }
        if (skippedHashes.size > 0) {
            toastr.warning(`${skippedHashes.size} message(s) skipped due to errors. Click Vectorize All again to retry.`, 'Vectorization partial');
        }
    } catch (error) {
        console.error('Vectors: Failed to vectorize all', error);
    } finally {
        $('#vectorize_progress').hide();
    }
}

let syncBlocked = false;

/**
 * Gets the chunk delimiters for splitting text.
 * @returns {string[]} Array of chunk delimiters
 */
function getChunkDelimiters() {
    const delimiters = ['\n\n', '\n', ' ', ''];

    if (settings.force_chunk_delimiter) {
        delimiters.unshift(settings.force_chunk_delimiter);
    }

    return delimiters;
}

/**
 * Splits messages into chunks before inserting them into the vector index.
 * @param {object[]} items Array of vector items
 * @returns {object[]} Array of vector items (possibly chunked)
 */
function splitByChunks(items) {
    if (settings.message_chunk_size <= 0) {
        return items;
    }

    const chunkedItems = [];

    for (const item of items) {
        const chunks = splitRecursive(item.text, settings.message_chunk_size, getChunkDelimiters());
        for (const chunk of chunks) {
            const chunkedItem = { ...item, text: chunk };
            chunkedItems.push(chunkedItem);
        }
    }

    return chunkedItems;
}

/**
 * Summarizes messages using the main API method.
 * @param {HashedMessage} element hashed message
 * @returns {Promise<boolean>} Success
 */
async function summarizeMain(element) {
    element.text = removeReasoningFromString(await generateRaw({ prompt: element.text, systemPrompt: settings.summary_prompt }));
    return true;
}

/**
 * Summarizes messages using WebLLM.
 * @param {HashedMessage} element hashed message
 * @returns {Promise<boolean>} Success
 */
async function summarizeWebLLM(element) {
    if (!isWebLlmSupported()) {
        console.warn('Vectors: WebLLM is not supported');
        return false;
    }

    const messages = [{ role: 'system', content: settings.summary_prompt }, { role: 'user', content: element.text }];
    element.text = removeReasoningFromString(await generateWebLlmChatPrompt(messages));

    return true;
}

/**
 * Runs one summarization attempt for a single element via the chosen endpoint.
 * @param {HashedMessage} element
 * @param {string} endpoint
 * @returns {Promise<boolean>} Whether the attempt succeeded.
 */
async function summarizeOne(element, endpoint) {
    switch (endpoint) {
        case 'main':
            return await summarizeMain(element);
        case 'webllm':
            return await summarizeWebLLM(element);
        default:
            throw new Error(`Unsupported summary endpoint: ${endpoint}`, { cause: 'summary_endpoint_invalid' });
    }
}

/**
 * Summarizes messages using the chosen method.
 * @param {HashedMessage[]} hashedMessages Array of hashed messages (mutated in place)
 * @param {string} endpoint Type of endpoint to use
 * @param {Object} [options]
 * @param {boolean} [options.skipOnFailure=false]
 * @returns {Promise<HashedMessage[]>} Summarized messages
 */
async function summarize(hashedMessages, endpoint = 'main', { skipOnFailure = false } = {}) {
    const maxAttempts = Math.max(1, Number(settings.summary_retries) || 1);
    for (const element of hashedMessages) {
        const cachedSummary = cachedSummaries.get(element.hash);
        if (cachedSummary) {
            element.text = cachedSummary;
            continue;
        }

        let success = false;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                success = await summarizeOne(element, endpoint);
                if (success) break;
            } catch (error) {
                if (FATAL_CAUSES.has(error?.cause)) throw error;
                console.warn(`Vectors: summary attempt ${attempt}/${maxAttempts} threw for hash ${element.hash}`, error);
            }
            console.warn(`Vectors: summary attempt ${attempt}/${maxAttempts} failed for hash ${element.hash}`);
        }
        if (!success) {
            if (skipOnFailure) {
                console.warn(`Vectors: summarization exhausted ${maxAttempts} attempt(s) for hash ${element.hash} — marking for skip`);
                element.summaryFailed = true;
                continue;
            }

            throw new Error(`Summarization failed after ${maxAttempts} attempt(s)`, { cause: 'summary_failed' });
        }
        cachedSummaries.set(element.hash, element.text);
    }
    return hashedMessages;
}

async function synchronizeChat(batchSize = 5) {
    if (!settings.enabled_chats) {
        return -1;
    }

    try {
        await waitUntilCondition(() => !syncBlocked && !is_send_press, 1000);
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

        /** @type {HashedMessage[]} */
        const hashedMessages = context.chat.filter(x => settings.keep_hidden || !x.is_system).map(x => ({ text: String(substituteParams(x.mes)), hash: getStringHash(substituteParams(x.mes)), index: context.chat.indexOf(x) }));
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
                if (FATAL_CAUSES.has(insertError?.cause)) {
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
        toastr.error(message, 'Vectorization failed', { preventDuplicates: true });
        return null;
    } finally {
        syncBlocked = false;
    }
}

/**
 * @type {Map<string, number>} Cache object for storing hash values
 */
const hashCache = new Map();

function getStringHash(str) {
    if (hashCache.has(str)) {
        return hashCache.get(str);
    }
    const hash = calculateHash(str);
    hashCache.set(str, hash);
    return hash;
}

async function processFiles(chat) {
    try {
        if (!settings.enabled_files) {
            return;
        }

        const dataBankCollectionIds = await ingestDataBankAttachments();

        if (dataBankCollectionIds.length) {
            const queryText = await getQueryText(chat, 'file');
            await injectDataBankChunks(queryText, dataBankCollectionIds);
        }

        for (const message of chat) {
            if (!Array.isArray(message?.extra?.files) || !message.extra.files.length) {
                continue;
            }

            const allFileText = String(message.mes || '').substring(0, message.extra.fileLength).trim();

            const thresholdLength = settings.size_threshold * 1024;

            if (allFileText.length < thresholdLength) {
                continue;
            }

            message.mes = message.mes.substring(message.extra.fileLength);

            const allFileChunks = [];
            const queryText = await getQueryText(chat, 'file');

            for (const file of message.extra.files) {
                const fileName = file.name;
                const fileUrl = file.url;
                const collectionId = getFileCollectionId(fileUrl);
                const hashesInCollection = await getSavedHashes(collectionId);

                if (!hashesInCollection.length) {
                    const fileText = file.text || (await getFileAttachment(fileUrl));
                    if (!fileText) {
                        continue;
                    }
                    await vectorizeFile(fileText, fileName, collectionId, settings.chunk_size, settings.overlap_percent);
                }

                const fileChunks = await retrieveFileChunks(queryText, collectionId);
                if (fileChunks) {
                    allFileChunks.push(fileChunks);
                }
            }

            message.mes = `${allFileChunks.join('\n\n')}\n\n${message.mes}`;
        }
    } catch (error) {
        console.error('Vectors: Failed to retrieve files', error);
    }
}

async function ingestDataBankAttachments(source) {
    const dataBank = source ? getDataBankAttachmentsForSource(source, false) : getDataBankAttachments(false);
    const dataBankCollectionIds = [];

    for (const file of dataBank) {
        const collectionId = getFileCollectionId(file.url);
        const hashesInCollection = await getSavedHashes(collectionId);
        dataBankCollectionIds.push(collectionId);

        if (hashesInCollection.length) {
            continue;
        }

        const fileText = await getFileAttachment(file.url);
        console.log(`Vectors: Retrieved file ${file.name} from Data Bank`);
        const thresholdLength = settings.size_threshold_db * 1024;
        const chunkSize = file.size > thresholdLength ? settings.chunk_size_db : -1;
        await vectorizeFile(fileText, file.name, collectionId, chunkSize, settings.overlap_percent_db);
    }

    return dataBankCollectionIds;
}

async function injectDataBankChunks(queryText, collectionIds) {
    try {
        const queryResults = await queryMultipleCollections(collectionIds, queryText, settings.chunk_count_db, settings.score_threshold);
        console.debug(`Vectors: Retrieved ${collectionIds.length} Data Bank collections`, queryResults);
        let textResult = '';

        for (const collectionId in queryResults) {
            console.debug(`Vectors: Processing Data Bank collection ${collectionId}`, queryResults[collectionId]);
            const metadata = queryResults[collectionId].metadata?.filter(x => x.text)?.sort((a, b) => a.index - b.index)?.map(x => x.text)?.filter(onlyUnique) || [];
            textResult += metadata.join('\n') + '\n\n';
        }

        if (!textResult) {
            console.debug('Vectors: No Data Bank chunks found');
            return;
        }

        const insertedText = substituteParamsExtended(settings.file_template_db, { text: textResult });
        setExtensionPrompt(EXTENSION_PROMPT_TAG_DB, insertedText, settings.file_position_db, settings.file_depth_db, settings.include_wi, settings.file_depth_role_db);
    } catch (error) {
        console.error('Vectors: Failed to insert Data Bank chunks', error);
    }
}

async function retrieveFileChunks(queryText, collectionId) {
    console.debug(`Vectors: Retrieving file chunks for collection ${collectionId}`, queryText);
    const queryResults = await queryCollection(collectionId, queryText, settings.chunk_count);
    console.debug(`Vectors: Retrieved ${queryResults.hashes.length} file chunks for collection ${collectionId}`, queryResults);
    const metadata = queryResults.metadata.filter(x => x.text).sort((a, b) => a.index - b.index).map(x => x.text).filter(onlyUnique);
    const fileText = metadata.join('\n');

    return fileText;
}

async function vectorizeFile(fileText, fileName, collectionId, chunkSize, overlapPercent) {
    let toast = jQuery();

    try {
        if (settings.translate_files && typeof globalThis.translate === 'function') {
            console.log(`Vectors: Translating file ${fileName} to English...`);
            const translatedText = await globalThis.translate(fileText, 'en');
            fileText = translatedText;
        }

        const batchSize = getBatchSize();
        const toastBody = $('<span>').text('This may take a while. Please wait...');
        toast = toastr.info(toastBody, `Ingesting file ${escapeHtml(fileName)}`, { closeButton: false, escapeHtml: false, timeOut: 0, extendedTimeOut: 0 });
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

        toastr.clear(toast);
        console.log(`Vectors: Inserted ${chunks.length} vector items for file ${fileName} into ${collectionId}`);
        return true;
    } catch (error) {
        toastr.clear(toast);
        toastr.error(String(error), 'Failed to vectorize file', { preventDuplicates: true });
        console.error('Vectors: Failed to vectorize file', error);
        return false;
    }
}

async function rearrangeChat(chat, _contextSize, _abort, type) {
    try {
        if (type === 'quiet') {
            console.debug('Vectors: Skipping quiet prompt');
            return;
        }

        setExtensionPrompt(EXTENSION_PROMPT_TAG, '', settings.position, settings.depth, settings.include_wi);
        setExtensionPrompt(EXTENSION_PROMPT_TAG_DB, '', settings.file_position_db, settings.file_depth_db, settings.include_wi, settings.file_depth_role_db);

        if (settings.enabled_files) {
            await processFiles(chat);
        }

        if (settings.enabled_world_info) {
            await activateWorldInfo(chat);
        }

        if (!settings.enabled_chats) {
            return;
        }

        const chatId = getCurrentChatId();

        if (!chatId || !Array.isArray(chat)) {
            console.debug('Vectors: No chat selected');
            return;
        }

        if (chat.length < settings.protect) {
            console.debug(`Vectors: Not enough messages to rearrange (less than ${settings.protect})`);
            return;
        }

        const queryText = await getQueryText(chat, 'chat');

        if (queryText.length === 0) {
            console.debug('Vectors: No text to query');
            return;
        }

        const queryResults = await queryCollection(chatId, queryText, settings.insert);
        const queryHashes = queryResults.hashes.filter(onlyUnique);
        const queriedMessages = [];
        const insertedHashes = new Set();
        const retainMessages = chat.slice(-settings.protect);

        for (const message of chat) {
            if (retainMessages.includes(message) || !message.mes) {
                continue;
            }
            const hash = getStringHash(substituteParams(message.mes));
            if (queryHashes.includes(hash) && !insertedHashes.has(hash)) {
                queriedMessages.push(message);
                insertedHashes.add(hash);
            }
        }

        queriedMessages.sort((a, b) => queryHashes.indexOf(getStringHash(substituteParams(b.mes))) - queryHashes.indexOf(getStringHash(substituteParams(a.mes))));

        for (const message of chat) {
            if (queriedMessages.includes(message)) {
                chat.splice(chat.indexOf(message), 1);
            }
        }

        if (queriedMessages.length === 0) {
            console.debug('Vectors: No relevant messages found');
            return;
        }

        const insertedText = getPromptText(queriedMessages);
        setExtensionPrompt(EXTENSION_PROMPT_TAG, insertedText, settings.position, settings.depth, settings.include_wi);
    } catch (error) {
        toastr.error('Generation interceptor aborted. Check browser console for more details.', 'Vector Storage');
        console.error('Vectors: Failed to rearrange chat', error);
    }
}

function getPromptText(queriedMessages) {
    const queriedText = queriedMessages.map(x => collapseNewlines(`${x.name}: ${x.mes}`).trim()).join('\n\n');
    console.log('Vectors: relevant past messages found.\n', queriedText);
    return substituteParamsExtended(settings.template, { text: queriedText });
}

function overlapChunks(chunk, index, chunks, overlapSize) {
    const halfOverlap = Math.floor(overlapSize / 2);
    const nextChunk = chunks[index + 1];
    const prevChunk = chunks[index - 1];

    const nextOverlap = trimToEndSentence(nextChunk?.substring(0, halfOverlap)) || '';
    const prevOverlap = trimToStartSentence(prevChunk?.substring(prevChunk.length - halfOverlap)) || '';
    const overlappedChunk = [prevOverlap, chunk, nextOverlap].filter(x => x).join(' ');

    return overlappedChunk;
}

globalThis.vectors_rearrangeChat = rearrangeChat;

const onChatEvent = debounce(async () => await moduleWorker.update(), debounce_timeout.relaxed);

async function getQueryText(chat, initiator) {
    const getTextWithoutAttachments = (x) => {
        const fileLength = x?.extra?.fileLength || 0;
        return String(x?.mes || '').substring(fileLength).trim();
    };

    let hashedMessages = chat
        .map(x => ({ text: substituteParams(getTextWithoutAttachments(x)), hash: getStringHash(substituteParams(getTextWithoutAttachments(x))), index: chat.indexOf(x) }))
        .filter(x => x.text)
        .reverse()
        .slice(0, settings.query);

    if (initiator === 'chat' && settings.enabled_chats && settings.summarize && settings.summarize_sent) {
        const minLength = Math.max(0, Number(settings.summary_threshold) || 0);
        const toSummarize = minLength > 0 ? hashedMessages.filter(x => x.text.length >= minLength) : hashedMessages;
        if (toSummarize.length > 0) {
            await summarize(toSummarize, settings.summary_source, { skipOnFailure: true });
        }
    }

    const queryText = hashedMessages.map(x => x.text).join('\n');

    return collapseNewlines(queryText).trim();
}

// ---------------------------------------------------------------------------
// Vector backend wrappers — all delegate to EmbeddingService.
// Special handling for client-side embedding sources (webllm, koboldcpp).
// ---------------------------------------------------------------------------

async function buildClientSideExtraBody(profile, items) {
    if (!profile) return null;
    if (profile.source === 'webllm') {
        const embeddings = await createWebLlmEmbeddings(items);
        return embeddings ? { embeddings } : null;
    }
    if (profile.source === 'koboldcpp') {
        const result = await createKoboldCppEmbeddings(items, profile);
        return { embeddings: result.embeddings, model: result.model };
    }
    return null;
}

async function createWebLlmEmbeddings(items) {
    if (!Array.isArray(items) || items.length === 0) {
        return /** @type {Record<string, number[]>} */ ({});
    }
    const profile = getActiveEmbedProfile();
    if (!profile || profile.source !== 'webllm' || !profile.model) {
        throw new Error('WebLLM is not supported', { cause: 'webllm_not_supported' });
    }
    try {
        const embeddings = await webllmProvider.embedTexts(items, profile.model);
        const result = /** @type {Record<string, number[]>} */ ({});
        for (let i = 0; i < items.length; i++) {
            result[items[i]] = embeddings[i];
        }
        return result;
    } catch (error) {
        console.error('Vectors: Failed to compute WebLLM embeddings', error);
        switch (error?.cause) {
            case 'webllm-not-available':
                toastr.warning('WebLLM is not available. Please install the extension.', 'WebLLM not installed');
                break;
            case 'webllm-not-updated':
                toastr.warning('The installed extension version does not support embeddings.', 'WebLLM update required');
                break;
        }
        throw new Error('WebLLM is not supported', { cause: 'webllm_not_supported' });
    }
}

async function createKoboldCppEmbeddings(items, profile) {
    const server = String(profile?.['api-url'] || '').trim();
    if (!server) {
        throw new Error('KoboldCpp URL missing', { cause: 'api_url_missing' });
    }
    const response = await fetch('/api/backends/kobold/embed', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ items: items, server }),
    });

    if (!response.ok) {
        throw new Error('Failed to get KoboldCpp embeddings');
    }

    const data = await response.json();
    if (!Array.isArray(data.embeddings) || !data.model || data.embeddings.length !== items.length) {
        throw new Error('Invalid response from KoboldCpp embeddings');
    }

    const embeddings = /** @type {Record<string, number[]>} */ ({});
    for (let i = 0; i < data.embeddings.length; i++) {
        if (!Array.isArray(data.embeddings[i]) || data.embeddings[i].length === 0) {
            throw new Error('KoboldCpp returned an empty embedding. Reduce the chunk size and/or size threshold and try again.');
        }
        embeddings[items[i]] = data.embeddings[i];
    }

    return { embeddings, model: data.model };
}

async function getSavedHashes(collectionId) {
    const profile = getActiveEmbedProfile();
    if (!profile) return [];
    return await EmbeddingService.listHashes({ profile, collectionId });
}

async function insertVectorItems(collectionId, items) {
    const profile = throwIfEmbeddingProfileMissing();
    const extraBody = await buildClientSideExtraBody(profile, items.map(x => x.text));
    await EmbeddingService.insert({ profile, collectionId, items, extraBody });
}

async function deleteVectorItems(collectionId, hashes) {
    const profile = getActiveEmbedProfile();
    if (!profile) return;
    await EmbeddingService.deleteByHashes({ profile, collectionId, hashes });
}

async function queryCollection(collectionId, searchText, topK) {
    const profile = throwIfEmbeddingProfileMissing();
    const retrieveK = settings.rerank_enabled ? Math.max(topK * 4, 20) : topK;
    const extraBody = await buildClientSideExtraBody(profile, [searchText]);
    const result = await EmbeddingService.query({
        profile,
        collectionId,
        searchText,
        topK: retrieveK,
        threshold: settings.score_threshold,
        extraBody,
    });

    if (settings.rerank_enabled && result.metadata?.length > 0) {
        const reranked = await rerankResults(searchText, result.metadata, topK);
        return {
            hashes: reranked.map(m => Number(m.hash)),
            metadata: reranked,
        };
    }

    return result;
}

async function queryMultipleCollections(collectionIds, searchText, topK, threshold) {
    const profile = throwIfEmbeddingProfileMissing();
    const retrieveK = settings.rerank_enabled ? Math.max(topK * 4, 20) : topK;
    const extraBody = await buildClientSideExtraBody(profile, [searchText]);
    const result = await EmbeddingService.queryMulti({
        profile,
        collectionIds,
        searchText,
        topK: retrieveK,
        threshold: threshold ?? settings.score_threshold,
        extraBody,
    });

    if (settings.rerank_enabled) {
        const allDocs = [];
        for (const [collId, data] of Object.entries(result)) {
            for (const meta of data.metadata) {
                allDocs.push({ ...meta, _collectionId: collId });
            }
        }

        if (allDocs.length > 0) {
            const reranked = await rerankResults(searchText, allDocs, topK);

            const grouped = {};
            for (const doc of reranked) {
                const collId = doc._collectionId;
                delete doc._collectionId;
                if (!grouped[collId]) {
                    grouped[collId] = { hashes: [], metadata: [] };
                }
                grouped[collId].hashes.push(Number(doc.hash));
                grouped[collId].metadata.push(doc);
            }
            return grouped;
        }
    }

    return result;
}

async function rerankResults(queryText, metadata, topK) {
    if (!settings.rerank_enabled || !metadata || metadata.length === 0) {
        return metadata;
    }
    const profile = getActiveRerankProfile();
    if (!profile) {
        console.warn('Vectors: Rerank enabled but no rerank profile selected — falling back.');
        return metadata.slice(0, topK);
    }
    try {
        const reranked = await EmbeddingService.rerank({ profile, query: queryText, documents: metadata, topK });
        console.log(`Vectors: Reranked ${metadata.length} candidates to ${reranked.length} results`);
        return reranked;
    } catch (error) {
        console.error('Vectors: Rerank error, falling back to original order:', error);
        return metadata.slice(0, topK);
    }
}

async function purgeFileVectorIndex(fileUrl) {
    try {
        if (!settings.enabled_files) {
            return;
        }

        console.log(`Vectors: Purging file vector index for ${fileUrl}`);
        const collectionId = getFileCollectionId(fileUrl);
        await EmbeddingService.purgeCollection({ collectionId });
        console.log(`Vectors: Purged vector index for collection ${collectionId}`);
    } catch (error) {
        console.error('Vectors: Failed to purge file', error);
    }
}

async function purgeVectorIndex(collectionId) {
    try {
        if (!settings.enabled_chats) {
            return true;
        }
        await EmbeddingService.purgeCollection({ collectionId });
        console.log(`Vectors: Purged vector index for collection ${collectionId}`);
        return true;
    } catch (error) {
        console.error('Vectors: Failed to purge', error);
        return false;
    }
}

async function purgeAllVectorIndexes() {
    try {
        const response = await fetch('/api/vector/purge-all', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });

        if (!response.ok) {
            throw new Error('Failed to purge all vector indexes');
        }

        console.log('Vectors: Purged all vector indexes');
        toastr.success('All vector indexes purged', 'Purge successful');
    } catch (error) {
        console.error('Vectors: Failed to purge all', error);
        toastr.error('Failed to purge all vector indexes', 'Purge failed');
    }
}

// ---------------------------------------------------------------------------
// Migration of legacy `extension_settings.vectors.*` fields into shared profiles.
// ---------------------------------------------------------------------------

function makeUniqueProfileName(prefix) {
    const existing = new Set([
        ...listEmbeddingProfiles().map(p => p.name),
        ...listRerankProfiles().map(p => p.name),
    ]);
    if (!existing.has(prefix)) return prefix;
    let i = 2;
    while (existing.has(`${prefix} ${i}`)) i += 1;
    return `${prefix} ${i}`;
}

const VECTOR_EXT_LEGACY_MODEL_KEYS = {
    openai: 'openai_model',
    electronhub: 'electronhub_model',
    openrouter: 'openrouter_model',
    togetherai: 'togetherai_model',
    cohere: 'cohere_model',
    jina: 'jina_model',
    ollama: 'ollama_model',
    vllm: 'vllm_model',
    webllm: 'webllm_model',
    palm: 'google_model',
    vertexai: 'google_model',
    chutes: 'chutes_model',
    nanogpt: 'nanogpt_model',
    siliconflow: 'siliconflow_model',
};

function migrateLegacySettings() {
    const v = extension_settings.vectors;
    if (!v || typeof v !== 'object') return;

    // Already migrated
    if (v.embeddingProfileId) {
        return;
    }
    // Nothing to migrate
    if (!v.source) {
        return;
    }

    const oldSource = String(v.source);
    if (oldSource === 'extras' || oldSource === 'local') {
        // 'extras' was deprecated upstream; treat both as 'transformers' for compat.
        v.source = 'transformers';
    }

    const sourceForProfile = (oldSource === 'extras' || oldSource === 'local') ? 'transformers' : oldSource;

    let model = '';
    const modelKey = VECTOR_EXT_LEGACY_MODEL_KEYS[sourceForProfile];
    if (modelKey) {
        model = String(v[modelKey] || '').trim();
    }
    if (sourceForProfile === 'workers_ai' && !model) {
        model = '@cf/baai/bge-m3';
    }

    const baseName = `${sourceForProfile}${model ? ' ' + model : ''}`.trim() || sourceForProfile;
    const profileName = makeUniqueProfileName(baseName);

    /** @type {any} */
    const profile = {
        id: uuidv4(),
        mode: 'embed',
        name: profileName,
        source: sourceForProfile,
    };
    if (model) profile.model = model;
    if (sourceForProfile === 'jina') {
        if (v.jina_late_chunking) profile['jina-late-chunking'] = 'true';
        if (Number(v.jina_dimensions) > 0) profile['jina-dimensions'] = String(Number(v.jina_dimensions));
    }
    if (sourceForProfile === 'ollama') {
        if (v.ollama_keep) profile['ollama-keep'] = 'true';
    }
    if (sourceForProfile === 'siliconflow' && oai_settings?.siliconflow_endpoint) {
        profile['siliconflow-endpoint'] = String(oai_settings.siliconflow_endpoint);
    }
    if (sourceForProfile === 'workers_ai' && oai_settings?.workers_ai_account_id) {
        profile['workers-ai-account-id'] = String(oai_settings.workers_ai_account_id);
    }
    if (sourceForProfile === 'vertexai') {
        if (oai_settings?.vertexai_region) profile['vertexai-region'] = String(oai_settings.vertexai_region);
        if (oai_settings?.vertexai_auth_mode) profile['vertexai-auth-mode'] = String(oai_settings.vertexai_auth_mode);
        if (oai_settings?.vertexai_express_project_id) profile['vertexai-express-project-id'] = String(oai_settings.vertexai_express_project_id);
    }

    // Local-backend URL: prefer the `alt_endpoint_url` override if it was active,
    // otherwise pick up the textgen default for the matching backend.
    const useAlt = v.use_alt_endpoint && v.alt_endpoint_url;
    const altUrl = useAlt ? String(v.alt_endpoint_url || '').trim() : '';
    const textgenUrls = textgenerationwebui_settings?.server_urls || {};
    const localUrlMap = {
        ollama: textgenUrls?.[textgen_types.OLLAMA] || '',
        llamacpp: textgenUrls?.[textgen_types.LLAMACPP] || '',
        vllm: textgenUrls?.[textgen_types.VLLM] || '',
        koboldcpp: textgenUrls?.[textgen_types.KOBOLDCPP] || '',
    };
    if (Object.hasOwn(localUrlMap, sourceForProfile)) {
        const url = altUrl || String(localUrlMap[sourceForProfile] || '').trim();
        if (url) profile['api-url'] = url;
    }

    const stored = upsertEmbeddingProfile(profile);
    if (stored) {
        v.embeddingProfileId = stored.id;
    }

    // Rerank
    if (v.rerank_enabled && v.rerank_source) {
        const rerankBase = `${v.rerank_source} rerank${v.rerank_model ? ' ' + v.rerank_model : ''}`.trim();
        /** @type {any} */
        const rerankProfile = {
            id: uuidv4(),
            mode: 'rerank',
            name: makeUniqueProfileName(rerankBase),
            source: String(v.rerank_source),
        };
        if (v.rerank_model) rerankProfile.model = String(v.rerank_model);
        if (v.rerank_source === 'custom') {
            if (v.rerank_api_url) rerankProfile['api-url'] = String(v.rerank_api_url);
            if (v.rerank_api_key) rerankProfile['proxy-password'] = String(v.rerank_api_key);
        }
        const storedRerank = upsertRerankProfile(rerankProfile);
        if (storedRerank) {
            v.rerankProfileId = storedRerank.id;
        }
    }

    saveSettingsDebounced();
    console.log('Vectors: Migrated legacy settings into Connection Manager profiles', {
        embeddingProfileId: v.embeddingProfileId,
        rerankProfileId: v.rerankProfileId,
    });
}

// ---------------------------------------------------------------------------
// UI handlers — Vectorize/Purge/Stats buttons & profile picker controls.
// ---------------------------------------------------------------------------

async function onPurgeClick() {
    const chatId = getCurrentChatId();
    if (!chatId) {
        toastr.info('No chat selected', 'Purge aborted');
        return;
    }
    if (await purgeVectorIndex(chatId)) {
        toastr.success('Vector index purged', 'Purge successful');
    } else {
        toastr.error('Failed to purge vector index', 'Purge failed');
    }
}

async function onViewStatsClick() {
    const chatId = getCurrentChatId();
    if (!chatId) {
        toastr.info('No chat selected');
        return;
    }

    const hashesInCollection = await getSavedHashes(chatId);
    const totalHashes = hashesInCollection.length;
    const uniqueHashes = hashesInCollection.filter(onlyUnique).length;

    toastr.info(`Total hashes: <b>${totalHashes}</b><br>
    Unique hashes: <b>${uniqueHashes}</b><br><br>
    I'll mark collected messages with a green circle.`,
    `Stats for chat ${escapeHtml(chatId)}`,
    { timeOut: 10000, escapeHtml: false },
    );

    $('#chat .mes.vectorized').removeClass('vectorized');
    const chat = getContext().chat;
    for (const message of chat) {
        if (hashesInCollection.includes(getStringHash(substituteParams(message.mes)))) {
            const messageElement = $(`#chat .mes[mesid="${chat.indexOf(message)}"]`);
            messageElement.addClass('vectorized');
        }
    }
}

async function onVectorizeAllFilesClick() {
    try {
        const dataBank = getDataBankAttachments();
        const chatAttachments = getContext().chat.filter(x => Array.isArray(x.extra?.files)).map(x => x.extra.files).flat();
        const allFiles = [...dataBank, ...chatAttachments];

        function getChunkSize(file) {
            if (chatAttachments.includes(file)) {
                const thresholdLength = settings.size_threshold * 1024;
                return file.size > thresholdLength ? settings.chunk_size : -1;
            }
            if (dataBank.includes(file)) {
                const thresholdLength = settings.size_threshold_db * 1024;
                return file.size > thresholdLength ? settings.chunk_size_db : -1;
            }
            return -1;
        }

        function getOverlapPercent(file) {
            if (chatAttachments.includes(file)) return settings.overlap_percent;
            if (dataBank.includes(file)) return settings.overlap_percent_db;
            return 0;
        }

        let allSuccess = true;

        for (const file of allFiles) {
            const text = await getFileAttachment(file.url);
            const collectionId = getFileCollectionId(file.url);
            const hashes = await getSavedHashes(collectionId);

            if (hashes.length) {
                console.log(`Vectors: File ${file.name} is already vectorized`);
                continue;
            }

            const chunkSize = getChunkSize(file);
            const overlapPercent = getOverlapPercent(file);
            const result = await vectorizeFile(text, file.name, collectionId, chunkSize, overlapPercent);

            if (!result) {
                allSuccess = false;
            }
        }

        if (allSuccess) {
            toastr.success('All files vectorized', 'Vectorization successful');
        } else {
            toastr.warning('Some files failed to vectorize. Check browser console for more details.', 'Vector Storage');
        }
    } catch (error) {
        console.error('Vectors: Failed to vectorize all files', error);
        toastr.error('Failed to vectorize all files', 'Vectorization failed');
    }
}

async function onPurgeFilesClick() {
    try {
        const dataBank = getDataBankAttachments();
        const chatAttachments = getContext().chat.filter(x => Array.isArray(x.extra?.files)).map(x => x.extra.files).flat();
        const allFiles = [...dataBank, ...chatAttachments];

        for (const file of allFiles) {
            await purgeFileVectorIndex(file.url);
        }

        toastr.success('All files purged', 'Purge successful');
    } catch (error) {
        console.error('Vectors: Failed to purge all files', error);
        toastr.error('Failed to purge all files', 'Purge failed');
    }
}

async function activateWorldInfo(chat) {
    if (!settings.enabled_world_info) {
        console.debug('Vectors: Disabled for World Info');
        return;
    }

    const entries = await getSortedEntries();

    if (!Array.isArray(entries) || entries.length === 0) {
        console.debug('Vectors: No WI entries found');
        return;
    }

    const groupedEntries = {};

    for (const entry of entries) {
        if (!entry.world) {
            console.debug('Vectors: Skipped orphaned WI entry', entry);
            continue;
        }
        if (entry.disable) continue;
        if (!entry.content) continue;
        if (!entry.vectorized && !settings.enabled_for_all) continue;
        if (!Object.hasOwn(groupedEntries, entry.world)) {
            groupedEntries[entry.world] = [];
        }
        groupedEntries[entry.world].push(entry);
    }

    const collectionIds = [];

    if (Object.keys(groupedEntries).length === 0) {
        console.debug('Vectors: No WI entries to synchronize');
        return;
    }

    for (const world in groupedEntries) {
        const collectionId = `world_${getStringHash(world)}`;
        const hashesInCollection = await getSavedHashes(collectionId);
        const newEntries = groupedEntries[world].filter(x => !hashesInCollection.includes(getStringHash(x.content)));
        const deletedHashes = hashesInCollection.filter(x => !groupedEntries[world].some(y => getStringHash(y.content) === x));

        if (newEntries.length > 0) {
            console.log(`Vectors: Found ${newEntries.length} new WI entries for world ${world}`);
            await insertVectorItems(collectionId, newEntries.map(x => ({ hash: getStringHash(x.content), text: x.content, index: x.uid })));
        }

        if (deletedHashes.length > 0) {
            console.log(`Vectors: Deleted ${deletedHashes.length} old hashes for world ${world}`);
            await deleteVectorItems(collectionId, deletedHashes);
        }

        collectionIds.push(collectionId);
    }

    const queryText = await getQueryText(chat, 'world-info');

    if (queryText.length === 0) {
        console.debug('Vectors: No text to query for WI');
        return;
    }

    const queryResults = await queryMultipleCollections(collectionIds, queryText, settings.max_entries, settings.score_threshold);
    const activatedHashes = Object.values(queryResults).flatMap(x => x.hashes).filter(onlyUnique);
    const activatedEntries = [];

    for (const entry of entries) {
        const hash = getStringHash(entry.content);
        if (activatedHashes.includes(hash)) activatedEntries.push(entry);
    }

    if (activatedEntries.length === 0) {
        console.debug('Vectors: No activated WI entries found');
        return;
    }

    console.log(`Vectors: Activated ${activatedEntries.length} WI entries`, activatedEntries);
    await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, activatedEntries);
}

// ---------------------------------------------------------------------------
// Profile picker UI — embedding & rerank.
// ---------------------------------------------------------------------------

function refreshEmbeddingProfileSelect() {
    const sel = /** @type {HTMLSelectElement} */ (document.getElementById('vectors_embedding_profile'));
    if (!sel) return;
    renderProfileSelect(sel, 'embed', settings.embeddingProfileId || '');
    // Sync persisted id with what the dropdown actually shows; the underlying
    // profile may have been deleted from the Connection Profile drawer.
    const actual = String(sel.value || '');
    if (actual !== (settings.embeddingProfileId || '')) {
        settings.embeddingProfileId = actual;
        persistSettings();
    }
    updateProfileButtonStates();
}

function refreshRerankProfileSelect() {
    const sel = /** @type {HTMLSelectElement} */ (document.getElementById('vectors_rerank_profile'));
    if (!sel) return;
    renderProfileSelect(sel, 'rerank', settings.rerankProfileId || '');
    const actual = String(sel.value || '');
    if (actual !== (settings.rerankProfileId || '')) {
        settings.rerankProfileId = actual;
        persistSettings();
    }
    updateProfileButtonStates();
}

function updateProfileButtonStates() {
    $('#vectors_rerank_settings').toggle(!!settings.rerank_enabled);
}

function persistSettings() {
    Object.assign(extension_settings.vectors, settings);
    saveSettingsDebounced();
}

function toggleSectionVisibility() {
    $('#vectors_files_settings').toggle(!!settings.enabled_files);
    $('#vectors_chats_settings').toggle(!!settings.enabled_chats);
    $('#vectors_world_info_settings').toggle(!!settings.enabled_world_info);
}

export async function init() {
    if (!extension_settings.vectors) {
        extension_settings.vectors = structuredClone(settings);
    }

    // Legacy field migration: 'enabled' → 'enabled_chats'.
    if (extension_settings.vectors.enabled) {
        extension_settings.vectors.enabled_chats = true;
    }

    // Move legacy single-source/model state into a shared embedding profile.
    migrateLegacySettings();

    Object.assign(settings, extension_settings.vectors);

    // Coerce removed/renamed sources, just in case the migration runs again.
    if (settings.summary_source === 'extras') settings.summary_source = 'main';

    const template = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    $('#vectors_container').append(template);

    // -- Embedding profile picker --
    refreshEmbeddingProfileSelect();
    $('#vectors_embedding_profile').on('change', () => {
        settings.embeddingProfileId = String($('#vectors_embedding_profile').val() || '');
        persistSettings();
        updateProfileButtonStates();
    });

    // -- Rerank profile picker --
    refreshRerankProfileSelect();
    $('#vectors_rerank_profile').on('change', () => {
        settings.rerankProfileId = String($('#vectors_rerank_profile').val() || '');
        persistSettings();
        updateProfileButtonStates();
    });

    // Refresh dropdowns when profiles are CRUD'd from any source.
    [event_types.CONNECTION_PROFILE_CREATED, event_types.CONNECTION_PROFILE_UPDATED, event_types.CONNECTION_PROFILE_DELETED].forEach(evt => {
        eventSource.on(evt, () => {
            refreshEmbeddingProfileSelect();
            refreshRerankProfileSelect();
        });
    });

    // -- Business policy controls --
    $('#vectors_enabled_chats').prop('checked', settings.enabled_chats).on('input', () => {
        settings.enabled_chats = $('#vectors_enabled_chats').prop('checked');
        persistSettings();
        toggleSectionVisibility();
    });
    $('#vectors_keep_hidden').prop('checked', settings.keep_hidden).on('input', () => {
        settings.keep_hidden = !!$('#vectors_keep_hidden').prop('checked');
        persistSettings();
    });
    $('#vectors_enabled_files').prop('checked', settings.enabled_files).on('input', () => {
        settings.enabled_files = $('#vectors_enabled_files').prop('checked');
        persistSettings();
        toggleSectionVisibility();
    });

    $('#vectors_template').val(settings.template).on('input', () => {
        settings.template = String($('#vectors_template').val());
        persistSettings();
    });
    $('#vectors_depth').val(settings.depth).on('input', () => {
        settings.depth = Number($('#vectors_depth').val());
        persistSettings();
    });
    $('#vectors_protect').val(settings.protect).on('input', () => {
        settings.protect = Number($('#vectors_protect').val());
        persistSettings();
    });
    $('#vectors_insert').val(settings.insert).on('input', () => {
        settings.insert = Number($('#vectors_insert').val());
        persistSettings();
    });
    $('#vectors_query').val(settings.query).on('input', () => {
        settings.query = Number($('#vectors_query').val());
        persistSettings();
    });
    $(`input[name="vectors_position"][value="${settings.position}"]`).prop('checked', true);
    $('input[name="vectors_position"]').on('change', () => {
        settings.position = Number($('input[name="vectors_position"]:checked').val());
        persistSettings();
    });
    $('#vectors_vectorize_all').on('click', onVectorizeAllClick);
    $('#vectors_purge').on('click', onPurgeClick);
    $('#vectors_view_stats').on('click', onViewStatsClick);
    $('#vectors_files_vectorize_all').on('click', onVectorizeAllFilesClick);
    $('#vectors_files_purge').on('click', onPurgeFilesClick);

    $('#vectors_size_threshold').val(settings.size_threshold).on('input', () => {
        settings.size_threshold = Number($('#vectors_size_threshold').val());
        persistSettings();
    });
    $('#vectors_chunk_size').val(settings.chunk_size).on('input', () => {
        settings.chunk_size = Number($('#vectors_chunk_size').val());
        persistSettings();
    });
    $('#vectors_chunk_count').val(settings.chunk_count).on('input', () => {
        settings.chunk_count = Number($('#vectors_chunk_count').val());
        persistSettings();
    });
    $('#vectors_include_wi').prop('checked', settings.include_wi).on('input', () => {
        settings.include_wi = !!$('#vectors_include_wi').prop('checked');
        persistSettings();
    });
    $('#vectors_summarize').prop('checked', settings.summarize).on('input', () => {
        settings.summarize = !!$('#vectors_summarize').prop('checked');
        persistSettings();
    });
    $('#vectors_summarize_user').prop('checked', settings.summarize_sent).on('input', () => {
        settings.summarize_sent = !!$('#vectors_summarize_user').prop('checked');
        persistSettings();
    });
    $('#vectors_summary_source').val(settings.summary_source).on('change', () => {
        settings.summary_source = String($('#vectors_summary_source').val());
        persistSettings();
    });
    $('#vectors_summary_prompt').val(settings.summary_prompt).on('input', () => {
        settings.summary_prompt = String($('#vectors_summary_prompt').val());
        persistSettings();
    });
    $('#vectors_summary_retries').val(settings.summary_retries).on('input', () => {
        const parsed = Number($('#vectors_summary_retries').val());
        settings.summary_retries = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
        persistSettings();
    });
    $('#vectors_summary_threshold').val(settings.summary_threshold).on('input', () => {
        const parsed = Number($('#vectors_summary_threshold').val());
        settings.summary_threshold = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
        persistSettings();
    });
    $('#vectors_message_chunk_size').val(settings.message_chunk_size).on('input', () => {
        settings.message_chunk_size = Number($('#vectors_message_chunk_size').val());
        persistSettings();
    });
    $('#vectors_size_threshold_db').val(settings.size_threshold_db).on('input', () => {
        settings.size_threshold_db = Number($('#vectors_size_threshold_db').val());
        persistSettings();
    });
    $('#vectors_chunk_size_db').val(settings.chunk_size_db).on('input', () => {
        settings.chunk_size_db = Number($('#vectors_chunk_size_db').val());
        persistSettings();
    });
    $('#vectors_chunk_count_db').val(settings.chunk_count_db).on('input', () => {
        settings.chunk_count_db = Number($('#vectors_chunk_count_db').val());
        persistSettings();
    });
    $('#vectors_overlap_percent').val(settings.overlap_percent).on('input', () => {
        settings.overlap_percent = Number($('#vectors_overlap_percent').val());
        persistSettings();
    });
    $('#vectors_overlap_percent_db').val(settings.overlap_percent_db).on('input', () => {
        settings.overlap_percent_db = Number($('#vectors_overlap_percent_db').val());
        persistSettings();
    });
    $('#vectors_file_template_db').val(settings.file_template_db).on('input', () => {
        settings.file_template_db = String($('#vectors_file_template_db').val());
        persistSettings();
    });
    $(`input[name="vectors_file_position_db"][value="${settings.file_position_db}"]`).prop('checked', true);
    $('input[name="vectors_file_position_db"]').on('change', () => {
        settings.file_position_db = Number($('input[name="vectors_file_position_db"]:checked').val());
        persistSettings();
    });
    $('#vectors_file_depth_db').val(settings.file_depth_db).on('input', () => {
        settings.file_depth_db = Number($('#vectors_file_depth_db').val());
        persistSettings();
    });
    $('#vectors_file_depth_role_db').val(settings.file_depth_role_db).on('input', () => {
        settings.file_depth_role_db = Number($('#vectors_file_depth_role_db').val());
        persistSettings();
    });
    $('#vectors_translate_files').prop('checked', settings.translate_files).on('input', () => {
        settings.translate_files = !!$('#vectors_translate_files').prop('checked');
        persistSettings();
    });
    $('#vectors_enabled_world_info').prop('checked', settings.enabled_world_info).on('input', () => {
        settings.enabled_world_info = !!$('#vectors_enabled_world_info').prop('checked');
        persistSettings();
        toggleSectionVisibility();
    });
    $('#vectors_enabled_for_all').prop('checked', settings.enabled_for_all).on('input', () => {
        settings.enabled_for_all = !!$('#vectors_enabled_for_all').prop('checked');
        persistSettings();
    });
    $('#vectors_max_entries').val(settings.max_entries).on('input', () => {
        settings.max_entries = Number($('#vectors_max_entries').val());
        persistSettings();
    });
    $('#vectors_score_threshold').val(settings.score_threshold).on('input', () => {
        settings.score_threshold = Number($('#vectors_score_threshold').val());
        persistSettings();
    });
    $('#vectors_force_chunk_delimiter').val(settings.force_chunk_delimiter).on('input', () => {
        settings.force_chunk_delimiter = String($('#vectors_force_chunk_delimiter').val());
        persistSettings();
    });
    $('#vectors_only_custom_boundary').prop('checked', settings.only_custom_boundary).on('input', () => {
        settings.only_custom_boundary = !!$('#vectors_only_custom_boundary').prop('checked');
        persistSettings();
    });
    $('#vectors_rerank_enabled').prop('checked', settings.rerank_enabled).on('input', () => {
        settings.rerank_enabled = !!$('#vectors_rerank_enabled').prop('checked');
        persistSettings();
        updateProfileButtonStates();
    });

    toggleSectionVisibility();
    updateProfileButtonStates();

    eventSource.on(event_types.MESSAGE_DELETED, onChatEvent);
    eventSource.on(event_types.MESSAGE_EDITED, onChatEvent);
    eventSource.on(event_types.MESSAGE_SENT, onChatEvent);
    eventSource.on(event_types.MESSAGE_RECEIVED, onChatEvent);
    eventSource.on(event_types.MESSAGE_SWIPED, onChatEvent);
    eventSource.on(event_types.CHAT_DELETED, purgeVectorIndex);
    eventSource.on(event_types.GROUP_CHAT_DELETED, purgeVectorIndex);
    eventSource.on(event_types.FILE_ATTACHMENT_DELETED, purgeFileVectorIndex);

    // ---- Slash commands -----
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'db-ingest',
        callback: async () => {
            await ingestDataBankAttachments();
            return '';
        },
        aliases: ['databank-ingest', 'data-bank-ingest'],
        helpString: 'Force the ingestion of all Data Bank attachments.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'db-purge',
        callback: async () => {
            const dataBank = getDataBankAttachments();
            for (const file of dataBank) {
                await purgeFileVectorIndex(file.url);
            }
            return '';
        },
        aliases: ['databank-purge', 'data-bank-purge'],
        helpString: 'Purge the vector index for all Data Bank attachments.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'db-search',
        callback: async (args, query) => {
            const clamp = (v) => Number.isNaN(v) ? null : Math.min(1, Math.max(0, v));
            const threshold = clamp(Number(args?.threshold ?? settings.score_threshold));
            const validateCount = (v) => Number.isNaN(v) || !Number.isInteger(v) || v < 1 ? null : v;
            const count = validateCount(Number(args?.count)) ?? settings.chunk_count_db;
            const source = String(args?.source ?? '');
            const attachments = source ? getDataBankAttachmentsForSource(source, false) : getDataBankAttachments(false);
            const collectionIds = await ingestDataBankAttachments(String(source));
            const queryResults = await queryMultipleCollections(collectionIds, String(query), count, threshold);

            const urls = Object
                .keys(queryResults)
                .map(x => attachments.find(y => getFileCollectionId(y.url) === x))
                .filter(x => x)
                .map(x => x.url);

            const getChunksText = () => {
                let textResult = '';
                for (const collectionId in queryResults) {
                    const metadata = queryResults[collectionId].metadata?.filter(x => x.text)?.sort((a, b) => a.index - b.index)?.map(x => x.text)?.filter(onlyUnique) || [];
                    textResult += metadata.join('\n') + '\n\n';
                }
                return textResult;
            };
            if (args.return === 'chunks') {
                return getChunksText();
            }

            // @ts-ignore
            return slashCommandReturnHelper.doReturn(args.return ?? 'object', urls, { objectToStringFunc: list => list.join('\n') });
        },
        aliases: ['databank-search', 'data-bank-search'],
        helpString: 'Search the Data Bank for a specific query using vector similarity. Returns a list of file URLs with the most relevant content.',
        namedArgumentList: [
            new SlashCommandNamedArgument('threshold', 'Threshold for the similarity score in the [0, 1] range. Uses the global config value if not set.', ARGUMENT_TYPE.NUMBER, false, false, ''),
            new SlashCommandNamedArgument('count', 'Maximum number of query results to return.', ARGUMENT_TYPE.NUMBER, false, false, ''),
            new SlashCommandNamedArgument('source', 'Optional filter for the attachments by source.', ARGUMENT_TYPE.STRING, false, false, '', ['global', 'character', 'chat']),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: 'How you want the return value to be provided',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'object',
                enumList: [
                    new SlashCommandEnumValue('chunks', 'Return the actual content chunks', enumTypes.enum, '{}'),
                    ...slashCommandReturnHelper.enumList({ allowObject: true }),
                ],
                forceEnum: true,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('Query to search by.', ARGUMENT_TYPE.STRING, true, false),
        ],
        returns: ARGUMENT_TYPE.LIST,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'vector-threshold',
        helpString: 'Set the vector score threshold or return the current threshold if no argument is provided.',
        returns: 'score threshold value',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Score threshold (number).',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
        ],
        callback: async (_args, value) => {
            const raw = String(value ?? '').trim();
            if (!raw) return String(settings.score_threshold);
            const parsed = Number(raw);
            if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
                toastr.warning('Score threshold must be a number between 0 and 1.');
                return '';
            }
            $('#vectors_score_threshold').val(parsed).trigger('input');
            return String(settings.score_threshold);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'vector-query',
        helpString: 'Set the vector query messages or returns the current query messages count if no argument is provided',
        returns: 'the query messages value',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Query messages (number > 0).',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
        ],
        callback: async (_args, value) => {
            const raw = String(value ?? '').trim();
            if (!raw) return String(settings.query);
            const parsed = Number(raw);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                toastr.warning('Query messages must be a number greater than 0.');
                return '';
            }
            $('#vectors_query').val(parsed).trigger('input');
            return String(settings.query);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'vector-max-entries',
        helpString: 'Set the vector world info max entries or returns the current max entries if no argument is provided',
        returns: 'world info max entries',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Max entries (number > 0).',
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
        ],
        callback: async (_args, value) => {
            const raw = String(value ?? '').trim();
            if (!raw) return String(settings.max_entries);
            const parsed = Number(raw);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                toastr.warning('Max entries must be a number greater than 0.');
                return '';
            }
            $('#vectors_max_entries').val(parsed).trigger('input');
            return String(settings.max_entries);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'vector-chats-state',
        helpString: 'Set whether chat vectorization is enabled or return the current boolean if no argument is provided',
        returns: 'boolean for if chat vectorization is enabled',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'boolean to set whether chat vectorization is enabled',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        callback: async (_args, value) => {
            const raw = String(value ?? '').trim();
            if (!raw) return String(settings.enabled_chats);
            const parsed = isTrueBoolean(raw);
            $('#vectors_enabled_chats').prop('checked', parsed).trigger('input');
            return String(settings.enabled_chats);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'vector-files-state',
        helpString: 'Set whether file vectorization is enabled or return the current boolean if no argument is provided',
        returns: 'boolean for if file vectorization is enabled',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'boolean to set whether file vectorization is enabled',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        callback: async (_args, value) => {
            const raw = String(value ?? '').trim();
            if (!raw) return String(settings.enabled_files);
            const parsed = isTrueBoolean(raw);
            $('#vectors_enabled_files').prop('checked', parsed).trigger('input');
            return String(settings.enabled_files);
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'vector-worldinfo-state',
        helpString: 'Set whether world info vectorization is enabled or return the current boolean if no argument is provided',
        returns: 'boolean for if world info vectorization is enabled',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'boolean to set whether world info vectorization is enabled',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        callback: async (_args, value) => {
            const raw = String(value ?? '').trim();
            if (!raw) return String(settings.enabled_world_info);
            const parsed = isTrueBoolean(raw);
            $('#vectors_enabled_world_info').prop('checked', parsed).trigger('input');
            return String(settings.enabled_world_info);
        },
    }));

    registerDebugFunction('purge-everything', 'Purge all vector indices', 'Obliterate all stored vectors for all sources. No mercy.', async () => {
        if (!confirm('Are you sure?')) return;
        await purgeAllVectorIndexes();
    });
}
