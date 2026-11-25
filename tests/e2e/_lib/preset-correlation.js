import { resolve } from 'node:path';
import { observeOperations } from '../../harness/observations.js';

const RELEVANT = /\/api\/(settings\/(save|patch|get)|presets\/(save|delete)|characters\/merge-attributes)$/;
const INTERCEPTED = /\/api\/settings\//;
const WRITE = /\/api\/(settings\/(save|patch)|presets\/save|characters\/merge-attributes)$/;
const FIXTURE_PREFIX = '[preset-correlation] ';
const NATIVE_MARKER = 'preset-correlation-native';

/** Read-only capture and real delivery control for the preset diagnostic cases, backed by observeOperations. */
export class PresetCorrelation {
    constructor({ page, context, scope, testInfo, baseURL, stored, runtime }) {
        Object.assign(this, { page, context, scope, testInfo, baseURL, stored, runtime });
        this.directory = testInfo.outputPath('preset-correlation');
        this.core = null;
        this.sends = [];
        this.saves = new Map();
        this.preparations = new Map();
        this.updates = new Map();
        this.scheduledSaves = new Map();
        this.debounces = new Map();
        this.publics = new Map();
        this.publicOwners = new Map();
        this.publicArguments = new Map();
        this.arguments = new Map();
        this.operations = new Map();
        this.nativeReplies = [];
        this.receipts = new Map();
        this.externalEntries = new Map();
        this.invocations = new Map();
        this.sourcesActive = false;
        this.activeSettingsCallback = null;
    }

    get cdp() { return this.core?.cdp ?? null; }
    get events() { return this.core?.events ?? []; }
    get ledger() { return this.core?.ledger ?? []; }
    get jobs() { return this.core?.jobs ?? new Set(); }
    get errors() { return this.core?.errors ?? []; }
    get network() { return this.core?.network ?? new Map(); }
    get fetch() { return this.core?.fetch ?? new Map(); }
    get holds() { return this.core?.holds ?? new Map(); }
    get points() { return this.core?.points ?? new Map(); }
    get serial() { return this.core?.serial ?? 0; }
    get rules() { return this.core?.rules ?? []; }
    set rules(value) { if (this.core) this.core.rules = value; }

    body(value, type = 'application/json') {
        return this.core.storeBody(value, type);
    }

    record(kind, data) {
        return this.core.record(kind, data);
    }

    wait(predicate, options) {
        return this.core.wait(predicate, options);
    }

    job(work) {
        return this.core.job(work);
    }

    capturesSettled() {
        return this.core.capturesSettled();
    }

    point(path, needle, label, expression, identities = {}, scope = null, condition = '') {
        return this.core.addLogpoint(path, needle, label, expression, identities, scope, condition);
    }

    returns(path, startNeedle, endNeedle, label, expression, identities = {}) {
        return this.core.addReturnLogpoints(path, startNeedle, endNeedle, label, expression, identities);
    }

    removePoints(predicate) {
        return this.core.removeLogpoints(predicate);
    }

    async start() {
        if (this.core) return this;
        this.core = await observeOperations({
            page: this.page,
            context: this.context,
            scope: this.scope,
            baseURL: this.baseURL,
            artifactDir: this.directory,
            diagnosticName: `preset-correlation-${this.testInfo.retry}-${this.testInfo.repeatEachIndex}.json`,
            markerPrefix: null,
            nativeMarker: NATIVE_MARKER,
            readStored: this.stored,
            recordBodies: true,
            networkFilter: event => RELEVANT.test(event.request.url) || INTERCEPTED.test(event.request.url) || event.type === 'Document',
            patterns: ['Request', 'Response'].flatMap(requestStage => [
                { urlPattern: '*/api/settings/*', requestStage },
                { urlPattern: '*/api/characters/merge-attributes', requestStage },
                { urlPattern: '*/api/presets/save', requestStage },
            ]),
            onNativePacket: ({ event, point, data, references, stack }) => this.captureNative({ event, point, data, references, stack }),
            onFetchPaused: ({ event, response, row, stored }) => this.onPausedRequest({ event, response, row, stored }),
            beforeClose: async () => {
                if (this.core.errors.length) {
                    while (this.core.jobs.size) await Promise.all([...this.core.jobs]);
                    for (const event of [...this.core.fetch.values()]) await this.core.continueFetch(event);
                }
                for (const event of [...this.core.holds.values()]) await this.core.release(event, { cleanup: true });
                if (this.sourcesActive) {
                    await this.drain({ cleanup: true });
                    await this.removePoints(point => ['save-captured', 'public-validation-entry', 'public-captured', 'settings-save-scheduled', 'settings-save-started'].includes(point.label));
                    await this.capturesSettled();
                    this.record('consumer-capture-closed', {
                        saves: [...this.saves.values()].map(save => save.id),
                        scheduled: [...this.scheduledSaves.values()].map(schedule => ({ id: schedule.id, started: schedule.started, save: schedule.save, replacedBy: schedule.replacedBy })),
                    });
                    await this.drain({ cleanup: true, includeScheduled: false });
                    await this.capturesSettled();
                    this.sourcesActive = false;
                }
            },
            afterClose: async () => {
                const ledgerPath = resolve(this.directory, 'ledger.json');
                await this.testInfo.attach('preset-correlation', { path: ledgerPath, contentType: 'application/json' });
            },
        });
        await this.point(
            'public/scripts/frontend-log-manager.js',
            '    const normalizedLevel = normalizeLevel(level);',
            'consumer-log',
            '({ level, values: values.map(value => value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value), source })',
            {},
            'function pushFrontendLog(',
            'typeof values[0] === "string" && (values[0].startsWith("[preset-correlation] ") || values[0].startsWith("[Regex]"))',
        );
        return this;
    }

    async captureSources() {
        await this.point('public/scripts/preset-manager.js', '        const { settings, presets, preset_names } = this.getPresetListRaw();\n        const selectedName = this.getSelectedPresetName();', 'public-validation-entry', '({ name, path, valueType: typeof value, nativeFunction: typeof value === "function" ? Function.prototype.toString.call(value) : null })', { argument: 'arguments[0]', scripts: 'value', script: 'Array.isArray(value) ? value[0] : null' }, '    async writePresetExtensionField(');
        await this.point('public/scripts/utils.js', '        debounceMap.set(func, timer);', 'settings-save-scheduled', '({ timer, args })', { debounce: 'fn' }, 'export function debounce(', 'fn === window.Luker.getContext().saveSettingsDebounced');
        await this.point('public/scripts/utils.js', 'func.apply(this, args);', 'settings-save-started', '({ timer, args })', { debounce: 'fn' }, 'export function debounce(', 'fn === window.Luker.getContext().saveSettingsDebounced');
        await this.point('public/script.js', '    const previous = settingsSaveInFlight;', 'save-captured', '({ payload, settingsInput: { firstRun, accountStorage: accountStorage.getState(), currentVersion, username: name1, active_character, active_group, user_avatar, amount_gen, max_context, main_api, world_info_settings: getWorldInfoSettings(), textgenerationwebui_settings: textgen_settings, swipes, horde_settings, power_user, extension_settings, tags, tag_map, nai_settings, kai_settings, oai_settings, background: background_settings, proxies, selected_proxy }, accountStorage: accountStorage.getState(), options: normalizedOptions, target: cardPresetSave && { id: cardPresetSave.id, name: cardPresetSave.name, ghostValue: cardPresetSave.ghostValue, before: cardPresetSave.before, body: cardPresetSave.body, owner: cardPresetSave.owner } })', { payload: 'payload', target: 'cardPresetSave', input: 'options', owner: 'options?.cardPresetOwner' });
        await this.point('public/script.js', '                const patchResult = await fetch(', 'settings-patch-send', '({ url: "/api/settings/patch", body: JSON.stringify({ operations }), options })', { payload: 'payload' }, 'async function saveSettingsInternal(');
        await this.point('public/script.js', '            const result = await fetch(\'/api/settings/save\'', 'settings-full-send', '({ url: "/api/settings/save", body: JSON.stringify(payload), options })', { payload: 'payload' });
        await this.point('public/script.js', '                saved = patchResult.ok;', 'settings-patch-reply', '({ status: patchResult.status, ok: patchResult.ok })', { payload: 'payload' });
        await this.point('public/script.js', '            if (result.status === 409)', 'settings-full-reply', '({ status: result.status, ok: result.ok })', { payload: 'payload' }, 'async function saveSettingsInternal(');
        await this.point('public/script.js', '                saved = true;', 'settings-no-http', '({ payload, previousSnapshot, operations })', { payload: 'payload' }, 'async function saveSettingsInternal(');
        await this.point('public/script.js', '        settings = structuredClone(nextSnapshot);\n        rememberSettingsSnapshot(nextSnapshot, { serialized: serializedPayload, syncWorker: !workerDiff });', 'settings-internal-completed', '({ saved, payload })', { payload: 'payload' }, 'async function saveSettingsInternal(');
        await this.point('public/script.js', '        await eventSource.emit(event_types.SETTINGS_UPDATED, { cardPresetSave });', 'settings-event-entry', '({ outcome })', { payload: 'payload', target: 'cardPresetSave' }, 'export async function saveSettings(');
        await this.point('public/script.js', '    return outcome;\n}', 'save-settled', '({ outcome })', { payload: 'payload', target: 'cardPresetSave' });
        await this.point('public/scripts/preset-manager.js', '            const desiredExtensions = structuredClone(', 'public-settings-entry', '({ path, value, extensions: settings.extensions })', { argument: 'arguments[0]', extensions: 'settings.extensions' });
        await this.point('public/scripts/preset-manager.js', '            const outcome = await saveSettings(0, { cardPresetOwner: target });', 'public-captured', '({ name, path, value, intendedExtensions, presetName, selectedName, hasPreset, target: target && { id: target.id, name: target.name, source: target.source, captured: { before: target.captured.before, body: target.captured.body, owner: target.captured.owner } } })', { argument: 'arguments[0]', owner: 'target', target: 'target?.captured', extensions: 'intendedExtensions', publishedExtensions: 'settings.extensions', privateValue: 'value' });
        await this.point('public/scripts/preset-manager.js', '            if (!lodash.isEqual(acknowledged?.extensions, intendedExtensions))', 'public-acknowledgement-comparison', '({ path, value, outcome, equal: lodash.isEqual(acknowledged?.extensions, intendedExtensions), intended: JSON.parse(JSON.stringify(intendedExtensions, (key, value) => typeof value === "number" && !Number.isFinite(value) ? { $nativeType: "number", value: String(value) } : value === undefined ? { $nativeType: "undefined" } : value)), acknowledged: JSON.parse(JSON.stringify(acknowledged?.extensions, (key, value) => typeof value === "number" && !Number.isFinite(value) ? { $nativeType: "number", value: String(value) } : value === undefined ? { $nativeType: "undefined" } : value)) })', { argument: 'arguments[0]', target: 'target?.captured', extensions: 'intendedExtensions' });
        await this.point('public/scripts/openai.js', '        written = preparePresetMutation(', 'preset-prepare', '({ before, desired, live, actual, path, value, owner: target.owner, characterId: target.id, name: target.name, ghostValue: target.ghostValue })', { target: 'target' });
        await this.point('public/scripts/openai.js', '        const presets = binding.presets.slice();', 'preset-prepared', '({ written, current, path, value, owner: target.owner })', { target: 'target', written: 'written' });
        await this.point('public/scripts/openai.js', '    const liveSlot = target.character.data?.extensions?.luker?', 'preset-acknowledged', '({ written, namespace: target.character.data.extensions.luker, json: target.character.json_data, cache: characterBoundPresetState.runtimeOptions.get(target.ghostValue) })', { target: 'target', written: 'written' });
        await this.point('public/scripts/openai.js', '        refreshCharacterBoundPresetCache(target, written);', 'preset-cache-publication', '({ written, namespace: target.character.data.extensions.luker, cacheBefore: characterBoundPresetState.runtimeOptions.get(target.ghostValue) })', { target: 'target', written: 'written' });
        await this.point('public/scripts/character/presets.js', '    const trimmed = String(name || \'\').trim();', 'external-entry', '({ avatar: character.avatar, name, presetBody })', { requested: 'presetBody' }, 'export async function updateCharacterBoundPreset(');
        await this.point('public/scripts/character/presets.js', '        const nextPresets = cur.presets.slice();', 'external-captured', '({ trimmed, presetBody, stripped, current: cur })', { written: 'stripped', requested: 'presetBody' }, 'export async function updateCharacterBoundPreset(');
        await this.point('public/scripts/extensions.js', '            writes.set(key, token);\n            const replacement', 'namespace-operation-started', '({ characterId, key, serialized: true })', { token: 'token', character: 'character' }, 'export async function writeExtensionField(');
        await this.point('public/scripts/extensions.js', '    writes.set(key, token);\n    if (!isCurrent())', 'namespace-operation-started', '({ characterId, key, serialized: false })', { token: 'token', character: 'character' }, 'export async function writeExtensionField(');
        await this.point('public/scripts/extensions.js', '    const mergeResponse = await fetch(\'/api/characters/merge-attributes\'', 'character-send', '({ url: "/api/characters/merge-attributes", body, previous, value, characterId, key, avatar: character.avatar })', { token: 'token', character: 'character', value: 'value', written: 'key === "luker" ? value.chat_completion_preset?.presets?.[0]?.preset : null' }, 'async function persistExtensionField(');
        await this.point('public/scripts/extensions.js', '    console.info(\'[Extensions] writeExtensionField merge response\'', 'character-reply', '({ receipt: mergeResponse.headers.get("X-Character-Version"), status: mergeResponse.status, ok: mergeResponse.ok, characterId, key, avatar: character.avatar })', { token: 'token', character: 'character', value: 'value', response: 'mergeResponse' }, 'async function persistExtensionField(');
        await this.point('public/scripts/preset-persistence.js', '    const response = await fetch(\'/api/presets/save\'', 'global-send', '({ url: "/api/presets/save", body: JSON.stringify({ apiId, name, preset }) })', { global: 'preset' });
        await this.point('public/scripts/preset-persistence.js', '    const data = response.ok ?', 'global-reply', '({ status: response.status, ok: response.ok })', { global: 'preset' });
        await this.point('public/scripts/preset-manager.js', '        if (target) {\n            await syncCharacterBoundOpenAIPresetExtensionField', 'public-global-acknowledged', '({ presetName, acknowledged: presets[index] })', { argument: 'arguments[0]', task: 'task' });
        await this.point('public/scripts/extensions/regex/index.js', '    logEditorState(\'popup_returned\'', 'regex-popup-returned', '({ popupResult, existingId, existingScriptIndex, scriptType, scriptTypeLabel })');
        await this.point('public/scripts/extensions/regex/index.js', '        console.info(\'[Regex] Editor save confirmed\'', 'regex-confirmed', '({ newRegexScript, nativeDepths: ["minDepth", "maxDepth"].map(key => ({ key, type: typeof newRegexScript[key], value: String(newRegexScript[key]), finite: Number.isFinite(newRegexScript[key]) })), scriptType, existingScriptIndex, namespace: characters[this_chid].data.extensions.luker, rawSettings: getPresetManager().getPresetListRaw().settings, currentPreset: getPresetManager().getPresetSettings(), accountStorage: accountStorage.getState(), selected: { value: document.querySelector("#settings_preset_openai option:checked").value, name: getCurrentPresetName(), api: getCurrentPresetAPI() } })', { script: 'newRegexScript' });
        await this.point('public/scripts/extensions/regex/engine.js', '            await presetManager.writePresetExtensionField(', 'regex-public-argument', '({ scriptType, normalizedScripts })', { scripts: 'normalizedScripts', script: 'normalizedScripts[0]', inputScript: 'scripts[0]' }, 'export async function saveScriptsByType(');
        await this.point('public/scripts/extensions/regex/index.js', '    console.info(\'[Regex] saveRegexScript completed\'', 'regex-completed', '({ regexScript, scriptType, existingScriptIndex, saveSettings })');
        await this.point('public/scripts/extensions/regex/engine.js', '            console.info(\'[Regex] Preset scripts persisted', 'regex-preset-acknowledged', '({ normalizedScripts, scriptType, context })');
        await this.point('public/scripts/power-user.js', '    accountStorage.setItem(storage_keys.storyStringValidationCache, JSON.stringify(cache));', 'story-validation-captured', '({ storyString, params, hash, cache })', { validationParams: 'params' }, 'function validateStoryString(');
        this.sourcesActive = true;
        this.record('private-source-observation-started', { precedingBoundary: 'Preparation retains independent Network/Fetch and immutable fixture entry/settlement logging; private capture probes begin at this explicit boundary.' });
    }

    async captureNative({ event, point, data, references, stack }) {
        const groups = {
            argument: 'argument',
            input: 'argument',
            requested: 'argument',
            first: 'argument',
            second: 'argument',
            inputScript: 'script',
            publishedExtensions: 'extensions',
            retainedValue: 'privateValue',
            retainedBefore: 'privateValue',
            publishedValue: 'privateValue',
        };
        const identities = {};
        for (const [name, remote] of Object.entries(references)) {
            identities[name] = await this.core.resolveRemoteIdentity(remote, groups[name] || name);
        }
        const caller = this.arguments.get(identities.argument) || this.arguments.get(identities.input) || this.arguments.get(identities.requested) || null;
        const row = { id: `${point.label}-${this.serial + 1}`, ...data, identities, caller, stack, nativeTimestamp: event.timestamp, sourcePoint: point.key };
        if (point.label === 'fixture-argument' || point.label === 'fixture-arguments') {
            const entry = this.invocations.get(data.invocationId)?.entry;
            if (!entry) throw new Error(`Native fixture argument lacks original entry: ${data.invocationId}`);
            for (const id of Object.values(identities)) if (id) this.arguments.set(id, { invocationId: data.invocationId, action: entry.action });
        }
        if (point.label === 'consumer-log' && data.values[0].startsWith(FIXTURE_PREFIX)) {
            const invocation = JSON.parse(data.values[0].slice(FIXTURE_PREFIX.length));
            invocation.observedStored = this.stored();
            invocation.storedObservation = { boundary: 'independently-timed-after-native-log', observedAt: new Date().toISOString() };
            const stored = this.invocations.get(invocation.invocationId) || {};
            stored[invocation.status] = invocation;
            this.invocations.set(invocation.invocationId, stored);
            this.core.recordInvocation(invocation);
        }
        if (point.label === 'settings-save-scheduled') {
            const previous = this.debounces.get(identities.debounce);
            if (previous && !previous.started) { previous.replacedBy = row.id; row.replaces = previous.id; }
            this.debounces.set(identities.debounce, row);
            this.scheduledSaves.set(row.id, row);
        }
        if (point.label === 'settings-save-started') {
            const schedule = this.debounces.get(identities.debounce);
            if (schedule) {
                if (schedule.timer !== row.timer) throw new Error(`Settings callback differs from its observed schedule: ${row.id} / timer ${row.timer}`);
                schedule.started = row.id; row.schedule = schedule.id;
            } else row.scheduleObservation = 'This callback was scheduled before source observation was armed.';
            this.activeSettingsCallback = { entry: row, schedule };
        }
        if (point.label === 'public-captured') {
            this.publicArguments.set(identities.argument, row);
            if (identities.target) this.publics.set(identities.target, row);
            if (identities.owner) this.publicOwners.set(identities.owner, row);
        }
        if (point.label === 'save-captured') {
            const parent = this.publicOwners.get(identities.owner);
            row.parentPublic = parent?.id;
            row.parentPublicTarget = parent?.identities.target;
            row.caller = parent?.caller || caller;
            this.saves.set(identities.payload, row);
            const callback = [...this.points.values()].find(candidate => candidate.label === 'settings-save-started');
            const frame = stack.find(item => item.url.split('?')[0] === this.baseURL + '/scripts/utils.js' && item.location.lineNumber === callback.lineNumber);
            if (frame) {
                const active = this.activeSettingsCallback;
                if (active?.schedule) {
                    if (active.schedule.save) throw new Error(`Settings callback captures multiple settings invocations: ${row.id}`);
                    active.schedule.save = row.id; row.schedule = active.schedule.id;
                    row.callbackProof = { callback: active.entry.id, schedule: active.schedule.id, source: frame, mechanism: 'Validated debounce callback synchronously invokes the settings arrow exactly once before yielding.' };
                } else row.scheduleObservation = 'The settings capture has no observed scheduling identity; no schedule is assigned.';
                this.activeSettingsCallback = null;
            }
        }
        if (point.label === 'save-settled') {
            const save = this.saves.get(identities.payload);
            if (save) save.settled = row.id;
            else row.captureObservation = 'Save entered before source observation was armed.';
        }
        if (point.label === 'preset-prepared') this.preparations.set(identities.written, row);
        if (point.label === 'external-entry') this.externalEntries.set(identities.requested, row);
        if (point.label === 'external-captured') {
            row.caller = this.externalEntries.get(identities.requested)?.caller;
            this.updates.set(identities.written, row);
        }
        if (point.label === 'namespace-operation-started') this.operations.set(identities.token, row);
        if (point.label.endsWith('-send')) {
            const save = this.saves.get(identities.payload);
            const prepared = this.preparations.get(identities.written);
            const update = this.updates.get(identities.written);
            const explicit = prepared && this.publics.get(prepared.identities.target);
            const ordinary = prepared && [...this.saves.values()].find(candidate => candidate.identities.target === prepared.identities.target);
            Object.assign(row, {
                save: save?.id || ordinary?.id,
                targetIdentity: prepared?.identities.target,
                preparation: prepared?.id,
                publicInvocation: explicit?.id || save?.parentPublic,
                external: update?.id,
                origin: explicit ? 'public-field-continuation' : ordinary ? 'settings-synchronization' : update ? 'external-public-update' : 'direct',
                invocationId: explicit?.caller?.invocationId || save?.caller?.invocationId || ordinary?.caller?.invocationId || update?.caller?.invocationId || caller?.invocationId || null,
            });
            if (identities.token) row.operation = this.operations.get(identities.token);
            this.sends.push(row);
        }
        if (point.label.endsWith('-reply')) {
            const matches = this.sends.filter(send => !send.reply && (identities.token ? send.identities.token === identities.token : identities.payload ? send.identities.payload === identities.payload : send.identities.global === identities.global));
            if (matches.length > 1) throw new Error(`Native reply has duplicate operation candidates: ${row.id}: ${matches.map(send => send.id)}`);
            if (matches.length === 1) { matches[0].reply = row.id; row.nativeSend = matches[0].id; }
            if (point.label === 'character-reply') { this.nativeReplies.push(row); this.joinReceipts(); }
        }
        if (point.label === 'public-return') {
            const original = this.publicArguments.get(identities.argument);
            row.publicInvocation = original?.id;
            const own = this.sends.filter(send => send.publicInvocation === original?.id && send.url.endsWith('/api/characters/merge-attributes'));
            if (own.length === 1 && own[0].networkId) {
                const http = this.network.get(own[0].networkId);
                row.acknowledgement = { nativeSend: own[0].id, networkId: own[0].networkId, receipt: own[0].receipt, stored: http.responseStored, boundary: 'held-Fetch-response-before-delivery' };
            }
        }
        this.record(point.label, row);
    }

    assignNetwork(http, send, proof) {
        if (http.send && http.send !== send) throw new Error(`Conflicting native owners for Network ${http.request.requestId}: ${http.send.id} / ${send.id}`);
        if (send.networkId && send.networkId !== http.request.requestId) throw new Error(`Native send ${send.id} assigned to distinct Network requests`);
        http.send = send;
        send.networkId = http.request.requestId;
        if (send.invocationId) {
            this.core.linkRequest(send.networkId, send.invocationId, proof);
        } else {
            http.ownerProofs ??= [];
            http.ownerProofs.push(proof);
        }
        this.record('request-owner', {
            networkId: send.networkId,
            nativeSendId: send.id,
            save: send.save,
            targetIdentity: send.targetIdentity,
            preparation: send.preparation,
            external: send.external,
            invocationId: send.invocationId,
            proof,
        });
    }

    joinReceipts() {
        for (const native of this.nativeReplies) {
            const responses = native.receipt ? this.receipts.get(native.receipt) || [] : [];
            const natives = this.nativeReplies.filter(reply => reply.receipt && reply.receipt === native.receipt);
            if (!native.ok || !native.receipt || responses.length !== 1 || natives.length !== 1) {
                if (native.joined) {
                    const http = this.network.get(native.joined);
                    const send = this.sends.find(candidate => candidate.id === native.nativeSend);
                    const lifetime = http.ownerProofs.some(proof => proof.mechanism === 'validated-serialized-native-await-lifetime');
                    this.record('receipt-join-revoked', { native: native.id, networkId: native.joined, receipt: native.receipt, independentLifetimeProof: lifetime });
                    if (!lifetime) { delete http.send; delete send.networkId; http.invocationId = null; }
                    delete send.receipt;
                    delete native.joined;
                }
                this.record('receipt-unassigned', { native: native.id, receipt: native.receipt, status: native.status, nativeCandidates: natives.map(reply => reply.id), httpCandidates: responses.map(response => response.networkId) });
                continue;
            }
            if (native.joined) continue;
            const response = responses[0];
            const http = this.network.get(response.networkId);
            const send = this.sends.find(candidate => candidate.id === native.nativeSend);
            if (!send) {
                this.record('receipt-unassigned', { native: native.id, receipt: native.receipt, status: native.status, reason: 'No original native send was observed; this reply does not establish caller ownership.' });
                continue;
            }
            if (native.status !== response.event.responseStatusCode) throw new Error(`Native/HTTP receipt status differs: ${native.receipt}`);
            this.assignNetwork(http, send, { mechanism: 'actual-native-response-receipt', nativeReply: native.id, receipt: native.receipt, fetchId: response.event.requestId, knownAfterDelivery: true });
            native.joined = response.networkId;
            send.receipt = native.receipt;
            this.record('response-receipt-joined', { nativeReply: native.id, nativeSend: send.id, token: native.identities.token, receipt: native.receipt, networkId: response.networkId, fetchId: response.event.requestId });
        }
    }

    async onPausedRequest({ event, response, row, stored }) {
        const privateSources = this.sourcesActive;
        const network = row.request;
        if (!response && WRITE.test(event.request.url) && privateSources) {
            const frames = [];
            for (let trace = network.initiator?.stack; trace; trace = trace.parent) frames.push(...trace.callFrames);
            const candidates = this.sends.filter(send => !send.reply && !send.networkId && this.baseURL + send.url === event.request.url);
            const points = [...this.points.values()].filter(point => point.label.endsWith('-send'));
            const nativeFrames = frames.filter(frame => points.some(point => frame.url.split('?')[0] === this.baseURL + '/' + point.path.replace(/^public\//, '') && frame.lineNumber === point.lineNumber));
            if (candidates.length === 1 && nativeFrames.length) {
                const send = candidates[0];
                const serialized = send.url.startsWith('/api/settings/') || send.operation?.serialized === true;
                if (serialized) {
                    this.assignNetwork(row, send, {
                        mechanism: 'validated-serialized-native-await-lifetime',
                        fetchId: event.requestId,
                        beforeDelivery: true,
                        candidates: candidates.map(candidate => candidate.id),
                        nativeFrames,
                        operation: send.operation?.id || send.save,
                    });
                }
            }
            if (!row.send) {
                this.record('request-unassigned', {
                    networkId: event.networkId,
                    fetchId: event.requestId,
                    nativeCandidates: candidates.map(send => send.id),
                    nativeFrames,
                    initiator: network.initiator,
                    reason: 'No unique validated serialized operation is known before delivery.',
                });
            }
        } else if (!response && WRITE.test(event.request.url)) {
            this.record('preparation-request', {
                networkId: event.networkId,
                fetchId: event.requestId,
                initiator: network.initiator,
                privateSourceCapture: 'not armed during preparation',
            });
        }
        if (response) {
            row.responseStored = stored;
            const receipt = event.responseHeaders?.find(header => header.name.toLowerCase() === 'x-character-version')?.value;
            if (receipt) {
                const receipts = this.receipts.get(receipt) || [];
                receipts.push({ event, networkId: event.networkId, stored });
                this.receipts.set(receipt, receipts);
                this.record('http-response-receipt', { receipt, networkId: event.networkId, fetchId: event.requestId, status: event.responseStatusCode });
                this.joinReceipts();
            }
        }
        return false;
    }

    hold(name, predicate, options) {
        return this.core.hold(name, ({ event, response, row, network }) => predicate({ event, response, send: row.send, network }), options);
    }

    continue(event) {
        return this.core.continueFetch(event);
    }

    release(event, options) {
        return this.core.release(event, options);
    }

    async begin(action) {
        const boundary = this.serial;
        this.record('fixture-gesture-entry', { action, key: 'Space' });
        await this.page.locator('#bound-' + action).focus();
        await this.page.locator('#bound-' + action).press('Space');
        this.record('fixture-gesture-returned', { action, key: 'Space', inputEvents: this.body(await this.page.locator('#bound-input-events').textContent(), 'text/plain') });
        return this.wait(() => this.events.find(event => event.sequence > boundary && event.kind === 'invocation-entry' && event.data.action === action)?.data);
    }

    async settlement(invocationId) {
        return this.wait(() => this.invocations.get(invocationId)?.fulfilled || this.invocations.get(invocationId)?.rejected);
    }

    async completeInvocation(invocationId) {
        while (!this.invocations.get(invocationId)?.fulfilled && !this.invocations.get(invocationId)?.rejected) {
            const next = await this.wait(() => this.invocations.get(invocationId)?.fulfilled || this.invocations.get(invocationId)?.rejected || [...this.holds.values()].find(event => event.request.url.endsWith('/api/characters/merge-attributes')));
            if (next.requestId) {
                this.record('required-continuation-release', { owningInvocation: invocationId, networkId: next.networkId, fetchId: next.requestId });
                await this.release(next);
            }
        }
        return this.settlement(invocationId);
    }

    async releaseKnown() {
        this.rules = [];
        for (const event of [...this.holds.values()]) await this.release(event);
        await this.drain();
    }

    async invoke(action) {
        const entry = await this.begin(action);
        return { entry, settlement: await this.settlement(entry.invocationId) };
    }

    async completeScheduledSave(schedule) {
        const original = schedule.id;
        for (;;) {
            await this.wait(() => schedule.replacedBy || schedule.save);
            if (schedule.replacedBy) { schedule = this.scheduledSaves.get(schedule.replacedBy); continue; }
            const save = [...this.saves.values()].find(candidate => candidate.id === schedule.save);
            await this.wait(() => save.settled);
            await this.capturesSettled();
            this.record('scheduled-save-consumer-completed', { original, schedule: schedule.id, save: save.id, settlement: save.settled });
            return save;
        }
    }

    async drain({ cleanup = false, includeScheduled = true } = {}) {
        const scheduled = includeScheduled ? [...this.scheduledSaves.values()] : [];
        const saves = [...this.saves.keys()];
        const invocations = [...this.invocations.keys()];
        const sends = this.sends.slice();
        this.record('consumer-drain-entry', { scheduled: scheduled.map(schedule => schedule.id), saves, invocations, nativeSends: sends.map(send => send.id), cleanup });
        await Promise.all(scheduled.map(schedule => this.completeScheduledSave(schedule)));
        await Promise.all(saves.map(id => this.wait(() => this.saves.get(id).settled, { allowErrors: cleanup })));
        await Promise.all(invocations.map(id => this.wait(() => this.invocations.get(id)?.fulfilled || this.invocations.get(id)?.rejected, { allowErrors: cleanup })));
        await Promise.all(sends.map(send => this.wait(() => {
            if (!send.networkId) return send.reply;
            const row = this.network.get(send.networkId);
            return row?.finished || row?.failed;
        }, { allowErrors: cleanup })));
        this.record('known-consumers-drained', { scheduled: scheduled.map(schedule => schedule.id), saves, invocations, nativeSends: sends.map(send => send.id) });
        await this.capturesSettled();
    }

    close() {
        if (!this.core) return Promise.resolve();
        return this.core.close();
    }
}
