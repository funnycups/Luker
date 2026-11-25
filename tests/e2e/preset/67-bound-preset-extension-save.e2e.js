import { test as base, expect } from '../../harness/playwright.js';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { startServer } from '../../harness/server.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer, closeExtensionsDrawer, selectCharacterByName } from '../_lib/page.js';
import { writeEmbeddedCharacter } from '../character/_helpers.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';
import { ensureOaiDrawerOpen } from './_helpers.js';
import { PresetCorrelation } from '../_lib/preset-correlation.js';
import { observeOperations } from '../../harness/observations.js';

const test = base.extend({
    presetObserver: async ({ page, context, resources }, use, testInfo) => {
        const observer = correlationObserver(page, context, resources, testInfo);
        try { await use(observer); }
        finally { await observer.close(); }
    },
});

const AVATAR = 'bound-extension-watch.png';
const NAME = 'Keeper of the Bound Watch';
const PRESET = 'Bound Watch';
const SAME_NAME_AVATAR = 'same-name-bound-watch.png';
const SAME_NAME_CHARACTER = 'Keeper of the Distant Watch';
const INITIAL = { retained: 'namespace', chat_completion_preset: { presets: [
    { name: PRESET, preset: { ...JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../default/content/presets/openai/Default.json'), 'utf8')), temperature: 0.23, extensions: { retained: 'preset' } } },
    { name: 'Other Watch', preset: { temperature: 0.77 } },
], defaultPresetName: PRESET } };
const ENTRY = `import { accountStorage } from '/scripts/util/AccountStorage.js';
import { getActiveCardBoundGhostSnapshot } from '/scripts/openai.js';
export function init(ctx) {
    const result = document.createElement('pre'); result.id = 'bound-result';
    const invocationLog = document.createElement('pre'); invocationLog.id = 'bound-invocations'; invocationLog.hidden = true;
    const inputLog = document.createElement('pre'); inputLog.id = 'bound-input-events'; inputLog.hidden = true;
    for (const type of ['mousedown','mouseup','click','keydown','keyup','focusin','focusout']) ctx.addEventListener(document, type, event => {
        if (!event.target.closest('[id^="bound-"],#rightNavHolder,#extensions-settings-button')) return;
        inputLog.textContent += JSON.stringify({at:performance.now(),type,key:event.key,target:event.target.id,targetClass:event.target.className,trusted:event.isTrusted,active:document.activeElement.id,right:document.querySelector('#right-nav-panel').className,extensions:document.querySelector('#rm_extensions_block').className}) + '\\n';
    }, {capture:true});
    const input = document.createElement('input'); input.id = 'bound-value'; input.value = 'dusk';
    const logInvocation = (status, invocationId, action, value) => {
        const character = live.characters[Number(live.characterId)];
        const selected = document.querySelector('#settings_preset_openai option:checked');
        const pm = live.getPresetManager('openai'), raw = pm.getPresetListRaw();
        const snapshot = { namespace: character.data.extensions.luker, json: JSON.parse(character.json_data), editor: JSON.parse(document.querySelector('#character_json_data').value), runtime: { settings: live.chatCompletionSettings, root: pm.readPresetExtensionField({path:''}), empty: pm.readPresetExtensionField({path:[]}), named: pm.getCompletionPresetByName(${JSON.stringify(PRESET)}), selected: pm.getPresetList().presets[Number(pm.getSelectedPreset())], ghost: getActiveCardBoundGhostSnapshot(), cache: {presets:raw.presets,preset_names:raw.preset_names} } };
        const nativeCaches = JSON.parse(JSON.stringify({ root: snapshot.runtime.root, named: snapshot.runtime.named, selected: snapshot.runtime.selected, ghost: snapshot.runtime.ghost, cache: snapshot.runtime.cache }, (key, value) => typeof value === 'number' && !Number.isFinite(value) ? {nativeNumber:String(value)} : value === undefined ? {nativeType:'undefined'} : value));
        const record = JSON.stringify({ status, invocationId, action, input: input.value, value, snapshot, nativeCaches, accountStorage: accountStorage.getState(), selected: selected && { value: selected.value, name: selected.textContent, bound: selected.getAttribute('data-luker-char-bound') }, namespace: character?.data?.extensions?.luker, runtimeSettings: live.chatCompletionSettings, stack: new Error().stack });
        invocationLog.textContent += record + '\\n';
        console.debug('[preset-correlation] ' + record);
    };
    const add = (id, action) => { const b = document.createElement('button'); b.id = 'bound-' + id; b.textContent = id; b.onclick = async function boundInvocation() { const invocationId = crypto.randomUUID(); inputLog.textContent += JSON.stringify({at:performance.now(),type:'handler-entry',invocationId,action:id}) + '\\n'; logInvocation('entry', invocationId, id); result.textContent = 'pending'; try { const value = await action(invocationId); logInvocation('fulfilled', invocationId, id, value); result.textContent = JSON.stringify({ok:true}); } catch (e) { logInvocation('rejected', invocationId, id, {message:e.message,stack:e.stack}); result.textContent = JSON.stringify({ok:false,error:e.message}); } finally { result.dataset.last = id; } }; ctx.container.append(b); return b; };
    const live = ctx.lukerContext;
    const argument = (invocationId, role, value) => {
        const snapshot = JSON.stringify({invocationId,role,value},(key,value) => typeof value === 'function' ? {nativeType:'function',source:Function.prototype.toString.call(value)} : typeof value === 'number' && !Number.isFinite(value) ? {nativeType:'number',value:String(value)} : value === undefined ? {nativeType:'undefined'} : value);
        console.dir(Object.freeze({marker:'preset-correlation-native',label:'fixture-argument',snapshot,references:Object.freeze({argument:value})}));
        return value;
    };
    add('reset', async () => { const next = ${JSON.stringify(INITIAL)}; next.chat_completion_preset.presets[0].preset = {...live.getPresetManager('openai').getPresetSettings(),temperature:0.23,n:1,seed:-1,extensions:{retained:'preset',luker:{prompt_groups:[],prompt_layout:[]}}}; await live.writeExtensionField(live.characters.findIndex(c => c.avatar === ${JSON.stringify(AVATAR)}), 'luker', next); });
    add('save', async invocationId => { await live.getPresetManager('openai').writePresetExtensionField(argument(invocationId,'public',{path:'watch.value',value:{bell:input.value}})); });
    let retainedPresetBody;
    add('save-live', async () => {
        const pm = live.getPresetManager('openai');
        retainedPresetBody = pm.getPresetList().presets[Number(pm.getSelectedPreset())];
        retainedPresetBody.temperature = 0.61;
        retainedPresetBody.extensions = {...retainedPresetBody.extensions,watch:{value:input.value}};
        await pm.savePreset(${JSON.stringify(PRESET)}, retainedPresetBody, {skipUpdate:true});
    });
    add('mutate-live', async () => { retainedPresetBody.temperature = 0.99; retainedPresetBody.extensions.watch.value = 'later argument edit'; });
    add('save-native', async () => {
        live.chatCompletionSettings.temp_openai = 0.61;
        live.chatCompletionSettings.extensions = {...live.chatCompletionSettings.extensions,watch:{value:input.value}};
        await live.openai.savePreset(${JSON.stringify(PRESET)}, live.chatCompletionSettings, false);
    });
    add('context', async () => { await live.presets.writeExtensions({collection:'openai',name:${JSON.stringify(PRESET)}}, 'watch.value', {bell:input.value}); });
    add('siblings', async () => { const pm = live.getPresetManager('openai'); await Promise.all([{path:'watch.first',value:'dawn',action:'sibling-first'},{path:'watch.second',value:'noon',action:'sibling-second'}].map(async ({path,value,action}) => { const invocationId = crypto.randomUUID(); logInvocation('entry',invocationId,action); try { await pm.writePresetExtensionField(argument(invocationId,'public',{path,value})); logInvocation('fulfilled',invocationId,action); } catch(error) { logInvocation('rejected',invocationId,action,{message:error.message,stack:error.stack}); throw error; } })); });
    add('nested-seed', async invocationId => { await live.getPresetManager('openai').writePresetExtensionField(argument(invocationId,'public',{path:'watch.nested',value:{branch:{kept:'seed'},list:[{kept:'seed'}]}})); });
    add('nested-isolate', async invocationId => {
        const retainedRoot = live.chatCompletionSettings.extensions.watch, retainedBefore = retainedRoot.nested;
        const input = argument(invocationId,'public',{path:'watch.nested',value:{branch:{kept:'intent',nan:NaN,omitted:undefined},list:[{kept:'intent'},undefined,,Infinity]}});
        const pending = live.getPresetManager('openai').writePresetExtensionField(input);
        const published = live.chatCompletionSettings.extensions.watch.nested;
        console.dir(Object.freeze({marker:'preset-correlation-native',label:'fixture-intention-values',snapshot:JSON.stringify({invocationId,retained:retainedRoot.nested,published}),references:Object.freeze({retainedValue:retainedRoot.nested,retainedBefore,publishedValue:published})}));
        retainedRoot.nested.branch.kept = 'retained-edit'; retainedRoot.nested.list[0].kept = 'retained-edit';
        published.branch.kept = 'live-edit'; published.list[0].kept = 'live-edit';
        input.value.branch.kept = 'argument-edit'; input.value.list[0].kept = 'argument-edit';
        console.dir(Object.freeze({marker:'preset-correlation-native',label:'fixture-intention-edited',snapshot:JSON.stringify({invocationId,retained:retainedRoot.nested,published,argument:input.value}),references:Object.freeze({retainedValue:retainedRoot.nested,publishedValue:published})}));
        await pending;
    });
    add('global', async () => { await live.getPresetManager('openai').savePreset(${JSON.stringify(PRESET)}, {temperature:0.91,extensions:{globalSibling:true}}, {skipUpdate:false}); });
    add('binding', async () => { await live.character.presets.setDefault(live.characters.find(c => c.avatar === ${JSON.stringify(AVATAR)}), 'Other Watch'); });
    add('namespace', async () => { await live.writeExtensionField(live.characters.findIndex(c => c.avatar === ${JSON.stringify(AVATAR)}), 'luker', current => ({...current, laterSibling:'retained'})); });
    add('capture', async () => { const value = {bell:input.value}; const path = ['watch','captured']; const pending = live.getPresetManager('openai').writePresetExtensionField({path,value}); value.bell='mutated'; path[1]='wrong'; await pending; });
    add('unrelated', async () => { await live.getPresetManager('context').writePresetExtensionField({path:'watch',value:'context'}); });
    add('ordinary', async invocationId => { return await live.saveSettings(0,argument(invocationId,'settings',{})); });
    add('reapply-bound', async () => { const option = Array.from(document.querySelectorAll('#settings_preset_openai option[data-luker-char-bound="1"]')).find(option => option.textContent === ${JSON.stringify(PRESET)}); await live.getPresetManager('openai').selectPreset(option.value); });
    add('source-baseline', async invocationId => { const outcome = await live.saveSettings(0,argument(invocationId,'settings',{})); if (!outcome?.ok || outcome.status !== 'saved') throw new Error('Source baseline was not saved'); result.dataset.source = JSON.stringify(outcome.payload); });
    add('validation-baseline', async invocationId => {
        const {renderStoryString} = await import('/scripts/power-user.js');
        const {getStringHash} = await import('/scripts/utils.js');
        const storyString = live.powerUserSettings.context.story_string;
        const params = {description:'',personality:'',persona:'',scenario:'',wiBefore:'',wiAfter:'',user:'User',char:'Keeper'};
        console.dir(Object.freeze({marker:'preset-correlation-native',label:'fixture-story-validation-input',snapshot:JSON.stringify({invocationId,storyString,hash:getStringHash(storyString),params,before:accountStorage.getState()}),references:Object.freeze({validationParams:params})}));
        renderStoryString(params,{customStoryString:storyString});
        return await live.saveSettings(0,argument(invocationId,'settings',{}));
    });
    add('delete', async () => { await live.getPresetManager('openai').deletePreset(${JSON.stringify(PRESET)}); });
    add('replace', async () => { await live.getPresetManager('openai').savePreset(${JSON.stringify(PRESET)}, {temperature:0.88,extensions:{replacement:true}}, {skipUpdate:false}); });
    add('rename', async () => { const pm = live.getPresetManager('openai'); await pm.savePreset('Renamed Watch', pm.getStoredPreset(${JSON.stringify(PRESET)}), {skipUpdate:false}); await pm.deletePreset(${JSON.stringify(PRESET)}); });
    let options;
    add('options', async () => { options = {presetExtensionWrite:false}; await live.saveSettings(0,options); });
    add('mutate-options', async () => { options.presetExtensionWrite = true; options.cardPresetOwner = {source:{defaultPresetName:'wrong'}}; });
    add('later-sampler', async invocationId => { const card = live.characters.find(c => c.avatar === ${JSON.stringify(AVATAR)}); const slot = live.character.presets.list(card).find(p => p.name === ${JSON.stringify(PRESET)}); await live.character.presets.update(card, ${JSON.stringify(PRESET)}, argument(invocationId,'external',{...slot.preset,temperature:0.88})); });
    add('pending-object', async () => { live.chatCompletionSettings.extensions.watch = {a:1}; });
    add('later-object', async () => { const card = live.characters.find(c => c.avatar === ${JSON.stringify(AVATAR)}); const slot = live.character.presets.list(card).find(p => p.name === ${JSON.stringify(PRESET)}); await live.character.presets.update(card, ${JSON.stringify(PRESET)}, {...slot.preset,extensions:{...slot.preset.extensions,watch:{later:true}}}); });
    add('pending-groups', async () => { live.chatCompletionSettings.extensions.luker = {prompt_groups:[{id:'watch-group',name:'Watch group',identifiers:['main']}],prompt_layout:[{type:'group',id:'watch-group'}]}; });
    add('later-groups', async invocationId => { const card = live.characters.find(c => c.avatar === ${JSON.stringify(AVATAR)}); const slot = live.character.presets.list(card).find(p => p.name === ${JSON.stringify(PRESET)}); await live.character.presets.update(card, ${JSON.stringify(PRESET)}, argument(invocationId,'external',{...slot.preset,extensions:{...slot.preset.extensions,luker:{prompt_groups:[],prompt_layout:[{type:'prompt',identifier:'later'}]}}})); });
    add('seed-paths', async () => { const pm = live.getPresetManager('openai'); await pm.writePresetExtensionField({path:'watch',value:{value:1}}); await pm.writePresetExtensionField({path:'items',value:[{enabled:false,retained:true}]}); });
    const stamp = () => { live.extensionSettings.boundPathAttempt = input.value; };
    add('empty-array', async () => { stamp(); await live.getPresetManager('openai').writePresetExtensionField({path:[],value:{replacement:true}}); });
    add('empty-carried', async invocationId => { live.chatCompletionSettings.temp_openai = 0.61; live.chatCompletionSettings.extensions.watch.carried = 'acknowledged'; stamp(); await live.getPresetManager('openai').writePresetExtensionField(argument(invocationId,'public',{path:[],value:{replacement:true}})); });
    add('root-replace', async () => { stamp(); await live.getPresetManager('openai').writePresetExtensionField({path:'',value:{replacement:true}}); });
    add('same-nested', async () => { stamp(); await live.getPresetManager('openai').writePresetExtensionField({path:'watch.value',value:1}); });
    add('same-root', async () => { stamp(); await live.getPresetManager('openai').writePresetExtensionField({path:'',value:live.chatCompletionSettings.extensions}); });
    add('index-bracket', async () => { stamp(); await live.getPresetManager('openai').writePresetExtensionField({path:'items[0].enabled',value:true}); });
    add('index-array', async () => { stamp(); const path = ['items',0,'enabled']; const pending = live.getPresetManager('openai').writePresetExtensionField({path,value:true}); path[1]=1; path[2]='wrong'; await pending; });
    add('later-value', async invocationId => { const card = live.characters.find(c => c.avatar === ${JSON.stringify(AVATAR)}); const slot = live.character.presets.list(card).find(p => p.name === ${JSON.stringify(PRESET)}); await live.character.presets.update(card, ${JSON.stringify(PRESET)}, argument(invocationId,'external',{...slot.preset,extensions:{...slot.preset.extensions,watch:{value:2}}})); });
    add('later-items', async () => { const card = live.characters.find(c => c.avatar === ${JSON.stringify(AVATAR)}); const slot = live.character.presets.list(card).find(p => p.name === ${JSON.stringify(PRESET)}); await live.character.presets.update(card, ${JSON.stringify(PRESET)}, {...slot.preset,extensions:{...slot.preset.extensions,items:[{later:true},...slot.preset.extensions.items]}}); });
    add('seed-literal', async () => { const card = live.characters.find(c => c.avatar === ${JSON.stringify(AVATAR)}); const slot = live.character.presets.list(card).find(p => p.name === ${JSON.stringify(PRESET)}); await live.character.presets.update(card, ${JSON.stringify(PRESET)}, {...slot.preset,extensions:{...slot.preset.extensions,'items[0].enabled':false,'watch.value':1}}); });
    add('later-literal', async () => { const card = live.characters.find(c => c.avatar === ${JSON.stringify(AVATAR)}); const slot = live.character.presets.list(card).find(p => p.name === ${JSON.stringify(PRESET)}); await live.character.presets.update(card, ${JSON.stringify(PRESET)}, {...slot.preset,extensions:{...slot.preset.extensions,'watch.value':2}}); });
    const wireValue = () => ({ retained:'wire',nan:NaN,infinite:Infinity,omitted:undefined,items:[undefined,,NaN,{retained:true,omitted:undefined}] });
    add('wire-object', async invocationId => { await live.getPresetManager('openai').writePresetExtensionField(argument(invocationId,'public',{path:'watch.wire',value:wireValue()})); });
    add('wire-delete', async invocationId => { await live.getPresetManager('openai').writePresetExtensionField(argument(invocationId,'public',{path:'watch.wire',value:undefined})); });
    add('wire-unsupported', async invocationId => { await live.getPresetManager('openai').writePresetExtensionField(argument(invocationId,'public',{path:'watch.wire',value:() => 'unsupported'})); });
    add('wire-equal', async invocationId => {
        const first = {path:'watch.equal',value:{same:true}}, second = {path:'watch.equal',value:{same:true}};
        console.dir(Object.freeze({marker:'preset-correlation-native',label:'fixture-arguments',snapshot:JSON.stringify({invocationId,first,second}),references:Object.freeze({first,second})}));
        await Promise.all([first,second].map(argument => live.getPresetManager('openai').writePresetExtensionField(argument)));
    });
    const overlap = add('wire-unsupported-with-ordinary', async invocationId => {
        await live.getPresetManager('openai').writePresetExtensionField(argument(invocationId,'public',{path:'watch.wire',value:() => 'unsupported'}));
    });
    ctx.addEventListener(overlap,'keydown',async event => {
        if (event.key !== ' ') return;
        const invocationId = crypto.randomUUID();
        logInvocation('entry',invocationId,'overlap-ordinary');
        const outcome = await live.saveSettings(0,argument(invocationId,'settings',{}));
        logInvocation('fulfilled',invocationId,'overlap-ordinary',outcome);
    });
    ctx.container.append(input,result,invocationLog,inputLog);
}`;
let server;
let baseline;
const caseHistory = [];
const cardPath = () => resolve(server.dataRoot, 'default-user', 'characters', AVATAR);
const disk = () => JSON.parse(readPngCard(readFileSync(cardPath()))).data.extensions.luker;
const storedSettings = () => JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8'));

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope, batchKey: 'preset', scenarioId: 'bound-extension-save' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: 'http://127.0.0.1:1' });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: AVATAR, overrides: { name: NAME, extensions: { luker: INITIAL, card_app: { enabled:true,entry:'index.js',files:{ 'index.js':ENTRY } } } } });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'other-bound-watch.png', overrides: { name: 'Keeper of the Other Watch' } });
    const sameName = structuredClone(INITIAL);
    sameName.chat_completion_preset.presets[0].preset.temperature = 0.79;
    sameName.chat_completion_preset.presets[0].preset.extensions.watch = { distant: true };
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: SAME_NAME_AVATAR, overrides: { name: SAME_NAME_CHARACTER, extensions: { luker:sameName } } });
    writeEmbeddedCharacter({ dataRoot: server.dataRoot, avatarFile: 'legacy-bound-watch.png', overrides: { name: 'Keeper of the Legacy Watch', extensions: { luker: { retained:'legacy',chat_completion_preset:{ name:PRESET,preset:INITIAL.chat_completion_preset.presets[0].preset } },card_app:{ enabled:true,entry:'index.js',files:{ 'index.js':ENTRY } } } } });
    const legacyDir = resolve(server.dataRoot,'default-user','card-apps','legacy-bound-watch'); mkdirSync(legacyDir,{ recursive:true }); writeFileSync(resolve(legacyDir,'index.js'),ENTRY);
    const dir = resolve(server.dataRoot, 'default-user', 'card-apps', 'bound-extension-watch');
    mkdirSync(dir, { recursive:true }); writeFileSync(resolve(dir, 'index.js'), ENTRY);
});



function recordCaseHistory(testInfo, boundary) {
    const bytes = readFileSync(cardPath());
    const global = resolve(server.dataRoot, 'default-user', 'OpenAI Settings', PRESET + '.json');
    const path = testInfo.outputPath('preset-case-' + boundary + '.json');
    writeFileSync(testInfo.outputPath('preset-case-' + boundary + '.png'), bytes);
    writeFileSync(path, JSON.stringify({ title: testInfo.title, boundary, repeat: testInfo.repeatEachIndex, previousCases: caseHistory, card: JSON.parse(readPngCard(bytes)), settings: storedSettings(), global: existsSync(global) ? JSON.parse(readFileSync(global, 'utf8')) : null }, null, 2));
    return { title: testInfo.title, boundary, path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

test.beforeEach(async ({}, testInfo) => { caseHistory.push(recordCaseHistory(testInfo, 'before')); });
test.afterEach(async ({}, testInfo) => { caseHistory.push(recordCaseHistory(testInfo, 'after')); });

async function open(page) {
    await awaitMainUI(page, server.baseURL);
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName('[init] complete').some(entry => entry.entryType === 'mark'))).toBe(true);
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await expect(page.locator('#bound-save')).toBeVisible();
    await page.locator('#bound-reset').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    await selectCharacterByName(page, 'Keeper of the Other Watch');
    await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Other Watch');
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await expect(page.locator('#bound-save')).toBeVisible();
    await expect(page.locator('#settings_preset_openai option:checked')).toHaveAttribute('data-luker-char-bound', '1');
    baseline = disk();
}
async function completeState(page) {
    return page.evaluate(avatar => {
        const c = window.Luker.getContext().characters.find(c => c.avatar === avatar);
        return { live:c.data.extensions.luker,json:JSON.parse(c.json_data).data.extensions.luker,editor:JSON.parse(document.querySelector('#character_json_data').value).data.extensions.luker };
    }, AVATAR);
}
function changed(extra) {
    const expected = structuredClone(baseline);
    expected.chat_completion_preset.presets[0].preset.extensions.watch = extra;
    return expected;
}

test('public extension save persists the supported card slot without creating a global preset', async ({ page }) => {
    await open(page);
    const presets = []; page.on('request', r => { if(r.url().endsWith('/api/presets/save')) presets.push(r.postDataJSON()); });
    await page.locator('#bound-value').fill('dusk'); await page.locator('#bound-save').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    const expected = changed({ value:{ bell:'dusk' } });
    expect(disk()).toEqual(expected); expect(await completeState(page)).toEqual({ live:expected,json:expected,editor:expected });
    expect(presets).toEqual([]);
    expect(storedSettings().oai_settings.extensions.watch).toEqual({ value:{ bell:'dusk' } });
});

function holdLivePresetResponse(observer) {
    return observer.hold('live-preset-card-response', ({ response, event }) => {
        if (!response || !event.request.url.endsWith('/api/characters/merge-attributes')) return false;
        const request = JSON.parse(event.request.postData);
        return request.avatar === AVATAR && request.data.extensions.luker?.chat_completion_preset?.presets[0]?.preset.temperature === 0.61;
    });
}

for (const action of ['save-live', 'save-native']) test(`a delayed live preset save cannot publish into another character with the same preset name: ${action}`, async ({ page, presetObserver: observer }) => {
    await observer.start();
    await open(page);
    const held = holdLivePresetResponse(observer);
    const entry = await observer.begin(action);
    const response = await held.paused();
    expect(disk().chat_completion_preset.presets[0].preset.temperature).toBe(0.61);
    await selectCharacterByName(page, SAME_NAME_CHARACTER);
    await expect(page.locator('#character_name_pole')).toHaveValue(SAME_NAME_CHARACTER);
    const otherPath = resolve(server.dataRoot, 'default-user', 'characters', SAME_NAME_AVATAR);
    const otherBefore = readFileSync(otherPath);
    const runtime = () => page.evaluate(() => {
        const ctx = window.Luker.getContext();
        const pm = ctx.getPresetManager('openai');
        return { settings: ctx.chatCompletionSettings, body: pm.getPresetList().presets[Number(pm.getSelectedPreset())] };
    });
    const before = await runtime();
    expect(before.body.temperature).toBe(0.79);
    await observer.release(response);
    expect((await observer.settlement(entry.invocationId)).status).toBe('fulfilled');
    expect(await runtime()).toEqual(before);
    expect(readFileSync(otherPath)).toEqual(otherBefore);
    expect(disk().chat_completion_preset.presets[0].preset.temperature).toBe(0.61);
});

test('a live preset save retains its invocation-time body through a delayed acknowledgement', async ({ page, presetObserver: observer }) => {
    await observer.start();
    await open(page);
    const held = holdLivePresetResponse(observer);
    const entry = await observer.begin('save-live');
    const response = await held.paused();
    expect(disk().chat_completion_preset.presets[0].preset.temperature).toBe(0.61);
    await observer.invoke('mutate-live');
    await observer.release(response);
    expect((await observer.settlement(entry.invocationId)).status).toBe('fulfilled');
    expect(disk().chat_completion_preset.presets[0].preset.temperature).toBe(0.61);
    expect(disk().chat_completion_preset.presets[0].preset.extensions.watch.value).toBe('dusk');
    expect(storedSettings().oai_settings.temp_openai).toBe(0.61);
});

test('settings failure stops dependent preset and card writes and preserves retry', async ({ page }) => {
    await open(page);
    const before = readFileSync(cardPath()); const settings = storedSettings();
    const later = []; page.on('request', r => { if(/\/api\/(presets\/save|characters\/merge-attributes)$/.test(r.url())) later.push(r.url()); });
    const user = resolve(server.dataRoot, 'default-user'); chmodSync(user, 0o555);
    try {
        await page.locator('#bound-value').fill('failed'); await page.locator('#bound-save').click();
        await expect(page.locator('#bound-result')).toContainText('"ok":false');
        expect(later).toEqual([]); expect(readFileSync(cardPath())).toEqual(before); expect(storedSettings()).toEqual(settings);
        expect(await completeState(page)).toEqual({ live:baseline,json:baseline,editor:baseline });
    } finally { chmodSync(user, 0o755); }
    await page.locator('#bound-save').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    expect(disk()).toEqual(changed({ value:{ bell:'failed' } }));
});

test('secondary card HTTP failure rejects after settings acknowledgement and retry retains siblings', async ({ page }) => {
    await open(page); const bytes = readFileSync(cardPath()); const held = cardPath() + '.held'; renameSync(cardPath(), held);
    try {
        await page.locator('#bound-value').fill('midnight'); await page.locator('#bound-save').click();
        await expect(page.locator('#bound-result')).toContainText('"ok":false');
        expect(readFileSync(held)).toEqual(bytes); expect(await completeState(page)).toEqual({ live:baseline,json:baseline,editor:baseline });
        expect(storedSettings().oai_settings.extensions.watch).toEqual({ value:{ bell:'midnight' } });
    } finally { renameSync(held, cardPath()); }
    await page.locator('#bound-save').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}'); expect(disk()).toEqual(changed({ value:{ bell:'midnight' } }));
});

test('queued public field writes compose on the same card namespace', async ({ page, presetObserver: observer }) => {
    await observer.start();
    await open(page);
    await observer.captureSources();
    await observer.returns('public/scripts/preset-manager.js', '    async writePresetExtensionField(', '    // ===== Preset Group Methods =====', 'public-return', '({ name, path, value })', { argument: 'arguments[0]' });
    await validatedStoryBaseline(observer);
    const { entry, settlement } = await observer.invoke('siblings');
    await observer.drain();
    await assertSiblingAcknowledgements(observer, entry, settlement);
    expect(settlement.status).toBe('fulfilled');
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    const expected = changed({ first:'dawn',second:'noon' }); expect(disk()).toEqual(expected); expect(await completeState(page)).toEqual({ live:expected,json:expected,editor:expected });
});

async function assertSiblingAcknowledgements(observer, entry, settlement) {
    const expected = changed({ first: 'dawn', second: 'noon' });
    const cache = structuredClone(entry.snapshot.runtime.cache);
    const globalIndex = cache.preset_names[PRESET];
    if (cache.presets[globalIndex]) cache.presets[globalIndex].extensions.watch = { first: 'dawn', second: 'noon' };
    let intendedSettings;
    const acknowledgements = [];
    for (const [action, watch] of [['sibling-first', { first: 'dawn' }], ['sibling-second', { first: 'dawn', second: 'noon' }]]) {
        const invocation = [...observer.invocations.values()].find(invocation => invocation.entry?.action === action);
        expect(invocation.fulfilled).toBeDefined();
        expect(invocation.rejected).toBeUndefined();
        const capture = [...observer.publics.values()].find(row => row.caller?.invocationId === invocation.entry.invocationId);
        const save = [...observer.saves.values()].find(save => save.parentPublic === capture.id);
        const ownSettings = structuredClone(save.settingsInput);
        ownSettings.oai_settings = structuredClone(entry.snapshot.runtime.settings);
        ownSettings.oai_settings.extensions.watch = watch;
        ownSettings.accountStorage = invocation.entry.accountStorage;
        intendedSettings = ownSettings;
        expect(save.payload).toEqual(ownSettings);
        expect(capture.intendedExtensions).toEqual(ownSettings.oai_settings.extensions);
        expect(capture.identities.extensions).not.toBe(capture.identities.publishedExtensions);
        const comparison = observer.events.find(event => event.kind === 'public-acknowledgement-comparison' && event.data.identities.argument === capture.identities.argument);
        expect(comparison.data.equal).toBe(true);
        expect(comparison.data.intended).toEqual(ownSettings.oai_settings.extensions);
        expect(comparison.data.acknowledged).toEqual(ownSettings.oai_settings.extensions);
        const settingsSend = observer.sends.find(send => send.save === save.id && send.url.startsWith('/api/settings/'));
        expect(observer.network.get(settingsSend.networkId).responseStored.settings).toEqual(ownSettings);
        if (capture.hasPreset) {
            const global = observer.events.find(event => event.kind === 'public-global-acknowledged' && event.data.identities.argument === capture.identities.argument).data;
            const expectedGlobal = structuredClone(entry.snapshot.runtime.cache.presets[globalIndex]);
            expectedGlobal.extensions.watch = watch;
            expect(global.acknowledged).toEqual(expectedGlobal);
            expect(global.identities.task).toBeTruthy();
        }
        const writes = observer.sends.filter(send => send.publicInvocation === capture.id && send.url.endsWith('/api/characters/merge-attributes'));
        expect(writes).toHaveLength(1);
        const returned = observer.events.find(event => event.kind === 'public-return' && event.data.publicInvocation === capture.id);
        expect(returned.data.acknowledgement.nativeSend).toBe(writes[0].id);
        expect(returned.data.acknowledgement.receipt).toMatch(/^[a-f0-9]{64}$/);
        const acknowledgedCard = structuredClone(baseline);
        acknowledgedCard.chat_completion_preset.presets[0].preset.extensions.watch = watch;
        expect(returned.data.acknowledgement.stored.card).toEqual(acknowledgedCard);
        expect(returned.sequence).toBeLessThan(observer.events.find(event => event.kind === 'invocation-fulfilled' && event.data.invocationId === invocation.entry.invocationId).sequence);
        acknowledgements.push({ invocationId: invocation.entry.invocationId, public: capture.id, settings: save.id, card: writes[0].id, acknowledgement: returned.data.acknowledgement });
    }
    assertCorrelatedState(settlement, entry, expected, intendedSettings, cache, expected.chat_completion_preset.presets[0].preset);
    observer.record('queued-public-original-consumer-outcomes', { invocationId: entry.invocationId, acknowledgements, expected, intendedSettings, cache });
}

test('nested preset intent stays private from published edits and a retained live subtree', async ({ page, presetObserver: observer }) => {
    await observer.start();
    await open(page);
    await observer.invoke('nested-seed');
    baseline = disk();
    await observer.captureSources();
    await observer.returns('public/scripts/preset-manager.js', '    async writePresetExtensionField(', '    // ===== Preset Group Methods =====', 'public-return', '({ name, path, value })', { argument: 'arguments[0]' });
    await validatedStoryBaseline(observer);
    const held = observer.hold('nested-original-settings', ({ response, send, event }) => response && event.responseStatusCode === 200 && [...observer.saves.values()].find(save => save.id === send?.save)?.caller?.action === 'nested-isolate');
    const entry = await observer.begin('nested-isolate');
    const response = await held.paused();
    const capture = [...observer.publics.values()].find(row => row.caller?.invocationId === entry.invocationId);
    const values = observer.events.find(event => event.kind === 'fixture-intention-values' && event.data.invocationId === entry.invocationId).data;
    const intended = { branch: { kept: 'intent', nan: null }, list: [{ kept: 'intent' }, null, null, null] };
    expect(values.retained).toEqual({ branch: { kept: 'seed' }, list: [{ kept: 'seed' }] });
    expect(values.identities.retainedValue).toBe(values.identities.retainedBefore);
    expect(capture.identities.privateValue).not.toBe(values.identities.retainedValue);
    expect(capture.identities.privateValue).not.toBe(values.identities.publishedValue);
    expect(capture.intendedExtensions.watch.nested).toEqual(intended);
    await observer.release(response);
    const settlement = await observer.settlement(entry.invocationId);
    expect(settlement.status).toBe('fulfilled');
    const settings = structuredClone(entry.observedStored.settings);
    settings.oai_settings = structuredClone(entry.snapshot.runtime.settings);
    settings.oai_settings.extensions.watch.nested = intended;
    settings.accountStorage = entry.accountStorage;
    const liveSettings = structuredClone(settings.oai_settings);
    liveSettings.extensions.watch.nested.branch.kept = 'live-edit';
    liveSettings.extensions.watch.nested.list[0].kept = 'live-edit';
    const expected = structuredClone(baseline);
    expected.chat_completion_preset.presets[0].preset.extensions.watch.nested = intended;
    const cache = structuredClone(entry.snapshot.runtime.cache);
    const index = cache.preset_names[PRESET];
    if (cache.presets[index]) cache.presets[index].extensions.watch.nested = intended;
    assertCorrelatedRuntime(settlement, entry, expected, cache, expected.chat_completion_preset.presets[0].preset, liveSettings);
    const returned = observer.events.find(event => event.kind === 'public-return' && event.data.publicInvocation === capture.id);
    expect(returned.data.value).toEqual(intended);
    const ownSave = [...observer.saves.values()].find(save => save.parentPublic === capture.id);
    const ownSend = observer.sends.find(send => send.save === ownSave.id && send.url.startsWith('/api/settings/'));
    expect(ownSave.payload).toEqual(settings);
    expect(observer.network.get(ownSend.networkId).responseStored.settings).toEqual(settings);
    expect(returned.data.acknowledgement.stored.card).toEqual(expected);
    expect(returned.data.acknowledgement.stored.global).toEqual(cache.presets[index] ?? null);
    expect(returned.data.acknowledgement.stored.other).toEqual(entry.observedStored.other);
    expect(returned.data.acknowledgement.stored.otherDocument).toEqual(entry.observedStored.otherDocument);
    observer.record('nested-private-intention-acknowledged', { invocationId: entry.invocationId, capture, values, expected, settings, liveSettings, acknowledgement: returned.data.acknowledgement });
    const ordinary = await observer.invoke('ordinary');
    expect(ordinary.settlement.status).toBe('fulfilled');
    const edited = structuredClone(expected);
    edited.chat_completion_preset.presets[0].preset.extensions.watch.nested = structuredClone(liveSettings.extensions.watch.nested);
    const editedSettings = { ...settings, oai_settings: liveSettings, accountStorage: ordinary.entry.accountStorage };
    expect(ordinary.settlement.value).toEqual({ ok: true, status: 'saved', payload: editedSettings });
    assertCorrelatedState(ordinary.settlement, ordinary.entry, edited, editedSettings, cache, edited.chat_completion_preset.presets[0].preset);
    observer.record('nested-editable-live-draft-acknowledged', { invocationId: ordinary.entry.invocationId, originalInvocation: entry.invocationId, edited, editedSettings });
});

async function observeEndpointWrite(page, scope, endpoint, matches = () => true, onCharacterRequest = null) {
    const patterns = endpoint === '/api/settings/*'
        ? [
            { urlPattern: '*/api/settings/save', requestStage: 'Response' },
            { urlPattern: '*/api/settings/patch', requestStage: 'Response' },
        ]
        : [{ urlPattern: '*' + endpoint, requestStage: 'Response' }];
    if (onCharacterRequest) {
        patterns.push({ urlPattern: '*/api/characters/merge-attributes', requestStage: 'Request' });
    }
    const observer = await observeOperations({
        page,
        scope,
        baseURL: server.baseURL,
        patterns,
        readStored: () => ({ card: disk(), settings: storedSettings() }),
        enableDebugger: false,
        onFetchPaused: onCharacterRequest
            ? async ({ event, response }) => {
                if (!response && event.request.url.endsWith('/api/characters/merge-attributes')) {
                    await onCharacterRequest(event, observer);
                    return true;
                }
                return false;
            }
            : null,
    });
    const held = observer.hold(`endpoint-${endpoint}`, ({ response, event }) => (
        response
        && event.request.method === 'POST'
        && matches(event.request, event.responseStatusCode)
    ));
    return { observer, paused: held.paused(), stop: () => observer.close() };
}

test('captured value and path survive consumer mutation while settings waits', async ({ page, resources }) => {
    await open(page);
    const { observer, paused } = await observeEndpointWrite(page, resources, '/api/settings/*');
    try {
        await page.locator('#bound-value').fill('captured'); await page.locator('#bound-capture').click();
        const response = await paused; expect(response.responseStatusCode).toBe(200);
        await observer.release(response); await observer.close();
        await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        const expected = changed({ captured:{ bell:'captured' } }); expect(disk()).toEqual(expected); expect(await completeState(page)).toEqual({ live:expected,json:expected,editor:expected });
    } finally { await observer.close(); }
});

test('binding change during settings acknowledgement refuses stale secondary mutation', async ({ page, resources }) => {
    await open(page);
    const { observer, paused } = await observeEndpointWrite(page, resources, '/api/settings/*');
    try {
        await page.locator('#bound-value').fill('stale'); await page.locator('#bound-save').click(); const response = await paused;
        await page.locator('#bound-binding').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        await observer.release(response); await observer.close();
        await expect(page.locator('#bound-result')).toContainText('"ok":false');
        const expected = structuredClone(baseline); expected.chat_completion_preset.defaultPresetName = 'Other Watch';
        expect(disk()).toEqual(expected); expect(await completeState(page)).toEqual({ live:expected,json:expected,editor:expected });
        expect(storedSettings().oai_settings.extensions.watch).toEqual({ value:{ bell:'stale' } });
    } finally { await observer.close(); }
});

test('selection change during settings acknowledgement writes only the captured card and retains namespace edits', async ({ page, resources }) => {
    await open(page); const otherPath = resolve(server.dataRoot,'default-user','characters','other-bound-watch.png'); const other = readFileSync(otherPath);
    const { observer, paused } = await observeEndpointWrite(page, resources, '/api/settings/*');
    try {
        await page.locator('#bound-value').fill('original'); await page.locator('#bound-save').click(); const response = await paused;
        await page.locator('#bound-namespace').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        await selectCharacterByName(page,'Keeper of the Other Watch'); await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Other Watch');
        await observer.release(response); await observer.close();
        const expected = { ...changed({ value:{ bell:'original' } }),laterSibling:'retained' };
        await expect.poll(disk).toEqual(expected); expect(readFileSync(otherPath)).toEqual(other);
        const state = await page.evaluate(avatar => { const c = window.Luker.getContext().characters.find(c => c.avatar === avatar); return { live:c.data.extensions.luker,json:JSON.parse(c.json_data).data.extensions.luker,editor:JSON.parse(document.querySelector('#character_json_data').value).data.name }; }, AVATAR);
        expect(state).toEqual({ live:expected,json:expected,editor:'Keeper of the Other Watch' });
    } finally { await observer.close(); }
});

test('card transport failure preserves acknowledged settings without false success', async ({ page, context, resources }) => {
    await open(page); const before = readFileSync(cardPath());
    const { observer, paused } = await observeEndpointWrite(page, resources, '/api/settings/*');
    try {
        await page.locator('#bound-value').fill('offline'); await page.locator('#bound-save').click(); const response = await paused;
        await context.setOffline(true); await observer.release(response); await observer.close();
        await expect(page.locator('#bound-result')).toContainText('"ok":false');
        expect(readFileSync(cardPath())).toEqual(before); expect(await completeState(page)).toEqual({ live:baseline,json:baseline,editor:baseline });
        expect(storedSettings().oai_settings.extensions.watch).toEqual({ value:{ bell:'offline' } });
    } finally { await context.setOffline(false); await observer.close(); }
    // Reopen the acknowledged source after connectivity restoration. Ordinary
    // deferred settings listeners can legitimately normalize its full body.
    await selectCharacterByName(page, 'Keeper of the Other Watch');
    await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Other Watch');
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    baseline = disk();
    await page.locator('#bound-value').fill('offline');
    await page.locator('#bound-save').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}'); expect(disk()).toEqual(changed({ value:{ bell:'offline' } }));
});

test('real global preset failure prevents the card stage and preserves its cached body', async ({ page }) => {
    await open(page); await page.locator('#bound-global').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    // Restore the card ghost through the actual preset selector after global creation.
    await selectCharacterByName(page, 'Keeper of the Other Watch');
    await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Other Watch');
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await expect(page.locator('#settings_preset_openai option:checked')).toHaveAttribute('data-luker-char-bound','1');
    const before = readFileSync(cardPath()); const dir = resolve(server.dataRoot,'default-user','OpenAI Settings');
    const presetPath = resolve(dir,PRESET + '.json'); expect(existsSync(presetPath)).toBe(true); const preset = readFileSync(presetPath);
    chmodSync(dir,0o555);
    try {
        await page.locator('#bound-value').fill('failed-preset'); await page.locator('#bound-save').click(); await expect(page.locator('#bound-result')).toContainText('"ok":false');
        expect(readFileSync(cardPath())).toEqual(before); expect(readFileSync(presetPath)).toEqual(preset);
        const cache = await page.evaluate(name => window.Luker.getContext().getPresetManager('openai').getPresetListRaw().presets[window.Luker.getContext().getPresetManager('openai').getPresetListRaw().preset_names[name]],PRESET);
        expect(cache).toEqual(JSON.parse(preset.toString()));
    } finally { chmodSync(dir,0o755); }
    await page.locator('#bound-save').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    expect(JSON.parse(readFileSync(presetPath,'utf8')).extensions).toEqual({ globalSibling:true,watch:{ value:{ bell:'failed-preset' } } });
    expect(disk()).toEqual(changed({ value:{ bell:'failed-preset' } }));
});

test('legacy single binding normalizes before the public extension consumer writes its modern slot', async ({ page }) => {
    await awaitMainUI(page,server.baseURL); await selectCharacterByName(page,'Keeper of the Legacy Watch');
    await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Legacy Watch'); await expect(page.locator('#bound-save')).toBeVisible();
    const path = resolve(server.dataRoot,'default-user','characters','legacy-bound-watch.png');
    await expect.poll(() => JSON.parse(readPngCard(readFileSync(path))).data.extensions.luker.chat_completion_preset.presets?.map(p => p.name)).toEqual([PRESET]);
    const intendedBody = await page.evaluate(async () => { const { getChatCompletionPreset, stripOpenAIConnectionFieldsFromPreset, oai_settings } = await import('/scripts/openai.js'); return stripOpenAIConnectionFieldsFromPreset(getChatCompletionPreset(oai_settings, { includeConnectionFields: false })); });
    await page.locator('#bound-value').fill('legacy'); await page.locator('#bound-save').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    const expected = { retained:'legacy',chat_completion_preset:{ presets:[{ ...INITIAL.chat_completion_preset.presets[0],preset:{ ...INITIAL.chat_completion_preset.presets[0].preset,extensions:{ retained:'preset',watch:{ value:{ bell:'legacy' } } } } }],defaultPresetName:PRESET } };
    // Legacy normalization deliberately strips API connection fields. Derive
    // that field inventory from the shipped mapping, not from stored output.
    const connectionKeys = await page.evaluate(async () => { const { isOpenAIConnectionPresetField } = await import('/scripts/openai.js'); return Object.keys(window.Luker.getContext().getPresetManager('openai').getPresetListRaw().settings).filter(isOpenAIConnectionPresetField); });
    for (const key of [...connectionKeys,'custom_include_body','custom_exclude_body','custom_include_headers']) delete expected.chat_completion_preset.presets[0].preset[key];
    expected.chat_completion_preset.presets[0].preset = { ...intendedBody, extensions: { ...intendedBody.extensions, watch: { value: { bell: 'legacy' } } } };
    expect(JSON.parse(readPngCard(readFileSync(path))).data.extensions.luker).toEqual(expected);
});

test('global acknowledgement remains stored when the secondary card fails', async ({ page }) => {
    await open(page); await page.locator('#bound-global').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    await selectCharacterByName(page,'Keeper of the Other Watch'); await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Other Watch');
    await selectCharacterByName(page,NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    const before = readFileSync(cardPath()); const held = cardPath() + '.held'; renameSync(cardPath(),held);
    try {
        await page.locator('#bound-value').fill('partial'); await page.locator('#bound-save').click(); await expect(page.locator('#bound-result')).toContainText('"ok":false');
        const global = JSON.parse(readFileSync(resolve(server.dataRoot,'default-user','OpenAI Settings',PRESET + '.json'),'utf8'));
        expect(global).toEqual({ temperature:0.91,extensions:{ globalSibling:true,watch:{ value:{ bell:'partial' } } } });
        expect(storedSettings().oai_settings.extensions.watch).toEqual({ value:{ bell:'partial' } });
        expect(readFileSync(held)).toEqual(before); expect(await completeState(page)).toEqual({ live:baseline,json:baseline,editor:baseline });
    } finally { renameSync(held,cardPath()); }
    await page.locator('#bound-save').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}'); expect(disk()).toEqual(changed({ value:{ bell:'partial' } }));
});

test('concurrent extension fields retain global and card siblings', async ({ page, presetObserver: observer }) => {
    await observer.start();
    await open(page);
    await page.locator('#bound-global').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    await selectCharacterByName(page, 'Keeper of the Other Watch');
    await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Other Watch');
    await selectCharacterByName(page, NAME);
    await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await observer.captureSources();
    await observer.returns('public/scripts/preset-manager.js', '    async writePresetExtensionField(', '    // ===== Preset Group Methods =====', 'public-return', '({ name, path, value })', { argument: 'arguments[0]' });
    await validatedStoryBaseline(observer);
    const { entry, settlement } = await observer.invoke('siblings');
    await observer.drain();
    await assertSiblingAcknowledgements(observer, entry, settlement);
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    const expected = changed({ first: 'dawn', second: 'noon' });
    expect(disk()).toEqual(expected);
    expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
    expect(JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'OpenAI Settings', PRESET + '.json'), 'utf8'))).toEqual({ temperature: 0.91, extensions: { globalSibling: true, watch: { first: 'dawn', second: 'noon' } } });
});

test('public context extension consumer propagates secondary failure and successful retry', async ({ page }) => {
    await open(page);
    const before = readFileSync(cardPath());
    const held = cardPath() + '.held';
    renameSync(cardPath(), held);
    try {
        await page.locator('#bound-value').fill('context');
        await page.locator('#bound-context').click();
        await expect(page.locator('#bound-result')).toContainText('"ok":false');
        expect(readFileSync(held)).toEqual(before);
        expect(await completeState(page)).toEqual({ live: baseline, json: baseline, editor: baseline });
    } finally { renameSync(held, cardPath()); }
    await page.locator('#bound-context').click();
    await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    expect(disk()).toEqual(changed({ value: { bell: 'context' } }));
});

test('review ghost reads and same-character reselect retain acknowledged extensions', async ({ page }) => {
    await open(page);
    await page.locator('#bound-delete').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    await selectCharacterByName(page, 'Keeper of the Other Watch'); await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Other Watch'); await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    baseline = disk();
    await page.locator('#bound-value').fill('cache'); await page.locator('#bound-save').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    const expected = changed({ value: { bell: 'cache' } });
    const body = await page.evaluate(name => window.Luker.getContext().getPresetManager('openai').getCompletionPresetByName(name), PRESET);
    expect(body).toEqual(expected.chat_completion_preset.presets[0].preset);
    const ghost = await page.locator('#settings_preset_openai option:checked').getAttribute('value');
    await page.locator('#settings_preset_openai').selectOption({ label: 'Default' }, { force: true });
    await page.locator('#settings_preset_openai').selectOption(ghost, { force: true });
    await page.locator('#bound-ordinary').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    expect(disk()).toEqual(expected); expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
});

for (const action of ['unrelated', 'save']) test(`review ${action} save retains acknowledged sampler changes`, async ({ page }) => {
    await open(page);
    await page.locator('#temp_openai').fill('0.61', { force: true });
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().chatCompletionSettings.temp_openai)).toBe(0.61);
    await page.locator('#bound-value').fill('sampler'); await page.locator('#bound-' + action).click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    const expected = action === 'save' ? changed({ value: { bell: 'sampler' } }) : structuredClone(baseline);
    expected.chat_completion_preset.presets[0].preset.temperature = 0.61;
    expect(disk()).toEqual(expected); expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
    await selectCharacterByName(page, 'Keeper of the Other Watch'); await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Other Watch'); await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().chatCompletionSettings.temp_openai)).toBe(0.61);
});

test('review deleted global target rejects stale completion without card continuation', async ({ page, resources }, testInfo) => {
    await open(page); await page.locator('#bound-global').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    await selectCharacterByName(page, 'Keeper of the Other Watch'); await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Other Watch'); await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    const before = disk(), delayed = [], stages = [];
    const { observer, paused, stop } = await observeEndpointWrite(page, resources, '/api/presets/save', () => true, async event => { delayed.push(event); });
    try {
        await page.locator('#bound-save').click(); const response = await paused;
        expect(response.responseStatusCode).toBe(200);
        const settings = storedSettings();
        await page.locator('#bound-delete').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        await observer.release(response);
        await expect(page.locator('#bound-result')).toHaveAttribute('data-last', 'save');
        await expect(page.locator('#bound-result')).toContainText('"ok":false');
        const actual = { disk: disk(), mirrors: await completeState(page) };
        stages.push({ name: 'stale-completion', before, settings, actual });
        expect(actual).toEqual({ disk: before, mirrors: { live: before, json: before, editor: before } });
        const ordinary = structuredClone(before);
        ordinary.chat_completion_preset.presets[0].preset.extensions.watch = { value: { bell: 'dusk' } };
        expect(settings.oai_settings.extensions).toEqual(ordinary.chat_completion_preset.presets[0].preset.extensions);
        for (const event of delayed) expect(JSON.parse(event.request.postData).data.extensions.luker).toEqual(ordinary);
        await page.locator('#bound-ordinary').click();
        await stop();
        await expect(page.locator('#bound-result')).toHaveAttribute('data-last', 'ordinary');
        await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        stages.push({ name: 'ordinary-synchronization', actual: { disk: disk(), mirrors: await completeState(page), settings: storedSettings() } });
        await page.locator('#bound-reapply-bound').click();
        await expect(page.locator('#bound-result')).toHaveAttribute('data-last', 'reapply-bound');
        await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        await expect(page.locator('#settings_preset_openai option:checked')).toHaveAttribute('data-luker-char-bound', '1');
        await page.locator('#bound-save').click();
        await expect(page.locator('#bound-result')).toHaveAttribute('data-last', 'save');
        await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        expect(disk()).toEqual(ordinary);
        expect(await completeState(page)).toEqual({ live: ordinary, json: ordinary, editor: ordinary });
        stages.push({ name: 'recovery', expected: ordinary, actual: { disk: disk(), mirrors: await completeState(page), settings: storedSettings() } });
    } finally {
        await stop();
        const observationPath = testInfo.outputPath('deleted-global-continuations.json'); writeFileSync(observationPath, JSON.stringify({ delayed, stages }, null, 2));
        await testInfo.attach('deleted-global-continuations', { path: observationPath, contentType: 'application/json' });
    }
});

test('review caller options mutation cannot change captured ordinary synchronization', async ({ page, resources }) => {
    await open(page);
    await page.locator('#temp_openai').fill('0.53', { force: true });
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().chatCompletionSettings.temp_openai)).toBe(0.53);
    const { observer, paused } = await observeEndpointWrite(page, resources, '/api/settings/*');
    try {
        await page.locator('#bound-options').click(); const response = await paused;
        await page.locator('#bound-mutate-options').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        await observer.release(response); await observer.close();
        const expected = structuredClone(baseline); expected.chat_completion_preset.presets[0].preset.temperature = 0.53;
        await expect.poll(disk).toEqual(expected); expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
    } finally { await observer.close(); }
});

for (const action of ['rename', 'replace']) test(`review global ${action} while response waits refuses obsolete cache and card continuation`, async ({ page, resources }) => {
    await open(page); await page.locator('#bound-global').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    await selectCharacterByName(page, 'Keeper of the Other Watch'); await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Other Watch'); await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    const before = disk(); const { observer, paused } = await observeEndpointWrite(page, resources, '/api/presets/save');
    try {
        await page.locator('#bound-value').fill('obsolete'); await page.locator('#bound-save').click(); const response = await paused;
        await page.locator('#bound-' + action).click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        expect(response.responseStatusCode).toBe(200);
        await observer.release(response); await observer.close();
        await expect(page.locator('#bound-result')).toContainText('"ok":false');
        expect(disk()).toEqual(before); expect(await completeState(page)).toEqual({ live: before, json: before, editor: before });
        const cache = await page.evaluate(name => { const pm = window.Luker.getContext().getPresetManager('openai'); const list = pm.getPresetListRaw(); return { name:list.preset_names[name],body:list.presets[list.preset_names[name]] }; }, PRESET);
        if (action === 'replace') expect(cache.body).toEqual({ temperature: 0.88, extensions: { replacement: true } });
        else expect(cache).toEqual({});
    } finally { await observer.close(); }
});

test('fix2 held owned settings save refuses a later same-card sampler replacement', async ({ page, resources }) => {
    await open(page); await page.locator('#temp_openai').fill('0.61', { force: true });
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().chatCompletionSettings.temp_openai)).toBe(0.61);
    const { observer, paused } = await observeEndpointWrite(page, resources, '/api/settings/*');
    try {
        await page.locator('#bound-value').fill('conflict'); await page.locator('#bound-save').click(); const response = await paused;
        await page.locator('#bound-later-sampler').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        await observer.release(response); await observer.close();
        await expect(page.locator('#bound-result')).toContainText('"ok":false');
        const expected = structuredClone(baseline); expected.chat_completion_preset.presets[0].preset.temperature = 0.88;
        expect(disk()).toEqual(expected); expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
    } finally { await observer.close(); }
});

test('fix2 ordinary captured object add preserves independently added children', async ({ page, resources }) => {
    await open(page); await page.locator('#bound-pending-object').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    const { observer, paused } = await observeEndpointWrite(page, resources, '/api/settings/*');
    try {
        await page.locator('#bound-ordinary').click(); const response = await paused;
        await page.locator('#bound-later-object').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        await observer.release(response); await observer.close();
        await expect(page.locator('#bound-result')).toHaveAttribute('data-last', 'ordinary');
        await expect.poll(disk).toEqual(changed({ later: true }));
        const expected = changed({ later: true }); expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
    } finally { await observer.close(); }
});

test('fix2 nested field save retains acknowledged prompt groups and layout', async ({ page }) => {
    await open(page); await page.locator('#bound-pending-groups').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    await page.locator('#bound-value').fill('groups'); await page.locator('#bound-save').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    const expected = changed({ value: { bell: 'groups' } }); expected.chat_completion_preset.presets[0].preset.extensions.luker = { prompt_groups:[{ id:'watch-group',name:'Watch group',identifiers:['main'] }],prompt_layout:[{ type:'group',id:'watch-group' }] };
    expect(disk()).toEqual(expected); expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
});

test('fix2 overlapping array edit refuses stale layout while preserving later card state', async ({ page, presetObserver }) => {
    await sourceOwnedArray(page, presetObserver);
});

test('fix2 prompt group DOM creation and field save retain complete runtime and ghost state', async ({ page }) => {
    await open(page); await page.locator('#bound-delete').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    await selectCharacterByName(page, 'Keeper of the Other Watch'); await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Other Watch'); await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME); baseline = disk();
    await ensureOaiDrawerOpen(page);
    await page.locator('#completion_prompt_manager_group_btn').click();
    const rows = page.locator('#completion_prompt_manager_list .prompt-manager-group-editing');
    await expect(rows.nth(1)).toBeVisible();
    const ids = await rows.evaluateAll(elements => elements.slice(0, 2).map(el => el.dataset.pmIdentifier));
    await rows.nth(0).click(); await rows.nth(1).click();
    await page.locator('.prompt-manager-group-create-btn').click();
    const popup = page.locator('.popup:visible').last();
    await popup.locator('textarea').fill('Watch group'); await popup.locator('.popup-button-ok').click();
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().chatCompletionSettings.extensions.luker.prompt_groups.some(group => group.name === 'Watch group'))).toBe(true);
    const group = await page.evaluate(() => window.Luker.getContext().chatCompletionSettings.extensions.luker.prompt_groups.find(group => group.name === 'Watch group'));
    expect(group.identifiers).toEqual(ids);
    const pending = await page.evaluate(() => structuredClone(window.Luker.getContext().chatCompletionSettings.extensions));
    await page.locator('#bound-value').fill('dom-group'); await page.locator('#bound-save').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    const expected = structuredClone(baseline); expected.chat_completion_preset.presets[0].preset.extensions = { ...pending,watch:{ value:{ bell:'dom-group' } } };
    expect(disk()).toEqual(expected); expect(await completeState(page)).toEqual({ live:expected,json:expected,editor:expected });
    const runtime = await page.evaluate(() => { const pm = window.Luker.getContext().getPresetManager('openai'); return { body:pm.getPresetList().presets[Number(pm.getSelectedPreset())],extensions:window.Luker.getContext().chatCompletionSettings.extensions }; });
    expect(runtime.body).toEqual(expected.chat_completion_preset.presets[0].preset); expect(runtime.extensions).toEqual(expected.chat_completion_preset.presets[0].preset.extensions);
    const ghost = await page.locator('#settings_preset_openai option:checked').getAttribute('value');
    await page.locator('#settings_preset_openai').selectOption({ label: 'Default' }, { force: true });
    await page.locator('#settings_preset_openai').selectOption(ghost, { force: true });
    await page.locator('#bound-ordinary').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    expect(disk()).toEqual(expected);
    await selectCharacterByName(page, 'Keeper of the Other Watch'); await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Other Watch'); await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
});

async function preparePaths(page) {
    const requests = [], stages = [];
    const onRequest = request => { if (/\/api\/(settings\/(save|patch)|characters\/merge-attributes)$/.test(request.url())) requests.push({ event: 'request', url: request.url(), body: request.postDataJSON(), card: disk(), settings: storedSettings() }); };
    const onResponse = response => { if (/\/api\/(settings\/(save|patch)|characters\/merge-attributes)$/.test(response.url())) requests.push({ event: 'response', url: response.url(), body: response.request().postDataJSON(), status: response.status(), card: disk(), settings: storedSettings() }); };
    page.on('request', onRequest); page.on('response', onResponse);
    const observe = async name => stages.push({ name, card: disk(), mirrors: await completeState(page), settings: storedSettings(), liveSettings: await page.evaluate(() => window.Luker.getContext().chatCompletionSettings) });
    try {
        await open(page); await observe('opened');
        await page.locator('#bound-seed-paths').click();
        await expect(page.locator('#bound-result')).toHaveAttribute('data-last', 'seed-paths');
        await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        await observe('seed-acknowledged');
        const expected = structuredClone(baseline);
        expected.chat_completion_preset.presets[0].preset.extensions.watch = { value: 1 };
        expected.chat_completion_preset.presets[0].preset.extensions.items = [{ enabled: false, retained: true }];
        expect(disk()).toEqual(expected);
        expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
        await selectCharacterByName(page, 'Keeper of the Other Watch'); await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Other Watch');
        await expect(page.locator('#settings_preset_openai option[data-luker-char-bound="1"]')).toHaveCount(0);
        await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
        await expect(page.locator('#settings_preset_openai option:checked')).toHaveAttribute('data-luker-char-bound', '1');
        await observe('selected-after-seed');
        await expect.poll(() => page.evaluate(() => window.Luker.getContext().chatCompletionSettings.extensions.items)).toEqual([{ enabled: false, retained: true }]);
        baseline = disk();
        expect(baseline).toEqual(expected);
    } finally {
        page.off('request', onRequest); page.off('response', onResponse);
        const observationPath = test.info().outputPath('preset-source-preparation.json'); writeFileSync(observationPath, JSON.stringify({ requests, stages }, null, 2));
        await test.info().attach('preset-source-preparation', { path: observationPath, contentType: 'application/json' });
    }
}

async function holdPathSave(page, scope, onCharacterRequest) {
    const marker = randomUUID();
    await page.locator('#bound-value').fill(marker);
    // Correlate the actual settings request with this consumer invocation,
    // rather than pausing an unrelated startup or character-switch save.
    return observeEndpointWrite(page, scope, '/api/settings/*', (request, status) => {
        const body = JSON.parse(request.postData);
        return status === 200 && (body.extension_settings?.boundPathAttempt === marker
            || body.operations?.some(op => ['add', 'replace'].includes(op.op) && op.path === '/extension_settings/boundPathAttempt' && op.value === marker));
    }, onCharacterRequest);
}

async function prepareEmptyPathCase(page, collision = false) {
    await preparePaths(page);
    await page.locator('#bound-delete').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    if (collision) {
        await page.locator('#bound-global').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    }
    await selectCharacterByName(page, 'Keeper of the Other Watch'); await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Other Watch');
    await expect(page.locator('#settings_preset_openai option[data-luker-char-bound="1"]')).toHaveCount(0);
    await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await expect(page.locator('#settings_preset_openai option:checked')).toHaveAttribute('data-luker-char-bound', '1');
    // Preset selection publishes before its deferred prompt-manager sanitizer.
    // Capture only after that real UI normalization has reached the source.
    const extensions = { retained: 'preset', luker: { prompt_groups: [], prompt_layout: [] }, watch: { value: 1 }, items: [{ enabled: false, retained: true }] };
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().chatCompletionSettings.extensions)).toEqual(extensions);
    await page.locator('#bound-source-baseline').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    baseline = disk();
    const settings = storedSettings();
    expect(await page.locator('#bound-result').evaluate(el => JSON.parse(el.dataset.source))).toEqual(settings);
    expect(settings.oai_settings.extensions).toEqual(extensions);
    expect(baseline.chat_completion_preset.presets[0].preset.extensions).toEqual(extensions);
    const cache = await page.evaluate(() => {
        const { presets, preset_names } = window.Luker.getContext().getPresetManager('openai').getPresetListRaw();
        return { presets, preset_names };
    });
    const globalPath = resolve(server.dataRoot, 'default-user', 'OpenAI Settings', PRESET + '.json');
    expect(existsSync(globalPath)).toBe(collision);
    return { settings, cache, globalPath };
}

async function expectEmptyPathState(page, expected, settings, cache, ghost = expected.chat_completion_preset.presets[0].preset, observationName = 'complete-empty-path-states') {
    const global = cache.presets[cache.preset_names[PRESET]] ?? null;
    const named = global ?? ghost;
    const runtime = await page.evaluate(async name => {
        const context = window.Luker.getContext();
        const pm = context.getPresetManager('openai');
        const raw = pm.getPresetListRaw();
        const { getActiveCardBoundGhostSnapshot } = await import('/scripts/openai.js');
        return {
            settings: context.chatCompletionSettings,
            root: pm.readPresetExtensionField({ path: '' }),
            empty: pm.readPresetExtensionField({ path: [] }),
            named: pm.getCompletionPresetByName(name),
            selected: pm.getPresetList().presets[Number(pm.getSelectedPreset())],
            ghost: getActiveCardBoundGhostSnapshot().body,
            cache: { presets: raw.presets, preset_names: raw.preset_names },
        };
    }, PRESET);
    const globalPath = resolve(server.dataRoot, 'default-user', 'OpenAI Settings', PRESET + '.json');
    const actual = { settings: storedSettings(), disk: disk(), mirrors: await completeState(page), runtime, global: existsSync(globalPath) ? JSON.parse(readFileSync(globalPath, 'utf8')) : null };
    const wanted = {
        settings, disk: expected, mirrors: { live: expected, json: expected, editor: expected },
        runtime: { settings: settings.oai_settings, root: settings.oai_settings.extensions, empty: null, named, selected: named, ghost, cache }, global,
    };
    const statesPath = test.info().outputPath(observationName + '.json');
    writeFileSync(statesPath, JSON.stringify({ expected: wanted, actual }, null, 2));
    await test.info().attach('complete-empty-path-states', { path: statesPath, contentType: 'application/json' });
    expect(actual).toEqual(wanted);
}

for (const collision of [false, true]) {
    for (const action of ['empty-array', 'empty-carried', 'root-replace']) test(`${action} public path keeps complete independent states with global collision ${collision}`, async ({ page }) => {
        const { settings, cache, globalPath } = await prepareEmptyPathCase(page, collision);
        const marker = randomUUID(); await page.locator('#bound-value').fill(marker);
        const expected = structuredClone(baseline);
        settings.extension_settings.boundPathAttempt = marker;
        if (action === 'empty-carried') {
            settings.oai_settings.temp_openai = 0.61;
            settings.oai_settings.extensions.watch.carried = 'acknowledged';
            expected.chat_completion_preset.presets[0].preset.temperature = 0.61;
            expected.chat_completion_preset.presets[0].preset.extensions.watch.carried = 'acknowledged';
        }
        if (action === 'root-replace') {
            settings.oai_settings.extensions = { replacement: true };
            expected.chat_completion_preset.presets[0].preset.extensions = { replacement: true };
            if (collision) cache.presets[cache.preset_names[PRESET]].extensions = { replacement: true };
        }
        const requests = []; page.on('request', request => { if (request.url().endsWith('/api/presets/save')) requests.push(request.postDataJSON()); });
        await page.locator('#bound-' + action).click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        await expect(page.locator('#bound-result')).toHaveAttribute('data-last', action);
        await expectEmptyPathState(page, expected, settings, cache);
        expect(requests).toHaveLength(collision ? 1 : 0);
        expect(existsSync(globalPath)).toBe(collision);
        if (collision) expect(JSON.parse(readFileSync(globalPath, 'utf8'))).toEqual(cache.presets[cache.preset_names[PRESET]]);
    });
}

for (const later of ['value', 'sampler']) test(`empty array path checks carried source against later ${later} edits`, async ({ page, presetObserver }) => {
    await sourceOwnedCarried(page, presetObserver, later, false);
});

test('ordinary capture before an external edit preserves its original carried source', async ({ page, presetObserver }) => {
    await sourceOwnedCarried(page, presetObserver, 'value', true);
});

for (const kind of ['nested', 'root']) test(`same-value ${kind} ownership refuses held-response external drift`, async ({ page, resources }) => {
    await preparePaths(page); const { observer, paused } = await holdPathSave(page, resources);
    try {
        await page.locator('#bound-same-' + kind).click(); const response = await paused;
        expect(response.responseStatusCode).toBe(200);
        await page.locator('#bound-later-value').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        await observer.release(response); await observer.close();
        await expect(page.locator('#bound-result')).toContainText('"ok":false');
        await expect(page.locator('#bound-result')).toContainText('source conflict');
        await expect(page.locator('#bound-result')).toHaveAttribute('data-last', 'same-' + kind);
        const expected = structuredClone(baseline); expected.chat_completion_preset.presets[0].preset.extensions.watch.value = 2;
        expect(disk()).toEqual(expected); expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
        expect(storedSettings().oai_settings.extensions).toEqual(baseline.chat_completion_preset.presets[0].preset.extensions);
    } finally { await observer.close(); }
});

for (const syntax of ['bracket', 'array']) {
    test(`${syntax} indexed field succeeds without source drift`, async ({ page }) => {
        await preparePaths(page); await page.locator('#bound-index-' + syntax).click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        const expected = structuredClone(baseline); expected.chat_completion_preset.presets[0].preset.extensions.items[0].enabled = true;
        expect(disk()).toEqual(expected); expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
        const body = expected.chat_completion_preset.presets[0].preset;
        expect(storedSettings().oai_settings.extensions).toEqual(body.extensions);
        expect(await page.evaluate(name => window.Luker.getContext().getPresetManager('openai').getCompletionPresetByName(name), PRESET)).toEqual(body);
    });

    test(`${syntax} indexed field refuses competing array insertion`, async ({ page, resources }) => {
        await preparePaths(page); const { observer, paused } = await holdPathSave(page, resources);
        try {
            await page.locator('#bound-index-' + syntax).click(); const response = await paused;
            expect(response.responseStatusCode).toBe(200);
            await page.locator('#bound-later-items').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
            await observer.release(response); await observer.close();
            await expect(page.locator('#bound-result')).toContainText('"ok":false');
            await expect(page.locator('#bound-result')).toContainText('source conflict at /extensions/items');
            await expect(page.locator('#bound-result')).toHaveAttribute('data-last', 'index-' + syntax);
            const expected = structuredClone(baseline); expected.chat_completion_preset.presets[0].preset.extensions.items.unshift({ later: true });
            expect(disk()).toEqual(expected); expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
            const intended = structuredClone(baseline.chat_completion_preset.presets[0].preset.extensions); intended.items[0].enabled = true;
            expect(storedSettings().oai_settings.extensions).toEqual(intended);
        } finally { await observer.close(); }
    });
}

async function prepareLiteralPaths(page) {
    await preparePaths(page); await page.locator('#bound-seed-literal').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    await selectCharacterByName(page, 'Keeper of the Other Watch'); await expect(page.locator('#character_name_pole')).toHaveValue('Keeper of the Other Watch');
    await expect(page.locator('#settings_preset_openai option[data-luker-char-bound="1"]')).toHaveCount(0);
    await selectCharacterByName(page, NAME); await expect(page.locator('#character_name_pole')).toHaveValue(NAME);
    await expect(page.locator('#settings_preset_openai option:checked')).toHaveAttribute('data-luker-char-bound', '1');
    await expect.poll(() => page.evaluate(() => window.Luker.getContext().chatCompletionSettings.extensions['watch.value'])).toBe(1);
    baseline = disk();
}

for (const [syntax, intended] of [['bracket', { 'items[0].enabled': true }], ['array', { items: [{ enabled: true, retained: true }] }]]) test(`${syntax} public path preserves literal-key lodash semantics`, async ({ page }) => {
    await prepareLiteralPaths(page); await page.locator('#bound-index-' + syntax).click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
    const expected = structuredClone(baseline);
    const extensions = expected.chat_completion_preset.presets[0].preset.extensions;
    Object.assign(extensions, intended);
    expect(disk()).toEqual(expected); expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
    expect(storedSettings().oai_settings.extensions).toEqual(extensions);
});

test('same-value literal field ownership rejects competing source drift', async ({ page, resources }) => {
    await prepareLiteralPaths(page); const { observer, paused } = await holdPathSave(page, resources);
    try {
        await page.locator('#bound-same-nested').click(); const response = await paused; expect(response.responseStatusCode).toBe(200);
        await page.locator('#bound-later-literal').click(); await expect(page.locator('#bound-result')).toHaveText('{"ok":true}');
        await observer.release(response); await observer.close();
        await expect(page.locator('#bound-result')).toContainText('"ok":false'); await expect(page.locator('#bound-result')).toContainText('source conflict');
        await expect(page.locator('#bound-result')).toHaveAttribute('data-last', 'same-nested');
        const expected = structuredClone(baseline); expected.chat_completion_preset.presets[0].preset.extensions['watch.value'] = 2;
        expect(disk()).toEqual(expected); expect(await completeState(page)).toEqual({ live: expected, json: expected, editor: expected });
        expect(storedSettings().oai_settings.extensions).toEqual(baseline.chat_completion_preset.presets[0].preset.extensions);
    } finally { await observer.close(); }
});

test('preset regex editor saves its complete script into the bound card slot with JSON-wire acknowledgement', async ({ page, presetObserver }) => {
    await sourceOwnedRegex(page, presetObserver);
});

const WIRE_VALUE = { retained: 'wire', nan: null, infinite: null, items: [null, null, null, { retained: true }] };

for (const collision of [false, true]) test(`public JSON-wire values retain complete caches and omission with global collision ${collision}`, async ({ page, presetObserver: observer }) => {
    await observer.start();
    const { cache } = await prepareEmptyPathCase(page, collision);
    await observer.captureSources();
    const { settings } = await validatedStoryBaseline(observer);
    const saved = await observer.invoke('wire-object');
    expect(saved.settlement.status).toBe('fulfilled');
    const expected = structuredClone(baseline), intended = structuredClone(settings), global = structuredClone(cache);
    expected.chat_completion_preset.presets[0].preset.extensions.watch.wire = WIRE_VALUE;
    intended.oai_settings.extensions.watch.wire = WIRE_VALUE;
    intended.accountStorage = saved.entry.accountStorage;
    if (collision) global.presets[global.preset_names[PRESET]].extensions.watch = { wire: WIRE_VALUE };
    observer.record('wire-intended-complete-state', { card: expected, settings: intended, cache: global });
    assertCorrelatedState(saved.settlement, saved.entry, expected, intended, global, expected.chat_completion_preset.presets[0].preset);
    assertNativeCaches(saved.settlement, intended, global, expected.chat_completion_preset.presets[0].preset);
    const omitted = await observer.invoke('wire-delete');
    expect(omitted.settlement.status).toBe('fulfilled');
    delete expected.chat_completion_preset.presets[0].preset.extensions.watch.wire;
    delete intended.oai_settings.extensions.watch.wire;
    intended.accountStorage = omitted.entry.accountStorage;
    if (collision) delete global.presets[global.preset_names[PRESET]].extensions.watch.wire;
    assertCorrelatedState(omitted.settlement, omitted.entry, expected, intended, global, expected.chat_completion_preset.presets[0].preset);
    assertNativeCaches(omitted.settlement, intended, global, expected.chat_completion_preset.presets[0].preset);
    const unsupported = await observer.invoke('wire-unsupported');
    expect(unsupported.settlement.status).toBe('rejected');
    expect(unsupported.settlement.value.message).toContain('could not be cloned');
    const validation = observer.events.filter(event => event.kind === 'public-validation-entry' && event.data.caller?.invocationId === unsupported.entry.invocationId);
    expect(validation).toHaveLength(1);
    expect(validation[0].data.valueType).toBe('function');
    expect(observer.events.filter(event => event.kind === 'public-captured' && event.data.caller?.invocationId === unsupported.entry.invocationId)).toEqual([]);
    expect(observer.sends.filter(send => send.invocationId === unsupported.entry.invocationId)).toEqual([]);
    expect(unsupported.settlement.snapshot).toEqual(unsupported.entry.snapshot);
    expect(unsupported.settlement.observedStored).toEqual(unsupported.entry.observedStored);
    await observer.drain();
});

test('public JSON-wire card refusal preserves acknowledged settings and cache until retry', async ({ page, presetObserver: observer }) => {
    const directory = resolve(server.dataRoot, 'default-user', 'characters');
    await observer.start();
    const { cache } = await prepareEmptyPathCase(page);
    await observer.captureSources();
    const { settings } = await validatedStoryBaseline(observer);
    chmodSync(directory, 0o555);
    let failed;
    try { failed = await observer.invoke('wire-object'); }
    finally { chmodSync(directory, 0o755); }
    expect(failed.settlement.status).toBe('rejected');
    const intended = structuredClone(settings);
    intended.accountStorage = failed.entry.accountStorage;
    intended.oai_settings.extensions.watch.wire = WIRE_VALUE;
    assertCorrelatedState(failed.settlement, failed.entry, baseline, intended, cache, baseline.chat_completion_preset.presets[0].preset);
    const recovered = await observer.invoke('wire-object');
    expect(recovered.settlement.status).toBe('fulfilled');
    const expected = structuredClone(baseline);
    expected.chat_completion_preset.presets[0].preset.extensions.watch.wire = WIRE_VALUE;
    intended.accountStorage = recovered.entry.accountStorage;
    assertCorrelatedState(recovered.settlement, recovered.entry, expected, intended, cache, expected.chat_completion_preset.presets[0].preset);
    assertNativeCaches(recovered.settlement, intended, cache, expected.chat_completion_preset.presets[0].preset);
    await observer.drain();
});

function correlationObserver(page, context, scope, testInfo) {
    const observer = new PresetCorrelation({
        page, context, scope, testInfo, baseURL: server.baseURL,
        stored: () => {
            const other = resolve(server.dataRoot, 'default-user', 'characters', 'other-bound-watch.png');
            const global = resolve(server.dataRoot, 'default-user', 'OpenAI Settings', PRESET + '.json');
            return { card: disk(), png: observer.body(readFileSync(cardPath()), 'image/png'), other: observer.body(readFileSync(other), 'image/png'), otherDocument: JSON.parse(readPngCard(readFileSync(other))), settings: storedSettings(), global: existsSync(global) ? JSON.parse(readFileSync(global, 'utf8')) : null };
        },
        runtime: () => page.evaluate(async avatar => {
            const context = window.Luker.getContext();
            const character = context.characters.find(character => character.avatar === avatar);
            const pm = context.getPresetManager('openai'), raw = pm.getPresetListRaw();
            const { getActiveCardBoundGhostSnapshot } = await import('/scripts/openai.js');
            return { namespace: character.data.extensions.luker, json: JSON.parse(character.json_data), editor: JSON.parse(document.querySelector('#character_json_data').value), runtime: { settings: context.chatCompletionSettings, root: pm.readPresetExtensionField({ path: '' }), empty: pm.readPresetExtensionField({ path: [] }), named: pm.getCompletionPresetByName('Bound Watch'), selected: pm.getPresetList().presets[Number(pm.getSelectedPreset())], ghost: getActiveCardBoundGhostSnapshot(), cache: { presets: raw.presets, preset_names: raw.preset_names } } };
        }, AVATAR),
    });
    return observer;
}

function diagnosticAssertion(observer, failures, name, assertion) {
    try { assertion(); observer.record('diagnostic-assertion-passed', { name }); }
    catch (error) { failures.push(error); observer.record('diagnostic-assertion-failed', { name, message: error.message, stack: error.stack }); }
}

function assertCorrelatedState(event, source, expected, settings, cache, ghostBody, liveSettings = settings.oai_settings) {
    assertCorrelatedRuntime(event, source, expected, cache, ghostBody, liveSettings);
    const global = cache.presets[cache.preset_names[PRESET]] ?? null;
    expect(event.observedStored.card).toEqual(expected);
    expect(event.observedStored.settings).toEqual(settings);
    expect(event.observedStored.global).toEqual(global);
    expect(event.observedStored.other).toEqual(source.observedStored.other);
    expect(event.observedStored.otherDocument).toEqual(source.observedStored.otherDocument);
}

function assertCorrelatedRuntime(event, source, expected, cache, ghostBody, liveSettings) {
    const json = structuredClone(source.snapshot.json), editor = structuredClone(source.snapshot.editor);
    json.data.extensions.luker = structuredClone(expected);
    editor.data.extensions.luker = structuredClone(expected);
    const global = cache.presets[cache.preset_names[PRESET]] ?? null;
    const named = global ?? ghostBody;
    const wanted = {
        namespace: expected, json, editor,
        runtime: { settings: liveSettings, root: liveSettings.extensions, empty: null, named, selected: named, ghost: { ...source.snapshot.runtime.ghost, body: ghostBody }, cache },
    };
    expect(event.snapshot).toEqual(wanted);
}

function assertNativeCaches(event, settings, cache, body) {
    const ghost = { ...event.snapshot.runtime.ghost, body };
    const named = Object.hasOwn(cache.preset_names, PRESET) ? cache.presets[cache.preset_names[PRESET]] : body;
    expect(event.nativeCaches).toEqual({ root: settings.oai_settings.extensions, named, selected: named, ghost, cache });
}

async function sourceOwnedCarried(page, observer, later, earlyOrdinary) {
    const failures = [];
    try {
        await observer.start();
        const { cache } = await prepareEmptyPathCase(page);
        await observer.captureSources();
        const { settings } = await validatedStoryBaseline(observer);
        const before = structuredClone(baseline);
        const other = readFileSync(resolve(server.dataRoot, 'default-user', 'characters', 'other-bound-watch.png'));
        await page.locator('#bound-value').fill('correlation-carried');
        const intendedSettings = structuredClone(settings);
        intendedSettings.extension_settings.boundPathAttempt = 'correlation-carried';
        intendedSettings.oai_settings.temp_openai = 0.61;
        intendedSettings.oai_settings.extensions.watch.carried = 'acknowledged';
        const held = observer.hold('owned-carried-settings', ({ response, send, event }) => response && event.responseStatusCode === 200 && send?.save && [...observer.saves.values()].find(save => save.id === send.save)?.caller?.action === 'empty-carried');
        const carried = await observer.begin('empty-carried');
        intendedSettings.accountStorage = carried.accountStorage;
        const response = await held.paused();
        const early = earlyOrdinary ? await observer.begin('ordinary') : null;
        const request = observer.network.get(response.networkId);
        expect(request.send.invocationId).toBe(carried.invocationId);
        const capture = [...observer.saves.values()].find(save => save.id === request.send.save);
        expect(capture.payload).toEqual(intendedSettings);
        expect(capture.target.before).toEqual(before.chat_completion_preset.presets[0].preset);
        expect(storedSettings()).toEqual(intendedSettings);
        if (early) {
            const earlyCapture = await observer.wait(() => [...observer.saves.values()].find(save => save.caller?.invocationId === early.invocationId));
            expect(earlyCapture.target.before).toEqual(before.chat_completion_preset.presets[0].preset);
            diagnosticAssertion(observer, failures, 'early ordinary complete input', () => expect(earlyCapture.payload).toEqual(intendedSettings));
            observer.record('controlled-pre-external-ordinary-capture', { invocationId: early.invocationId, capture: earlyCapture });
        }
        observer.record('owned-settings-committed', { stored: observer.stored(), capture, intended: { settings: intendedSettings, card: before } });
        const external = await observer.invoke('later-' + later);
        expect(external.settlement.status).toBe('fulfilled');
        const afterExternal = structuredClone(before);
        if (later === 'value') afterExternal.chat_completion_preset.presets[0].preset.extensions.watch = { value: 2 };
        else afterExternal.chat_completion_preset.presets[0].preset.temperature = 0.88;
        diagnosticAssertion(observer, failures, 'complete external publication', () => assertCorrelatedState(external.settlement, external.entry, afterExternal, intendedSettings, cache, before.chat_completion_preset.presets[0].preset));
        observer.record('external-completed', { consumer: external.settlement, intended: { settings: intendedSettings, card: afterExternal } });
        const others = observer.hold('other-character-invocations', ({ response, event, send }) => !response && event.request.url.endsWith('/api/characters/merge-attributes') && send.invocationId !== carried.invocationId, { repeat: true });
        await observer.release(response);
        const result = await observer.completeInvocation(carried.invocationId);
        if (early) {
            const earlySettlement = await observer.completeInvocation(early.invocationId);
            expect(earlySettlement.status).toBe('fulfilled');
            observer.record('controlled-pre-external-ordinary-settled', { invocationId: early.invocationId, settlement: earlySettlement });
        }
        const carriedState = structuredClone(afterExternal);
        if (later === 'value') {
            expect(result.status).toBe('fulfilled');
            carriedState.chat_completion_preset.presets[0].preset.temperature = 0.61;
            carriedState.chat_completion_preset.presets[0].preset.extensions.watch = { value: 2, carried: 'acknowledged' };
        } else {
            expect(result.status).toBe('rejected');
            expect(result.value.message).toContain('source conflict at /temperature');
        }
        diagnosticAssertion(observer, failures, 'complete carried publication', () => assertCorrelatedState(result, carried, carriedState, intendedSettings, cache, later === 'value' ? carriedState.chat_completion_preset.presets[0].preset : before.chat_completion_preset.presets[0].preset));
        observer.record('carried-consumer-completed', { consumer: result, intended: { card: carriedState, settings: intendedSettings } });
        const ordinary = structuredClone(carriedState);
        ordinary.chat_completion_preset.presets[0].preset.temperature = 0.61;
        ordinary.chat_completion_preset.presets[0].preset.extensions = structuredClone(intendedSettings.oai_settings.extensions);
        for (const event of others.rule.events) {
            const send = observer.network.get(event.networkId).send;
            observer.record('additional-character-classification-input', { networkId: event.networkId, fetchId: event.requestId, nativeSend: send });
            expect(send.origin).toBe('settings-synchronization');
            const source = [...observer.saves.values()].find(save => save.id === send.save);
            expect(source).toBeDefined();
            const originalSource = isDeepStrictEqual(source.target.before, before.chat_completion_preset.presets[0].preset);
            if (later === 'sampler') expect(originalSource).toBe(false);
            if (!originalSource) expect([afterExternal.chat_completion_preset.presets[0].preset, carriedState.chat_completion_preset.presets[0].preset]).toContainEqual(source.target.before);
            const expected = later === 'value' && originalSource ? carriedState : ordinary;
            expect(JSON.parse(event.request.postData)).toEqual({ avatar: AVATAR, data: { extensions: { luker: expected } }, replacePaths: ['data.extensions.luker'] });
            observer.record('source-owned-additional-request', { source, expected, networkId: event.networkId, fetchId: event.requestId });
        }
        await observer.releaseKnown();
        const ordinaryInvocation = await observer.invoke('ordinary');
        expect(ordinaryInvocation.settlement.status).toBe('fulfilled');
        const ordinarySettings = { ...intendedSettings, accountStorage: ordinaryInvocation.entry.accountStorage };
        expect(ordinaryInvocation.settlement.value).toEqual({ ok: true, status: 'saved', payload: ordinarySettings });
        await observer.drain();
        diagnosticAssertion(observer, failures, 'complete later ordinary publication', () => assertCorrelatedState(ordinaryInvocation.settlement, ordinaryInvocation.entry, ordinary, ordinarySettings, cache, ordinary.chat_completion_preset.presets[0].preset));
        expect(readFileSync(resolve(server.dataRoot, 'default-user', 'characters', 'other-bound-watch.png'))).toEqual(other);
        observer.record('separate-ordinary-consumer-completed', { consumer: ordinaryInvocation.settlement, intended: { card: ordinary, settings: ordinarySettings } });
        await observer.drain();
        const noops = observer.events.filter(event => event.kind === 'settings-no-http');
        diagnosticAssertion(observer, failures, 'observed no-HTTP settings lifecycle', () => expect(noops.length).toBeGreaterThan(0));
        for (const noop of noops) {
            const save = observer.saves.get(noop.data.identities.payload);
            expect(noop.data.payload).toEqual(noop.data.previousSnapshot);
            expect(noop.data.operations).toEqual([]);
            expect(save.settled).toBeDefined();
            expect(observer.sends.filter(send => send.save === save.id && send.url.startsWith('/api/settings/'))).toEqual([]);
            observer.record('no-http-settings-consumer-completed', { saveId: save.id, targetIdentity: save.identities.target, settlement: save.settled, input: noop.data });
        }
    } catch (error) {
        failures.push(error); observer.record('diagnostic-case-error', { message: error.message, stack: error.stack });
    }
    if (failures.length) throw new AggregateError(failures, 'Preset correlation retained diagnostic failures');
}

async function sourceOwnedArray(page, observer) {
    const failures = [];
    try {
        await observer.start();
        await open(page);
        await observer.captureSources();
        await validatedStoryBaseline(observer);
        const before = structuredClone(baseline);
        const cache = (await observer.runtime()).runtime.cache;
        const pending = await observer.invoke('pending-groups');
        expect(pending.settlement.status).toBe('fulfilled');
        const groups = { prompt_groups: [{ id: 'watch-group', name: 'Watch group', identifiers: ['main'] }], prompt_layout: [{ type: 'group', id: 'watch-group' }] };
        expect(pending.settlement.snapshot.runtime.settings.extensions.luker).toEqual(groups);
        let originalSelection;
        const held = observer.hold('owned-array-settings', ({ response, event, send }) => {
            if (response && /\/api\/settings\//.test(event.request.url) && !originalSelection) {
                originalSelection = { event, send };
                observer.record('array-original-response-selection', originalSelection);
            }
            return response && event.responseStatusCode === 200 && send?.save && [...observer.saves.values()].find(save => save.id === send.save)?.caller?.action === 'save';
        });
        const invocation = await observer.begin('save');
        const response = await held.paused();
        const native = observer.network.get(response.networkId).send;
        diagnosticAssertion(observer, failures, 'array held response invocation', () => expect(native?.invocationId).toBe(invocation.invocationId));
        const capture = await observer.wait(() => [...observer.saves.values()].find(save => save.caller?.invocationId === invocation.invocationId));
        const source = [...observer.publics.values()].find(row => row.caller?.invocationId === invocation.invocationId);
        const intendedSettings = structuredClone(capture.payload);
        intendedSettings.oai_settings = structuredClone(invocation.snapshot.runtime.settings);
        intendedSettings.accountStorage = invocation.accountStorage;
        intendedSettings.oai_settings.extensions.luker = groups;
        intendedSettings.oai_settings.extensions.watch = { value: { bell: 'dusk' } };
        diagnosticAssertion(observer, failures, 'array complete desired settings', () => expect(capture.payload).toEqual(intendedSettings));
        diagnosticAssertion(observer, failures, 'array original empty source', () => expect(source.target.captured.before).toEqual(before.chat_completion_preset.presets[0].preset));
        observer.record('array-source-discriminator', { invocationId: invocation.invocationId, originalSelection, heldNetworkId: response.networkId, heldFetchId: response.requestId, heldMethod: response.request.method, heldURL: response.request.url, heldNativeSend: native, publicCapture: source, settingsCapture: capture, original: before, pendingGroups: groups });
        expect(native.invocationId).toBe(invocation.invocationId);
        expect(source.target.captured.before.extensions.luker).toEqual({ prompt_groups: [], prompt_layout: [] });
        const external = await observer.invoke('later-groups');
        expect(external.settlement.status).toBe('fulfilled');
        const later = structuredClone(external.entry.snapshot.namespace);
        later.chat_completion_preset.presets[0].preset.extensions.luker = { prompt_groups: [], prompt_layout: [{ type: 'prompt', identifier: 'later' }] };
        diagnosticAssertion(observer, failures, 'array external complete acknowledgement', () => assertCorrelatedState(external.settlement, external.entry, later, intendedSettings, cache, external.entry.snapshot.runtime.ghost.body));
        observer.hold('array-other-character-invocations', ({ response, event, send }) => !response && event.request.url.endsWith('/api/characters/merge-attributes') && send.invocationId !== invocation.invocationId, { repeat: true });
        await observer.release(response);
        const result = await observer.completeInvocation(invocation.invocationId);
        // A global preset with the same name accepts the card-bound watch
        // write during the save. The cache captured before the save still
        // holds the prior body, so mirror the acknowledged value.
        const globalIndex = cache.preset_names[PRESET];
        if (globalIndex !== undefined) cache.presets[globalIndex].extensions.watch = { value: { bell: 'dusk' } };
        diagnosticAssertion(observer, failures, 'retained original array refusal', () => expect(result.status).toBe('rejected'));
        const expected = structuredClone(later);
        diagnosticAssertion(observer, failures, 'array refusal details', () => expect(result.value.message).toContain('source conflict at /extensions/luker/prompt_layout'));
        diagnosticAssertion(observer, failures, 'array complete consumer state', () => assertCorrelatedState(result, invocation, expected, intendedSettings, cache, invocation.snapshot.runtime.ghost.body));
        observer.record('array-public-result', { invocationId: invocation.invocationId, source: source.target.captured, result, external: external.settlement });
        await observer.releaseKnown();
        const recovery = await observer.invoke('save');
        expect(recovery.settlement.status).toBe('fulfilled');
        const recovered = structuredClone(recovery.entry.snapshot.namespace);
        recovered.chat_completion_preset.presets[0].preset.extensions.luker = groups;
        recovered.chat_completion_preset.presets[0].preset.extensions.watch = { value: { bell: 'dusk' } };
        const recoverySettings = { ...intendedSettings, accountStorage: recovery.entry.accountStorage };
        diagnosticAssertion(observer, failures, 'array non-overlap recovery', () => assertCorrelatedState(recovery.settlement, recovery.entry, recovered, recoverySettings, cache, recovered.chat_completion_preset.presets[0].preset));
        observer.record('state', { name: 'array-recovery-consumer-completed', stored: recovery.settlement.observedStored, runtime: recovery.settlement.snapshot, intended: { card: recovered, settings: recoverySettings }, invocationId: recovery.entry.invocationId });
        await observer.drain();
    } catch (error) { failures.push(error); observer.record('diagnostic-case-error', { message: error.message, stack: error.stack }); }
    if (failures.length) throw new AggregateError(failures, 'Array correlation retained diagnostic failures');
}

async function sourceOwnedRegex(page, observer) {
    const failures = [];
    try {
        await observer.start();
        await open(page);
        await observer.captureSources();
        await validatedStoryBaseline(observer);
        const beforeFlow = { entry: { snapshot: await observer.runtime(), observedStored: observer.stored() } };
        await openExtensionsDrawer(page);
        const content = page.locator('#regex_container .inline-drawer').first().locator('> .inline-drawer-content');
        if (!await content.isVisible()) await page.locator('#regex_container .inline-drawer-toggle').first().click();
        const uiInvocation = randomUUID();
        observer.record('regex-ui-entry', { invocationId: uiInvocation, selector: '#open_preset_editor', stored: observer.stored() });
        await page.locator('#open_preset_editor').click();
        const popup = page.locator('.popup:visible').last();
        await popup.locator('input.regex_script_name').fill('Watch inscription');
        await popup.locator('input.find_regex').fill('/dusk/g');
        await popup.locator('textarea.regex_replace_string').fill('midnight');
        await observer.returns('public/scripts/preset-manager.js', '    async writePresetExtensionField(', '    // ===== Preset Group Methods =====', 'public-return', '({ name, path, value })', { argument: 'arguments[0]' });
        await observer.returns('public/scripts/extensions/regex/index.js', 'async function saveRegexScript(', '/**\n * Delete a regex script by ID', 'regex-return', '({ regexScript, scriptType, existingScriptIndex, saveSettings })', { script: 'regexScript' });
        const boundary = observer.serial;
        observer.record('regex-confirmation-entry', { invocationId: uiInvocation, entered: { scriptName: 'Watch inscription', findRegex: '/dusk/g', replaceString: 'midnight' } });
        await popup.locator('.popup-button-ok').first().press('Enter');
        await expect(popup).toBeHidden();
        observer.record('regex-popup-hidden', { invocationId: uiInvocation, stored: observer.stored() });
        const confirmed = await observer.wait(() => observer.events.find(event => event.sequence > boundary && event.kind === 'regex-confirmed')?.data);
        const expectedScript = { id: confirmed.newRegexScript.id, scriptName: 'Watch inscription', findRegex: '/dusk/g', replaceString: 'midnight', trimStrings: [], placement: [1], disabled: false, markdownOnly: true, promptOnly: false, pluginLanes: [], runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null };
        diagnosticAssertion(observer, failures, 'independent complete confirmed regex record', () => expect(confirmed.newRegexScript).toEqual(expectedScript));
        observer.record('regex-frozen-intention', { invocationId: uiInvocation, script: expectedScript, preInvocation: confirmed });
        const settled = await observer.wait(() => observer.events.find(event => event.sequence > boundary && (event.kind === 'public-return' && event.data.path === 'regex_scripts' && event.data.value.some(script => script.id === expectedScript.id) || event.kind === 'consumer-log' && event.data.values[0] === '[Regex] saveRegexScript failed after editor confirm')));
        observer.record('regex-owning-consumer-settled', { invocationId: uiInvocation, stage: settled.kind, event: settled.data });
        const publicCapture = observer.events.find(event => event.sequence > boundary && event.kind === 'public-captured' && event.data.path === 'regex_scripts' && event.data.value.some(script => script.id === expectedScript.id));
        expect(publicCapture).toBeDefined();
        diagnosticAssertion(observer, failures, 'regex target source', () => expect(publicCapture.data.target.captured.before).toEqual(confirmed.namespace.chat_completion_preset.presets[0].preset));
        diagnosticAssertion(observer, failures, 'regex owning public consumer fulfilled', () => expect(settled.kind).toBe('public-return'));
        if (settled.kind === 'public-return') await observer.wait(() => observer.events.find(event => event.sequence > boundary && event.kind === 'regex-return' && event.data.regexScript.id === expectedScript.id));
        const expected = structuredClone(confirmed.namespace);
        expected.chat_completion_preset.presets[0].preset.extensions.regex_scripts = [expectedScript];
        const capture = [...observer.saves.values()].find(save => save.parentPublic === publicCapture.data.id);
        expect(capture).toBeDefined();
        diagnosticAssertion(observer, failures, 'regex original public return acknowledges its complete settings and card', () => {
            expect(settled.data.publicInvocation).toBe(publicCapture.data.id);
            expect(settled.data.acknowledgement.stored.settings).toEqual(capture.payload);
            expect(settled.data.acknowledgement.stored.card).toEqual(expected);
        });
        const scheduled = observer.events.findLast(event => event.sequence > boundary && event.kind === 'settings-save-scheduled' && event.data.stack.some(frame => frame.functionName === 'saveRegexScript'));
        expect(scheduled).toBeDefined();
        const continuation = await observer.completeScheduledSave(scheduled.data);
        const finalSettings = structuredClone(capture.payload);
        finalSettings.accountStorage = continuation.accountStorage;
        const allowed = finalSettings.extension_settings.preset_allowed_regex.openai ?? [];
        finalSettings.extension_settings.preset_allowed_regex.openai = allowed.includes(PRESET) ? allowed : [...allowed, PRESET];
        diagnosticAssertion(observer, failures, 'regex scheduled permission save has the complete intended input', () => expect(continuation.payload).toEqual(finalSettings));
        await observer.drain();
        await closeExtensionsDrawer(page);
        const actual = { settlement: { snapshot: await observer.runtime(), observedStored: observer.stored() } };
        diagnosticAssertion(observer, failures, 'regex complete requested script array', () => expect(publicCapture.data.value).toEqual([expectedScript]));
        const cache = structuredClone(beforeFlow.entry.snapshot.runtime.cache);
        if (Object.hasOwn(cache.preset_names, PRESET)) cache.presets[cache.preset_names[PRESET]].extensions.regex_scripts = [expectedScript];
        diagnosticAssertion(observer, failures, 'regex complete acknowledged state', () => assertCorrelatedState(actual.settlement, beforeFlow.entry, expected, finalSettings, cache, expected.chat_completion_preset.presets[0].preset));
        const ghost = { ...beforeFlow.entry.snapshot.runtime.ghost, body: expected.chat_completion_preset.presets[0].preset };
        const named = Object.hasOwn(cache.preset_names, PRESET) ? cache.presets[cache.preset_names[PRESET]] : ghost.body;
        const nativeCaches = await page.evaluate(async () => {
            const context = window.Luker.getContext(), pm = context.getPresetManager('openai'), raw = pm.getPresetListRaw();
            const { getActiveCardBoundGhostSnapshot } = await import('/scripts/openai.js');
            return JSON.parse(JSON.stringify({ root: pm.readPresetExtensionField({ path: '' }), named: pm.getCompletionPresetByName('Bound Watch'), selected: pm.getPresetList().presets[Number(pm.getSelectedPreset())], ghost: getActiveCardBoundGhostSnapshot(), cache: { presets: raw.presets, preset_names: raw.preset_names } }, (key, value) => typeof value === 'number' && !Number.isFinite(value) ? { nativeNumber: String(value) } : value === undefined ? { nativeType: 'undefined' } : value));
        });
        diagnosticAssertion(observer, failures, 'regex native caches equal acknowledged wire objects', () => expect(nativeCaches).toEqual({ root: capture.payload.oai_settings.extensions, named, selected: named, ghost, cache }));
        const ownWrites = observer.sends.filter(send => send.publicInvocation === publicCapture.data.id && send.url.endsWith('/api/characters/merge-attributes'));
        diagnosticAssertion(observer, failures, 'regex original public writer reached its own card HTTP acknowledgement', () => {
            expect(ownWrites).toHaveLength(1);
            expect(observer.network.get(ownWrites[0].networkId).response.response.status).toBe(200);
        });
        observer.record('regex-post-consumer-and-descendants', { actual: actual.settlement, nativeCaches, intended: { card: expected, script: expectedScript, settings: finalSettings }, publicSettings: observer.body(capture.payload), requiredSchedule: scheduled.data.id, requiredSave: continuation.id, invocationId: uiInvocation });
    } catch (error) { failures.push(error); observer.record('diagnostic-case-error', { message: error.message, stack: error.stack }); }
    if (failures.length) throw new AggregateError(failures, 'Regex correlation retained diagnostic failures');
}

test('shared navigation acknowledges drawer state and the named character', async ({ page }) => {
    await open(page);
    const before = { card: disk(), mirrors: await completeState(page) };
    await openExtensionsDrawer(page);
    await openExtensionsDrawer(page);
    await closeExtensionsDrawer(page);
    await closeExtensionsDrawer(page);
    await selectCharacterByName(page, 'Keeper of the Other Watch');
    await selectCharacterByName(page, NAME);
    expect({ card: disk(), mirrors: await completeState(page) }).toEqual(before);
});

test('preset observer releases held settings through its owning consumer before detaching', async ({ page, presetObserver: observer }) => {
    await observer.start();
    const { cache } = await prepareEmptyPathCase(page);
    await observer.captureSources();
    const { settings } = await validatedStoryBaseline(observer);
    const held = observer.hold('close-owned-settings', ({ response, send, event }) => response && event.responseStatusCode === 200 && send?.invocationId && observer.invocations.get(send.invocationId)?.entry?.action === 'save');
    const entry = await observer.begin('save');
    const response = await held.paused();
    expect(observer.network.get(response.networkId).send.invocationId).toBe(entry.invocationId);
    await observer.close();
    expect(page.isClosed()).toBe(false);
    expect(observer.holds.size).toBe(0);
    expect(observer.jobs.size).toBe(0);
    const result = await observer.settlement(entry.invocationId);
    expect(result.status).toBe('fulfilled');
    const expected = changed({ value: { bell: 'dusk' } });
    const intended = structuredClone(settings);
    intended.oai_settings.extensions.watch = { value: { bell: 'dusk' } };
    intended.accountStorage = entry.accountStorage;
    assertCorrelatedState(result, entry, expected, intended, cache, expected.chat_completion_preset.presets[0].preset);
});

async function validatedStoryBaseline(observer) {
    const invocation = await observer.invoke('validation-baseline');
    expect(invocation.settlement.status).toBe('fulfilled');
    const input = observer.events.find(event => event.kind === 'fixture-story-validation-input' && event.data.invocationId === invocation.entry.invocationId).data;
    const account = structuredClone(input.before);
    const cache = account.StoryStringValidationCache === undefined ? { hashCache: {} } : JSON.parse(account.StoryStringValidationCache);
    if (!Object.hasOwn(cache.hashCache, input.hash)) cache.hashCache[input.hash] = { fieldsWarned: {} };
    account.StoryStringValidationCache = JSON.stringify(cache);
    const validation = observer.events.find(event => event.kind === 'story-validation-captured' && event.data.identities.validationParams === input.identities.validationParams).data;
    expect(validation.storyString).toBe(input.storyString);
    expect(validation.params).toEqual(input.params);
    expect(validation.cache).toEqual(cache);
    const save = [...observer.saves.values()].find(save => save.caller?.invocationId === invocation.entry.invocationId);
    const settings = structuredClone(save.settingsInput);
    settings.oai_settings = structuredClone(invocation.entry.snapshot.runtime.settings);
    settings.accountStorage = account;
    expect(save.accountStorage).toEqual(account);
    expect(save.payload).toEqual(settings);
    expect(invocation.settlement.value).toEqual({ ok: true, status: 'saved', payload: settings });
    await observer.drain();
    expect(observer.stored().settings).toEqual(settings);
    observer.record('owned-story-validation-baseline', { invocationId: invocation.entry.invocationId, input, validation, settings, save: save.id });
    return { ...invocation, settings };
}

test('shared native response receipts preserve equal-body ownership and unsupported input without pauses', async ({ page, presetObserver: observer }) => {
    await observer.start();
    await open(page);
    await observer.captureSources();
    await observer.returns('public/scripts/preset-manager.js', '    async writePresetExtensionField(', '    // ===== Preset Group Methods =====', 'public-return', '({ name, path, value })', { argument: 'arguments[0]' });
    const baselineSave = await validatedStoryBaseline(observer);
    expect(baselineSave.settlement.status).toBe('fulfilled');
    const baselineSettings = baselineSave.settings;
    const equal = await observer.invoke('wire-equal');
    expect(equal.settlement.status).toBe('fulfilled');
    await observer.drain();
    const publics = [...observer.publics.values()].filter(row => row.caller?.invocationId === equal.entry.invocationId);
    expect(publics).toHaveLength(2);
    expect(publics[0].identities.argument).not.toBe(publics[1].identities.argument);
    const expected = structuredClone(baseline);
    expected.chat_completion_preset.presets[0].preset.extensions.watch = { equal: { same: true } };
    const intended = structuredClone(baselineSettings);
    intended.oai_settings.extensions.watch = { equal: { same: true } };
    intended.accountStorage = equal.entry.accountStorage;
    const cache = structuredClone(baselineSave.entry.snapshot.runtime.cache);
    const globalIndex = cache.preset_names[PRESET];
    if (cache.presets[globalIndex]) cache.presets[globalIndex].extensions.watch.equal = { same: true };
    assertCorrelatedState(equal.settlement, equal.entry, expected, intended, cache, expected.chat_completion_preset.presets[0].preset);
    const joins = [];
    for (const publicCall of publics) {
        expect(publicCall.target.captured.before).toEqual(baseline.chat_completion_preset.presets[0].preset);
        expect(publicCall.target.captured.body).toEqual(expected.chat_completion_preset.presets[0].preset);
        const save = [...observer.saves.values()].find(save => save.parentPublic === publicCall.id);
        expect(save.payload).toEqual(intended);
        expect(save.parentPublicTarget).toBe(publicCall.identities.target);
        const writes = observer.sends.filter(send => send.publicInvocation === publicCall.id && send.url.endsWith('/api/characters/merge-attributes'));
        expect(writes).toHaveLength(1);
        const write = writes[0];
        const reply = observer.nativeReplies.find(reply => reply.nativeSend === write.id);
        expect(reply.identities.token).toBe(write.identities.token);
        expect(reply.identities.value).toBe(write.identities.value);
        expect(reply.identities.character).toBe(write.identities.character);
        expect(write.targetIdentity).toBe(publicCall.identities.target);
        expect(reply.receipt).toMatch(/^[a-f0-9]{64}$/);
        expect(reply.joined).toBe(write.networkId);
        expect(observer.receipts.get(reply.receipt)).toHaveLength(1);
        const returned = observer.events.find(event => event.kind === 'public-return' && event.data.publicInvocation === publicCall.id);
        expect(returned.data.acknowledgement.receipt).toBe(reply.receipt);
        expect(returned.data.acknowledgement.stored.card).toEqual(expected);
        joins.push({ publicCall: publicCall.id, nativeSend: write.id, networkId: write.networkId, token: write.identities.token, receipt: reply.receipt });
    }
    expect(new Set(joins.map(join => join.receipt)).size).toBe(2);
    expect(new Set(joins.map(join => join.networkId)).size).toBe(2);
    observer.record('equal-body-original-consumer-receipts', { invocationId: equal.entry.invocationId, joins, knowledge: 'Native response receipts are known only after Fetch delivery.' });
    await validatedStoryBaseline(observer);
    await observer.drain();
    const before = { stored: observer.stored(), runtime: await observer.runtime() };
    const unsupported = await observer.invoke('wire-unsupported-with-ordinary');
    expect(unsupported.settlement.status).toBe('rejected');
    expect(unsupported.settlement.value.message).toContain('could not be cloned');
    const ordinary = await observer.wait(() => [...observer.invocations.values()].find(invocation => invocation.entry?.action === 'overlap-ordinary'));
    expect((await observer.settlement(ordinary.entry.invocationId)).status).toBe('fulfilled');
    await observer.drain();
    const input = (await page.locator('#bound-input-events').textContent()).trim().split('\n').map(line => JSON.parse(line)).filter(event => event.target === 'bound-wire-unsupported-with-ordinary');
    for (const type of ['keydown', 'keyup', 'click']) expect(input.find(event => event.type === type).trusted).toBe(true);
    const save = [...observer.saves.values()].find(save => save.caller?.invocationId === ordinary.entry.invocationId);
    expect(save.at).toBeGreaterThanOrEqual(input.find(event => event.type === 'keydown').at);
    expect(save.at).toBeLessThanOrEqual(input.find(event => event.type === 'keyup').at);
    const noop = observer.events.find(event => event.kind === 'settings-no-http' && event.data.identities.payload === save.identities.payload);
    expect(noop.data.operations).toEqual([]);
    expect(noop.data.payload).toEqual(noop.data.previousSnapshot);
    const validation = observer.events.filter(event => event.kind === 'public-validation-entry' && event.data.caller?.invocationId === unsupported.entry.invocationId);
    expect(validation).toHaveLength(1);
    expect(validation[0].data.valueType).toBe('function');
    expect(observer.sends.filter(send => send.invocationId === unsupported.entry.invocationId)).toEqual([]);
    expect(unsupported.settlement.snapshot).toEqual(unsupported.entry.snapshot);
    expect(unsupported.settlement.nativeCaches).toEqual(unsupported.entry.nativeCaches);
    expect({ stored: observer.stored(), runtime: await observer.runtime() }).toEqual(before);
    expect(observer.events.filter(event => event.kind === 'unexpected-debugger-pause')).toEqual([]);
    observer.record('native-input-with-ordinary-save-preserved', { input, unsupported: unsupported.entry.invocationId, ordinary: ordinary.entry.invocationId, save: save.id });
});
