'use strict';

import { DOMPurify } from '../lib.js';

import { event_types, eventSource, is_send_press, main_api, substituteParams } from '../script.js';
import { is_group_generating } from './group-chats.js';
import { Message, MessageCollection, TokenHandler } from './openai.js';
import { power_user } from './power-user.js';
import { debounce, waitUntilCondition, escapeHtml, includesIgnoreCaseAndAccents, resetScrollHeight, toggleDrawer, uuidv4 } from './utils.js';
import { debounce_timeout } from './constants.js';
import { renderTemplateAsync } from './templates.js';
import { Popup } from './popup.js';
import { t } from './i18n.js';
import { showUndoToast } from './undo-toast.js';
import { estimateTotalTokensFromCache } from './util/prompt-token-estimate.js';
import { INJECTION_POSITION, getPromptInjectionPosition } from './prompt-injections.js';

function debouncePromise(func, delay) {
    let timeoutId;

    return (...args) => {
        clearTimeout(timeoutId);

        return new Promise((resolve) => {
            timeoutId = setTimeout(() => {
                const result = func(...args);
                resolve(result);
            }, delay);
        });
    };
}

function buildPromptManagerDragHelper(item) {
    const itemEl = item?.get?.(0) || item?.[0] || item;
    const helper = item?.clone?.() || $(itemEl).clone();
    const width = Math.round(item?.outerWidth?.() || itemEl?.getBoundingClientRect?.().width || 0);
    helper.addClass('prompt-manager-drag-helper');
    helper.css({
        width: width > 0 ? `${width}px` : '',
        'pointer-events': 'none',
        'box-shadow': '0 12px 28px rgba(0, 0, 0, 0.18)',
        opacity: '0.96',
        transform: 'rotate(1deg)',
    });
    return helper;
}

function stylePromptManagerDragPlaceholder(ui) {
    const placeholder = ui?.placeholder;
    if (!placeholder?.length) {
        return;
    }

    placeholder.css({
        height: '4px',
        'min-height': '4px',
        visibility: 'visible',
        border: '0',
        'border-radius': '999px',
        background: 'var(--SmartThemeQuoteColor)',
        opacity: '0.7',
        margin: '8px 0',
    });
}

function setInjectionDepthOrderDisplay(depthBlock, orderBlock, isVisible) {
    const display = isVisible ? '' : 'none';
    depthBlock.style.display = display;
    orderBlock.style.display = display;
}

const DEFAULT_DEPTH = 4;
const DEFAULT_ORDER = 100;
const TOGGLE_UNDO_WINDOW_MS = 6000;
const DETACH_UNDO_WINDOW_MS = 6000;
const PROMPT_PLACEHOLDER_REGEX = /\{\{\s*([^{}\s]+)\s*\}\}/g;
const PROMPT_SEARCH_SCOPES = Object.freeze({
    ALL: 'all',
    NAME: 'name',
    CONTENT: 'content',
    PLACEHOLDER: 'placeholder',
    IDENTIFIER: 'identifier',
    ROLE: 'role',
    SOURCE: 'source',
});
const PROMPT_SEARCH_SCOPE_ALIASES = Object.freeze({
    name: PROMPT_SEARCH_SCOPES.NAME,
    title: PROMPT_SEARCH_SCOPES.NAME,
    content: PROMPT_SEARCH_SCOPES.CONTENT,
    text: PROMPT_SEARCH_SCOPES.CONTENT,
    body: PROMPT_SEARCH_SCOPES.CONTENT,
    placeholder: PROMPT_SEARCH_SCOPES.PLACEHOLDER,
    placeholders: PROMPT_SEARCH_SCOPES.PLACEHOLDER,
    ph: PROMPT_SEARCH_SCOPES.PLACEHOLDER,
    id: PROMPT_SEARCH_SCOPES.IDENTIFIER,
    identifier: PROMPT_SEARCH_SCOPES.IDENTIFIER,
    role: PROMPT_SEARCH_SCOPES.ROLE,
    source: PROMPT_SEARCH_SCOPES.SOURCE,
});

export { INJECTION_POSITION };

/**
 * Register migrations for the prompt manager when settings are loaded or an Open AI preset is loaded.
 */
const registerPromptManagerMigration = () => {
    const migrate = (settings, savePreset = null, presetName = null) => {
        if ('Default' === presetName) return;

        if (settings.main_prompt || settings.nsfw_prompt || settings.jailbreak_prompt) {
            console.log('Running prompt manager configuration migration');
            if (settings.prompts === undefined || settings.prompts.length === 0) settings.prompts = structuredClone(chatCompletionDefaultPrompts.prompts);

            const findPrompt = (identifier) => settings.prompts.find(prompt => identifier === prompt.identifier);
            if (settings.main_prompt) {
                findPrompt('main').content = settings.main_prompt;
                delete settings.main_prompt;
            }

            if (settings.nsfw_prompt) {
                findPrompt('nsfw').content = settings.nsfw_prompt;
                delete settings.nsfw_prompt;
            }

            if (settings.jailbreak_prompt) {
                findPrompt('jailbreak').content = settings.jailbreak_prompt;
                delete settings.jailbreak_prompt;
            }

            if (savePreset && presetName) savePreset(presetName, settings, false);
        }
    };

    eventSource.on(event_types.SETTINGS_LOADED_BEFORE, settings => migrate(settings));
    eventSource.on(event_types.OAI_PRESET_CHANGED_BEFORE, event => migrate(event.preset, event.savePreset, event.presetName));
};

/**
 * Represents a prompt.
 */
class Prompt {
    /**
     * Indicates if the prompt is enabled.
     * @type {boolean}
     */
    enabled;

    /**
     * Unique identifier for the prompt.
     * @type {string}
     */
    identifier;

    /**
     * Role of the prompt, e.g., 'system', 'user', etc.
     * @type {string}
     */
    role;

    /**
     * Content of the prompt.
     * @type {string}
     */
    content;

    /**
     * Display name of the prompt.
     * @type {string}
     */
    name;

    /**
     * Indicates if the prompt is a system prompt.
     * @type {boolean}
     */
    system_prompt;

    /**
     * Position of the prompt in the prompt list.
     * @type {string|number}
     */
    position;

    /**
     * Inject position of the prompt (relative = 0 or in-chat = 1)
     * @type {number}
     */
    injection_position;

    /**
     * Depth of the prompt in the chat.
     * @type {number}
     */
    injection_depth;

    /**
     * Order of the prompt in the chat.
     * @type {number}
     */
    injection_order;

    /**
     * Indicates if the prompt should not be overridden.
     * @type {boolean}
     */
    forbid_overrides;

    /**
     * Prompt is added by an extension.
     * @type {boolean}
     */
    extension;

    /**
     * A list of generation type triggers for the prompt injection.
     * @type {string[]}
     */
    injection_trigger;

    /**
     * Indicates if the prompt is a marker prompt.
     * @type {boolean}
     */
    marker;

    /**
     * Marks this prompt as "extra" for plugin calls. Extra prompts are excluded in plugin preset assembly.
     * @type {boolean}
     */
    plugin_extra;

    /**
     * Create a new Prompt instance.
     *
     * @param {Object} [param0] - Object containing the properties of the prompt.
     * @param {string} [param0.identifier] - The unique identifier of the prompt.
     * @param {string} [param0.role] - The role associated with the prompt.
     * @param {string} [param0.content] - The content of the prompt.
     * @param {string} [param0.name] - The name of the prompt.
     * @param {boolean} [param0.system_prompt] - Indicates if the prompt is a system prompt.
     * @param {string|number} [param0.position] - The position of the prompt in the prompt list.
     * @param {number} [param0.injection_position] - The insert position of the prompt.
     * @param {number} [param0.injection_depth] - The depth of the prompt in the chat.
     * @param {number} [param0.injection_order] - The order of the prompt in the chat.
     * @param {string[]} [param0.injection_trigger] - The generation type trigger for the prompt injection.
     * @param {boolean} [param0.forbid_overrides] - Indicates if the prompt should not be overridden.
     * @param {boolean} [param0.extension] - Prompt is added by an extension.
     * @param {boolean} [param0.plugin_extra] - Exclude this prompt from plugin preset assembly.
     */
    constructor({ identifier, role, content, name, system_prompt, position, injection_depth, injection_position, forbid_overrides, extension, injection_order, injection_trigger, plugin_extra, attach_role, attach_index, attach_side } = {}) {
        this.identifier = identifier;
        this.role = role;
        this.content = content;
        this.name = name;
        this.system_prompt = system_prompt;
        this.position = position;
        this.injection_depth = injection_depth;
        this.injection_position = injection_position;
        this.forbid_overrides = forbid_overrides;
        this.extension = extension ?? false;
        this.injection_order = injection_order ?? DEFAULT_ORDER;
        this.injection_trigger = injection_trigger ?? [];
        this.plugin_extra = Boolean(plugin_extra);
        this.attach_role = attach_role;
        this.attach_index = attach_index;
        this.attach_side = attach_side;
    }
}

/**
 * Representing a collection of prompts.
 */
export class PromptCollection {
    /**
     * List of Prompts in the collection.
     * @type {Prompt[]}
     */
    collection = [];

    /**
     * List of identifiers of prompts that have been overridden.
     * @type {string[]}
     */
    overriddenPrompts = [];

    /**
     * Create a new PromptCollection instance.
     *
     * @param {...Prompt} prompts - An array of Prompt instances.
     */
    constructor(...prompts) {
        this.add(...prompts);
    }

    /**
     * Checks if the provided instances are of the Prompt class.
     *
     * @param {...Prompt} prompts - Instances to check.
     * @throws Will throw an error if one or more instances are not of the Prompt class.
     */
    checkPromptInstance(...prompts) {
        for (let prompt of prompts) {
            if (!(prompt instanceof Prompt)) {
                throw new Error('Only Prompt instances can be added to PromptCollection');
            }
        }
    }

    /**
     * Adds new Prompt instances to the collection.
     *
     * @param {...Prompt} prompts - An array of Prompt instances.
     */
    add(...prompts) {
        this.checkPromptInstance(...prompts);
        this.collection.push(...prompts);
    }

    /**
     * Sets a Prompt instance at a specific position in the collection.
     *
     * @param {Prompt} prompt - The Prompt instance to set.
     * @param {number} position - The position in the collection to set the Prompt instance.
     */
    set(prompt, position) {
        this.checkPromptInstance(prompt);
        this.collection[position] = prompt;
    }

    /**
     * Retrieves a Prompt instance from the collection by its identifier.
     *
     * @param {string} identifier - The identifier of the Prompt instance to retrieve.
     * @returns {Prompt} The Prompt instance with the provided identifier, or undefined if not found.
     */
    get(identifier) {
        return this.collection.find(prompt => prompt.identifier === identifier);
    }

    /**
     * Retrieves the index of a Prompt instance in the collection by its identifier.
     *
     * @param {string} identifier - The identifier of the Prompt instance to find.
     * @returns {number} The index of the Prompt instance in the collection, or -1 if not found.
     */
    index(identifier) {
        return this.collection.findIndex(prompt => prompt.identifier === identifier);
    }

    /**
     * Checks if a Prompt instance exists in the collection by its identifier.
     *
     * @param {string} identifier - The identifier of the Prompt instance to check.
     * @returns {boolean} true if the Prompt instance exists in the collection, false otherwise.
     */
    has(identifier) {
        return this.index(identifier) !== -1;
    }

    /**
     * Overrides a prompt at a specific position in the collection.
     *
     * @param {Prompt} prompt - The Prompt instance to override.
     * @param {number} position - The position in the collection to override the Prompt instance.
     */
    override(prompt, position) {
        this.set(prompt, position);
        this.overriddenPrompts.push(prompt.identifier);
    }
}

class PromptManager {
    get promptSources() {
        return {
            charDescription: t`Character Description`,
            charPersonality: t`Character Personality`,
            scenario: t`Character Scenario`,
            personaDescription: t`Persona Description`,
            worldInfoBefore: t`World Info (↑Char)`,
            worldInfoAfter: t`World Info (↓Char)`,
        };
    }

    constructor() {
        this.systemPrompts = [
            'main',
            'nsfw',
            'jailbreak',
            'enhanceDefinitions',
        ];

        this.overridablePrompts = [
            'main',
            'jailbreak',
        ];

        this.overriddenPrompts = [];

        this.configuration = {
            version: 1,
            prefix: '',
            containerIdentifier: '',
            listIdentifier: '',
            listItemTemplateIdentifier: '',
            toggleDisabled: [],
            promptOrder: {
                strategy: 'global',
                dummyId: 100000,
            },
            sortableDelay: 30,
            warningTokenThreshold: 1500,
            dangerTokenThreshold: 500,
            defaultPrompts: {
                main: '',
                nsfw: '',
                jailbreak: '',
                enhanceDefinitions: '',
            },
        };

        // Chatcompletion configuration object
        this.serviceSettings = null;

        // DOM element containing the prompt manager
        this.containerElement = null;

        // DOM element containing the prompt list
        this.listElement = null;

        // Prompt list filter text
        this.promptListSearchQuery = '';

        // Enables advanced syntax for prompt list search.
        this.promptListSearchAdvancedSyntax = false;

        // Currently selected character
        this.activeCharacter = null;

        // Message collection of the most recent chatcompletion
        this.messages = null;

        // The current token handler instance
        this.tokenHandler = null;

        // Token usage of last dry run
        this.tokenUsage = 0;

        // Error state, contains error message.
        this.error = null;

        // Group edit mode state
        this._groupEditMode = false;
        this._groupEditSelection = null;
        this._groupEditCollapsed = new Set();

        // Batched toggle undo state
        this.toggleUndoBatch = null;
        this.toggleUndoTimer = null;
        this.toggleUndoToast = null;
        this.toggleUndoToastMessage = null;

        // Batched detach undo state
        this.detachUndoBatch = null;
        this.detachUndoTimer = null;
        this.detachUndoToast = null;
        this.detachUndoToastMessage = null;

        /** Dry-run for generate, must return a promise  */
        this.tryGenerate = async () => { };

        /** Called to persist the configuration, must return a promise */
        this.saveServiceSettings = () => { return Promise.resolve(); };

        /** Toggle prompt button click */
        this.handleToggle = () => { };

        /** Toggle plugin-extra marker */
        this.handlePluginExtraToggle = () => { };

        /** Prompt name click */
        this.handleInspect = () => { };

        /** Edit prompt button click */
        this.handleEdit = () => { };

        /** Detach prompt button click */
        this.handleDetach = () => { };

        /** Save prompt button click */
        this.handleSavePrompt = () => { };

        /** Reset prompt button click */
        this.handleResetPrompt = () => { };

        /** New prompt button click */
        this.handleNewPrompt = () => { };

        /** Delete prompt button click */
        this.handleDeletePrompt = () => { };

        /** Append prompt button click */
        this.handleAppendPrompt = () => { };

        /** Import button click */
        this.handleImport = () => { };

        /** Full export click */
        this.handleFullExport = () => { };

        /** Character export click */
        this.handleCharacterExport = () => { };

        /** Character reset button click*/
        this.handleCharacterReset = () => { };

        /** Debounced version of render */
        this.renderDebounced = debounce(this.render.bind(this), debounce_timeout.relaxed);
        this.renderRequestId = 0;
        this.deferredTryGenerateRequestId = 0;
        /**
         * Schedules the dry-run Generate that powers token-count display.
         *
         * Mobile-open-chat traces show this debounced timer firing 4× during a
         * single chat-open burst (events fan out from CHAT_LOADED,
         * OAI_PRESET_CHANGED_AFTER, WORLDINFO_SETTINGS_UPDATED, etc.) and each
         * dry run dumps tens of thousands of microtasks onto the main thread,
         * blocking it for >10s on big presets. Yielding the actual fire to a
         * requestIdleCallback slot lets the chat-open work drain first; the
         * 2s timeout caps additional latency. Mirrors updateTokenDisplayDebounced.
         */
        this.scheduleDeferredTryGenerate = debounce((requestId) => {
            const run = () => { void this.runDeferredTryGenerate(requestId); };
            if (typeof globalThis.requestIdleCallback === 'function') {
                globalThis.requestIdleCallback(run, { timeout: 2000 });
            } else {
                run();
            }
        }, debounce_timeout.standard);

        /**
         * Debounced token-only update (no DOM rebuild).
         *
         * Runs the dry-run Generate (full prompt-assembly pipeline) which is the
         * largest main-thread cost on toggle for big presets. Two layers defer it:
         *   1. 2.5s debounce — coalesces rapid toggle bursts into a single run
         *      after the user pauses.
         *   2. requestIdleCallback (when available) — yields the actual run to a
         *      browser-idle slot; the 2s timeout caps the additional wait.
         */
        this.updateTokenDisplayDebounced = debounce(() => {
            const run = () => this.scheduleTokenUpdate();
            if (typeof globalThis.requestIdleCallback === 'function') {
                globalThis.requestIdleCallback(run, { timeout: 2000 });
            } else {
                run();
            }
        }, 2500);
    }


    /**
     * Initializes the PromptManager with provided configuration and service settings.
     *
     * Sets up various handlers for user interactions, event listeners and initial rendering of prompts.
     * It is also responsible for preparing prompt edit form buttons, managing popup form close and clear actions.
     *
     * @param {Object} moduleConfiguration - Configuration object for the PromptManager.
     * @param {Object} serviceSettings - Service settings object for the PromptManager.
     */
    init(moduleConfiguration, serviceSettings) {
        this.configuration = Object.assign(this.configuration, moduleConfiguration);
        this.tokenHandler = this.tokenHandler || new TokenHandler(() => { throw new Error('Token handler not set'); });
        this.serviceSettings = serviceSettings;
        this.containerElement = document.getElementById(this.configuration.containerIdentifier);

        if ('global' === this.configuration.promptOrder.strategy) this.activeCharacter = { id: this.configuration.promptOrder.dummyId };

        this.sanitizeServiceSettings();

        // Enable and disable prompts
        this.handleToggle = (event) => {
            const promptID = event.target.closest('.' + this.configuration.prefix + 'prompt_manager_prompt').dataset.pmIdentifier;
            const promptOrderEntry = this.getPromptOrderEntry(this.activeCharacter, promptID);
            if (!promptOrderEntry) {
                return;
            }

            const wasEnabled = Boolean(promptOrderEntry.enabled);
            const nowEnabled = !wasEnabled;

            // The prompt's content has not changed, only its enabled flag — so the
            // cached per-prompt token count is still accurate. Preserve it so the
            // immediate header-total estimate below stays close to the real total.
            // The next dry run (via updateTokenDisplayDebounced) will repopulate
            // counts and call updateTokenDisplay to correct any drift.
            promptOrderEntry.enabled = nowEnabled;
            this.enqueueToggleUndo(promptID, wasEnabled, nowEnabled);

            // In-place update: only change the affected <li>, then schedule token refresh
            if (!this.updateToggleInPlace(promptID, nowEnabled)) {
                // Fallback to full render if element not found
                this.render();
            } else {
                this.updateHeaderTotalEstimate();
                this.updateTokenDisplayDebounced();
            }
            this.saveServiceSettings();
        };

        this.handlePluginExtraToggle = (event) => {
            const promptID = event.target.closest('.' + this.configuration.prefix + 'prompt_manager_prompt').dataset.pmIdentifier;
            const current = this.isPromptPluginExtra(promptID);
            const newValue = !current;
            this.setPromptPluginExtra(promptID, newValue);

            // In-place update: only change the affected <li>
            if (!this.updatePluginExtraInPlace(promptID, newValue)) {
                this.render();
            }
            this.saveServiceSettings();
        };

        // Open edit form and load selected prompt
        this.handleEdit = (event) => {
            this.clearEditForm();
            this.clearInspectForm();

            const promptID = event.target.closest('.' + this.configuration.prefix + 'prompt_manager_prompt').dataset.pmIdentifier;
            const prompt = this.getPromptById(promptID);

            this.loadPromptIntoEditForm(prompt);

            this.showPopup();
        };

        // Open edit form and load selected prompt
        this.handleInspect = (event) => {
            this.clearEditForm();
            this.clearInspectForm();

            const promptID = event.target.closest('.' + this.configuration.prefix + 'prompt_manager_prompt').dataset.pmIdentifier;
            if (true === this.messages.hasItemWithIdentifier(promptID)) {
                const messages = this.messages.getItemByIdentifier(promptID);

                this.loadMessagesIntoInspectForm(messages);

                this.showPopup('inspect');
            }
        };

        // Detach selected prompt from list form and close edit form (in-place DOM removal)
        this.handleDetach = (event) => {
            if (null === this.activeCharacter) return;
            const promptID = event.target.closest('.' + this.configuration.prefix + 'prompt_manager_prompt').dataset.pmIdentifier;
            const prompt = this.getPromptById(promptID);
            if (!prompt) {
                return;
            }
            const detached = this.detachPrompt(prompt, this.activeCharacter);
            if (!detached) {
                return;
            }
            this.enqueueDetachUndo(promptID, detached.entry, detached.index);
            this.hidePopup();
            this.clearEditForm();

            // In-place removal: only remove the affected <li>
            if (!this.removePromptItemInPlace(promptID)) {
                this.render();
            } else {
                this.updateTokenDisplayDebounced();
            }
            this.saveServiceSettings();
        };

        // Save prompt edit form to settings and close form.
        this.handleSavePrompt = (event) => {
            const promptId = event.target.dataset.pmPrompt;
            const prompt = this.getPromptById(promptId);
            const isNew = (null === prompt);

            if (isNew) {
                const newPrompt = {};
                this.updatePromptWithPromptEditForm(newPrompt);
                this.addPrompt(newPrompt, promptId);
            } else {
                this.updatePromptWithPromptEditForm(prompt);
            }

            if ('main' === promptId) this.updateQuickEdit('main', prompt || this.getPromptById(promptId));
            if ('nsfw' === promptId) this.updateQuickEdit('nsfw', prompt || this.getPromptById(promptId));
            if ('jailbreak' === promptId) this.updateQuickEdit('jailbreak', prompt || this.getPromptById(promptId));

            this.log('Saved prompt: ' + promptId);

            this.hidePopup();
            this.clearEditForm();

            // In-place update: replace just the affected <li>
            if (!isNew && this.replacePromptItemInPlace(promptId)) {
                this.updateTokenDisplayDebounced();
            } else {
                // New prompt or element not found: full rebuild needed
                this.render();
            }
            this.saveServiceSettings();
        };

        // Reset prompt should it be a system prompt
        this.handleResetPrompt = (event) => {
            const promptId = event.target.dataset.pmPrompt;
            const prompt = this.getPromptById(promptId);
            const isPulledPrompt = Object.keys(this.promptSources).includes(promptId);

            switch (promptId) {
                case 'main':
                    prompt.name = 'Main Prompt';
                    prompt.content = this.configuration.defaultPrompts.main;
                    prompt.forbid_overrides = false;
                    prompt.plugin_extra = false;
                    break;
                case 'nsfw':
                    prompt.name = 'Nsfw Prompt';
                    prompt.content = this.configuration.defaultPrompts.nsfw;
                    prompt.plugin_extra = false;
                    break;
                case 'jailbreak':
                    prompt.name = 'Jailbreak Prompt';
                    prompt.content = this.configuration.defaultPrompts.jailbreak;
                    prompt.forbid_overrides = false;
                    prompt.plugin_extra = false;
                    break;
                case 'enhanceDefinitions':
                    prompt.name = 'Enhance Definitions';
                    prompt.content = this.configuration.defaultPrompts.enhanceDefinitions;
                    prompt.plugin_extra = false;
                    break;
            }

            const nameField = /** @type {HTMLTextAreaElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_name'));
            const roleField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_role'));
            const promptField = /** @type {HTMLTextAreaElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_prompt'));
            const injectionPositionField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_position'));
            const injectionDepthField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_depth'));
            const injectionOrderField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_order'));
            const injectionTriggerField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_trigger'));
            const depthBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_depth_block'));
            const orderBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_order_block'));
            const attachBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_attach_block'));
            const attachRoleField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_attach_role'));
            const attachIndexField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_attach_index'));
            const attachSideField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_attach_side'));
            const forbidOverridesField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_forbid_overrides'));
            const forbidOverridesBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_forbid_overrides_block'));
            const pluginExtraField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_plugin_extra'));
            const entrySourceBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_source_block'));
            const entrySource = /** @type {HTMLSpanElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_source'));

            const injectionPosition = getPromptInjectionPosition(prompt);

            nameField.value = prompt.name;
            if (!CSS.supports('field-sizing', 'content')) {
                void resetScrollHeight(nameField);
            }
            roleField.value = 'system';
            promptField.value = prompt.content ?? '';
            injectionPositionField.value = injectionPosition.toString();
            injectionDepthField.value = (prompt.injection_depth ?? DEFAULT_DEPTH).toString();
            injectionOrderField.value = (prompt.injection_order ?? DEFAULT_ORDER).toString();
            Array.from(injectionTriggerField.options).forEach(option => {
                option.selected = false;
            });
            injectionTriggerField.dispatchEvent(new Event('change', { bubbles: true }));
            setInjectionDepthOrderDisplay(depthBlock, orderBlock, injectionPosition === INJECTION_POSITION.ABSOLUTE);
            attachBlock.style.display = injectionPosition === INJECTION_POSITION.ATTACH_EXISTING ? 'flex' : 'none';
            attachRoleField.value = prompt.attach_role ?? 'user';
            attachIndexField.value = (prompt.attach_index ?? 1).toString();
            attachSideField.value = prompt.attach_side ?? 'end';
            forbidOverridesField.checked = prompt.forbid_overrides ?? false;
            forbidOverridesBlock.style.visibility = this.overridablePrompts.includes(prompt.identifier) ? 'visible' : 'hidden';
            pluginExtraField.checked = Boolean(prompt.plugin_extra);
            promptField.disabled = prompt.marker ?? false;
            entrySourceBlock.style.display = isPulledPrompt ? '' : 'none';

            if (isPulledPrompt) {
                const sourceName = this.promptSources[promptId];
                entrySource.textContent = sourceName;
            }
        };

        // Append prompt to selected character
        this.handleAppendPrompt = (event) => {
            const appendPromptFooter = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_footer_append_prompt'));
            const promptID = appendPromptFooter.value;
            const prompt = this.getPromptById(promptID);

            if (prompt) {
                this.appendPrompt(prompt, this.activeCharacter);
                this.render();
                this.saveServiceSettings();
            }
        };

        // Delete selected prompt from list form and close edit form (in-place DOM removal)
        this.handleDeletePrompt = async () => {
            const userChoice = await Popup.show.confirm(t`Are you sure you want to delete this prompt?`, null);
            if (!userChoice) {
                return;
            }

            const appendPromptFooter = /** @type {HTMLSelectElement|null} */(document.getElementById(this.configuration.prefix + 'prompt_manager_footer_append_prompt'));
            const promptID = appendPromptFooter?.value;
            const prompt = this.getPromptById(promptID);

            if (!prompt || true !== this.isPromptDeletionAllowed(prompt)) {
                return;
            }

            const promptIndex = this.getPromptIndexById(promptID);
            if (!Number.isInteger(promptIndex) || promptIndex < 0) {
                return;
            }

            const promptSnapshot = structuredClone(prompt);
            this.serviceSettings.prompts.splice(promptIndex, 1);

            try {
                this.log('Deleted prompt: ' + prompt.identifier);

                this.hidePopup();
                this.clearEditForm();

                // In-place removal: only remove the affected <li>
                if (!this.removePromptItemInPlace(promptID)) {
                    this.render();
                } else {
                    this.updateTokenDisplayDebounced();
                }
                await this.saveServiceSettings();
            } catch (error) {
                this.serviceSettings.prompts.splice(promptIndex, 0, promptSnapshot);
                this.render();
                console.error('Failed to delete prompt', error);
                toastr.error(t`Failed to delete prompt.`);
                return;
            }

            showUndoToast({
                message: t`Prompt deleted.`,
                onUndo: async () => {
                    try {
                        if (!this.getPromptById(promptSnapshot.identifier)) {
                            const restoreIndex = Math.max(0, Math.min(promptIndex, this.serviceSettings.prompts.length));
                            this.serviceSettings.prompts.splice(restoreIndex, 0, structuredClone(promptSnapshot));
                        }

                        this.log('Restored prompt: ' + promptSnapshot.identifier);
                        this.render();
                        await this.saveServiceSettings();
                    } catch (error) {
                        console.error('Failed to restore deleted prompt', error);
                        toastr.error(t`Failed to restore prompt.`);
                    }
                },
            });
        };

        // Create new prompt, then save it to settings and close form.
        this.handleNewPrompt = (event) => {
            const prompt = {
                identifier: this.getUuidv4(),
                name: '',
                role: 'system',
                content: '',
            };

            this.loadPromptIntoEditForm(prompt);
            this.showPopup();
        };

        // Export all user prompts
        this.handleFullExport = () => {
            const prompts = this.serviceSettings.prompts.reduce((userPrompts, prompt) => {
                if (false === prompt.system_prompt && false === prompt.marker) userPrompts.push(prompt);
                return userPrompts;
            }, []);

            let promptOrder = [];
            if ('global' === this.configuration.promptOrder.strategy) {
                promptOrder = this.getPromptOrderForCharacter({ id: this.configuration.promptOrder.dummyId });
            } else if ('character' === this.configuration.promptOrder.strategy) {
                promptOrder = [];
            } else {
                throw new Error('Prompt order strategy not supported.');
            }

            const exportPrompts = {
                prompts: prompts,
                prompt_order: promptOrder,
            };

            // Include prompt groups if any exist
            const groups = this.getPromptGroups();
            if (groups.length > 0) {
                exportPrompts.extensions = { luker: { prompt_groups: structuredClone(groups) } };
            }

            this.export(exportPrompts, 'full', 'st-prompts');
        };

        // Export user prompts and order for this character
        this.handleCharacterExport = () => {
            const characterPrompts = this.getPromptsForCharacter(this.activeCharacter).reduce((userPrompts, prompt) => {
                if (false === prompt.system_prompt && !prompt.marker) userPrompts.push(prompt);
                return userPrompts;
            }, []);

            const characterList = this.getPromptOrderForCharacter(this.activeCharacter);

            const exportPrompts = {
                prompts: characterPrompts,
                prompt_order: characterList,
            };

            // Include prompt groups if any exist
            const groups = this.getPromptGroups();
            if (groups.length > 0) {
                exportPrompts.extensions = { luker: { prompt_groups: structuredClone(groups) } };
            }

            const name = this.activeCharacter.name + '-prompts';
            this.export(exportPrompts, 'character', name);
        };

        // Import prompts for the selected character
        this.handleImport = () => {
            Popup.show.confirm(t`Existing prompts with the same ID will be overridden. Do you want to proceed?`, null)
                .then(userChoice => {
                    if (!userChoice) return;

                    const fileOpener = document.createElement('input');
                    fileOpener.type = 'file';
                    fileOpener.accept = '.json';

                    fileOpener.addEventListener('change', (event) => {
                        if (!(event.target instanceof HTMLInputElement)) return;
                        const file = event.target.files[0];
                        if (!file) return;

                        const reader = new FileReader();

                        reader.onload = (event) => {
                            const fileContent = event.target.result;

                            try {
                                const data = JSON.parse(fileContent.toString());
                                this.import(data);
                            } catch (err) {
                                toastr.error(t`An error occurred while importing prompts. More info available in console.`);
                                console.log('An error occurred while importing prompts');
                                console.log(err.toString());
                            }
                        };

                        reader.readAsText(file);
                    });

                    fileOpener.click();
                });
        };

        // Restore default state of a characters prompt order
        this.handleCharacterReset = () => {
            Popup.show.confirm(t`This will reset the prompt order for this character. You will not lose any prompts.`, null)
                .then(userChoice => {
                    if (!userChoice) return;

                    this.removePromptOrderForCharacter(this.activeCharacter);
                    this.addPromptOrderForCharacter(this.activeCharacter, promptManagerDefaultPromptOrder);

                    this.render();
                    this.saveServiceSettings();
                });
        };

        // Fill quick edit fields for the first time
        if ('global' === this.configuration.promptOrder.strategy) {
            const handleQuickEditSave = (event) => {
                const promptId = event.target.dataset.pmPrompt;
                const prompt = this.getPromptById(promptId);

                prompt.content = event.target.value;

                // Update edit form if present
                // @see https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/offsetParent
                const popupEditFormPrompt = /** @type {HTMLTextAreaElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_prompt'));
                if (popupEditFormPrompt.offsetParent) {
                    popupEditFormPrompt.value = prompt.content;
                }

                this.log('Saved prompt: ' + promptId);
                // In-place update: replace just the affected <li>, then refresh tokens
                this.saveServiceSettings().then(() => {
                    if (!this.replacePromptItemInPlace(promptId)) {
                        this.render();
                    } else {
                        this.updateTokenDisplayDebounced();
                    }
                });
            };

            const mainPrompt = this.getPromptById('main');
            const mainElementId = this.updateQuickEdit('main', mainPrompt);
            document.getElementById(mainElementId).addEventListener('blur', handleQuickEditSave);

            const nsfwPrompt = this.getPromptById('nsfw');
            const nsfwElementId = this.updateQuickEdit('nsfw', nsfwPrompt);
            document.getElementById(nsfwElementId).addEventListener('blur', handleQuickEditSave);

            const jailbreakPrompt = this.getPromptById('jailbreak');
            const jailbreakElementId = this.updateQuickEdit('jailbreak', jailbreakPrompt);
            document.getElementById(jailbreakElementId).addEventListener('blur', handleQuickEditSave);
        }

        // Update token counts when chat history changes (no DOM rebuild needed).
        eventSource.on(event_types.MESSAGE_DELETED, () => this.updateTokenDisplayDebounced());
        eventSource.on(event_types.MESSAGE_EDITED, () => this.updateTokenDisplayDebounced());
        eventSource.on(event_types.MESSAGE_RECEIVED, () => this.updateTokenDisplayDebounced());

        // Re-render when chatcompletion settings change
        eventSource.on(event_types.CHATCOMPLETION_SOURCE_CHANGED, () => this.renderDebounced());

        eventSource.on(event_types.CHATCOMPLETION_MODEL_CHANGED, () => this.renderDebounced());

        // Re-render when the character changes.
        eventSource.on(event_types.CHAT_LOADED, (event) => {
            this.handleCharacterSelected(event);
            this.saveServiceSettings().then(() => this.renderDebounced());
        });

        // Re-render when the character gets edited.
        eventSource.on(event_types.CHARACTER_EDITED, (event) => {
            this.handleCharacterUpdated(event);
            this.saveServiceSettings().then(() => this.renderDebounced());
        });

        // Re-render when the group changes.
        eventSource.on('groupSelected', (event) => {
            this.handleGroupSelected(event);
            this.saveServiceSettings().then(() => this.renderDebounced());
        });

        // Sanitize settings after character has been deleted.
        eventSource.on(event_types.CHARACTER_DELETED, (event) => {
            this.handleCharacterDeleted(event);
            this.saveServiceSettings().then(() => this.renderDebounced());
        });

        // Trigger re-render when token settings are changed
        document.getElementById('openai_max_context').addEventListener('change', (event) => {
            if (!(event.target instanceof HTMLInputElement)) return;
            this.serviceSettings.openai_max_context = event.target.value;
            if (this.activeCharacter) this.renderDebounced();
        });

        document.getElementById('openai_max_tokens').addEventListener('change', (event) => {
            if (this.activeCharacter) this.renderDebounced();
        });

        // Prepare prompt edit form buttons
        document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_save').addEventListener('click', this.handleSavePrompt);
        document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_reset').addEventListener('click', this.handleResetPrompt);

        const closeAndClearPopup = () => {
            this.hidePopup();
            this.clearEditForm();
            this.clearInspectForm();
        };

        // Clear forms on closing the popup
        document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_close').addEventListener('click', closeAndClearPopup);
        document.getElementById(this.configuration.prefix + 'prompt_manager_popup_close_button').addEventListener('click', closeAndClearPopup);
        closeAndClearPopup();

        // Re-render prompt manager on openai preset change
        eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
            this.sanitizeServiceSettings();
            const mainPrompt = this.getPromptById('main');
            this.updateQuickEdit('main', mainPrompt);

            const nsfwPrompt = this.getPromptById('nsfw');
            this.updateQuickEdit('nsfw', nsfwPrompt);

            const jailbreakPrompt = this.getPromptById('jailbreak');
            this.updateQuickEdit('jailbreak', jailbreakPrompt);

            this.hidePopup();
            this.clearEditForm();
            this.renderDebounced();
        });

        // Re-render prompt manager on world settings update
        eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, () => this.renderDebounced());

        this.log('Initialized');
    }

    getToggleUndoCharacterTarget() {
        if (this.activeCharacter) {
            return { id: this.activeCharacter.id };
        }
        if (this.toggleUndoBatch?.characterId !== undefined && this.toggleUndoBatch?.characterId !== null) {
            return { id: this.toggleUndoBatch.characterId };
        }
        return null;
    }

    resetToggleUndoTimer() {
        if (this.toggleUndoTimer) {
            clearTimeout(this.toggleUndoTimer);
        }
        this.toggleUndoTimer = setTimeout(() => {
            this.clearToggleUndoToast();
            this.toggleUndoBatch = null;
            this.toggleUndoTimer = null;
        }, TOGGLE_UNDO_WINDOW_MS);
    }

    clearToggleUndoToast() {
        if (typeof toastr !== 'undefined' && this.toggleUndoToast) {
            toastr.clear(this.toggleUndoToast);
        }
        if (this.toggleUndoToast?.remove) {
            this.toggleUndoToast.remove();
        }
        this.toggleUndoToast = null;
        this.toggleUndoToastMessage = null;
    }

    formatToggleUndoMessage(changeCount) {
        const label = t`Prompt order updated.`;
        if (changeCount <= 1) {
            return label;
        }
        return `${label} (${changeCount})`;
    }

    syncToggleUndoToast() {
        const changeCount = this.toggleUndoBatch?.changes?.size ?? 0;
        if (changeCount <= 0) {
            this.clearToggleUndoToast();
            return;
        }

        if (typeof toastr === 'undefined') {
            return;
        }

        if (this.toggleUndoToast && (!this.toggleUndoToast.length || !document.body.contains(this.toggleUndoToast[0]))) {
            this.toggleUndoToast = null;
            this.toggleUndoToastMessage = null;
        }

        if (!this.toggleUndoToast) {
            this.toggleUndoToast = toastr.info(' ', '', {
                timeOut: 0,
                extendedTimeOut: 0,
                tapToDismiss: false,
                closeButton: true,
                progressBar: false,
            });

            const toastBody = this.toggleUndoToast ? this.toggleUndoToast.find('.toast-message') : null;
            const toastTarget = toastBody && toastBody.length > 0 ? toastBody : this.toggleUndoToast;
            if (toastTarget && toastTarget.length > 0) {
                toastTarget.empty();

                this.toggleUndoToastMessage = jQuery('<div class="prompt-manager-toggle-undo-text"></div>');
                const undoButton = jQuery('<button type="button" class="menu_button menu_button_small prompt-manager-toggle-undo-button"></button>');
                undoButton.text(String(t`Undo`));
                undoButton.on('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.undoToggleBatch();
                });

                toastTarget.append(this.toggleUndoToastMessage);
                toastTarget.append(undoButton);
            }
        }

        if (this.toggleUndoToastMessage && this.toggleUndoToastMessage.length > 0) {
            this.toggleUndoToastMessage.text(this.formatToggleUndoMessage(changeCount));
        }
    }

    enqueueToggleUndo(promptID, before, after) {
        const characterTarget = this.getToggleUndoCharacterTarget();
        if (!characterTarget) {
            return;
        }

        if (!this.toggleUndoBatch || String(this.toggleUndoBatch.characterId) !== String(characterTarget.id)) {
            this.toggleUndoBatch = {
                characterId: characterTarget.id,
                changes: new Map(),
            };
        }

        const existing = this.toggleUndoBatch.changes.get(promptID);
        if (existing) {
            existing.after = after;
            if (existing.before === existing.after) {
                this.toggleUndoBatch.changes.delete(promptID);
            }
        } else {
            this.toggleUndoBatch.changes.set(promptID, { before, after });
        }

        this.syncToggleUndoToast();

        if (this.toggleUndoBatch.changes.size <= 0) {
            if (this.toggleUndoTimer) {
                clearTimeout(this.toggleUndoTimer);
                this.toggleUndoTimer = null;
            }
            this.toggleUndoBatch = null;
            return;
        }

        this.resetToggleUndoTimer();
    }

    undoToggleBatch() {
        if (!this.toggleUndoBatch || !(this.toggleUndoBatch.changes instanceof Map) || this.toggleUndoBatch.changes.size === 0) {
            this.clearToggleUndoToast();
            return;
        }

        if (this.toggleUndoTimer) {
            clearTimeout(this.toggleUndoTimer);
            this.toggleUndoTimer = null;
        }

        const targetCharacter = { id: this.toggleUndoBatch.characterId };
        let allUpdatedInPlace = true;

        for (const [promptID, change] of this.toggleUndoBatch.changes.entries()) {
            const promptOrderEntry = this.getPromptOrderEntry(targetCharacter, promptID);
            if (!promptOrderEntry) {
                continue;
            }
            promptOrderEntry.enabled = Boolean(change.before);

            // Try in-place update for each toggled item
            if (!this.updateToggleInPlace(promptID, Boolean(change.before))) {
                allUpdatedInPlace = false;
            }
        }

        this.toggleUndoBatch = null;
        this.clearToggleUndoToast();

        if (!allUpdatedInPlace) {
            this.render();
        } else {
            this.updateHeaderTotalEstimate();
            this.updateTokenDisplayDebounced();
        }
        this.saveServiceSettings();
    }

    getDetachUndoCharacterTarget() {
        if (this.activeCharacter) {
            return { id: this.activeCharacter.id };
        }
        if (this.detachUndoBatch?.characterId !== undefined && this.detachUndoBatch?.characterId !== null) {
            return { id: this.detachUndoBatch.characterId };
        }
        return null;
    }

    resetDetachUndoTimer() {
        if (this.detachUndoTimer) {
            clearTimeout(this.detachUndoTimer);
        }
        this.detachUndoTimer = setTimeout(() => {
            this.clearDetachUndoToast();
            this.detachUndoBatch = null;
            this.detachUndoTimer = null;
        }, DETACH_UNDO_WINDOW_MS);
    }

    clearDetachUndoToast() {
        if (typeof toastr !== 'undefined' && this.detachUndoToast) {
            toastr.clear(this.detachUndoToast);
        }
        if (this.detachUndoToast?.remove) {
            this.detachUndoToast.remove();
        }
        this.detachUndoToast = null;
        this.detachUndoToastMessage = null;
    }

    formatDetachUndoMessage(changeCount) {
        if (changeCount <= 1) {
            return t`Prompt removed from order.`;
        }
        return `${t`Prompts removed from order.`} (${changeCount})`;
    }

    syncDetachUndoToast() {
        const changeCount = this.detachUndoBatch?.changes?.size ?? 0;
        if (changeCount <= 0) {
            this.clearDetachUndoToast();
            return;
        }

        if (typeof toastr === 'undefined') {
            return;
        }

        if (this.detachUndoToast && (!this.detachUndoToast.length || !document.body.contains(this.detachUndoToast[0]))) {
            this.detachUndoToast = null;
            this.detachUndoToastMessage = null;
        }

        if (!this.detachUndoToast) {
            this.detachUndoToast = toastr.info(' ', '', {
                timeOut: 0,
                extendedTimeOut: 0,
                tapToDismiss: false,
                closeButton: true,
                progressBar: false,
            });

            const toastBody = this.detachUndoToast ? this.detachUndoToast.find('.toast-message') : null;
            const toastTarget = toastBody && toastBody.length > 0 ? toastBody : this.detachUndoToast;
            if (toastTarget && toastTarget.length > 0) {
                toastTarget.empty();

                this.detachUndoToastMessage = jQuery('<div class="prompt-manager-toggle-undo-text"></div>');
                const undoButton = jQuery('<button type="button" class="menu_button menu_button_small prompt-manager-toggle-undo-button"></button>');
                undoButton.text(String(t`Undo`));
                undoButton.on('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.undoDetachBatch();
                });

                toastTarget.append(this.detachUndoToastMessage);
                toastTarget.append(undoButton);
            }
        }

        if (this.detachUndoToastMessage && this.detachUndoToastMessage.length > 0) {
            this.detachUndoToastMessage.text(this.formatDetachUndoMessage(changeCount));
        }
    }

    enqueueDetachUndo(promptID, entry, index) {
        const characterTarget = this.getDetachUndoCharacterTarget();
        if (!characterTarget || !entry || !Number.isInteger(index)) {
            return;
        }

        if (!this.detachUndoBatch || String(this.detachUndoBatch.characterId) !== String(characterTarget.id)) {
            this.detachUndoBatch = {
                characterId: characterTarget.id,
                changes: new Map(),
            };
        }

        this.detachUndoBatch.changes.set(promptID, {
            index,
            entry: structuredClone(entry),
        });
        this.syncDetachUndoToast();
        this.resetDetachUndoTimer();
    }

    undoDetachBatch() {
        if (!this.detachUndoBatch || !(this.detachUndoBatch.changes instanceof Map) || this.detachUndoBatch.changes.size === 0) {
            this.clearDetachUndoToast();
            return;
        }

        if (this.detachUndoTimer) {
            clearTimeout(this.detachUndoTimer);
            this.detachUndoTimer = null;
        }

        const targetCharacter = { id: this.detachUndoBatch.characterId };
        const promptOrder = this.getPromptOrderForCharacter(targetCharacter);
        const restoreOperations = Array.from(this.detachUndoBatch.changes.entries())
            .map(([promptID, value]) => ({ promptID, ...value }))
            .sort((a, b) => a.index - b.index);

        for (const restore of restoreOperations) {
            const existingIndex = promptOrder.findIndex(entry => entry.identifier === restore.promptID);
            if (existingIndex !== -1) {
                continue;
            }
            const safeIndex = Math.max(0, Math.min(restore.index, promptOrder.length));
            promptOrder.splice(safeIndex, 0, structuredClone(restore.entry));
        }

        this.detachUndoBatch = null;
        this.clearDetachUndoToast();

        // Try in-place insertion for each restored item
        let allInsertedInPlace = true;
        for (const restore of restoreOperations) {
            if (!this.insertPromptItemInPlace(restore.promptID)) {
                allInsertedInPlace = false;
                break;
            }
        }

        if (!allInsertedInPlace) {
            this.render();
        } else {
            this.updateTokenDisplayDebounced();
        }
        this.saveServiceSettings();
    }

    /**
     * Walk up from #prompt_manager to find the first ancestor that actually scrolls
     * on the Y axis. On desktop the scroll container is the #left-nav-panel drawer
     * itself (.drawer-content.openDrawer); on mobile it's the inner .scrollableInner.
     * Hard-coding either selector breaks the other.
     */
    #getScrollContainer() {
        let cur = document.getElementById(this.configuration.prefix + 'prompt_manager');
        while (cur instanceof HTMLElement) {
            try {
                const oy = window.getComputedStyle(cur).overflowY;
                if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay')
                    && (cur.scrollHeight - cur.clientHeight) > 2) {
                    return cur;
                }
            } catch { /* getComputedStyle can throw if element is detached */ }
            cur = cur.parentElement;
        }
        return null;
    }

    /**
     * Get the scroll position of the prompt manager
     * @returns {number} - Scroll position of the prompt manager
     */
    #getScrollPosition() {
        return this.#getScrollContainer()?.scrollTop;
    }

    /**
     * Set the scroll position of the prompt manager
     * @param {number} scrollPosition - The scroll position to set
     */
    #setScrollPosition(scrollPosition) {
        if (scrollPosition === undefined || scrollPosition === null) return;
        this.#getScrollContainer()?.scrollTo(0, scrollPosition);
    }

    /**
     * Main rendering function
     *
     * @param afterTryGenerate - Whether a dry run should be attempted before rendering
     */
    render(afterTryGenerate = true) {
        if (main_api !== 'openai') return;

        if ('character' === this.configuration.promptOrder.strategy && null === this.activeCharacter) return;
        this.error = null;
        const requestId = ++this.renderRequestId;

        waitUntilCondition(() => !is_send_press && !is_group_generating, 1024 * 1024, 100).catch(() => {
            console.log('Timeout while waiting for send press to be false');
            throw new Error('prompt-manager-render-skip');
        }).then(async () => {
            if (requestId !== this.renderRequestId) {
                return;
            }

            const renderProfileId = `prompt-manager-render-${requestId}`;
            this.profileStart(renderProfileId);
            const scrollPosition = this.#getScrollPosition();
            await this.renderPromptManager();
            if (requestId !== this.renderRequestId) {
                this.profileEnd(renderProfileId);
                return;
            }
            await this.renderPromptManagerListItems();
            if (requestId !== this.renderRequestId) {
                this.profileEnd(renderProfileId);
                return;
            }
            this.makeDraggable();
            this.#setScrollPosition(scrollPosition);
            this.profileEnd(renderProfileId);

            if (true === afterTryGenerate) {
                this.scheduleDeferredTryGenerate(requestId);
            }
        }).catch((err) => {
            if (err?.message === 'prompt-manager-render-skip') return;
            console.error('PromptManager render failed:', err);
            try { toastr.error(t`Prompt manager render failed: ${String(err?.message || err)}`); } catch { /* toastr unavailable */ }
        });
    }

    async runDeferredTryGenerate(requestId) {
        if (requestId !== this.renderRequestId) {
            return;
        }

        const dryRunRequestId = ++this.deferredTryGenerateRequestId;
        const fillingProfileId = `prompt-manager-filling-context-${dryRunRequestId}`;
        this.profileStart(fillingProfileId);
        try {
            await this.tryGenerate();
        } finally {
            this.profileEnd(fillingProfileId);
        }

        if (dryRunRequestId !== this.deferredTryGenerateRequestId) {
            return;
        }
        if (requestId !== this.renderRequestId) {
            return;
        }

        // Only update token displays instead of full DOM rebuild
        this.updateTokenDisplay();
    }

    /**
     * Schedule a token-only update: run tryGenerate dry run then update token text nodes.
     * Does NOT rebuild the DOM.
     */
    async scheduleTokenUpdate() {
        if (main_api !== 'openai') return;
        if ('character' === this.configuration.promptOrder.strategy && null === this.activeCharacter) return;

        const tokenUpdateId = ++this.deferredTryGenerateRequestId;
        try {
            await this.tryGenerate();
        } catch {
            // Ignore errors from dry run
        }

        if (tokenUpdateId !== this.deferredTryGenerateRequestId) {
            return;
        }

        this.updateTokenDisplay();
    }

    /**
     * Update a single prompt item's toggle state in-place without rebuilding the DOM.
     * @param {string} promptID - The identifier of the prompt to update
     * @param {boolean} enabled - The new enabled state
     * @returns {boolean} True if the element was found and updated
     */
    updateToggleInPlace(promptID, enabled) {
        const { prefix } = this.configuration;
        const li = this.listElement?.querySelector(`[data-pm-identifier="${CSS.escape(promptID)}"]`);
        if (!li) return false;

        // Toggle disabled class
        if (enabled) {
            li.classList.remove(`${prefix}prompt_manager_prompt_disabled`);
        } else {
            li.classList.add(`${prefix}prompt_manager_prompt_disabled`);
        }

        // Toggle icon
        const toggleSpan = li.querySelector('.prompt-manager-toggle-action');
        if (toggleSpan) {
            toggleSpan.classList.toggle('fa-toggle-on', enabled);
            toggleSpan.classList.toggle('fa-toggle-off', !enabled);
        }

        // Render token cell from cache: an enabled prompt with a known positive
        // count shows that count immediately (estimate); otherwise show "-" until
        // the next dry run populates a real value.
        const tokenCell = li.querySelector('.prompt-manager-tokens-cell');
        if (tokenCell) {
            const cached = this.tokenHandler?.getCounts?.()[promptID];
            const showNumber = enabled && typeof cached === 'number' && Number.isFinite(cached) && cached > 0;
            const display = showNumber ? String(cached) : '-';
            if (tokenCell.dataset.pmTokens !== display) {
                tokenCell.dataset.pmTokens = display;
                tokenCell.innerHTML = `<span> </span>${display}`;
            }
        }

        return true;
    }

    /**
     * Update a single prompt item's plugin-extra state in-place without rebuilding the DOM.
     * @param {string} promptID - The identifier of the prompt to update
     * @param {boolean} isExtra - The new plugin-extra state
     * @returns {boolean} True if the element was found and updated
     */
    updatePluginExtraInPlace(promptID, isExtra) {
        const li = this.listElement?.querySelector(`[data-pm-identifier="${CSS.escape(promptID)}"]`);
        if (!li) return false;

        // Toggle bookmark icon style
        const extraSpan = li.querySelector('.prompt-manager-plugin-extra-action');
        if (extraSpan) {
            if (isExtra) {
                extraSpan.classList.replace('fa-regular', 'fa-solid');
            } else {
                extraSpan.classList.replace('fa-solid', 'fa-regular');
            }
        }

 // Update badge in name meta (create container if absent, e.g. system-role prompts)
 let nameMeta = li.querySelector('.prompt-manager-name-meta');
 const existingBadge = li.querySelector('.prompt-manager-plugin-extra-badge');
 if (isExtra && !existingBadge) {
 if (!nameMeta) {
 nameMeta = document.createElement('span');
 nameMeta.className = 'prompt-manager-name-meta';
 li.querySelector('.prompt-manager-name-body')?.appendChild(nameMeta);
 }
 const badge = document.createElement('small');
 badge.className = 'prompt-manager-plugin-extra-badge';
 badge.title = 'Excluded from plugin request assembly';
 badge.textContent = 'extra';
 nameMeta.prepend(badge);
 } else if (!isExtra && existingBadge) {
 existingBadge.remove();
 // Clean up empty meta container
 if (nameMeta && !nameMeta.children.length) nameMeta.remove();
 }

        return true;
    }

    /**
     * Remove a prompt item from the DOM without rebuilding the entire list.
     * @param {string} promptID - The identifier of the prompt to remove
     * @returns {boolean} True if the element was found and removed
     */
    removePromptItemInPlace(promptID) {
        const li = this.listElement?.querySelector(`[data-pm-identifier="${CSS.escape(promptID)}"]`);
        if (!li) return false;
        li.remove();
        return true;
    }

    /**
     * Build the HTML string for a single prompt list item.
     * Extracted from renderPromptManagerListItems() for reuse in in-place updates.
     * @param {Prompt} prompt - The prompt object
     * @param {object} listEntry - The prompt order entry (with .enabled)
     * @returns {string} The HTML string for the <li> element
     */
    buildPromptItemHtml(prompt, listEntry) {
        const { prefix } = this.configuration;
        const enabledClass = listEntry.enabled ? '' : `${prefix}prompt_manager_prompt_disabled`;
        const draggableClass = `${prefix}prompt_manager_prompt_draggable`;
        const markerClass = prompt.marker ? `${prefix}prompt_manager_marker` : '';
        const tokens = this.tokenHandler?.getCounts()[prompt.identifier] ?? 0;

        let warningClass = '';
        let warningTitle = '';
        const tokenBudget = this.serviceSettings.openai_max_context - this.serviceSettings.openai_max_tokens;
        if (this.tokenUsage > tokenBudget * 0.8 && 'chatHistory' === prompt.identifier) {
            const warningThreshold = this.configuration.warningTokenThreshold;
            const dangerThreshold = this.configuration.dangerTokenThreshold;
            if (tokens <= dangerThreshold) {
                warningClass = 'fa-solid tooltip fa-triangle-exclamation text_danger';
                warningTitle = 'Very little of your chat history is being sent, consider deactivating some other prompts.';
            } else if (tokens <= warningThreshold) {
                warningClass = 'fa-solid tooltip fa-triangle-exclamation text_warning';
                warningTitle = 'Only a few messages worth chat history are being sent.';
            }
        }

        const calculatedTokens = tokens ? tokens : '-';

        let detachSpanHtml = this.isPromptDeletionAllowed(prompt)
            ? '<span title="Remove" class="prompt-manager-detach-action caution fa-solid fa-chain-broken fa-xs"></span>'
            : '<span class="fa-solid"></span>';

        let editSpanHtml = this.isPromptEditAllowed(prompt)
            ? '<span title="edit" class="prompt-manager-edit-action fa-solid fa-pencil fa-xs"></span>'
            : '<span class="fa-solid"></span>';

        let toggleSpanHtml = this.isPromptToggleAllowed(prompt)
            ? `<span class="prompt-manager-toggle-action ${listEntry.enabled ? 'fa-solid fa-toggle-on' : 'fa-solid fa-toggle-off'}"></span>`
            : '<span class="fa-solid"></span>';

        const pluginExtra = this.isPromptPluginExtra(prompt.identifier);
        const pluginExtraSpanHtml = `<span title="Extra Prompt: exclude from plugin request assembly" class="prompt-manager-plugin-extra-action ${pluginExtra ? 'fa-solid fa-bookmark' : 'fa-regular fa-bookmark'}"></span>`;
        const pluginExtraBadgeHtml = pluginExtra
            ? '<small class="prompt-manager-plugin-extra-badge" title="Excluded from plugin request assembly">extra</small>'
            : '';

        const encodedName = escapeHtml(prompt.name);
        const injectionPosition = getPromptInjectionPosition(prompt);
        const isMarkerPrompt = prompt.marker && injectionPosition === INJECTION_POSITION.RELATIVE;
        const isSystemPrompt = !prompt.marker && prompt.system_prompt && injectionPosition === INJECTION_POSITION.RELATIVE && !prompt.forbid_overrides;
        const isImportantPrompt = !prompt.marker && prompt.system_prompt && injectionPosition === INJECTION_POSITION.RELATIVE && prompt.forbid_overrides;
        const isUserPrompt = !prompt.marker && !prompt.system_prompt && injectionPosition === INJECTION_POSITION.RELATIVE;
        const isInjectionPrompt = injectionPosition === INJECTION_POSITION.ABSOLUTE;
        const isAttachedPrompt = injectionPosition === INJECTION_POSITION.ATTACH_EXISTING;
        const isOverriddenPrompt = Array.isArray(this.overriddenPrompts) && this.overriddenPrompts.includes(prompt.identifier);
        const importantClass = isImportantPrompt ? `${prefix}prompt_manager_important` : '';
        const iconLookup = prompt.role === 'system' && (prompt.marker || prompt.system_prompt) ? '' : prompt.role;

        const promptRoles = {
            assistant: { roleIcon: 'fa-robot', roleTitle: 'Prompt will be sent as Assistant' },
            user: { roleIcon: 'fa-user', roleTitle: 'Prompt will be sent as User' },
        };
        const roleIcon = promptRoles[iconLookup]?.roleIcon || '';
        const roleTitle = promptRoles[iconLookup]?.roleTitle || '';
        const markerHandleClass = 'prompt-manager-marker-handle';
        const leadingIconHtml = isMarkerPrompt
            ? `<span class="fa-fw fa-solid fa-thumb-tack ${markerHandleClass}" title="Marker"></span>`
            : isSystemPrompt
                ? `<span class="fa-fw fa-solid fa-square-poll-horizontal ${markerHandleClass}" title="Global Prompt"></span>`
                : isImportantPrompt
                    ? `<span class="fa-fw fa-solid fa-star ${markerHandleClass}" title="Important Prompt"></span>`
                    : isUserPrompt
                        ? `<span class="fa-fw fa-solid fa-asterisk ${markerHandleClass}" title="Preset Prompt"></span>`
                        : isInjectionPrompt
                            ? `<span class="fa-fw fa-solid fa-syringe ${markerHandleClass}" title="In-Chat Injection"></span>`
                            : isAttachedPrompt
                                ? `<span class="fa-fw fa-solid fa-paperclip ${markerHandleClass}" title="Attached to Existing Message"></span>`
                                : '<span class="fa-fw fa-solid prompt-manager-name-leading-placeholder" aria-hidden="true"></span>';
        const nameTextHtml = this.isPromptInspectionAllowed(prompt)
            ? `<a title="${encodedName}" class="prompt-manager-inspect-action prompt-manager-name-text">${encodedName}</a>`
            : `<span title="${encodedName}" class="prompt-manager-name-text">${encodedName}</span>`;
        const attachSideText = prompt.attach_side === 'start' ? t`Prepend` : t`Append`;
        const nameMetaHtml = [
            pluginExtraBadgeHtml,
            roleIcon ? `<span data-role="${escapeHtml(prompt.role)}" class="fa-xs fa-solid ${roleIcon}" title="${roleTitle}"></span>` : '',
            isInjectionPrompt ? `<small class="prompt-manager-injection-depth">@ ${escapeHtml(prompt.injection_depth.toString())}</small>` : '',
            isAttachedPrompt ? `<small class="prompt-manager-injection-depth">${escapeHtml(attachSideText)} → ${escapeHtml(String(prompt.attach_role ?? 'user'))} #${escapeHtml(String(prompt.attach_index ?? 1))}</small>` : '',
            isOverriddenPrompt ? '<small class="fa-solid fa-address-card prompt-manager-overridden" title="Pulled from a character card"></small>' : '',
        ].filter(Boolean).join('');

        return `
            <li class="${prefix}prompt_manager_prompt ${draggableClass} ${enabledClass} ${markerClass} ${importantClass}" data-pm-identifier="${escapeHtml(prompt.identifier)}">
                <span class="${prefix}prompt_manager_prompt_name" data-pm-name="${encodedName}">
                    <span class="prompt-manager-name-leading">${leadingIconHtml}</span>
                    <span class="prompt-manager-name-body">
                        ${nameTextHtml}
                        ${nameMetaHtml ? `<span class="prompt-manager-name-meta">${nameMetaHtml}</span>` : ''}
                    </span>
                </span>
                <span class="prompt-manager-actions-cell">
                        <span class="prompt_manager_prompt_controls">
                            ${detachSpanHtml}
                            ${editSpanHtml}
                            ${pluginExtraSpanHtml}
                            ${toggleSpanHtml}
                        </span>
                </span>
                <span class="prompt_manager_prompt_tokens prompt-manager-tokens-cell" data-pm-tokens="${calculatedTokens}"><span class="${warningClass}" title="${warningTitle}"> </span>${calculatedTokens}</span>
            </li>
        `;
    }

    /**
     * Replace a single prompt item in the DOM with freshly built HTML.
     * @param {string} promptID - The identifier of the prompt to replace
     * @returns {boolean} True if the element was found and replaced
     */
    replacePromptItemInPlace(promptID) {
        const prompt = this.getPromptById(promptID);
        const listEntry = this.getPromptOrderEntry(this.activeCharacter, promptID);
        if (!prompt || !listEntry) return false;

        const oldLi = this.listElement?.querySelector(`[data-pm-identifier="${CSS.escape(promptID)}"]`);
        if (!oldLi) return false;

        const html = this.buildPromptItemHtml(prompt, listEntry);
        const template = document.createElement('template');
        template.innerHTML = html.trim();
        const newLi = template.content.firstElementChild;
        if (!newLi) return false;

        oldLi.replaceWith(newLi);
        return true;
    }

    /**
     * Insert a prompt item at the correct position in the DOM list.
     * @param {string} promptID - The identifier of the prompt to insert
     * @returns {boolean} True if the element was successfully inserted
     */
    insertPromptItemInPlace(promptID) {
        const prompt = this.getPromptById(promptID);
        const listEntry = this.getPromptOrderEntry(this.activeCharacter, promptID);
        if (!prompt || !listEntry || !this.listElement) return false;

        const html = this.buildPromptItemHtml(prompt, listEntry);
        const template = document.createElement('template');
        template.innerHTML = html.trim();
        const newLi = template.content.firstElementChild;
        if (!newLi) return false;

        // Find the correct insertion position based on prompt order
        const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);
        const myIndex = promptOrder.findIndex(e => e.identifier === promptID);

        // Look for the next sibling that exists in the DOM
        let insertBefore = null;
        for (let i = myIndex + 1; i < promptOrder.length; i++) {
            const siblingLi = this.listElement.querySelector(`[data-pm-identifier="${CSS.escape(promptOrder[i].identifier)}"]`);
            if (siblingLi) {
                insertBefore = siblingLi;
                break;
            }
        }

        if (insertBefore) {
            this.listElement.insertBefore(newLi, insertBefore);
        } else {
            this.listElement.appendChild(newLi);
        }

        return true;
    }

    /**
     * Update token count text nodes in-place without rebuilding the DOM.
     * Also updates the total token count in the header.
     */
    updateTokenDisplay() {
        const counts = this.tokenHandler?.getCounts();
        if (!counts) return;

        const { prefix } = this.configuration;
        const promptManagerList = this.listElement;
        if (!promptManagerList) return;

        // Update individual prompt token counts
        const tokenCells = promptManagerList.querySelectorAll('.prompt-manager-tokens-cell');
        for (const cell of tokenCells) {
            const li = cell.closest(`.${prefix}prompt_manager_prompt`);
            if (!li) continue;
            const identifier = li.dataset.pmIdentifier;
            if (!identifier) continue;

            const tokens = counts[identifier] ?? 0;
            const calculatedTokens = tokens ? tokens : '-';
            const currentValue = cell.dataset.pmTokens;

            if (String(calculatedTokens) !== String(currentValue)) {
                cell.dataset.pmTokens = calculatedTokens;

                // Update warning class
                const tokenBudget = this.serviceSettings.openai_max_context - this.serviceSettings.openai_max_tokens;
                let warningClass = '';
                let warningTitle = '';

                if (this.tokenUsage > tokenBudget * 0.8 && 'chatHistory' === identifier) {
                    const warningThreshold = this.configuration.warningTokenThreshold;
                    const dangerThreshold = this.configuration.dangerTokenThreshold;

                    if (tokens <= dangerThreshold) {
                        warningClass = 'fa-solid tooltip fa-triangle-exclamation text_danger';
                        warningTitle = 'Very little of your chat history is being sent, consider deactivating some other prompts.';
                    } else if (tokens <= warningThreshold) {
                        warningClass = 'fa-solid tooltip fa-triangle-exclamation text_warning';
                        warningTitle = 'Only a few messages worth chat history are being sent.';
                    }
                }

                // Rebuild cell content (minimal DOM operation)
                cell.innerHTML = `<span class="${warningClass}" title="${warningTitle}"> </span>${calculatedTokens}`;
            }
        }

        // Update total token count in header
        this.tokenUsage = this.tokenHandler.getTotal();
        const headerDiv = this.containerElement?.querySelector(`.${prefix}prompt_manager_header div:last-child`);
        if (headerDiv) {
            const totalText = headerDiv.textContent;
            const match = totalText?.match(/^(.+?)\s*\d+/);
            if (match) {
                headerDiv.textContent = `${match[1]} ${this.tokenUsage}`;
            }
        }
    }

    /**
     * Refresh the header total token count using cached per-prompt counts only,
     * filtered by current enabled state. Cheap synchronous estimate intended for
     * the brief window between a toggle and the next dry-run completing — the
     * dry-run's updateTokenDisplay will overwrite this value with the real total.
     */
    updateHeaderTotalEstimate() {
        const counts = this.tokenHandler?.getCounts();
        if (!counts) return;
        const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);
        const estimated = estimateTotalTokensFromCache(promptOrder, counts);
        this.tokenUsage = estimated;

        const { prefix } = this.configuration;
        const headerDiv = this.containerElement?.querySelector(`.${prefix}prompt_manager_header div:last-child`);
        if (!headerDiv) return;
        const totalText = headerDiv.textContent;
        const match = totalText?.match(/^(.+?)\s*\d+/);
        if (match) {
            headerDiv.textContent = `${match[1]} ${estimated}`;
        }
    }

    /**
     * Update a prompt with the values from the HTML form.
     * @param {Partial<Prompt>} prompt - The prompt to be updated.
     * @returns {void}
     */
    updatePromptWithPromptEditForm(prompt) {
        const nameField = /** @type {HTMLTextAreaElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_name'));
        const roleField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_role'));
        const promptField = /** @type {HTMLTextAreaElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_prompt'));
        const injectionPositionField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_position'));
        const injectionDepthField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_depth'));
        const injectionOrderField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_order'));
        const injectionTriggerField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_trigger'));
        const forbidOverridesField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_forbid_overrides'));
        const pluginExtraField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_plugin_extra'));
        const attachRoleField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_attach_role'));
        const attachIndexField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_attach_index'));
        const attachSideField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_attach_side'));

        prompt.name = nameField.value.replace(/\s*\r?\n+\s*/g, ' ').trim();
        prompt.role = roleField.value;
        prompt.content = promptField.value;
        prompt.injection_position = Number(injectionPositionField.value);
        prompt.injection_depth = Number(injectionDepthField.value);
        prompt.injection_order = Number(injectionOrderField.value);
        prompt.injection_trigger = Array.from(injectionTriggerField.selectedOptions).map(option => option.value);
        prompt.forbid_overrides = forbidOverridesField.checked;
        prompt.plugin_extra = pluginExtraField.checked;
        prompt.attach_role = attachRoleField.value;
        prompt.attach_index = Number(attachIndexField.value) || 1;
        prompt.attach_side = attachSideField.value;
    }

    /**
     * Find a prompt by its identifier and update it with the provided object.
     * @param {string} identifier - The identifier of the prompt.
     * @param {Prompt} updatePrompt - An object with properties to be updated in the prompt.
     * @returns {void}
     */
    updatePromptByIdentifier(identifier, updatePrompt) {
        let prompt = this.serviceSettings.prompts.find((item) => identifier === item.identifier);
        if (prompt) prompt = Object.assign(prompt, updatePrompt);
    }

    /**
     * Iterate over an array of prompts, find each one by its identifier, and update them with the provided data.
     * @param {Prompt[]} prompts - An array of prompt updates.
     * @returns {void}
     */
    updatePrompts(prompts) {
        prompts.forEach((update) => {
            let prompt = this.getPromptById(update.identifier);
            if (prompt) Object.assign(prompt, update);
        });
    }

    getTokenHandler() {
        return this.tokenHandler;
    }

    isPromptDisabledForActiveCharacter(identifier) {
        const promptOrderEntry = this.getPromptOrderEntry(this.activeCharacter, identifier);
        if (promptOrderEntry) return !promptOrderEntry.enabled;
        return false;
    }

    /**
     * Add a prompt to the current character's prompt list.
     * @param {Prompt} prompt - The prompt to be added.
     * @param {object} character - The character whose prompt list will be updated.
     * @returns {void}
     */
    appendPrompt(prompt, character) {
        const promptOrder = this.getPromptOrderForCharacter(character);
        const index = promptOrder.findIndex(entry => entry.identifier === prompt.identifier);

        if (-1 === index) promptOrder.unshift({ identifier: prompt.identifier, enabled: false });
    }

    /**
     * Remove a prompt from the current character's prompt list.
     * @param {Prompt} prompt - The prompt to be removed.
     * @param {object} character - The character whose prompt list will be updated.
     * @returns {void}
     */
    // Remove a prompt from the current characters prompt list
    detachPrompt(prompt, character) {
        const promptOrder = this.getPromptOrderForCharacter(character);
        const index = promptOrder.findIndex(entry => entry.identifier === prompt.identifier);
        if (-1 === index) return null;
        const [removedEntry] = promptOrder.splice(index, 1);

        // Remove from any group it belongs to
        const group = this.getGroupForPrompt(prompt.identifier);
        if (group) {
            group.identifiers = group.identifiers.filter(id => id !== prompt.identifier);
            this.cleanupEmptyGroups();
        }

        return {
            index,
            entry: structuredClone(removedEntry),
        };
    }

    /**
     * Create a new prompt and add it to the list of prompts.
     * @param {Partial<Prompt>} prompt - The prompt to be added.
     * @param {string} identifier - The identifier for the new prompt.
     * @returns {void}
     */
    addPrompt(prompt, identifier) {
        if (typeof prompt !== 'object' || prompt === null) throw new Error('Object is not a prompt');

        const newPrompt = {
            identifier: identifier,
            system_prompt: false,
            enabled: false,
            marker: false,
            plugin_extra: false,
            ...prompt,
        };

        this.serviceSettings.prompts.push(newPrompt);
    }

    /**
     * Sanitize the service settings, ensuring each prompt has a unique identifier.
     * @returns {void}
     */
    sanitizeServiceSettings() {
        this.serviceSettings.prompts = this.serviceSettings.prompts ?? [];
        this.serviceSettings.prompt_order = this.serviceSettings.prompt_order ?? [];
        this.serviceSettings.extensions = this.serviceSettings.extensions && typeof this.serviceSettings.extensions === 'object'
            ? this.serviceSettings.extensions
            : {};
        this.serviceSettings.extensions.luker = this.serviceSettings.extensions.luker && typeof this.serviceSettings.extensions.luker === 'object'
            ? this.serviceSettings.extensions.luker
            : {};
        this.serviceSettings.extensions.luker.prompt_layout = Array.isArray(this.serviceSettings.extensions.luker.prompt_layout)
            ? this.serviceSettings.extensions.luker.prompt_layout
            : [];
        this.serviceSettings.extensions.luker.prompt_groups = Array.isArray(this.serviceSettings.extensions.luker.prompt_groups)
            ? this.serviceSettings.extensions.luker.prompt_groups
            : [];

        if ('global' === this.configuration.promptOrder.strategy) {
            const dummyCharacter = { id: this.configuration.promptOrder.dummyId };
            const promptOrder = this.getPromptOrderForCharacter(dummyCharacter);

            if (0 === promptOrder.length) this.addPromptOrderForCharacter(dummyCharacter, promptManagerDefaultPromptOrder);
        }

        // Check whether the referenced prompts are present.
        this.serviceSettings.prompts.length === 0
            ? this.setPrompts(chatCompletionDefaultPrompts.prompts)
            : this.checkForMissingPrompts(this.serviceSettings.prompts);

        // Add identifiers if there are none assigned to a prompt
        this.serviceSettings.prompts.forEach(prompt => {
            if (!prompt) {
                return;
            }
            prompt.identifier = prompt.identifier ?? this.getUuidv4();
            if (typeof prompt.name !== 'string') prompt.name = prompt.identifier;
            prompt.plugin_extra = Boolean(prompt.plugin_extra);
        });

        if (this.activeCharacter) {
            const promptReferences = this.getPromptOrderForCharacter(this.activeCharacter);
            for (let i = promptReferences.length - 1; i >= 0; i--) {
                const reference = promptReferences[i];
                if (reference && -1 === this.serviceSettings.prompts.findIndex(prompt => prompt.identifier === reference.identifier)) {
                    promptReferences.splice(i, 1);
                    this.log('Removed unused reference: ' + reference.identifier);
                }
            }
        }
    }

    /**
     * Checks whether entries of a characters prompt order are orphaned
     * and if all mandatory system prompts for a character are present.
     *
     * @param prompts
     */
    checkForMissingPrompts(prompts) {
        const defaultPromptIdentifiers = chatCompletionDefaultPrompts.prompts.reduce((list, prompt) => { list.push(prompt.identifier); return list; }, []);

        const missingIdentifiers = defaultPromptIdentifiers.filter(identifier =>
            !prompts.some(prompt => prompt.identifier === identifier),
        );

        missingIdentifiers.forEach(identifier => {
            const defaultPrompt = chatCompletionDefaultPrompts.prompts.find(prompt => prompt?.identifier === identifier);
            if (defaultPrompt) {
                prompts.push(defaultPrompt);
                this.log(`Missing system prompt: ${defaultPrompt.identifier}. Added default.`);
            }
        });
    }

    /**
     * Check whether a prompt can be inspected.
     * @param {Prompt} prompt - The prompt to check.
     * @returns {boolean} True if the prompt is a marker, false otherwise.
     */
    isPromptInspectionAllowed(prompt) {
        return true;
    }

    /**
     * Check whether a prompt can be deleted. System prompts cannot be deleted.
     * @param {Prompt} prompt - The prompt to check.
     * @returns {boolean} True if the prompt can be deleted, false otherwise.
     */
    isPromptDeletionAllowed(prompt) {
        return false === prompt.system_prompt;
    }

    /**
     * Check whether a prompt can be edited.
     * @param {Prompt} prompt - The prompt to check.
     * @returns {boolean} True if the prompt can be edited, false otherwise.
     */
    isPromptEditAllowed(prompt) {
        const forceEditPrompts = [
            'charDescription',
            'charPersonality',
            'scenario',
            'personaDescription',
            'worldInfoBefore',
            'worldInfoAfter',
        ];
        return forceEditPrompts.includes(prompt.identifier) || !prompt.marker;
    }

    /**
     * Check whether a prompt can be toggled on or off.
     * @param {Prompt} prompt - The prompt to check.
     * @returns {boolean} True if the prompt can be deleted, false otherwise.
     */
    isPromptToggleAllowed(prompt) {
        const forceTogglePrompts = [
            'charDescription',
            'charPersonality',
            'scenario',
            'personaDescription',
            'worldInfoBefore',
            'worldInfoAfter',
            'main',
            'chatHistory',
            'dialogueExamples',
        ];
        return prompt.marker && !forceTogglePrompts.includes(prompt.identifier) ? false : !this.configuration.toggleDisabled.includes(prompt.identifier);
    }

    /**
     * Handle the deletion of a character by removing their prompt list and nullifying the active character if it was the one deleted.
     * @param {object} event - The event object containing the character's ID.
     * @returns void
     */
    handleCharacterDeleted(event) {
        if ('global' === this.configuration.promptOrder.strategy) return;
        this.removePromptOrderForCharacter(this.activeCharacter);
        if (this.activeCharacter.id === event.detail.id) this.activeCharacter = null;
    }

    /**
     * Handle the selection of a character by setting them as the active character and setting up their prompt list if necessary.
     * @param {object} event - The event object containing the character's ID and character data.
     * @returns {void}
     */
    handleCharacterSelected(event) {
        if ('global' === this.configuration.promptOrder.strategy) {
            this.activeCharacter = { id: this.configuration.promptOrder.dummyId };
        } else if ('character' === this.configuration.promptOrder.strategy) {
            console.log('FOO');
            this.activeCharacter = { id: event.detail.id, ...event.detail.character };
            const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);

            // ToDo: These should be passed as parameter or attached to the manager as a set of default options.
            // Set default prompts and order for character.
            if (0 === promptOrder.length) this.addPromptOrderForCharacter(this.activeCharacter, promptManagerDefaultPromptOrder);
        } else {
            throw new Error('Unsupported prompt order mode.');
        }
    }

    /**
     * Set the most recently selected character
     *
     * @param event
     */
    handleCharacterUpdated(event) {
        if ('global' === this.configuration.promptOrder.strategy) {
            this.activeCharacter = { id: this.configuration.promptOrder.dummyId };
        } else if ('character' === this.configuration.promptOrder.strategy) {
            this.activeCharacter = { id: event.detail.id, ...event.detail.character };
        } else {
            throw new Error('Prompt order strategy not supported.');
        }
    }

    /**
     * Set the most recently selected character group
     *
     * @param event
     */
    handleGroupSelected(event) {
        if ('global' === this.configuration.promptOrder.strategy) {
            this.activeCharacter = { id: this.configuration.promptOrder.dummyId };
        } else if ('character' === this.configuration.promptOrder.strategy) {
            const characterDummy = { id: event.detail.id, group: event.detail.group };
            this.activeCharacter = characterDummy;
            const promptOrder = this.getPromptOrderForCharacter(characterDummy);

            if (0 === promptOrder.length) this.addPromptOrderForCharacter(characterDummy, promptManagerDefaultPromptOrder);
        } else {
            throw new Error('Prompt order strategy not supported.');
        }
    }

    /**
     * Get a list of group characters, regardless of whether they are active or not.
     *
     * @returns {string[]}
     */
    getActiveGroupCharacters() {
        // ToDo: Ideally, this should return the actual characters.
        return (this.activeCharacter?.group?.members || []).map(member => member && member.substring(0, member.lastIndexOf('.')));
    }

    /**
     * Get the prompts for a specific character. Can be filtered to only include enabled prompts.
     * @returns {Prompt[]} The prompts for the character.
     * @param character
     * @param onlyEnabled
     */
    getPromptsForCharacter(character, onlyEnabled = false) {
        return this.getPromptOrderForCharacter(character)
            .map(item => true === onlyEnabled ? (true === item.enabled ? this.getPromptById(item.identifier) : null) : this.getPromptById(item.identifier))
            .filter(prompt => null !== prompt);
    }

    /**
     * Get the order of prompts for a specific character. If no character is specified or the character doesn't have a prompt list, an empty array is returned.
     * @param {object|null} character - The character to get the prompt list for.
     * @returns {Partial<Prompt>[]} The prompt list for the character, or an empty array.
     */
    getPromptOrderForCharacter(character) {
        return !character ? [] : (this.serviceSettings.prompt_order.find(list => String(list.character_id) === String(character.id))?.order ?? []);
    }

    /**
     * Set the prompts for the manager.
     * @param {Partial<Prompt>[]} prompts - The prompts to be set.
     * @returns {void}
     */
    setPrompts(prompts) {
        this.serviceSettings.prompts = prompts;
    }

    /**
     * Remove the prompt list for a specific character.
     * @param {object} character - The character whose prompt list will be removed.
     * @returns {void}
     */
    removePromptOrderForCharacter(character) {
        const index = this.serviceSettings.prompt_order.findIndex(list => String(list.character_id) === String(character.id));
        if (-1 !== index) this.serviceSettings.prompt_order.splice(index, 1);
    }

    /**
     * Adds a new prompt list for a specific character.
     * @param {Object} character - Object with at least an `id` property
     * @param {Array<Object>} promptOrder - Array of prompt objects
     */
    addPromptOrderForCharacter(character, promptOrder) {
        this.serviceSettings.prompt_order.push({
            character_id: character.id,
            order: JSON.parse(JSON.stringify(promptOrder)),
        });
    }

    /**
     * Searches for a prompt list entry for a given character and identifier.
     * @param {Object} character - Character object
     * @param {string} identifier - Identifier of the prompt list entry
     * @returns {Object|null} The prompt list entry object, or null if not found
     */
    getPromptOrderEntry(character, identifier) {
        return this.getPromptOrderForCharacter(character).find(entry => entry.identifier === identifier) ?? null;
    }

    // ========================================
    // Prompt Groups
    // ========================================

    /**
     * Get all prompt groups.
     * @returns {Array<{id: string, name: string, collapsed: boolean, identifiers: string[]}>}
     */
    getPromptGroups() {
        return this.serviceSettings.extensions?.luker?.prompt_groups ?? [];
    }

    /**
     * Get the nesting depth of a group (0 = top-level).
     * @param {string} groupId
     * @returns {number}
     */
    getGroupDepth(groupId) {
        const groups = this.getPromptGroups();
        const groupMap = new Map(groups.map(g => [g.id, g]));
        let depth = 0;
        let current = groupMap.get(groupId);
        while (current && current.parentId) {
            depth++;
            current = groupMap.get(current.parentId);
            // Guard against circular references
            if (depth > 100) break;
        }
        return depth;
    }

    /**
     * Get direct child groups of a given group.
     * @param {string} groupId
     * @returns {Array}
     */
    getGroupChildren(groupId) {
        return this.getPromptGroups().filter(g => (g.parentId ?? null) === groupId);
    }

    /**
     * Get all descendant group IDs (recursive).
     * @param {string} groupId
     * @returns {string[]}
     */
    getDescendantGroupIds(groupId) {
        const children = this.getGroupChildren(groupId);
        const result = [];
        for (const child of children) {
            result.push(child.id);
            result.push(...this.getDescendantGroupIds(child.id));
        }
        return result;
    }

    /**
     * Check if a group is visible (all ancestor groups are expanded).
     * @param {string} groupId
     * @returns {boolean}
     */
    isGroupVisible(groupId) {
        const groups = this.getPromptGroups();
        const groupMap = new Map(groups.map(g => [g.id, g]));
        let current = groupMap.get(groupId);
        while (current && current.parentId) {
            const parent = groupMap.get(current.parentId);
            if (!parent) break; // orphaned, treat as visible
            if (parent.collapsed) return false;
            current = parent;
        }
        return true;
    }

    /**
     * Sort groups hierarchically: top-level first, then their children recursively.
     * @returns {Array} Sorted array of group objects
     */
    getPromptGroupsSorted() {
        const groups = this.getPromptGroups();
        const topLevel = groups.filter(g => !g.parentId);
        const result = [];
        const addWithChildren = (parent) => {
            result.push(parent);
            const children = groups.filter(g => (g.parentId ?? null) === parent.id);
            for (const child of children) {
                addWithChildren(child);
            }
        };
        for (const g of topLevel) {
            addWithChildren(g);
        }
        // Also include any orphaned groups (parentId references a non-existent group)
        const included = new Set(result.map(g => g.id));
        for (const g of groups) {
            if (!included.has(g.id)) {
                result.push(g);
            }
        }
        return result;
    }

    /**
     * Find the group a prompt belongs to.
     * @param {string} identifier - The prompt identifier
     * @returns {{id: string, name: string, collapsed: boolean, identifiers: string[]}|null}
     */
    getGroupForPrompt(identifier) {
        return this.getPromptGroups().find(g => g.identifiers.includes(identifier)) ?? null;
    }

    /**
     * Check if the given identifiers are contiguous in the current prompt order.
     * @param {string[]} identifiers - The identifiers to check
     * @returns {boolean}
     */
    areIdentifiersContiguous(identifiers) {
        if (identifiers.length <= 1) return true;
        const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);
        const indices = identifiers.map(id => promptOrder.findIndex(e => e.identifier === id)).filter(i => i !== -1);
        if (indices.length !== identifiers.length) return false;
        indices.sort((a, b) => a - b);
        for (let i = 1; i < indices.length; i++) {
            if (indices[i] !== indices[i - 1] + 1) return false;
        }
        return true;
    }

    /**
     * Create a new prompt group from the given identifiers.
     * @param {string} name - Group display name
     * @param {string[]} identifiers - Ordered list of prompt identifiers
     * @returns {{id: string, name: string, collapsed: boolean, identifiers: string[]}|null}
     */
    createPromptGroup(name, identifiers, parentId = null) {
        // Allow empty identifiers only if creating a sub-group
        if (!identifiers.length && !parentId) return null;
        if (identifiers.length && !this.areIdentifiersContiguous(identifiers)) return null;

        // Remove these identifiers from any existing groups
        for (const group of this.getPromptGroups()) {
            group.identifiers = group.identifiers.filter(id => !identifiers.includes(id));
        }
        // Clean up empty groups (but preserve groups that have child groups)
        this.cleanupEmptyGroups();

        // Sort identifiers by their position in prompt_order
        const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);
        const sorted = [...identifiers].sort((a, b) => {
            const ia = promptOrder.findIndex(e => e.identifier === a);
            const ib = promptOrder.findIndex(e => e.identifier === b);
            return ia - ib;
        });

        const newGroup = {
            id: 'grp_' + this.getUuidv4(),
            name: name,
            collapsed: true,
            identifiers: sorted,
            parentId: parentId,
        };

        this.getPromptGroups().push(newGroup);
        return newGroup;
    }

    /**
     * Remove a prompt group (ungroup). Does not affect prompt order.
     * @param {string} groupId
     */
    removePromptGroup(groupId) {
        const groups = this.getPromptGroups();
        const index = groups.findIndex(g => g.id === groupId);
        if (index !== -1) {
            const deletedGroup = groups[index];
            // Move child groups up to the deleted group's parent
            const parentId = deletedGroup.parentId ?? null;
            for (const group of groups) {
                if ((group.parentId ?? null) === groupId) {
                    group.parentId = parentId || null;
                }
            }
            groups.splice(index, 1);
        }
    }

    /**
     * Check if a group or any of its ancestors is collapsed.
     * @param {string} groupId
     * @returns {boolean}
     */
    _isGroupOrAncestorCollapsed(groupId) {
        const groups = this.getPromptGroups();
        const groupMap = new Map(groups.map(g => [g.id, g]));
        let current = groupMap.get(groupId);
        while (current) {
            if (current.collapsed) return true;
            if (!current.parentId) break;
            current = groupMap.get(current.parentId);
        }
        return false;
    }

    /**
     * Rename a prompt group.
     * @param {string} groupId
     * @param {string} newName
     */
    renamePromptGroup(groupId, newName) {
        const group = this.getPromptGroups().find(g => g.id === groupId);
        if (group) group.name = newName;
    }

    /**
     * Check if any ancestor of a group is collapsed (not including the group itself).
     * @param {string} groupId
     * @returns {boolean}
     */
    _isAncestorCollapsed(groupId) {
        const groups = this.getPromptGroups();
        const groupMap = new Map(groups.map(g => [g.id, g]));
        const group = groupMap.get(groupId);
        if (!group || !group.parentId) return false;
        let current = groupMap.get(group.parentId);
        while (current) {
            if (current.collapsed) return true;
            if (!current.parentId) break;
            current = groupMap.get(current.parentId);
        }
        return false;
    }

    /**
     * Toggle the collapsed state of a prompt group.
     * @param {string} groupId
     */
    toggleGroupCollapse(groupId) {
        const group = this.getPromptGroups().find(g => g.id === groupId);
        if (group) group.collapsed = !group.collapsed;
    }

    /**
     * Toggle all prompts in a group on/off.
     * @param {string} groupId
     */
    toggleGroupPrompts(groupId) {
        const group = this.getPromptGroups().find(g => g.id === groupId);
        if (!group) return;

        const entries = group.identifiers.map(id => this.getPromptOrderEntry(this.activeCharacter, id)).filter(Boolean);
        const allEnabled = entries.every(e => e.enabled);
        const newState = !allEnabled;

        for (const entry of entries) {
            entry.enabled = newState;
        }
    }

    /**
     * Calculate the total token count for a group.
     * @param {string} groupId
     * @returns {number}
     */
    getGroupTokenCount(groupId) {
        const group = this.getPromptGroups().find(g => g.id === groupId);
        if (!group) return 0;
        const counts = this.tokenHandler?.getCounts() ?? {};
        return group.identifiers.reduce((sum, id) => {
            const entry = this.getPromptOrderEntry(this.activeCharacter, id);
            if (entry?.enabled) {
                return sum + (counts[id] ?? 0);
            }
            return sum;
        }, 0);
    }

    /**
     * Remove empty groups (groups with no identifiers).
     */
    cleanupEmptyGroups() {
        const groups = this.getPromptGroups();
        for (let i = groups.length - 1; i >= 0; i--) {
            // Don't remove groups that have child groups
            const hasChildren = groups.some(g => (g.parentId ?? null) === groups[i].id);
            if (!groups[i].identifiers.length && !hasChildren) groups.splice(i, 1);
        }
    }

    /**
     * Validate and repair group data after prompt order changes.
     * Removes identifiers that no longer exist in prompt_order,
     * and splits groups whose members are no longer contiguous.
     */
    validateGroups() {
        const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);
        const orderIds = new Set(promptOrder.map(e => e.identifier));
        const groups = this.getPromptGroups();
        const groupIds = new Set(groups.map(g => g.id));

        for (const group of groups) {
            // Remove identifiers not in prompt_order
            group.identifiers = group.identifiers.filter(id => orderIds.has(id));
            // Clean up parentId references to deleted groups
            if (group.parentId && !groupIds.has(group.parentId)) {
                group.parentId = null;
            }
        }

        this.cleanupEmptyGroups();
    }

    isPromptPluginExtra(identifier) {
        const prompt = this.getPromptById(identifier);
        return Boolean(prompt?.plugin_extra);
    }

    setPromptPluginExtra(identifier, extra) {
        const prompt = this.getPromptById(identifier);
        if (!prompt) {
            return;
        }
        prompt.plugin_extra = Boolean(extra);
    }

    /**
     * Finds and returns a prompt by its identifier.
     * @param {string} identifier - Identifier of the prompt
     * @returns {Prompt|null} The prompt object, or null if not found
     */
    getPromptById(identifier) {
        return this.serviceSettings.prompts.find(item => item && item.identifier === identifier) ?? null;
    }

    /**
     * Normalizes prompt-manager search text so camelCase identifiers and placeholders
     * can be searched with natural-language queries.
     * @param {string} value
     * @returns {string}
     */
    normalizePromptSearchText(value) {
        return String(value || '')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/[_./:-]+/g, ' ')
            .replace(/[{}[\]()<>"'`|\\]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    normalizePromptSearchCandidateValues(values) {
        const candidates = new Set();

        for (const value of Array.isArray(values) ? values : [values]) {
            const raw = String(value || '').trim();
            if (!raw) {
                continue;
            }

            candidates.add(raw);
            const normalized = this.normalizePromptSearchText(raw);
            if (normalized) {
                candidates.add(normalized);
            }
        }

        return Array.from(candidates);
    }

    createBasicPromptSearchClauses(searchValue) {
        const value = String(searchValue || '').trim();
        return value
            ? [[{
                negated: false,
                scope: PROMPT_SEARCH_SCOPES.ALL,
                term: value,
            }]]
            : [];
    }

    tokenizePromptSearchQuery(searchValue) {
        const tokens = [];
        let current = '';
        let inQuotes = false;
        let escapeNext = false;

        const pushCurrentToken = () => {
            const value = current.trim();
            if (value) {
                tokens.push(value);
            }
            current = '';
        };

        for (const character of String(searchValue || '')) {
            if (escapeNext) {
                current += character;
                escapeNext = false;
                continue;
            }

            if (character === '\\' && inQuotes) {
                escapeNext = true;
                continue;
            }

            if (character === '"') {
                inQuotes = !inQuotes;
                continue;
            }

            if (!inQuotes && character === '|') {
                pushCurrentToken();
                tokens.push('|');
                continue;
            }

            if (!inQuotes && /\s/.test(character)) {
                pushCurrentToken();
                continue;
            }

            current += character;
        }

        pushCurrentToken();
        return tokens;
    }

    isPromptSearchOrToken(token) {
        return token === '|' || /^or$/i.test(String(token || '').trim());
    }

    isPromptSearchAndToken(token) {
        return /^and$/i.test(String(token || '').trim());
    }

    parsePromptSearchToken(token, nextToken = '') {
        let value = String(token || '').trim();
        let consumeNextToken = false;

        if (!value) {
            return null;
        }

        let negated = false;
        if (value.startsWith('-') && value.length > 1) {
            negated = true;
            value = value.slice(1).trim();
        }

        if (!value) {
            return null;
        }

        let scope = PROMPT_SEARCH_SCOPES.ALL;
        const scopedMatch = value.match(/^([a-z_]+):(.*)$/i);
        if (scopedMatch) {
            const scopeValue = PROMPT_SEARCH_SCOPE_ALIASES[String(scopedMatch[1] || '').trim().toLowerCase()];
            if (scopeValue) {
                scope = scopeValue;
                value = String(scopedMatch[2] || '').trim();

                if (!value) {
                    const fallbackToken = String(nextToken || '').trim();
                    if (fallbackToken && !this.isPromptSearchOrToken(fallbackToken) && !this.isPromptSearchAndToken(fallbackToken)) {
                        value = fallbackToken;
                        consumeNextToken = true;
                    }
                }
            }
        }

        value = value.trim();
        if (!value) {
            return null;
        }

        return {
            term: {
                negated,
                scope,
                term: value,
            },
            consumeNextToken,
        };
    }

    parsePromptSearchQuery(searchValue, { advancedSyntax = false } = {}) {
        if (!advancedSyntax) {
            return this.createBasicPromptSearchClauses(searchValue);
        }

        const tokens = this.tokenizePromptSearchQuery(searchValue);
        const clauses = [];
        let currentClause = [];

        const pushClause = () => {
            if (currentClause.length > 0) {
                clauses.push(currentClause);
            }
            currentClause = [];
        };

        for (let index = 0; index < tokens.length; index++) {
            const token = tokens[index];

            if (this.isPromptSearchOrToken(token)) {
                pushClause();
                continue;
            }

            if (this.isPromptSearchAndToken(token)) {
                continue;
            }

            const parsedToken = this.parsePromptSearchToken(token, tokens[index + 1]);
            if (!parsedToken) {
                continue;
            }

            currentClause.push(parsedToken.term);
            if (parsedToken.consumeNextToken) {
                index += 1;
            }
        }

        pushClause();
        return clauses;
    }

    /**
     * Extracts placeholder identifiers from prompt content.
     * @param {string} content
     * @returns {string[]}
     */
    extractPromptPlaceholders(content) {
        const placeholders = new Set();
        const text = String(content || '');

        for (const match of text.matchAll(PROMPT_PLACEHOLDER_REGEX)) {
            const identifier = String(match[1] || '').trim();
            if (identifier) {
                placeholders.add(identifier);
            }
        }

        return Array.from(placeholders);
    }

    /**
     * Builds human-readable aliases for a prompt identifier.
     * @param {string} identifier
     * @returns {string[]}
     */
    getPromptSearchAliases(identifier) {
        const aliases = new Set();
        const normalizedIdentifier = String(identifier || '').trim();

        if (!normalizedIdentifier) {
            return [];
        }

        aliases.add(normalizedIdentifier);
        aliases.add(this.normalizePromptSearchText(normalizedIdentifier));

        const prompt = this.getPromptById(normalizedIdentifier);
        if (prompt?.name) {
            aliases.add(String(prompt.name));
            aliases.add(this.normalizePromptSearchText(prompt.name));
        }

        const sourceName = this.promptSources[normalizedIdentifier];
        if (sourceName) {
            aliases.add(String(sourceName));
            aliases.add(this.normalizePromptSearchText(sourceName));
        }

        return Array.from(aliases).filter(Boolean);
    }

    /**
     * Gets runtime messages currently associated with a prompt in the active chat completion.
     * For marker prompts like chat history, this returns the actual inspected messages.
     * @param {Prompt} prompt
     * @returns {import('./openai.js').Message[]}
     */
    getPromptRuntimeMessages(prompt) {
        if (!prompt?.identifier || !this.messages?.hasItemWithIdentifier(prompt.identifier)) {
            return [];
        }

        const item = this.messages.getItemByIdentifier(prompt.identifier);
        if (!item) {
            return [];
        }

        if (item instanceof MessageCollection) {
            return item.flatten();
        }

        if (item instanceof Message) {
            return [item];
        }

        return [];
    }

    getPromptSearchFields(prompt) {
        const runtimeMessages = this.getPromptRuntimeMessages(prompt);
        const placeholderCandidates = [];
        for (const placeholder of this.extractPromptPlaceholders(prompt?.content)) {
            placeholderCandidates.push(placeholder, ...this.getPromptSearchAliases(placeholder));
        }

        return {
            nameCandidates: this.normalizePromptSearchCandidateValues([
                prompt?.name,
                ...runtimeMessages.map(message => message?.name),
            ]),
            contentCandidates: this.normalizePromptSearchCandidateValues([
                prompt?.content,
                ...runtimeMessages.map(message => message?.content),
            ]),
            placeholderCandidates: this.normalizePromptSearchCandidateValues(placeholderCandidates),
            identifierCandidates: this.normalizePromptSearchCandidateValues([
                prompt?.identifier,
                ...runtimeMessages.map(message => message?.identifier),
            ]),
            roleCandidates: this.normalizePromptSearchCandidateValues([
                prompt?.role,
                ...runtimeMessages.map(message => message?.role),
            ]),
            sourceCandidates: this.normalizePromptSearchCandidateValues(this.promptSources[prompt?.identifier]),
        };
    }

    getPromptMessageSearchFields(message) {
        const placeholderCandidates = this.extractPromptPlaceholders(message?.content).flatMap((placeholder) => [
            placeholder,
            ...this.getPromptSearchAliases(placeholder),
        ]);

        return {
            nameCandidates: this.normalizePromptSearchCandidateValues(message?.name),
            contentCandidates: this.normalizePromptSearchCandidateValues(message?.content),
            placeholderCandidates: this.normalizePromptSearchCandidateValues(placeholderCandidates),
            identifierCandidates: this.normalizePromptSearchCandidateValues(message?.identifier),
            roleCandidates: this.normalizePromptSearchCandidateValues(message?.role),
            sourceCandidates: [],
        };
    }

    getPromptSearchCandidatesForScope(fields, scope) {
        switch (scope) {
            case PROMPT_SEARCH_SCOPES.NAME:
                return fields.nameCandidates;
            case PROMPT_SEARCH_SCOPES.CONTENT:
                return fields.contentCandidates;
            case PROMPT_SEARCH_SCOPES.PLACEHOLDER:
                return fields.placeholderCandidates;
            case PROMPT_SEARCH_SCOPES.IDENTIFIER:
                return fields.identifierCandidates;
            case PROMPT_SEARCH_SCOPES.ROLE:
                return fields.roleCandidates;
            case PROMPT_SEARCH_SCOPES.SOURCE:
                return fields.sourceCandidates;
            default:
                return [
                    ...fields.nameCandidates,
                    ...fields.contentCandidates,
                    ...fields.placeholderCandidates,
                    ...fields.identifierCandidates,
                    ...fields.roleCandidates,
                    ...fields.sourceCandidates,
                ];
        }
    }

    matchesPromptSearchTerm(fields, term) {
        const candidates = this.getPromptSearchCandidatesForScope(fields, term.scope);
        return candidates.some(candidate => includesIgnoreCaseAndAccents(candidate, term.term));
    }

    matchesPromptSearchClause(fields, clause) {
        let positiveTerms = 0;

        for (const term of clause) {
            const isMatched = this.matchesPromptSearchTerm(fields, term);
            if (term.negated) {
                if (isMatched) {
                    return false;
                }
                continue;
            }

            if (!isMatched) {
                return false;
            }

            positiveTerms += 1;
        }

        return positiveTerms > 0 || clause.every(term => term.negated);
    }

    matchesPromptSearchFields(fields, clauses) {
        if (!Array.isArray(clauses) || clauses.length === 0) {
            return false;
        }

        return clauses.some(clause => this.matchesPromptSearchClause(fields, clause));
    }

    buildPromptSearchSyntaxHelpHtml() {
        const basicRows = [
            {
                query: 'chat history',
                description: t`Default prompt search looks for the exact text chat history.`,
            },
            {
                query: 'name:main',
                description: t`With Advanced syntax off, this searches the literal text name:main.`,
            },
        ];
        const advancedRows = [
            {
                query: 'jailbreak main',
                description: t`With Advanced syntax enabled, space-separated terms use AND. Both terms must match.`,
            },
            {
                query: '"chat history"',
                description: t`Quoted text matches an exact phrase.`,
            },
            {
                query: '-system',
                description: t`Prefix a term with - to exclude matches.`,
            },
            {
                query: 'name:jailbreak content:"Stay in character"',
                description: t`Scope a term to prompt name or content.`,
            },
            {
                query: 'placeholder:chatHistory role:system',
                description: t`Scope a term to placeholders or roles.`,
            },
            {
                query: 'id:main source:character',
                description: t`Scope a term to identifiers or source labels.`,
            },
        ];

        const syntaxHeader = escapeHtml(t`Syntax`);
        const effectHeader = escapeHtml(t`Effect`);
        const buildTableRows = (rows) => rows.map((row) => `
            <tr>
                <td data-label="${syntaxHeader}"><code>${escapeHtml(row.query)}</code></td>
                <td data-label="${effectHeader}">${escapeHtml(row.description)}</td>
            </tr>
        `).join('');

        return `
            <div class="prompt_manager_search_syntax_help">
                <p>${escapeHtml(t`Prompt Search defaults to direct whole-query matching across prompt names, identifiers, placeholders, content, sources, and runtime messages.`)}</p>
                <section class="prompt_manager_search_syntax_section">
                    <h4>${escapeHtml(t`Default behavior`)}</h4>
                    <div class="prompt_manager_search_syntax_table_wrap">
                        <table class="prompt_manager_search_syntax_table">
                            <thead>
                                <tr>
                                    <th>${syntaxHeader}</th>
                                    <th>${effectHeader}</th>
                                </tr>
                            </thead>
                            <tbody>${buildTableRows(basicRows)}</tbody>
                        </table>
                    </div>
                </section>
                <p>${escapeHtml(t`Enable Advanced syntax to use operators and field prefixes.`)}</p>
                <p>${escapeHtml(t`name: searches prompt names. content: searches prompt and runtime message content. placeholder: searches placeholder identifiers. id: searches prompt or runtime identifiers. role: searches prompt and runtime roles. source: searches the prompt source label.`)}</p>
                <section class="prompt_manager_search_syntax_section">
                    <h4>${escapeHtml(t`Advanced behavior`)}</h4>
                    <div class="prompt_manager_search_syntax_table_wrap">
                        <table class="prompt_manager_search_syntax_table">
                            <thead>
                                <tr>
                                    <th>${syntaxHeader}</th>
                                    <th>${effectHeader}</th>
                                </tr>
                            </thead>
                            <tbody>${buildTableRows(advancedRows)}</tbody>
                        </table>
                    </div>
                </section>
                <p>${escapeHtml(t`Aliases: title: maps to name:. text: and body: map to content:. placeholders: and ph: map to placeholder:. identifier: maps to id.`)}</p>
            </div>
        `;
    }

    async showPromptSearchSyntaxHelp() {
        await Popup.show.text(
            t`Prompt Search Syntax`,
            this.buildPromptSearchSyntaxHelpHtml(),
            {
                okButton: t`Close`,
                wide: true,
                allowVerticalScrolling: true,
            },
        );
    }

    updatePromptSearchInputState() {
        if (!this.containerElement) {
            return;
        }

        const { prefix } = this.configuration;
        const searchInput = /** @type {HTMLInputElement|null} */ (this.containerElement.querySelector(`#${prefix}prompt_manager_search`));
        const advancedInput = /** @type {HTMLInputElement|null} */ (this.containerElement.querySelector(`#${prefix}prompt_manager_search_advanced`));
        const advancedSyntax = Boolean(this.promptListSearchAdvancedSyntax);

        if (searchInput) {
            searchInput.placeholder = advancedSyntax ? t`Advanced prompt search...` : t`Search prompts or placeholders...`;
            searchInput.title = advancedSyntax
                ? t`Advanced prompt search over names, content, placeholders, identifiers, sources, and roles. Supports name:, content:, placeholder:, id:, source:, role:, quotes, -, and OR.`
                : t`Direct prompt search over names, content, placeholders, identifiers, sources, and roles. Enable Advanced syntax for operators like name:, OR, -, and quotes.`;
        }

        if (advancedInput) {
            advancedInput.checked = advancedSyntax;
        }
    }

    /**
     * Highlights raw query matches in text for inspect drawers.
     * Falls back to plain escaped text when the current match only exists after normalization.
     * @param {string} value
     * @param {string} searchQuery
     * @returns {string}
     */
    highlightPromptSearchText(value, searchQuery) {
        const raw = String(value || '');
        const query = String(searchQuery || '').trim();

        if (!query) {
            return escapeHtml(raw);
        }

        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const matcher = new RegExp(`(${escapedQuery})`, 'ig');

        if (!matcher.test(raw)) {
            return escapeHtml(raw);
        }

        matcher.lastIndex = 0;
        return escapeHtml(raw).replace(matcher, '<mark>$1</mark>');
    }

    /**
     * Finds and returns the index of a prompt by its identifier.
     * @param {string} identifier - Identifier of the prompt
     * @returns {number|null} Index of the prompt, or null if not found
     */
    getPromptIndexById(identifier) {
        return this.serviceSettings.prompts.findIndex(item => item.identifier === identifier) ?? null;
    }

    /**
     * Enriches a generic object, creating a new prompt object in the process
     *
     * @param {Partial<Prompt>} prompt - Prompt object
     * @param original
     * @returns {Prompt} An object with "role" and "content" properties
     */
    preparePrompt(prompt, original = null) {
        const groupMembers = this.getActiveGroupCharacters();
        const preparedPrompt = new Prompt(prompt);

        if (typeof original === 'string') {
            if (0 < groupMembers.length) preparedPrompt.content = substituteParams(prompt.content ?? '', { original, groupOverride: groupMembers.join(', ') });
            else preparedPrompt.content = substituteParams(prompt.content, { original });
        } else {
            if (0 < groupMembers.length) preparedPrompt.content = substituteParams(prompt.content ?? '', { groupOverride: groupMembers.join(', ') });
            else preparedPrompt.content = substituteParams(prompt.content);
        }

        return preparedPrompt;
    }

    /**
     * Factory function for creating a QuickEdit object associated with a prompt element.
     *
     * The QuickEdit object provides methods to synchronize an input element's value with a prompt's content
     * and handle input events to update the prompt content.
     *
     */
    createQuickEdit(identifier, title) {
        const prompt = this.getPromptById(identifier);
        const textareaIdentifier = `${identifier}_prompt_quick_edit_textarea`;
        const html = `<div class="range-block m-t-1">
                        <div class="justifyLeft">${title}</div>
                        <div class="wide100p">
                            <textarea id="${textareaIdentifier}" class="text_pole textarea_compact" rows="6" placeholder="">${prompt.content}</textarea>
                        </div>
                    </div>`;

        const quickEditContainer = document.getElementById('quick-edit-container');
        quickEditContainer.insertAdjacentHTML('afterbegin', html);

        const debouncedSaveServiceSettings = debouncePromise(() => this.saveServiceSettings(), 300);

        const textarea = /** @type {HTMLTextAreaElement} */(document.getElementById(textareaIdentifier));
        textarea.addEventListener('blur', () => {
            prompt.content = textarea.value;
            this.updatePromptByIdentifier(identifier, prompt);
            debouncedSaveServiceSettings().then(() => this.render());
        });
    }

    /**
     * Updates the quick edit textarea for a specific prompt.
     * @param {string} identifier - The identifier of the prompt.
     * @param {Prompt} prompt - The updated prompt object.
     * @returns {string} The ID of the updated textarea element.
     */
    updateQuickEdit(identifier, prompt) {
        const elementId = `${identifier}_prompt_quick_edit_textarea`;
        const textarea = /** @type {HTMLTextAreaElement} */(document.getElementById(elementId));
        textarea.value = prompt.content;

        return elementId;
    }

    /**
     * Checks if a given name is accepted by OpenAi API
     * @link https://platform.openai.com/docs/api-reference/chat/create
     *
     * @param name
     * @returns {boolean}
     */
    isValidName(name) {
        const regex = /^[a-zA-Z0-9_]{1,64}$/;

        return regex.test(name);
    }

    sanitizeName(name) {
        return name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 64);
    }

    /**
     * Loads a given prompt into the edit form fields.
     * @param {Partial<Prompt>} prompt - Prompt object with properties 'name', 'role', 'content', and 'system_prompt'
     */
    loadPromptIntoEditForm(prompt) {
        const nameField = /** @type {HTMLTextAreaElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_name'));
        const roleField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_role'));
        const promptField = /** @type {HTMLTextAreaElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_prompt'));
        const injectionPositionField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_position'));
        const injectionDepthField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_depth'));
        const injectionOrderField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_order'));
        const injectionTriggerField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_trigger'));
        const injectionDepthBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_depth_block'));
        const injectionOrderBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_order_block'));
        const attachBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_attach_block'));
        const attachRoleField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_attach_role'));
        const attachIndexField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_attach_index'));
        const attachSideField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_attach_side'));
        const forbidOverridesField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_forbid_overrides'));
        const forbidOverridesBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_forbid_overrides_block'));
        const pluginExtraField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_plugin_extra'));
        const entrySourceBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_source_block'));
        const entrySource = /** @type {HTMLSpanElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_source'));
        const isPulledPrompt = Object.keys(this.promptSources).includes(prompt.identifier);

        const injectionPosition = getPromptInjectionPosition(prompt);

        nameField.value = prompt.name ?? '';
        if (!CSS.supports('field-sizing', 'content')) {
            void resetScrollHeight(nameField);
        }
        roleField.value = prompt.role || 'system';
        promptField.value = prompt.content ?? '';
        promptField.disabled = prompt.marker ?? false;
        injectionPositionField.value = injectionPosition.toString();
        injectionDepthField.value = (prompt.injection_depth ?? DEFAULT_DEPTH).toString();
        injectionOrderField.value = (prompt.injection_order ?? DEFAULT_ORDER).toString();
        Array.from(injectionTriggerField.options).forEach(option => {
            option.selected = Array.isArray(prompt.injection_trigger) && prompt.injection_trigger.includes(option.value);
        });
        injectionTriggerField.dispatchEvent(new Event('change', { bubbles: true }));
        setInjectionDepthOrderDisplay(injectionDepthBlock, injectionOrderBlock, injectionPosition === INJECTION_POSITION.ABSOLUTE);
        attachBlock.style.display = injectionPosition === INJECTION_POSITION.ATTACH_EXISTING ? 'flex' : 'none';
        attachRoleField.value = prompt.attach_role ?? 'user';
        attachIndexField.value = (prompt.attach_index ?? 1).toString();
        attachSideField.value = prompt.attach_side ?? 'end';
        injectionPositionField.removeAttribute('disabled');
        forbidOverridesField.checked = prompt.forbid_overrides ?? false;
        forbidOverridesBlock.style.visibility = this.overridablePrompts.includes(prompt.identifier) ? 'visible' : 'hidden';
        pluginExtraField.checked = Boolean(prompt.plugin_extra);
        entrySourceBlock.style.display = isPulledPrompt ? '' : 'none';

        if (isPulledPrompt) {
            const sourceName = this.promptSources[prompt.identifier];
            entrySource.textContent = sourceName;
        }

        const resetPromptButton = document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_reset');
        if (true === prompt.system_prompt) {
            resetPromptButton.style.display = 'block';
            resetPromptButton.dataset.pmPrompt = prompt.identifier;
        } else {
            resetPromptButton.style.display = 'none';
        }

        injectionPositionField.removeEventListener('change', (e) => this.handleInjectionPositionChange(e));
        injectionPositionField.addEventListener('change', (e) => this.handleInjectionPositionChange(e));

        const savePromptButton = document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_save');
        savePromptButton.dataset.pmPrompt = prompt.identifier;
    }

    handleInjectionPositionChange(event) {
        const injectionDepthBlock = document.getElementById(this.configuration.prefix + 'prompt_manager_depth_block');
        const injectionOrderBlock = document.getElementById(this.configuration.prefix + 'prompt_manager_order_block');
        const attachBlock = document.getElementById(this.configuration.prefix + 'prompt_manager_attach_block');
        const injectionPosition = Number(event.target.value);
        if (injectionPosition === INJECTION_POSITION.ABSOLUTE) {
            setInjectionDepthOrderDisplay(injectionDepthBlock, injectionOrderBlock, true);
            attachBlock.style.display = 'none';
        } else if (injectionPosition === INJECTION_POSITION.ATTACH_EXISTING) {
            setInjectionDepthOrderDisplay(injectionDepthBlock, injectionOrderBlock, false);
            attachBlock.style.display = 'flex';
        } else {
            setInjectionDepthOrderDisplay(injectionDepthBlock, injectionOrderBlock, false);
            attachBlock.style.display = 'none';
        }
    }

    /**
     * Loads a given prompt into the inspect form
     * @param {MessageCollection} messages - Prompt object with properties 'name', 'role', 'content', and 'system_prompt'
     */
    loadMessagesIntoInspectForm(messages) {
        if (!messages) return;

        const searchQuery = String(this.promptListSearchQuery || '').trim();
        const advancedSyntax = Boolean(this.promptListSearchAdvancedSyntax);
        const searchClauses = this.parsePromptSearchQuery(searchQuery, { advancedSyntax });
        const highlightQuery = advancedSyntax ? '' : searchQuery;

        const createInlineDrawer = (message) => {
            const content = String(message.content || 'No Content');
            const truncatedTitle = content.length > 32 ? content.slice(0, 32) + '...' : content;
            const title = String(message.identifier || truncatedTitle);
            const role = String(message.role || '');
            const tokens = message.getTokens();
            const isMatched = this.matchesPromptSearchFields(this.getPromptMessageSearchFields(message), searchClauses);
            const matchedBadge = isMatched ? `<small class="prompt-manager-search-hit-badge">${escapeHtml(t`Match`)}</small>` : '';
            const highlightedTitle = this.highlightPromptSearchText(title, highlightQuery);
            const highlightedRole = this.highlightPromptSearchText(role, highlightQuery);
            const highlightedContent = this.highlightPromptSearchText(content, highlightQuery);

            let drawerHTML = `
        <div class="inline-drawer ${this.configuration.prefix}prompt_manager_prompt ${isMatched ? `${this.configuration.prefix}prompt_manager_search_hit` : ''}">
            <div class="inline-drawer-toggle inline-drawer-header">
                <span>Name: ${highlightedTitle}, Role: ${highlightedRole}, Tokens: ${tokens} ${matchedBadge}</span>
                <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
            </div>
            <div class="inline-drawer-content" style="white-space: pre-wrap;">${highlightedContent}</div>
        </div>
        `;

            let template = document.createElement('template');
            template.innerHTML = drawerHTML.trim();
            const drawer = /** @type {HTMLElement} */(template.content.firstChild);
            if (isMatched) {
                toggleDrawer(drawer, true);
            }
            return drawer;
        };

        const messageList = document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_inspect_list');

        const messagesCollection = messages instanceof Message ? [messages] : messages.flatten();

        if (0 === messagesCollection.length) messageList.innerHTML = '<span>This marker does not contain any prompts.</span>';

        messagesCollection.forEach(message => {
            messageList.append(createInlineDrawer(message));
        });
    }

    /**
     * Clears all input fields in the edit form.
     */
    clearEditForm() {
        const editArea = document.getElementById(this.configuration.prefix + 'prompt_manager_popup_edit');
        editArea.style.display = 'none';

        const nameField = /** @type {HTMLTextAreaElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_name'));
        const roleField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_role'));
        const promptField = /** @type {HTMLTextAreaElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_prompt'));
        const injectionPositionField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_position'));
        const injectionDepthField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_depth'));
        const injectionDepthBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_depth_block'));
        const injectionOrderBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_order_block'));
        const injectionOrderField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_order'));
        const injectionTriggerField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_injection_trigger'));
        const attachBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_attach_block'));
        const attachRoleField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_attach_role'));
        const attachIndexField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_attach_index'));
        const attachSideField = /** @type {HTMLSelectElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_attach_side'));
        const forbidOverridesField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_forbid_overrides'));
        const forbidOverridesBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_forbid_overrides_block'));
        const pluginExtraField = /** @type {HTMLInputElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_plugin_extra'));
        const entrySourceBlock = /** @type {HTMLDivElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_source_block'));
        const entrySource = /** @type {HTMLSpanElement} */(document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_source'));

        nameField.value = '';
        if (!CSS.supports('field-sizing', 'content')) {
            void resetScrollHeight(nameField);
        }
        roleField.selectedIndex = 0;
        promptField.value = '';
        promptField.disabled = false;
        injectionPositionField.selectedIndex = 0;
        injectionPositionField.removeAttribute('disabled');
        injectionDepthField.value = DEFAULT_DEPTH.toString();
        injectionOrderField.value = DEFAULT_ORDER.toString();
        injectionTriggerField.value = '';
        setInjectionDepthOrderDisplay(injectionDepthBlock, injectionOrderBlock, true);
        attachBlock.style.display = 'none';
        attachRoleField.value = 'user';
        attachIndexField.value = '1';
        attachSideField.value = 'end';
        forbidOverridesBlock.style.visibility = 'unset';
        forbidOverridesField.checked = false;
        pluginExtraField.checked = false;
        entrySourceBlock.style.display = 'none';
        entrySource.textContent = '';

        roleField.disabled = false;
    }

    clearInspectForm() {
        const inspectArea = document.getElementById(this.configuration.prefix + 'prompt_manager_popup_inspect');
        inspectArea.style.display = 'none';
        const messageList = document.getElementById(this.configuration.prefix + 'prompt_manager_popup_entry_form_inspect_list');
        messageList.innerHTML = '';
    }

    /**
     * Returns a full list of prompts whose content markers have been substituted.
     * @param {string} generationType - The type of generation, e.g., 'continue' or 'quiet'.
     * @returns {PromptCollection} A PromptCollection object
     */
    getPromptCollection(generationType) {
        generationType = String(generationType || 'normal').toLowerCase().trim();
        const promptCollection = new PromptCollection();
        const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);

        promptOrder.forEach(entry => {
            const prompt = this.getPromptById(entry.identifier);
            const allowedTrigger = entry.enabled && this.shouldTrigger(prompt, generationType);

            if (!prompt) {
                return;
            }

            if (allowedTrigger) {
                promptCollection.add(this.preparePrompt(prompt));
            } else if (entry.identifier === 'main') {
                // Some extensions require main prompt to be present for relative inserts.
                // So we make a GMO-free vegan replacement.
                const replacementPrompt = structuredClone(prompt);
                replacementPrompt.content = '';
                promptCollection.add(this.preparePrompt(replacementPrompt));
            }
        });

        return promptCollection;
    }

    /**
     * Checks if a prompt should be triggered based on its injection triggers.
     * @param {Prompt} prompt - The prompt to check.
     * @param {string} generationType - The type of generation to check against.
     * @returns {boolean} True if the prompt should be triggered, false otherwise.
     */
    shouldTrigger(prompt, generationType) {
        if (!Array.isArray(prompt?.injection_trigger)) return true;
        if (!prompt.injection_trigger.length) return true;
        return prompt.injection_trigger.includes(generationType);
    }

    /**
     * Setter for messages property
     *
     * @param {import('./openai.js').MessageCollection} messages
     */
    setMessages(messages) {
        this.messages = messages;
    }

    /**
     * Set and process a finished chat completion object
     *
     * @param {import('./openai.js').ChatCompletion} chatCompletion
     */
    setChatCompletion(chatCompletion) {
        const messages = chatCompletion.getMessages();

        this.setMessages(messages);
        this.populateTokenCounts(messages);
        this.overriddenPrompts = chatCompletion.getOverriddenPrompts();
    }

    /**
     * Populates the token handler
     *
     * @param {import('./openai.js').MessageCollection} messages
     */
    populateTokenCounts(messages) {
        this.tokenHandler.resetCounts();
        const counts = this.tokenHandler.getCounts();
        messages.getCollection().forEach(message => {
            counts[message.identifier] = message.getTokens();
        });

        this.tokenUsage = this.tokenHandler.getTotal();

        this.log('Updated token usage with ' + this.tokenUsage);
    }

    /**
     * Empties, then re-assembles the container containing the prompt list.
     */
    async renderPromptManager() {
        let selectedPromptIndex = 0;
        const existingAppendSelect = document.getElementById(`${this.configuration.prefix}prompt_manager_footer_append_prompt`);
        if (existingAppendSelect instanceof HTMLSelectElement) {
            selectedPromptIndex = existingAppendSelect.selectedIndex;
        }
        // Drop any prior Sortable instance before wiping the container —
        // jQuery UI Sortable stashes refs to the old <li> nodes inside its
        // own instance, so a bare innerHTML='' (followed by makeDraggable()
        // on the freshly-built list) leaves the previous render's DOM alive
        // as detached nodes. Heap snapshots showed 228 stale drag handles.
        // Must run while the old list is still attached so jQuery can find it.
        const $existingList = $(`#${this.configuration.prefix}prompt_manager_list`);
        // @ts-ignore
        if ($existingList.length && $existingList.sortable('instance') !== undefined) {
            // @ts-ignore
            $existingList.sortable('destroy');
        }
        const promptManagerDiv = this.containerElement;
        promptManagerDiv.innerHTML = '';

        const errorDiv = this.error ? `
                <div class="${this.configuration.prefix}prompt_manager_error">
                    <span class="fa-solid tooltip fa-triangle-exclamation text_danger"></span> ${DOMPurify.sanitize(this.error)}
                </div>
        ` : '';

        const totalActiveTokens = this.tokenUsage;

        const headerHtml = await renderTemplateAsync('promptManagerHeader', { error: this.error, errorDiv, prefix: this.configuration.prefix, totalActiveTokens });
        promptManagerDiv.insertAdjacentHTML('beforeend', headerHtml);

        const { prefix } = this.configuration;
        const searchInput = /** @type {HTMLInputElement|null} */(promptManagerDiv.querySelector(`#${prefix}prompt_manager_search`));
        const searchHelpButton = /** @type {HTMLButtonElement|null} */(promptManagerDiv.querySelector(`#${prefix}prompt_manager_search_help`));
        const searchAdvancedInput = /** @type {HTMLInputElement|null} */(promptManagerDiv.querySelector(`#${prefix}prompt_manager_search_advanced`));
        if (searchInput) {
            searchInput.value = this.promptListSearchQuery;
            searchInput.addEventListener('input', (event) => {
                if (!(event.target instanceof HTMLInputElement)) {
                    return;
                }
                this.promptListSearchQuery = String(event.target.value || '');
                this.renderPromptManagerListItems();
            });
        }
        if (searchHelpButton) {
            searchHelpButton.addEventListener('click', async () => {
                await this.showPromptSearchSyntaxHelp();
            });
        }
        if (searchAdvancedInput) {
            searchAdvancedInput.checked = Boolean(this.promptListSearchAdvancedSyntax);
            searchAdvancedInput.addEventListener('change', (event) => {
                if (!(event.target instanceof HTMLInputElement)) {
                    return;
                }
                this.promptListSearchAdvancedSyntax = Boolean(event.target.checked);
                this.updatePromptSearchInputState();
                this.renderPromptManagerListItems();
            });
        }
        this.updatePromptSearchInputState();

        this.listElement = promptManagerDiv.querySelector(`#${prefix}prompt_manager_list`);

        if (null !== this.activeCharacter) {
            const prompts = [...this.serviceSettings.prompts]
                .filter(prompt => prompt && !prompt?.system_prompt)
                .sort((promptA, promptB) => promptA.name.localeCompare(promptB.name));
            const promptsHtml = prompts.reduce((acc, prompt) => acc + `<option value="${prompt.identifier}">${escapeHtml(prompt.name)}</option>`, '');

            if (selectedPromptIndex > 0) {
                selectedPromptIndex = Math.min(selectedPromptIndex, prompts.length - 1);
            }

            if (selectedPromptIndex === -1 && prompts.length) {
                selectedPromptIndex = 0;
            }

            const rangeBlockDiv = promptManagerDiv.querySelector('.range-block');
            const headerDiv = promptManagerDiv.querySelector('.completion_prompt_manager_header');
            const footerHtml = await renderTemplateAsync('promptManagerFooter', { promptsHtml, prefix: this.configuration.prefix });
            headerDiv.insertAdjacentHTML('afterend', footerHtml);
            rangeBlockDiv.querySelector('#prompt-manager-reset-character').addEventListener('click', this.handleCharacterReset);

            const footerDiv = rangeBlockDiv.querySelector(`.${this.configuration.prefix}prompt_manager_footer`);
            footerDiv.querySelector('.menu_button:nth-child(2)').addEventListener('click', this.handleAppendPrompt);
            footerDiv.querySelector('.caution').addEventListener('click', this.handleDeletePrompt);
            footerDiv.querySelector('.menu_button:last-child').addEventListener('click', this.handleNewPrompt);
            footerDiv.querySelector('select').selectedIndex = selectedPromptIndex;

            // Add prompt export dialogue and options
            footerDiv.querySelector('#prompt-manager-import').addEventListener('click', this.handleImport);
            footerDiv.querySelector('#prompt-manager-export').addEventListener('click', this.handleFullExport);
        }

        // Bind group edit button in header
        const groupBtn = promptManagerDiv.querySelector(`#${prefix}prompt_manager_group_btn`);
        if (groupBtn) {
            groupBtn.addEventListener('click', () => {
                if (this._groupEditMode) {
                    this.exitGroupEditMode();
                } else {
                    this.enterGroupEditMode();
                }
            });
        }
    }

    /**
     * Build the HTML for a group header row.
     * @param {object} group - The group object
     * @returns {string}
     */
    buildGroupHeaderHtml(group) {
            const tokenSum = this.getGroupTokenCount(group.id);
            const displayTokens = tokenSum || '-';
            const expandedClass = group.collapsed ? '' : 'expanded';
            const depth = this.getGroupDepth(group.id);
            const indentPx = depth * 24;
            const entries = group.identifiers.map(id => this.getPromptOrderEntry(this.activeCharacter, id)).filter(Boolean);
            const allEnabled = entries.length > 0 && entries.every(e => e.enabled);
            const toggleAllClass = allEnabled ? 'fa-toggle-on all-enabled' : 'fa-toggle-off';
            const parentIdAttr = group.parentId ? ` data-pm-parent-id="${escapeHtml(group.parentId)}"` : '';

            return `
            <li class="prompt-manager-group ${expandedClass}" data-pm-group-id="${escapeHtml(group.id)}"${parentIdAttr} data-depth="${depth}" style="--group-indent:${indentPx}px">
        <span class="prompt-manager-group-toggle fa-solid fa-chevron-right"></span>
        <span class="prompt-manager-group-info">
            <span class="prompt-manager-group-icon fa-solid fa-folder"></span>
            <span class="prompt-manager-group-name">${escapeHtml(group.name)}</span>
            <span class="prompt-manager-group-count">(${group.identifiers.length})</span>
        </span>
        <span class="prompt-manager-group-actions">
            <span class="prompt-manager-group-rename fa-solid fa-pencil fa-xs" title="Rename group" data-i18n="[title]Rename group"></span>
            <span class="prompt-manager-group-subgroup fa-solid fa-folder-plus fa-xs" title="Create sub-group" data-i18n="[title]Create sub-group"></span>
            <span class="prompt-manager-group-ungroup fa-solid fa-object-ungroup fa-xs" title="Ungroup" data-i18n="[title]Ungroup"></span>
            <span class="prompt-manager-group-toggle-all fa-solid ${toggleAllClass}" title="Toggle all in group" data-i18n="[title]Toggle all in group"></span>
        </span>
        <span class="prompt-manager-group-tokens">${displayTokens}</span>
    </li>
    `;
    }

    /**
     * Empties, then re-assembles the prompt list.
     * Now supports prompt groups: inserts group headers and handles collapsed state.
     *
     * Debounced via requestAnimationFrame: multiple calls within one frame
     * are collapsed into a single render, avoiding redundant DOM rebuilds
     * when triggered by cascading state changes (e.g. model switch →
     * settings refresh → prompt list update).
     */
    async renderPromptManagerListItems() {
        if (!this.serviceSettings.prompts) return;
        if (this._rlrafId) {
            cancelAnimationFrame(this._rlrafId);
            this._rlrafId = null;
            // Settle any previously-awaiting caller so it doesn't hang forever
            // now that its RAF has been superseded.
            if (this._rlrafResolve) {
                const prev = this._rlrafResolve;
                this._rlrafResolve = null;
                prev();
            }
        }
        return new Promise(resolve => {
            this._rlrafResolve = resolve;
            this._rlrafId = requestAnimationFrame(async () => {
                this._rlrafId = null;
                try {
                    await this._renderPromptManagerListItemsImpl();
                } finally {
                    const r = this._rlrafResolve;
                    this._rlrafResolve = null;
                    if (r) r();
                }
            });
        });
    }

    /**
     * Internal: performs the actual DOM rebuild.
     * Do not call directly — use renderPromptManagerListItems().
     */
    async _renderPromptManagerListItemsImpl() {
        if (!this.serviceSettings.prompts) return;

        // Validate groups before rendering
        this.validateGroups();

        const promptManagerList = this.listElement;
        promptManagerList.innerHTML = '';

        const { prefix } = this.configuration;
        let listItemHtml = await renderTemplateAsync('promptManagerListHeader', { prefix });

        const searchQuery = String(this.promptListSearchQuery || '').trim();
        const searchClauses = this.parsePromptSearchQuery(searchQuery, {
            advancedSyntax: Boolean(this.promptListSearchAdvancedSyntax),
        });

        // In group edit mode, render differently
        if (this._groupEditMode) {
            listItemHtml += this.renderGroupEditModeList(searchQuery, searchClauses);
            promptManagerList.insertAdjacentHTML('beforeend', listItemHtml);
            this.setupListEventDelegation(promptManagerList);
            this._applyGroupEditCollapsedState();
            return;
        }

        const visiblePrompts = this.getPromptsForCharacter(this.activeCharacter)
            .filter(prompt => {
                if (!prompt) return false;
                if (!searchQuery) return true;
                return this.matchesPromptSearchFields(this.getPromptSearchFields(prompt), searchClauses);
            });

        const groups = this.getPromptGroups();
        const sortedGroups = this.getPromptGroupsSorted();
        const renderedGroupIds = new Set();
        const isSearching = Boolean(searchQuery);

         // Render hierarchically: for each top-level group, render its header, its prompts,
         // then recursively its child groups — interleaved by prompt order.
         const renderGroupAndChildren = (groupId) => {
             const group = groups.find(g => g.id === groupId);
             if (!group || renderedGroupIds.has(groupId)) return;
             renderedGroupIds.add(groupId);

             // Render group header
             const groupHiddenClass = (!isSearching && this._isAncestorCollapsed(groupId)) ? ' prompt-manager-group-hidden' : '';
             const groupHtml = this.buildGroupHeaderHtml(group);
             // Inject hidden class into the group header if needed
             listItemHtml += groupHiddenClass
                 ? groupHtml.replace('prompt-manager-group ', `prompt-manager-group${groupHiddenClass} `)
                 : groupHtml;

             // Collect all descendant identifiers (including from child groups)
             const descendantIds = new Set();
             const collectDescendants = (g) => {
                 for (const id of g.identifiers) descendantIds.add(id);
                 const children = this.getGroupChildren(g.id);
                 for (const child of children) collectDescendants(child);
             };
             collectDescendants(group);

             // Map each identifier to the child group that directly owns it (if any)
             const childGroups = this.getGroupChildren(groupId);
             const idToChildGroup = new Map();
             for (const child of childGroups) {
                 for (const id of child.identifiers) {
                     idToChildGroup.set(id, child);
                 }
             }

             // Build set of direct prompts in this group
             const directIds = new Set(group.identifiers);

             const renderPromptItem = (prompt) => {
                 const isHidden = !isSearching && this._isGroupOrAncestorCollapsed(groupId);
                 const depth = this.getGroupDepth(groupId);
                 const childClass = 'prompt-manager-group-child';
                 const hiddenClass = isHidden ? 'prompt-manager-group-child-hidden' : '';
                 const groupIdAttr = `data-pm-group-id="${escapeHtml(groupId)}"`;
                 const depthAttr = `data-depth="${depth}"`;
                 const indentStyle = `style="--group-indent:${depth * 24}px"`;

                 const listEntry = this.getPromptOrderEntry(this.activeCharacter, prompt.identifier);
                 const html = this.buildPromptItemHtml(prompt, listEntry);

                 const extraClasses = `${childClass} ${hiddenClass}`.trim();
                 listItemHtml += html.replace(
                     /^(\s*<li\s+class=")/,
                     `$1${extraClasses} `,
                 ).replace(
                     /^(\s*<li\s)/,
                     `$1${groupIdAttr} ${depthAttr} ${indentStyle} `,
                 );
             };

             // Render direct prompts and child groups interleaved by visible order
             const renderedChildIds = new Set();
             for (const prompt of visiblePrompts) {
                 const id = prompt.identifier;
                 if (!descendantIds.has(id)) continue;

                 const childGroup = idToChildGroup.get(id);
                 if (childGroup && !renderedChildIds.has(childGroup.id)) {
                     renderGroupAndChildren(childGroup.id);
                     renderedChildIds.add(childGroup.id);
                 } else if (!childGroup && directIds.has(id)) {
                     renderPromptItem(prompt);
                 }
             }
        };

        if (!isSearching) {
            // Render all top-level groups and their descendants
            const topLevelGroups = sortedGroups.filter(g => !g.parentId);
            for (const g of topLevelGroups) {
                renderGroupAndChildren(g.id);
            }
        }

        // Render ungrouped prompts (and also in search mode, render everything)
        visiblePrompts.forEach(prompt => {
            if (!prompt) return;
            const group = this.getGroupForPrompt(prompt.identifier);

            if (isSearching) {
                // In search mode, don't show group headers, just render all prompts
                listItemHtml += this.buildPromptItemHtml(prompt, this.getPromptOrderEntry(this.activeCharacter, prompt.identifier));
                return;
            }

            // Skip prompts that have already been rendered inside groups
            if (group && renderedGroupIds.has(group.id)) {
                // Already rendered above
                return;
            }
            // Ungrouped prompts
            if (!group) {
                const listEntry = this.getPromptOrderEntry(this.activeCharacter, prompt.identifier);
                listItemHtml += this.buildPromptItemHtml(prompt, listEntry);
            }
        });

        if (searchQuery && visiblePrompts.length === 0) {
            listItemHtml += `
                <li class="${prefix}prompt_manager_prompt_disabled">
                    <span>${escapeHtml(String(t`No prompts match your search.`))}</span>
                </li>
            `;
        }

        promptManagerList.insertAdjacentHTML('beforeend', listItemHtml);

        // Set up event delegation on the list element (once per list rebuild)
        this.setupListEventDelegation(promptManagerList);
    }

    /**
     * Render the prompt list in group edit mode.
     * All groups are "exploded" (shown as flat list with color indicators),
     * and each item gets a checkbox for selection.
     * @param {string} searchQuery
     * @param {Array} searchClauses
     * @returns {string} HTML string
     */
    renderGroupEditModeList(searchQuery, searchClauses) {
            const { prefix } = this.configuration;
            const groups = this.getPromptGroups();
            const sortedGroups = this.getPromptGroupsSorted();
            const groupColorMap = new Map();
            groups.forEach((g, i) => groupColorMap.set(g.id, i % 8));

            const visiblePrompts = this.getPromptsForCharacter(this.activeCharacter)
                .filter(prompt => {
                    if (!prompt) return false;
                    if (!searchQuery) return true;
                    return this.matchesPromptSearchFields(this.getPromptSearchFields(prompt), searchClauses);
                });

            let html = '';

            // Render group labels hierarchically
            let currentGroupId = null;
            const renderedGroupLabels = new Set();

            // First render groups that have prompts in the visible list, in sorted order
            const visibleGroupIds = new Set();
            for (const prompt of visiblePrompts) {
                const group = this.getGroupForPrompt(prompt.identifier);
                if (group) visibleGroupIds.add(group.id);
            }

            // Also render empty groups that have children
            const renderGroupLabel = (groupId) => {
                if (renderedGroupLabels.has(groupId)) return;
                renderedGroupLabels.add(groupId);
                const group = groups.find(g => g.id === groupId);
                if (!group) return;
                const colorIdx = groupColorMap.get(groupId) ?? 0;
                const depth = this.getGroupDepth(groupId);
                const indentPx = depth * 24;
                html += `
                <li class="prompt-manager-group-edit-label" data-pm-group-id="${escapeHtml(groupId)}" data-depth="${depth}" style="--group-indent:${indentPx}px">
                    <span class="prompt-manager-group-edit-toggle fa-solid fa-chevron-right"></span>
                    <span class="prompt-manager-group-indicator" data-group-color="${colorIdx}"></span>
        <span class="prompt-manager-group-edit-label-name">
            <span class="fa-solid fa-folder" style="opacity:0.5"></span>
            ${escapeHtml(group.name)}
        </span>
        <span class="prompt-manager-group-edit-label-actions">
            <span class="prompt-manager-group-edit-rename fa-solid fa-pencil fa-xs" title="Rename" data-i18n="[title]Rename" data-pm-group-id="${escapeHtml(groupId)}"></span>
            <span class="prompt-manager-group-edit-dissolve fa-solid fa-object-ungroup fa-xs caution" title="Dissolve group" data-i18n="[title]Dissolve group" data-pm-group-id="${escapeHtml(groupId)}"></span>
        </span>
    </li>
    `;
            };

            // Render group labels in hierarchical order
            for (const g of sortedGroups) {
                if (visibleGroupIds.has(g.id) || this.getGroupChildren(g.id).length > 0) {
                    renderGroupLabel(g.id);
                }
            }

            // Render prompts with group indicators
            for (const prompt of visiblePrompts) {
                if (!prompt) continue;

                const group = this.getGroupForPrompt(prompt.identifier);
                const groupId = group?.id ?? null;

                const isSelected = this._groupEditSelection?.has(prompt.identifier) ?? false;
                const selectedClass = isSelected ? 'selected' : '';
                const colorIdx = groupId ? groupColorMap.get(groupId) : null;
                const depth = groupId ? this.getGroupDepth(groupId) : 0;
                const indentPx = depth * 24;
                const indicatorHtml = colorIdx !== null
                    ? `<span class="prompt-manager-group-indicator" data-group-color="${colorIdx}"></span>`
                    : '';

                const listEntry = this.getPromptOrderEntry(this.activeCharacter, prompt.identifier);
                const enabledClass = listEntry?.enabled ? '' : `${prefix}prompt_manager_prompt_disabled`;
                const encodedName = escapeHtml(prompt.name);

                html += `
                <li class="${prefix}prompt_manager_prompt prompt-manager-group-editing ${enabledClass}" data-pm-identifier="${escapeHtml(prompt.identifier)}" data-pm-group-id="${escapeHtml(groupId ?? '')}" data-depth="${depth}" style="--group-indent:${indentPx}px">
                    ${indicatorHtml}
        <span class="prompt-manager-group-select fa-solid ${isSelected ? 'fa-square-check' : 'fa-square'} ${selectedClass}" data-pm-identifier="${escapeHtml(prompt.identifier)}"></span>
        <span class="${prefix}prompt_manager_prompt_name" data-pm-name="${encodedName}">
            <span class="prompt-manager-name-text">${encodedName}</span>
        </span>
    </li>
    `;
            }

            return html;
        }

    /**
     * Set up event delegation on the prompt list element.
     * Uses a single click handler on the <ul> instead of binding to each individual element.
     * @param {HTMLElement} listElement - The prompt list <ul> element
     */
    setupListEventDelegation(listElement) {
        // Remove previous delegation handler if any
        if (this._listDelegationHandler) {
            listElement.removeEventListener('click', this._listDelegationHandler);
        }

        this._listDelegationHandler = (event) => {
            const target = event.target;
            if (!target) return;

            // --- Group edit mode: handle checkbox clicks ---
            if (this._groupEditMode) {
                const selectAction = target.closest('.prompt-manager-group-select');
                if (selectAction) {
                    const id = selectAction.dataset.pmIdentifier;
                    if (id) this.toggleGroupEditSelection(id);
                    return;
                }
                // Also allow clicking the whole row to toggle selection
                const editRow = target.closest('.prompt-manager-group-editing');
                if (editRow && !target.closest('.prompt-manager-group-edit-rename') && !target.closest('.prompt-manager-group-edit-dissolve')) {
                    const id = editRow.dataset.pmIdentifier;
                    if (id) this.toggleGroupEditSelection(id);
                    return;
                }
                // Edit mode: toggle group collapse
                const editToggle = target.closest('.prompt-manager-group-edit-toggle');
                if (editToggle) {
                    const groupLabel = editToggle.closest('.prompt-manager-group-edit-label');
                    const groupId = groupLabel?.dataset.pmGroupId;
                    if (groupId) {
                        if (this._groupEditCollapsed.has(groupId)) {
                            this._groupEditCollapsed.delete(groupId);
                            groupLabel.classList.remove('collapsed');
                        } else {
                            this._groupEditCollapsed.add(groupId);
                            groupLabel.classList.add('collapsed');
                        }
                        this._applyGroupEditCollapsedState();
                    }
                    return;
                }
                // Edit mode: rename group
                const editRename = target.closest('.prompt-manager-group-edit-rename');
                if (editRename) {
                    const groupId = editRename.dataset.pmGroupId;
                    if (groupId) this.handleGroupRename(groupId);
                    return;
                }
                // Edit mode: dissolve group
                const editDissolve = target.closest('.prompt-manager-group-edit-dissolve');
                if (editDissolve) {
                    const groupId = editDissolve.dataset.pmGroupId;
                    if (groupId) {
                        this.removePromptGroup(groupId);
                        this.renderPromptManagerListItems();
                        this.saveServiceSettings();
                    }
                    return;
                }
                return;
            }

            // --- Normal mode: group header actions ---
            const groupHeader = target.closest('.prompt-manager-group');
            if (groupHeader) {
                const groupId = groupHeader.dataset.pmGroupId;
                if (!groupId) return;

                // Rename
                            const renameAction = target.closest('.prompt-manager-group-rename');
                            if (renameAction) {
                                this.handleGroupRename(groupId);
                                return;
                            }

                            // Create sub-group
                            const subGroupAction = target.closest('.prompt-manager-group-subgroup');
                            if (subGroupAction) {
                                const name = prompt(t`Enter sub-group name:`);
                                if (name && name.trim()) {
                                    this.createPromptGroup(name.trim(), [], groupId);
                                    this.renderPromptManagerListItems();
                                    this.saveServiceSettings();
                                }
                                return;
                            }

                            // Ungroup
                const ungroupAction = target.closest('.prompt-manager-group-ungroup');
                if (ungroupAction) {
                    this.removePromptGroup(groupId);
                    this.renderPromptManagerListItems();
                    this.saveServiceSettings();
                    return;
                }

                // Toggle all
                const toggleAllAction = target.closest('.prompt-manager-group-toggle-all');
                if (toggleAllAction) {
                    this.toggleGroupPrompts(groupId);
                    this.renderPromptManagerListItems();
                    this.saveServiceSettings();
                    this.updateHeaderTotalEstimate();
                    this.updateTokenDisplayDebounced();
                    return;
                }

                // Click anywhere else on group header = toggle collapse
                this.toggleGroupCollapse(groupId);
                this.renderPromptManagerListItems();
                // Don't save collapse state to settings (it's UI-only)
                return;
            }

            // --- Normal mode: prompt item actions ---
            const detachAction = target.closest('.prompt-manager-detach-action');
            if (detachAction) {
                this.handleDetach(event);
                return;
            }

            const inspectAction = target.closest('.prompt-manager-inspect-action');
            if (inspectAction) {
                this.handleInspect(event);
                return;
            }

            const editAction = target.closest('.prompt-manager-edit-action');
            if (editAction) {
                this.handleEdit(event);
                return;
            }

            const toggleAction = target.closest('.prompt-manager-toggle-action');
            if (toggleAction) {
                this.handleToggle(event);
                return;
            }

            const pluginExtraAction = target.closest('.prompt-manager-plugin-extra-action');
            if (pluginExtraAction) {
                this.handlePluginExtraToggle(event);
                return;
            }
        };

        listElement.addEventListener('click', this._listDelegationHandler);
    }

    // ========================================
    // Group Edit Mode
    // ========================================

    /**
     * Enter group edit mode.
     */
    enterGroupEditMode() {
        this._groupEditMode = true;
        this._groupEditSelection = new Set();
        this.renderGroupEditUI();
        this.renderPromptManagerListItems();
    }

    /**
     * Exit group edit mode without creating a group.
     */
    exitGroupEditMode() {
        this._groupEditMode = false;
        this._groupEditSelection = null;
        this._groupEditCollapsed = new Set();
        this.removeGroupEditUI();
        this.renderPromptManagerListItems();
        this.makeDraggable();
    }

    /**
     * Show/hide prompt items in edit mode based on group collapse state.
     */
    _applyGroupEditCollapsedState() {
        const list = this.listElement;
        if (!list || !this._groupEditMode) return;
        const items = list.querySelectorAll('.prompt-manager-group-editing');
        for (const item of items) {
            const gid = item.dataset.pmGroupId;
            if (gid && this._isGroupOrAncestorCollapsedInEdit(gid)) {
                item.classList.add('prompt-manager-group-editing-hidden');
            } else {
                item.classList.remove('prompt-manager-group-editing-hidden');
            }
        }
    }

    _isGroupOrAncestorCollapsedInEdit(groupId) {
        if (this._groupEditCollapsed.has(groupId)) return true;
        let currentId = groupId;
        const groups = this.getPromptGroups();
        while (currentId) {
            const group = groups.find(g => g.id === currentId);
            if (!group || !group.parentId) break;
            if (this._groupEditCollapsed.has(group.parentId)) return true;
            currentId = group.parentId;
        }
        return false;
    }

    /**
     * Toggle a prompt's selection in group edit mode.
     * Auto-fills gaps to maintain contiguity.
     * @param {string} identifier
     */
    toggleGroupEditSelection(identifier) {
        if (!this._groupEditSelection) return;

        if (this._groupEditSelection.has(identifier)) {
            this._groupEditSelection.delete(identifier);
        } else {
            this._groupEditSelection.add(identifier);
        }

        // Auto-fill gaps: if selection is non-contiguous, fill in the middle
        if (this._groupEditSelection.size > 1) {
            const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);
            const selectedIndices = [...this._groupEditSelection]
                .map(id => promptOrder.findIndex(e => e.identifier === id))
                .filter(i => i !== -1)
                .sort((a, b) => a - b);

            if (selectedIndices.length >= 2) {
                const min = selectedIndices[0];
                const max = selectedIndices[selectedIndices.length - 1];
                for (let i = min; i <= max; i++) {
                    this._groupEditSelection.add(promptOrder[i].identifier);
                }
            }
        }

        this.updateGroupEditUI();
        this.renderPromptManagerListItems();
    }

    /**
     * Render the group edit toolbar (replaces search bar area).
     */
    renderGroupEditUI() {
        const { prefix } = this.configuration;
        const container = this.containerElement;

        // Hide search bar
        const searchBar = container.querySelector('.completion_prompt_manager_search');
        if (searchBar) searchBar.style.display = 'none';

        // Hide footer
        const footer = container.querySelector(`.${prefix}prompt_manager_footer`);
        if (footer) footer.style.display = 'none';

        // Insert toolbar
        const existingToolbar = container.querySelector('.prompt-manager-group-edit-toolbar');
        if (existingToolbar) existingToolbar.remove();

        const toolbarHtml = `
            <div class="prompt-manager-group-edit-toolbar">
                <div class="prompt-manager-group-edit-toolbar-info">
                    <i class="fa-solid fa-object-group"></i>
                    <span class="prompt-manager-group-edit-label" data-i18n="Group Edit">Group Edit</span>
                    <span class="prompt-manager-group-edit-selected-count"></span>
                    <span class="prompt-manager-group-edit-warning"></span>
                </div>
                <div class="prompt-manager-group-edit-toolbar-actions">
                    <a class="menu_button prompt-manager-group-toggle-btn" title="Toggle selected prompts on/off" data-i18n="[title]Toggle selected prompts on/off">
                        <i class="fa-solid fa-power-off"></i>
                        <span data-i18n="Toggle Selected">Toggle Selected</span>
                    </a>
                    <a class="menu_button prompt-manager-group-extra-btn" title="Mark selected as extra" data-i18n="[title]Mark selected as extra">
                        <i class="fa-solid fa-star"></i>
                        <span data-i18n="Mark Extra">Mark Extra</span>
                    </a>
                    <a class="menu_button prompt-manager-group-remove-btn" title="Remove selected from list" data-i18n="[title]Remove selected from list">
                        <i class="fa-solid fa-circle-minus"></i>
                        <span data-i18n="Remove Selected">Remove Selected</span>
                    </a>
                    <span class="prompt-manager-group-edit-separator"></span>
                    <a class="menu_button prompt-manager-group-create-btn" title="Create group from selection" data-i18n="[title]Create group from selection">
                        <i class="fa-solid fa-folder-plus"></i>
                        <span data-i18n="Create Group">Create Group</span>
                    </a>
                </div>
            </div>
        `;

        const listEl = container.querySelector(`#${prefix}prompt_manager_list`);
        listEl.insertAdjacentHTML('beforebegin', toolbarHtml);

        // Bind toolbar events
        const toolbar = container.querySelector('.prompt-manager-group-edit-toolbar');
        toolbar.querySelector('.prompt-manager-group-create-btn').addEventListener('click', () => this.handleCreateGroupFromSelection());
        toolbar.querySelector('.prompt-manager-group-toggle-btn').addEventListener('click', () => this.handleBatchToggle());
        toolbar.querySelector('.prompt-manager-group-extra-btn').addEventListener('click', () => this.handleBatchExtra());
        toolbar.querySelector('.prompt-manager-group-remove-btn').addEventListener('click', () => this.handleBatchRemove());

        this.updateGroupEditUI();
    }

    /**
     * Update the group edit toolbar state (selected count, warnings, button state).
     */
    updateGroupEditUI() {
        const container = this.containerElement;
        const toolbar = container?.querySelector('.prompt-manager-group-edit-toolbar');
        if (!toolbar) return;

        const count = this._groupEditSelection?.size ?? 0;
        const countEl = toolbar.querySelector('.prompt-manager-group-edit-selected-count');
        const warningEl = toolbar.querySelector('.prompt-manager-group-edit-warning');
        const createBtn = toolbar.querySelector('.prompt-manager-group-create-btn');
        const toggleBtn = toolbar.querySelector('.prompt-manager-group-toggle-btn');
        const extraBtn = toolbar.querySelector('.prompt-manager-group-extra-btn');
        const removeBtn = toolbar.querySelector('.prompt-manager-group-remove-btn');

        if (countEl) countEl.textContent = count > 0 ? `${count} ${t`selected`}` : '';

        const isContiguous = count > 0 && this.areIdentifiersContiguous([...this._groupEditSelection]);
        const canCreate = count >= 2 && isContiguous;
        const canAct = count >= 1;

        if (warningEl) {
            warningEl.textContent = (count >= 2 && !isContiguous) ? `⚠ ${t`Selection not contiguous`}` : '';
        }

        if (createBtn) {
            createBtn.style.opacity = canCreate ? '1' : '0.4';
            createBtn.style.pointerEvents = canCreate ? '' : 'none';
        }

        for (const btn of [toggleBtn, extraBtn, removeBtn]) {
            if (btn) {
                btn.style.opacity = canAct ? '1' : '0.4';
                btn.style.pointerEvents = canAct ? '' : 'none';
            }
        }
    }

    /**
     * Remove the group edit toolbar and restore normal UI.
     */
    removeGroupEditUI() {
        const container = this.containerElement;
        const { prefix } = this.configuration;

        const toolbar = container?.querySelector('.prompt-manager-group-edit-toolbar');
        if (toolbar) toolbar.remove();

        // Restore search bar
        const searchBar = container?.querySelector('.completion_prompt_manager_search');
        if (searchBar) searchBar.style.display = '';

        // Restore footer
        const footer = container?.querySelector(`.${prefix}prompt_manager_footer`);
        if (footer) footer.style.display = '';
    }

    /**
     * Handle creating a group from the current selection.
     */
    async handleCreateGroupFromSelection() {
        if (!this._groupEditSelection || this._groupEditSelection.size < 2) return;

        const identifiers = [...this._groupEditSelection];
        if (!this.areIdentifiersContiguous(identifiers)) {
            toastr.warning(t`Selected prompts must be contiguous.`);
            return;
        }

        const result = await Popup.show.input(t`Enter group name:`, null, '');
        if (!result) return;

        // If all selected identifiers belong to the same group, create the
        // new group as its child (nested sub-group) instead of a top-level group
        let parentId = null;
        const groups = this.getPromptGroups();
        for (const g of groups) {
            const allInThis = identifiers.every(id => g.identifiers.includes(id));
            if (allInThis) {
                parentId = g.id;
                break;
            }
        }

        const group = this.createPromptGroup(result, identifiers, parentId);
        if (!group) {
            toastr.error(t`Failed to create group.`);
            return;
        }

        toastr.success(t`Group "${result}" created.`);
        this.exitGroupEditMode();
        this.saveServiceSettings();
        }

        /**
         * Batch toggle enabled/disabled for all selected prompts.
         * If any selected prompt is disabled → enable all; otherwise → disable all.
         */
        handleBatchToggle() {
            if (!this._groupEditSelection || this._groupEditSelection.size === 0) return;

            const identifiers = [...this._groupEditSelection];
            const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);

            // Determine target state: if any is disabled, enable all; otherwise disable all
            const hasDisabled = identifiers.some(id => {
                const entry = promptOrder.find(e => e.identifier === id);
                return entry && !entry.enabled;
            });
            const targetEnabled = hasDisabled;

            let changedCount = 0;
            for (const promptID of identifiers) {
                const promptOrderEntry = promptOrder.find(e => e.identifier === promptID);
                if (!promptOrderEntry || promptOrderEntry.enabled === targetEnabled) continue;

                const wasEnabled = Boolean(promptOrderEntry.enabled);
                promptOrderEntry.enabled = targetEnabled;
                this.enqueueToggleUndo(promptID, wasEnabled, targetEnabled);
                if (!this.updateToggleInPlace(promptID, targetEnabled)) {
                    this.render();
                }
                changedCount++;
            }

            if (changedCount > 0) {
                this.updateHeaderTotalEstimate();
                this.updateTokenDisplayDebounced();
                this.saveServiceSettings();
                this.updateGroupEditUI();
            }
        }

        /**
         * Batch toggle plugin_extra for all selected prompts.
         * If any selected prompt is not extra → mark all extra; otherwise → unmark all.
         */
        handleBatchExtra() {
            if (!this._groupEditSelection || this._groupEditSelection.size === 0) return;

            const identifiers = [...this._groupEditSelection];

            // Determine target state: if any is not extra, mark all; otherwise unmark all
            const hasNonExtra = identifiers.some(id => !this.isPromptPluginExtra(id));
            const targetExtra = hasNonExtra;

            let changedCount = 0;
            for (const promptID of identifiers) {
                const current = this.isPromptPluginExtra(promptID);
                if (current === targetExtra) continue;

                this.setPromptPluginExtra(promptID, targetExtra);
                if (!this.updatePluginExtraInPlace(promptID, targetExtra)) {
                    this.render();
                }
                changedCount++;
            }

            if (changedCount > 0) {
                this.saveServiceSettings();
                this.updateGroupEditUI();
            }
        }

        /**
         * Batch remove (detach) all selected prompts from the order list.
         */
        handleBatchRemove() {
            if (!this._groupEditSelection || this._groupEditSelection.size === 0) return;
            if (null === this.activeCharacter) return;

            const identifiers = [...this._groupEditSelection];
            let removedCount = 0;

            for (const promptID of identifiers) {
                const prompt = this.getPromptById(promptID);
                if (!prompt) continue;

                const detached = this.detachPrompt(prompt, this.activeCharacter);
                if (!detached) continue;

                this.enqueueDetachUndo(promptID, detached.entry, detached.index);
                if (!this.removePromptItemInPlace(promptID)) {
                    this.render();
                }
                removedCount++;
            }

            if (removedCount > 0) {
                this._groupEditSelection.clear();
                this.updateTokenDisplayDebounced();
                this.saveServiceSettings();
                this.updateGroupEditUI();
            }
        }

        /**
        * Handle renaming a group.
     * @param {string} groupId
     */
    async handleGroupRename(groupId) {
        const group = this.getPromptGroups().find(g => g.id === groupId);
        if (!group) return;

        const result = await Popup.show.input(t`Rename group:`, null, group.name);
        if (result === null || result === undefined) return;

        this.renamePromptGroup(groupId, result);
        this.renderPromptManagerListItems();
        this.saveServiceSettings();
    }

    /**
     * Writes the passed data to a json file
     *
     * @param data
     * @param type
     * @param name
     */
    export(data, type, name = 'export') {
        const promptExport = {
            version: this.configuration.version,
            type: type,
            data: data,
        };

        const serializedObject = JSON.stringify(promptExport, null, 4);
        const blob = new Blob([serializedObject], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const downloadLink = document.createElement('a');
        downloadLink.href = url;

        const dateString = this.getFormattedDate();
        downloadLink.download = `${name}-${dateString}.json`;

        downloadLink.click();

        URL.revokeObjectURL(url);
    }

    /**
     * Imports a json file with prompts and an optional prompt list for the active character
     *
     * @param importData
     */
    import(importData) {
        const normalizeImportedPrompt = (prompt) => {
            if (!prompt || typeof prompt !== 'object') {
                return prompt;
            }
            return {
                ...prompt,
                plugin_extra: Boolean(prompt.plugin_extra),
            };
        };

        const mergeKeepNewer = (prompts, newPrompts) => {
            let merged = [...prompts, ...newPrompts];

            let map = new Map();
            for (let obj of merged) {
                const normalized = normalizeImportedPrompt(obj);
                map.set(normalized.identifier, normalized);
            }

            merged = Array.from(map.values());

            return merged;
        };

        const controlObj = {
            version: 1,
            type: '',
            data: {
                prompts: [],
                prompt_order: null,
            },
        };

        if (false === this.validateObject(controlObj, importData)) {
            toastr.warning(t`Could not import prompts. Export failed validation.`);
            return;
        }

        const prompts = mergeKeepNewer(this.serviceSettings.prompts, importData.data.prompts);

        this.setPrompts(prompts);
        this.log('Prompt import succeeded');

        if ('global' === this.configuration.promptOrder.strategy) {
            const promptOrder = this.getPromptOrderForCharacter({ id: this.configuration.promptOrder.dummyId });
            Object.assign(promptOrder, importData.data.prompt_order);
            this.log('Prompt order import succeeded');
        } else if ('character' === this.configuration.promptOrder.strategy) {
            if ('character' === importData.type) {
                const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);
                Object.assign(promptOrder, importData.data.prompt_order);
                this.log(`Prompt order import for character ${this.activeCharacter.name} succeeded`);
            }
        } else {
            throw new Error('Prompt order strategy not supported.');
        }

        // Import prompt groups if present (Luker extension data)
        if (Array.isArray(importData.data.extensions?.luker?.prompt_groups)) {
            const importedGroups = importData.data.extensions.luker.prompt_groups;
            const existingGroups = this.getPromptGroups();

            // Merge: imported groups override existing ones with the same ID
            const groupMap = new Map(existingGroups.map(g => [g.id, g]));
            for (const importedGroup of importedGroups) {
                if (importedGroup && importedGroup.id && Array.isArray(importedGroup.identifiers)) {
                    groupMap.set(importedGroup.id, structuredClone(importedGroup));
                }
            }
            this.serviceSettings.extensions.luker.prompt_groups = Array.from(groupMap.values());
            this.validateGroups();
            this.log('Prompt groups import succeeded');
        }

        toastr.success(t`Prompt import complete.`);
        this.saveServiceSettings().then(() => this.render());
    }

    /**
     * Helper function to check whether the structure of object matches controlObj
     *
     * @param controlObj
     * @param object
     * @returns {boolean}
     */
    validateObject(controlObj, object) {
        for (let key in controlObj) {
            if (!Object.hasOwn(object, key)) {
                if (controlObj[key] === null) continue;
                else return false;
            }

            if (typeof controlObj[key] === 'object' && controlObj[key] !== null) {
                if (typeof object[key] !== 'object') return false;
                if (!this.validateObject(controlObj[key], object[key])) return false;
            } else {
                if (typeof object[key] !== typeof controlObj[key]) return false;
            }
        }

        return true;
    }

    /**
     * Get current date as mm/dd/YYYY
     *
     * @returns {`${string}_${string}_${string}`}
     */
    getFormattedDate() {
        const date = new Date();
        let month = String(date.getMonth() + 1);
        let day = String(date.getDate());
        const year = String(date.getFullYear());

        if (month.length < 2) month = '0' + month;
        if (day.length < 2) day = '0' + day;

        return `${month}_${day}_${year}`;
    }

    /**
     * Makes the prompt list draggable and handles swapping of two entries in the list.
     * @typedef {Object} Entry
     * @property {string} identifier
     * @returns {void}
     */
    makeDraggable() {
        // Don't enable drag in group edit mode
        if (this._groupEditMode) return;

        const listSelector = `#${this.configuration.prefix}prompt_manager_list`;

        // Destroy any prior Sortable instance attached to this list before
        // re-initialising — re-init alone does not release the previous
        // instance's internal references to the old <li> nodes (the
        // renderPromptManagerListItems() path nukes <li>s via innerHTML='').
        // @ts-ignore
        if ($(listSelector).sortable('instance') !== undefined) {
            // @ts-ignore
            $(listSelector).sortable('destroy');
        }

        $(listSelector).sortable({
            delay: this.configuration.sortableDelay,
            handle: '.prompt-manager-marker-handle',
            items: `.${this.configuration.prefix}prompt_manager_prompt_draggable`,
            helper: (_event, ui) => buildPromptManagerDragHelper(ui),
            appendTo: document.body,
            tolerance: 'pointer',
            forcePlaceholderSize: false,
            placeholder: 'prompt-manager-sortable-placeholder',
            cursor: 'grabbing',
            scroll: true,
            scrollSensitivity: 60,
            scrollSpeed: 18,
            start: (_event, ui) => {
                stylePromptManagerDragPlaceholder(ui);
            },
            update: (event, ui) => {
                const promptOrder = this.getPromptOrderForCharacter(this.activeCharacter);
                const promptListElement = $(`#${this.configuration.prefix}prompt_manager_list`).sortable('toArray', { attribute: 'data-pm-identifier' })
                    .filter(id => id); // Filter out group header rows (no data-pm-identifier)
                const idToObjectMap = new Map(promptOrder.map(prompt => [prompt.identifier, prompt]));
                const updatedPromptOrder = promptListElement.map(identifier => idToObjectMap.get(identifier)).filter(Boolean);

                this.removePromptOrderForCharacter(this.activeCharacter);
                this.addPromptOrderForCharacter(this.activeCharacter, updatedPromptOrder);

                // Validate groups after reorder — remove prompts that are no longer contiguous
                this.validateGroups();

                this.log(`Prompt order updated for ${this.activeCharacter.name}.`);

                this.saveServiceSettings();
            },
        });

        // Suppress native long-press context menu on drag handles.
        $(listSelector)
            .off('contextmenu.promptManagerHandle', '.prompt-manager-marker-handle')
            .on('contextmenu.promptManagerHandle', '.prompt-manager-marker-handle', (event) => event.preventDefault());
    }

    /**
     * Slides down the edit form and adds the class 'openDrawer' to the first element of '#openai_prompt_manager_popup'.
     * @returns {void}
     */
    showPopup(area = 'edit') {
        const areaElement = document.getElementById(this.configuration.prefix + 'prompt_manager_popup_' + area);
        areaElement.style.display = 'flex';

        $('#' + this.configuration.prefix + 'prompt_manager_popup').first()
            .slideDown(200, 'swing')
            .addClass('openDrawer');
    }

    /**
     * Slides up the edit form and removes the class 'openDrawer' from the first element of '#openai_prompt_manager_popup'.
     * @returns {void}
     */
    hidePopup() {
        $('#' + this.configuration.prefix + 'prompt_manager_popup').first()
            .slideUp(200, 'swing')
            .removeClass('openDrawer');
    }

    /**
     * Quick uuid4 implementation
     * @returns {string} A string representation of an uuid4
     */
    getUuidv4() {
        return uuidv4();
    }

    /**
     * Write to console with prefix
     *
     * @param output
     */
    log(output) {
        if (power_user.console_log_prompts) console.log('[PromptManager] ' + output);
    }

    /**
     * Start a profiling task
     *
     * @param identifier
     */
    profileStart(identifier) {
        if (power_user.console_log_prompts) console.time(identifier);
    }

    /**
     * End a profiling task
     *
     * @param identifier
     */
    profileEnd(identifier) {
        if (power_user.console_log_prompts) {
            this.log('Profiling of "' + identifier + '" finished. Result below.');
            console.timeEnd(identifier);
        }
    }
}

const chatCompletionDefaultPrompts = {
    'prompts': [
        {
            'name': 'Main Prompt',
            'system_prompt': true,
            'role': 'system',
            'content': 'Write {{char}}\'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.',
            'identifier': 'main',
        },
        {
            'name': 'Auxiliary Prompt',
            'system_prompt': true,
            'role': 'system',
            'content': '',
            'identifier': 'nsfw',
        },
        {
            'identifier': 'dialogueExamples',
            'name': 'Chat Examples',
            'system_prompt': true,
            'marker': true,
        },
        {
            'name': 'Post-History Instructions',
            'system_prompt': true,
            'role': 'system',
            'content': '',
            'identifier': 'jailbreak',
        },
        {
            'identifier': 'chatHistory',
            'name': 'Chat History',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'worldInfoAfter',
            'name': 'World Info (after)',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'worldInfoBefore',
            'name': 'World Info (before)',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'enhanceDefinitions',
            'role': 'system',
            'name': 'Enhance Definitions',
            'content': 'If you have more knowledge of {{char}}, add to the character\'s lore and personality to enhance them but keep the Character Sheet\'s definitions absolute.',
            'system_prompt': true,
            'marker': false,
        },
        {
            'identifier': 'charDescription',
            'name': 'Char Description',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'charPersonality',
            'name': 'Char Personality',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'scenario',
            'name': 'Scenario',
            'system_prompt': true,
            'marker': true,
        },
        {
            'identifier': 'personaDescription',
            'name': 'Persona Description',
            'system_prompt': true,
            'marker': true,
        },
    ],
};

const promptManagerDefaultPromptOrders = {
    'prompt_order': [],
};

const promptManagerDefaultPromptOrder = [
    {
        'identifier': 'main',
        'enabled': true,
    },
    {
        'identifier': 'worldInfoBefore',
        'enabled': true,
    },
    {
        'identifier': 'personaDescription',
        'enabled': true,
    },
    {
        'identifier': 'charDescription',
        'enabled': true,
    },
    {
        'identifier': 'charPersonality',
        'enabled': true,
    },
    {
        'identifier': 'scenario',
        'enabled': true,
    },
    {
        'identifier': 'enhanceDefinitions',
        'enabled': false,
    },
    {
        'identifier': 'nsfw',
        'enabled': true,
    },
    {
        'identifier': 'worldInfoAfter',
        'enabled': true,
    },
    {
        'identifier': 'dialogueExamples',
        'enabled': true,
    },
    {
        'identifier': 'chatHistory',
        'enabled': true,
    },
    {
        'identifier': 'jailbreak',
        'enabled': true,
    },
];

export {
    PromptManager,
    registerPromptManagerMigration,
    chatCompletionDefaultPrompts,
    promptManagerDefaultPromptOrders,
    Prompt,
};
