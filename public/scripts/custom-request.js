import { getPresetManager } from './preset-manager.js';
import { extractJsonFromData, extractMessageFromData, getGenerateUrl, getRequestHeaders, name1, name2 } from '../script.js';
import { getTextGenServer, createTextGenGenerationData, setting_names, textgenerationwebui_settings } from './textgen-settings.js';
import { extractReasoningFromData } from './reasoning.js';
import { formatInstructModeChat, formatInstructModePrompt, getInstructStoppingSequences } from './instruct-mode.js';
import { tryParseStreamingError, createGenerationParameters, isOpenAIConnectionPresetField, settingsToUpdate, oai_settings } from './openai.js';
import { createCompletionServices } from './custom-request-core.js';

export { createCompletionServices };

const { TextCompletionService, ChatCompletionService } = createCompletionServices({
    getPresetManager: (...args) => getPresetManager(...args),
    extractJsonFromData: (...args) => extractJsonFromData(...args),
    extractMessageFromData: (...args) => extractMessageFromData(...args),
    getGenerateUrl: (...args) => getGenerateUrl(...args),
    getRequestHeaders: (...args) => getRequestHeaders(...args),
    getName1: () => name1,
    getName2: () => name2,
    getTextGenServer: (...args) => getTextGenServer(...args),
    createTextGenGenerationData: (...args) => createTextGenGenerationData(...args),
    getTextGenSettingNames: () => setting_names,
    getTextGenSettings: () => textgenerationwebui_settings,
    extractReasoningFromData: (...args) => extractReasoningFromData(...args),
    formatInstructModeChat: (...args) => formatInstructModeChat(...args),
    formatInstructModePrompt: (...args) => formatInstructModePrompt(...args),
    getInstructStoppingSequences: (...args) => getInstructStoppingSequences(...args),
    tryParseStreamingError: (...args) => tryParseStreamingError(...args),
    createGenerationParameters: (...args) => createGenerationParameters(...args),
    isOpenAIConnectionPresetField: (...args) => isOpenAIConnectionPresetField(...args),
    getOpenAISettingsToUpdate: () => settingsToUpdate,
    getOpenAISettings: () => oai_settings,
});

export { TextCompletionService, ChatCompletionService };
