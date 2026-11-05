/**
 * Human labels for conflict view fields.
 *
 * Static labels are English i18n source strings. A label derived from user
 * data (a prompt name, an entry comment) must not pass through translate;
 * the renderer marks those nodes with translateLabel: false.
 */

const PRESET_FIELDS = {
    name: 'Name',
    temperature: 'Temperature',
    frequency_penalty: 'Frequency penalty',
    presence_penalty: 'Presence penalty',
    repetition_penalty: 'Repetition penalty',
    top_p: 'Top P',
    top_k: 'Top K',
    top_a: 'Top A',
    min_p: 'Min P',
    openai_max_context: 'Context size',
    openai_max_tokens: 'Max tokens',
    max_context_unlocked: 'Unlocked context size',
    n: 'Responses',
    seed: 'Seed',
    stream_openai: 'Stream responses',
    use_sysprompt: 'Use system prompt',
    squash_system_messages: 'Squash system messages',
    names_behavior: 'Names behavior',
    send_if_empty: 'Send if empty',
    continue_prefill: 'Continue prefill',
    continue_postfix: 'Continue postfix',
    continue_nudge_prompt: 'Continue nudge prompt',
    new_chat_prompt: 'New chat prompt',
    new_group_chat_prompt: 'New group chat prompt',
    new_example_chat_prompt: 'New example chat prompt',
    impersonation_prompt: 'Impersonation prompt',
    group_nudge_prompt: 'Group nudge prompt',
    scenario_format: 'Scenario format',
    personality_format: 'Personality format',
    wi_format: 'World info format',
    bias_preset_selected: 'Bias preset',
    assistant_prefill: 'Assistant prefill',
    assistant_impersonation: 'Assistant impersonation',
    request_images: 'Request images',
    request_image_resolution: 'Image resolution',
    request_image_aspect_ratio: 'Image aspect ratio',
    inline_image_quality: 'Inline image quality',
    media_inlining: 'Media inlining',
    enable_web_search: 'Web search',
    function_calling: 'Function calling',
    tool_call_recurse_limit: 'Tool call recursion limit',
    tool_reasoning_mode: 'Tool reasoning mode',
    show_thoughts: 'Show thoughts',
    reasoning_effort: 'Reasoning effort',
    verbosity: 'Verbosity',
    content: 'Content',
    system_prompt: 'System prompt',
    role: 'Role',
    enabled: 'Enabled',
    marker: 'Marker',
    identifier: 'Identifier',
    injection_position: 'Injection position',
    injection_depth: 'Injection depth',
    injection_order: 'Injection order',
    forbid_overrides: 'Forbid overrides',
    prompts: 'Prompts',
    prompt_order: 'Prompt order',
    extensions: 'Extensions',
    character_id: 'Character ID',
};

const WORLD_BOOK_FIELDS = {
    uid: 'UID',
    displayIndex: 'Display index',
    comment: 'Comment',
    content: 'Content',
    key: 'Keywords',
    keysecondary: 'Secondary keywords',
    disable: 'Disabled',
    constant: 'Constant',
    selective: 'Selective',
    selectiveLogic: 'Selective logic',
    scanDepth: 'Scan depth',
    vectorized: 'Vectorized',
    position: 'Position',
    role: 'Role',
    depth: 'Depth',
    order: 'Order',
    useProbability: 'Use probability',
    probability: 'Probability',
    excludeRecursion: 'Exclude recursion',
    preventRecursion: 'Prevent recursion',
    delayUntilRecursion: 'Delay until recursion',
    sticky: 'Sticky',
    cooldown: 'Cooldown',
    delay: 'Delay',
    addMemo: 'Add memo',
    matchPersonaDescription: 'Match persona description',
    matchCharacterDescription: 'Match character description',
    matchCharacterPersonality: 'Match character personality',
    matchCharacterDepthPrompt: 'Match character depth prompt',
    matchScenario: 'Match scenario',
    matchCreatorNotes: 'Match creator notes',
    group: 'Group',
    groupOverride: 'Group override',
    groupWeight: 'Group weight',
    caseSensitive: 'Case sensitive',
    matchWholeWords: 'Match whole words',
    useGroupScoring: 'Use group scoring',
    automationId: 'Automation ID',
    ignoreBudget: 'Ignore budget',
    outletName: 'Outlet name',
    triggers: 'Triggers',
    characterFilter: 'Character filter',
};

const CHARACTER_FIELDS = {
    name: 'Name',
    description: 'Description',
    personality: 'Personality',
    scenario: 'Scenario',
    first_mes: 'First message',
    mes_example: 'Example messages',
    creator_notes: 'Creator notes',
    system_prompt: 'System prompt',
    post_history_instructions: 'Post-history instructions',
    alternate_greetings: 'Alternate greetings',
    tags: 'Tags',
    creator: 'Creator',
    character_version: 'Character version',
    extensions: 'Extensions',
    character_book: 'Embedded world book',
    group_only_greetings: 'Group-only greetings',
    nickname: 'Nickname',
    assets: 'Assets',
    creatorcomment: 'Creator comment',
    avatar: 'Avatar',
    talkativeness: 'Talkativeness',
    fav: 'Favorite',
    spec: 'Specification',
    spec_version: 'Specification version',
};

const CHAT_FIELDS = {
    mes: 'Message',
    name: 'Name',
    is_user: 'User message',
    is_system: 'System message',
    send_date: 'Sent',
    extra: 'Extra',
    swipes: 'Swipes',
    swipe_id: 'Swipe',
    swipe_info: 'Swipe info',
    force_avatar: 'Forced avatar',
    original_avatar: 'Original avatar',
    chat_metadata: 'Metadata',
    user_name: 'User name',
    character_name: 'Character name',
    create_date: 'Created',
};

/**
 * Turn a JSON key into a readable title: `max_context_unlocked` →
 * `Max context unlocked`, `selectiveLogic` → `Selective logic`.
 *
 * @param {string} key
 */
export function humanizeKey(key) {
    const spaced = String(key ?? '')
        .replace(/([a-z0-9])([A-Z])/g, (_, before, capital) => `${before} ${capital.toLowerCase()}`)
        .replace(/[_-]+/g, ' ')
        .trim();
    if (!spaced) return '';
    return spaced[0].toUpperCase() + spaced.slice(1);
}

export const presetFieldLabel = key => PRESET_FIELDS[key] ?? humanizeKey(key);
export const worldBookFieldLabel = key => WORLD_BOOK_FIELDS[key] ?? humanizeKey(key);
export const characterFieldLabel = key => CHARACTER_FIELDS[key] ?? humanizeKey(key);
export const chatFieldLabel = key => CHAT_FIELDS[key] ?? humanizeKey(key);
