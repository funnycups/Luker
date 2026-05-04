import { fuzzySearchCharacters, fuzzySearchGroups, fuzzySearchPersonas, fuzzySearchTags, fuzzySearchWorldInfo, power_user } from './power-user.js';
import { tag_map } from './tags.js';
import { equalsIgnoreCaseAndAccents, includesIgnoreCaseAndAccents } from './utils.js';


/**
 * @typedef FilterType The filter type possible for this filter helper
 * @type {'search'|'tag'|'folder'|'fav'|'group'|'world_info_search'|'world_info_search_mode'|'world_info_search_advanced'|'persona_search'}
 */

/**
 * The filter types
 * @type {{ SEARCH: 'search', TAG: 'tag', FOLDER: 'folder', FAV: 'fav', GROUP: 'group', WORLD_INFO_SEARCH: 'world_info_search', WORLD_INFO_SEARCH_MODE: 'world_info_search_mode', WORLD_INFO_SEARCH_ADVANCED: 'world_info_search_advanced', PERSONA_SEARCH: 'persona_search'}}
 */
export const FILTER_TYPES = {
    SEARCH: 'search',
    TAG: 'tag',
    FOLDER: 'folder',
    FAV: 'fav',
    GROUP: 'group',
    WORLD_INFO_SEARCH: 'world_info_search',
    WORLD_INFO_SEARCH_MODE: 'world_info_search_mode',
    WORLD_INFO_SEARCH_ADVANCED: 'world_info_search_advanced',
    PERSONA_SEARCH: 'persona_search',
};

export const WORLD_INFO_SEARCH_MODES = Object.freeze({
    FUZZY: 'fuzzy',
    KEYWORD: 'keyword',
});

const WORLD_INFO_KEYWORD_SEARCH_SCOPES = Object.freeze({
    ALL: 'all',
    TITLE: 'title',
    GROUP: 'group',
    CONTENT: 'content',
    UID: 'uid',
    AUTOMATION_ID: 'automation_id',
});

const WORLD_INFO_KEYWORD_SEARCH_SCOPE_ALIASES = Object.freeze({
    title: WORLD_INFO_KEYWORD_SEARCH_SCOPES.TITLE,
    name: WORLD_INFO_KEYWORD_SEARCH_SCOPES.TITLE,
    comment: WORLD_INFO_KEYWORD_SEARCH_SCOPES.TITLE,
    key: WORLD_INFO_KEYWORD_SEARCH_SCOPES.TITLE,
    keyword: WORLD_INFO_KEYWORD_SEARCH_SCOPES.TITLE,
    keywords: WORLD_INFO_KEYWORD_SEARCH_SCOPES.TITLE,
    group: WORLD_INFO_KEYWORD_SEARCH_SCOPES.GROUP,
    content: WORLD_INFO_KEYWORD_SEARCH_SCOPES.CONTENT,
    text: WORLD_INFO_KEYWORD_SEARCH_SCOPES.CONTENT,
    body: WORLD_INFO_KEYWORD_SEARCH_SCOPES.CONTENT,
    uid: WORLD_INFO_KEYWORD_SEARCH_SCOPES.UID,
    id: WORLD_INFO_KEYWORD_SEARCH_SCOPES.UID,
    automationid: WORLD_INFO_KEYWORD_SEARCH_SCOPES.AUTOMATION_ID,
    automation_id: WORLD_INFO_KEYWORD_SEARCH_SCOPES.AUTOMATION_ID,
    autoid: WORLD_INFO_KEYWORD_SEARCH_SCOPES.AUTOMATION_ID,
    auto_id: WORLD_INFO_KEYWORD_SEARCH_SCOPES.AUTOMATION_ID,
});

function normalizeWorldInfoKeywordSearchValue(searchValue) {
    return String(searchValue || '').trim();
}

function normalizeWorldInfoKeywordSearchCandidates(values) {
    return (Array.isArray(values) ? values : [values])
        .map(value => String(value ?? '').trim())
        .filter(Boolean);
}

function createBasicWorldInfoKeywordSearchClauses(searchValue) {
    const value = normalizeWorldInfoKeywordSearchValue(searchValue);
    return value
        ? [[{
            negated: false,
            scope: WORLD_INFO_KEYWORD_SEARCH_SCOPES.ALL,
            term: value,
        }]]
        : [];
}

function tokenizeWorldInfoKeywordSearch(searchValue) {
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

function isWorldInfoKeywordSearchOrToken(token) {
    return token === '|' || /^or$/i.test(String(token || '').trim());
}

function isWorldInfoKeywordSearchAndToken(token) {
    return /^and$/i.test(String(token || '').trim());
}

function parseWorldInfoKeywordSearchToken(token, nextToken = '') {
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

    let scope = WORLD_INFO_KEYWORD_SEARCH_SCOPES.ALL;
    const scopedMatch = value.match(/^([a-z_]+):(.*)$/i);
    if (scopedMatch) {
        const scopeValue = WORLD_INFO_KEYWORD_SEARCH_SCOPE_ALIASES[String(scopedMatch[1] || '').trim().toLowerCase()];
        if (scopeValue) {
            scope = scopeValue;
            value = String(scopedMatch[2] || '').trim();

            if (!value) {
                const fallbackToken = String(nextToken || '').trim();
                if (fallbackToken && !isWorldInfoKeywordSearchOrToken(fallbackToken) && !isWorldInfoKeywordSearchAndToken(fallbackToken)) {
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

function parseWorldInfoKeywordSearch(searchValue, { advancedSyntax = false } = {}) {
    if (!advancedSyntax) {
        return createBasicWorldInfoKeywordSearchClauses(searchValue);
    }

    const tokens = tokenizeWorldInfoKeywordSearch(searchValue);
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

        if (isWorldInfoKeywordSearchOrToken(token)) {
            pushClause();
            continue;
        }

        if (isWorldInfoKeywordSearchAndToken(token)) {
            continue;
        }

        const parsedToken = parseWorldInfoKeywordSearchToken(token, tokens[index + 1]);
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

function getWorldInfoKeywordSearchFields(entry) {
    const titleCandidates = normalizeWorldInfoKeywordSearchCandidates([
        String(entry?.comment || '').trim(),
        ...(Array.isArray(entry?.key) ? entry.key : []),
        ...(Array.isArray(entry?.keysecondary) ? entry.keysecondary : []),
    ]);
    const groupCandidates = normalizeWorldInfoKeywordSearchCandidates(entry?.group);
    const contentCandidates = normalizeWorldInfoKeywordSearchCandidates(entry?.content);
    const uidCandidates = normalizeWorldInfoKeywordSearchCandidates(entry?.uid);
    const automationIdCandidates = normalizeWorldInfoKeywordSearchCandidates(entry?.automationId);

    return {
        titleCandidates,
        groupCandidates,
        contentCandidates,
        uidCandidates,
        automationIdCandidates,
    };
}

function pushWorldInfoKeywordCandidateScores(scores, candidates, searchTerm, exactScore, includeScore) {
    for (const value of candidates) {
        if (equalsIgnoreCaseAndAccents(value, searchTerm)) {
            scores.push(exactScore);
            continue;
        }
        if (includesIgnoreCaseAndAccents(value, searchTerm)) {
            scores.push(includeScore);
        }
    }
}

function getWorldInfoKeywordSearchScore(fields, searchTerm, scope = WORLD_INFO_KEYWORD_SEARCH_SCOPES.ALL) {
    /** @type {number[]} */
    const scores = [];

    if (scope === WORLD_INFO_KEYWORD_SEARCH_SCOPES.ALL || scope === WORLD_INFO_KEYWORD_SEARCH_SCOPES.TITLE) {
        pushWorldInfoKeywordCandidateScores(scores, fields.titleCandidates, searchTerm, 0, 1);
    }

    if (scope === WORLD_INFO_KEYWORD_SEARCH_SCOPES.ALL || scope === WORLD_INFO_KEYWORD_SEARCH_SCOPES.GROUP) {
        pushWorldInfoKeywordCandidateScores(scores, fields.groupCandidates, searchTerm, 2, 3);
    }

    if (scope === WORLD_INFO_KEYWORD_SEARCH_SCOPES.ALL || scope === WORLD_INFO_KEYWORD_SEARCH_SCOPES.CONTENT) {
        pushWorldInfoKeywordCandidateScores(scores, fields.contentCandidates, searchTerm, 4, 5);
    }

    if (scope === WORLD_INFO_KEYWORD_SEARCH_SCOPES.ALL || scope === WORLD_INFO_KEYWORD_SEARCH_SCOPES.UID) {
        pushWorldInfoKeywordCandidateScores(scores, fields.uidCandidates, searchTerm, 6, 7);
    }

    if (scope === WORLD_INFO_KEYWORD_SEARCH_SCOPES.ALL || scope === WORLD_INFO_KEYWORD_SEARCH_SCOPES.AUTOMATION_ID) {
        pushWorldInfoKeywordCandidateScores(scores, fields.automationIdCandidates, searchTerm, 8, 9);
    }

    return scores.length > 0 ? Math.min(...scores) : null;
}

function getWorldInfoKeywordClauseScore(fields, clause) {
    let score = 0;
    let positiveTermCount = 0;

    for (const term of clause) {
        const termScore = getWorldInfoKeywordSearchScore(fields, term.term, term.scope);

        if (term.negated) {
            if (termScore !== null) {
                return null;
            }
            continue;
        }

        if (termScore === null) {
            return null;
        }

        positiveTermCount += 1;
        score += termScore;
    }

    return positiveTermCount > 0 ? score : 6;
}

export function keywordSearchWorldInfo(data, searchValue, { advancedSyntax = false } = {}) {
    const clauses = parseWorldInfoKeywordSearch(searchValue, { advancedSyntax });

    if (clauses.length === 0) {
        return [];
    }

    return data
        .map((entry) => {
            const fields = getWorldInfoKeywordSearchFields(entry);
            const scores = clauses
                .map((clause) => getWorldInfoKeywordClauseScore(fields, clause))
                .filter((score) => score !== null);
            if (scores.length === 0) {
                return null;
            }
            return { item: entry, score: Math.min(...scores) };
        })
        .filter(Boolean);
}

/**
 * @typedef FilterState One of the filter states
 * @property {string} key - The key of the state
 * @property {string} class - The css class for this state
 */

/**
 * The filter states
 * @type {{ SELECTED: FilterState, EXCLUDED: FilterState, UNDEFINED: FilterState, [key: string]: FilterState }}
 */
export const FILTER_STATES = {
    SELECTED: { key: 'SELECTED', class: 'selected' },
    EXCLUDED: { key: 'EXCLUDED', class: 'excluded' },
    UNDEFINED: { key: 'UNDEFINED', class: 'undefined' },
};
/** @type {string} the default filter state of `FILTER_STATES` */
export const DEFAULT_FILTER_STATE = FILTER_STATES.UNDEFINED.key;

/**
 * Robust check if one state equals the other. It does not care whether it's the state key or the state value object.
 * @param {FilterState|string} a First state
 * @param {FilterState|string} b Second state
 * @returns {boolean}
 */
export function isFilterState(a, b) {
    const states = Object.keys(FILTER_STATES);

    const aKey = typeof a == 'string' && states.includes(a) ? a : states.find(key => FILTER_STATES[key] === a);
    const bKey = typeof b == 'string' && states.includes(b) ? b : states.find(key => FILTER_STATES[key] === b);

    return aKey === bKey;
}

/**
 * The fuzzy search categories
 * @type {{ characters: string, worldInfo: string, personas: string, tags: string, groups: string }}
 */
export const fuzzySearchCategories = Object.freeze({
    characters: 'characters',
    worldInfo: 'worldInfo',
    personas: 'personas',
    tags: 'tags',
    groups: 'groups',
});


/**
 * Helper class for filtering data.
 * @example
 * const filterHelper = new FilterHelper(() => console.log('data changed'));
 * filterHelper.setFilterData(FILTER_TYPES.SEARCH, 'test');
 * data = filterHelper.applyFilters(data);
 */
export class FilterHelper {
    /**
     * Cache fuzzy search weighting scores for re-usability, sorting and stuff
     *
     * Contains maps of weighting numbers assigned to their uid/id, for each of the different `FILTER_TYPES`
     * @type {Map<FilterType, Map<string|number,number>>}
     */
    scoreCache;

    /**
     * Cache for fuzzy search results per category.
     * @type {Object.<string, { resultMap: Map<string, any> }>}
     */
    fuzzySearchCaches;

    /**
     * Creates a new FilterHelper
     * @param {Function} onDataChanged Callback to trigger when the filter data changes
     */
    constructor(onDataChanged) {
        this.onDataChanged = onDataChanged;
        this.scoreCache = new Map();
        this.fuzzySearchCaches = {
            [fuzzySearchCategories.characters]: { resultMap: new Map() },
            [fuzzySearchCategories.worldInfo]: { resultMap: new Map() },
            [fuzzySearchCategories.personas]: { resultMap: new Map() },
            [fuzzySearchCategories.tags]: { resultMap: new Map() },
            [fuzzySearchCategories.groups]: { resultMap: new Map() },
        };
    }

    /**
     * Checks if the filter data has any values.
     * @returns {boolean} Whether the filter data has any values
     */
    hasAnyFilter() {
        /**
         * Checks if the object has any values.
         * @param {object} obj The object to check for values
         * @returns {boolean} Whether the object has any values
         */
        function checkRecursive(obj) {
            if (typeof obj === 'string' && obj.length > 0 && obj !== 'UNDEFINED') {
                return true;
            } else if (typeof obj === 'boolean' && obj) {
                return true;
            } else if (Array.isArray(obj) && obj.length > 0) {
                return true;
            } else if (typeof obj === 'object' && obj !== null && Object.keys(obj.length > 0)) {
                for (const key in obj) {
                    if (checkRecursive(obj[key])) {
                        return true;
                    }
                }
            }
            return false;
        }

        return checkRecursive(this.filterData);
    }

    /**
     * The filter functions.
     * @type {Object.<string, Function>}
     */
    filterFunctions = {
        [FILTER_TYPES.SEARCH]: this.searchFilter.bind(this),
        [FILTER_TYPES.FAV]: this.favFilter.bind(this),
        [FILTER_TYPES.GROUP]: this.groupFilter.bind(this),
        [FILTER_TYPES.FOLDER]: this.folderFilter.bind(this),
        [FILTER_TYPES.TAG]: this.tagFilter.bind(this),
        [FILTER_TYPES.WORLD_INFO_SEARCH]: this.wiSearchFilter.bind(this),
        [FILTER_TYPES.PERSONA_SEARCH]: this.personaSearchFilter.bind(this),
    };

    /**
     * The filter data.
     * @type {Object.<string, any>}
     */
    filterData = {
        [FILTER_TYPES.SEARCH]: '',
        [FILTER_TYPES.FAV]: false,
        [FILTER_TYPES.GROUP]: false,
        [FILTER_TYPES.FOLDER]: false,
        [FILTER_TYPES.TAG]: { excluded: [], selected: [] },
        [FILTER_TYPES.WORLD_INFO_SEARCH]: '',
        [FILTER_TYPES.WORLD_INFO_SEARCH_MODE]: '',
        [FILTER_TYPES.WORLD_INFO_SEARCH_ADVANCED]: false,
        [FILTER_TYPES.PERSONA_SEARCH]: '',
    };

    /**
     * Applies a fuzzy search filter to the World Info data.
     * @param {any[]} data The data to filter. Must have a uid property.
     * @returns {any[]} The filtered data.
     */
    wiSearchFilter(data) {
        const term = this.filterData[FILTER_TYPES.WORLD_INFO_SEARCH];
        const mode = this.filterData[FILTER_TYPES.WORLD_INFO_SEARCH_MODE] || WORLD_INFO_SEARCH_MODES.KEYWORD;
        const advancedSyntax = Boolean(this.filterData[FILTER_TYPES.WORLD_INFO_SEARCH_ADVANCED]);

        if (!term) {
            return data;
        }

        const searchResults = mode === WORLD_INFO_SEARCH_MODES.KEYWORD
            ? keywordSearchWorldInfo(data, term, { advancedSyntax })
            : fuzzySearchWorldInfo(data, term, this.fuzzySearchCaches);
        this.cacheScores(FILTER_TYPES.WORLD_INFO_SEARCH, new Map(searchResults.map(i => [i.item?.uid, i.score])));

        const filteredData = data.filter(entity => searchResults.find(x => x.item === entity));
        return filteredData;
    }

    /**
     * Applies a search filter to Persona data.
     * @param {string[]} data The data to filter.
     * @returns {string[]} The filtered data.
     */
    personaSearchFilter(data) {
        const term = this.filterData[FILTER_TYPES.PERSONA_SEARCH];

        if (!term) {
            return data;
        }

        const fuzzySearchResults = fuzzySearchPersonas(data, term, this.fuzzySearchCaches);
        this.cacheScores(FILTER_TYPES.PERSONA_SEARCH, new Map(fuzzySearchResults.map(i => [i.item.key, i.score])));

        const filteredData = data.filter(name => fuzzySearchResults.find(x => x.item.key === name));
        return filteredData;
    }

    /**
     * Checks if the given entity is tagged with the given tag ID.
     * @param {object} entity Searchable entity
     * @param {string} tagId Tag ID to check
     * @returns {boolean} Whether the entity is tagged with the given tag ID
     */
    isElementTagged(entity, tagId) {
        const isCharacter = entity.type === 'character';
        const lookupValue = isCharacter ? entity.item.avatar : String(entity.id);
        const isTagged = Array.isArray(tag_map[lookupValue]) && tag_map[lookupValue].includes(tagId);

        return isTagged;
    }

    /**
     * Applies a tag filter to the data.
     * @param {any[]} data The data to filter.
     * @returns {any[]} The filtered data.
     */
    tagFilter(data) {
        const TAG_LOGIC_AND = true; // switch to false to use OR logic for combining tags
        const { selected, excluded } = this.filterData[FILTER_TYPES.TAG];

        if (!selected.length && !excluded.length) {
            return data;
        }

        const getIsTagged = (entity) => {
            const isTag = entity.type === 'tag';
            const tagFlags = selected.map(tagId => this.isElementTagged(entity, tagId));
            const trueFlags = tagFlags.filter(x => x);
            const isTagged = TAG_LOGIC_AND ? tagFlags.length === trueFlags.length : trueFlags.length > 0;

            const excludedTagFlags = excluded.map(tagId => this.isElementTagged(entity, tagId));
            const isExcluded = excludedTagFlags.includes(true);

            if (isTag) {
                return true;
            } else if (isExcluded) {
                return false;
            } else if (selected.length > 0 && !isTagged) {
                return false;
            } else {
                return true;
            }
        };

        return data.filter(entity => getIsTagged(entity));
    }

    /**
     * Applies a favorite filter to the data.
     * @param {any[]} data The data to filter.
     * @returns {any[]} The filtered data.
     */
    favFilter(data) {
        const state = this.filterData[FILTER_TYPES.FAV];
        const isFav = entity => {
            const favorite = entity?.item?.data?.extensions?.fav ?? entity?.item?.fav;
            return favorite === true || favorite === 'true';
        };

        return this.filterDataByState(data, state, isFav, { includeFolders: true });
    }

    /**
     * Applies a group type filter to the data.
     * @param {any[]} data The data to filter.
     * @returns {any[]} The filtered data.
     */
    groupFilter(data) {
        const state = this.filterData[FILTER_TYPES.GROUP];
        const isGroup = entity => entity.type === 'group';

        return this.filterDataByState(data, state, isGroup, { includeFolders: true });
    }

    /**
     * Applies a "folder" filter to the data.
     * @param {any[]} data The data to filter.
     * @returns {any[]} The filtered data.
     */
    folderFilter(data) {
        const state = this.filterData[FILTER_TYPES.FOLDER];
        // Filter directly on folder. Special rules on still displaying characters with active folder filter are implemented in 'getEntitiesList' directly.
        const isFolder = entity => entity.type === 'tag';

        return this.filterDataByState(data, state, isFolder);
    }

    /**
     * Filters an array of entities based on a tri-state filter value.
     * SELECTED keeps entities where filterFunc returns true; EXCLUDED removes them; UNDEFINED returns data unchanged.
     * @param {any[]} data The data to filter
     * @param {FilterState|string} state The tri-state filter value (SELECTED, EXCLUDED, or UNDEFINED)
     * @param {Function} filterFunc A predicate function applied to each entity
     * @param {object} [options] Options object
     * @param {boolean} [options.includeFolders=false] If true, entities with type 'tag' always pass through
     * @returns {any[]} The filtered data
     */
    filterDataByState(data, state, filterFunc, { includeFolders = false } = {}) {
        if (isFilterState(state, FILTER_STATES.SELECTED)) {
            return data.filter(entity => filterFunc(entity) || (includeFolders && entity.type == 'tag'));
        }
        if (isFilterState(state, FILTER_STATES.EXCLUDED)) {
            return data.filter(entity => !filterFunc(entity) || (includeFolders && entity.type == 'tag'));
        }

        return data;
    }

    /**
     * Applies a search filter to the data. Uses fuzzy search if enabled.
     * @param {any[]} data The data to filter.
     * @returns {any[]} The filtered data.
     */
    searchFilter(data) {
        if (!this.filterData[FILTER_TYPES.SEARCH]) {
            return data;
        }

        const searchValue = this.filterData[FILTER_TYPES.SEARCH];

        // Save fuzzy search results and scores if enabled
        if (power_user.fuzzy_search) {
            const fuzzySearchCharactersResults = fuzzySearchCharacters(searchValue, this.fuzzySearchCaches);
            const fuzzySearchGroupsResults = fuzzySearchGroups(searchValue, this.fuzzySearchCaches);
            const fuzzySearchTagsResult = fuzzySearchTags(searchValue, this.fuzzySearchCaches);
            this.cacheScores(FILTER_TYPES.SEARCH, new Map(fuzzySearchCharactersResults.map(i => [`character.${i.refIndex}`, i.score])));
            this.cacheScores(FILTER_TYPES.SEARCH, new Map(fuzzySearchGroupsResults.map(i => [`group.${i.item.id}`, i.score])));
            this.cacheScores(FILTER_TYPES.SEARCH, new Map(fuzzySearchTagsResult.map(i => [`tag.${i.item.id}`, i.score])));
        }

        const _this = this;
        function getIsValidSearch(entity) {
            if (power_user.fuzzy_search) {
                // We can filter easily by checking if we have saved a score
                const score = _this.getScore(FILTER_TYPES.SEARCH, `${entity.type}.${entity.id}`);
                return score !== undefined;
            } else {
                // Compare insensitive and without accents
                return includesIgnoreCaseAndAccents(entity.item?.name, searchValue);
            }
        }

        return data.filter(entity => getIsValidSearch(entity));
    }

    /**
     * Sets the filter data for the given filter type.
     * @param {string} filterType The filter type to set data for.
     * @param {any} data The data to set.
     * @param {boolean} suppressDataChanged Whether to suppress the data changed callback.
     */
    setFilterData(filterType, data, suppressDataChanged = false) {
        const oldData = this.filterData[filterType];
        this.filterData[filterType] = data;

        // only trigger a data change if the data actually changed
        if (JSON.stringify(oldData) !== JSON.stringify(data) && !suppressDataChanged) {
            this.onDataChanged();
        }
    }

    /**
     * Gets the filter data for the given filter type.
     * @param {FilterType} filterType The filter type to get data for.
     */
    getFilterData(filterType) {
        return this.filterData[filterType];
    }

    /**
     * Applies all filters to the given data.
     * @param {any[]} data - The data to filter.
     * @param {object} options - Optional call parameters
     * @param {boolean} [options.clearScoreCache=true] - Whether the score cache should be cleared.
     * @param {Object.<FilterType, any>} [options.tempOverrides={}] - Temporarily override specific filters for this filter application
     * @param {boolean} [options.clearFuzzySearchCaches=true] - Whether the fuzzy search caches should be cleared.
     * @returns {any[]} The filtered data.
     */
    applyFilters(data, { clearScoreCache = true, tempOverrides = {}, clearFuzzySearchCaches = true } = {}) {
        if (clearScoreCache) this.clearScoreCache();

        if (clearFuzzySearchCaches) this.clearFuzzySearchCaches();

        // Save original filter states
        const originalStates = {};
        for (const key in tempOverrides) {
            originalStates[key] = this.filterData[key];
            this.filterData[key] = tempOverrides[key];
        }

        try {
            const result = Object.values(this.filterFunctions)
                .reduce((data, fn) => fn(data), data);

            // Restore original filter states
            for (const key in originalStates) {
                this.filterData[key] = originalStates[key];
            }

            return result;
        } catch (error) {
            // Restore original filter states in case of an error
            for (const key in originalStates) {
                this.filterData[key] = originalStates[key];
            }
            throw error;
        }
    }


    /**
     * Cache scores for a specific filter type
     * @param {FilterType} type - The type of data being cached
     * @param {Map<string|number, number>} results - The search results containing mapped item identifiers and their scores
     */
    cacheScores(type, results) {
        /** @type {Map<string|number, number>} */
        const typeScores = this.scoreCache.get(type) || new Map();
        for (const [uid, score] of results) {
            typeScores.set(uid, score);
        }
        this.scoreCache.set(type, typeScores);
        console.debug('search scores cached', type, typeScores);
    }

    /**
     * Get the cached score for an item by type and its identifier
     * @param {FilterType} type The type of data
     * @param {string|number} uid The unique identifier for an item
     * @returns {number|undefined} The cached score, or `undefined` if no score is present
     */
    getScore(type, uid) {
        return this.scoreCache.get(type)?.get(uid) ?? undefined;
    }

    /**
     * Clear the score cache for a specific type, or completely if no type is specified
     * @param {FilterType} [type] The type of data to clear scores for. Clears all if unspecified.
     */
    clearScoreCache(type) {
        if (type) {
            this.scoreCache.set(type, new Map());
        } else {
            this.scoreCache = new Map();
        }
    }

    /**
     * Clears fuzzy search caches
     */
    clearFuzzySearchCaches() {
        for (const cache of Object.values(this.fuzzySearchCaches)) {
            cache.resultMap.clear();
        }
    }
}
