// fixtures.js — A realistic memory graph for testing hybrid recall.
//
// Scenario: A dark fantasy RP, ~60 turns in.
// Characters: 艾琳 (protagonist), 凯恩 (antagonist turned ally), 莉娜 (healer, dead),
//             老铁匠格雷 (NPC), 暗影领主 (boss, sealed)
// Locations: 银月城, 黑森林, 废弃矿洞, 封印祭坛
// Timeline: seqTo 1-60, current turn = 60

export const SCHEMA = [
    { id: 'event', latestOnly: false, tableColumns: ['summary', 'key_sentences'] },
    { id: 'character_sheet', latestOnly: true, tableColumns: ['title', 'aliases', 'traits', 'identity', 'state', 'goal', 'inventory', 'language_sample', 'core_note', 'addressing_user'] },
    { id: 'location_state', latestOnly: true, tableColumns: ['title', 'aliases', 'controller', 'danger', 'resources', 'state'] },
    { id: 'rule_constraint', latestOnly: false, tableColumns: ['title', 'constraint', 'scope', 'status'] },
];

export const CURRENT_SEQ = 60;

const nodes = {
    char_eileen: { id: 'char_eileen', type: 'character_sheet', seqTo: 58, fields: { name: '艾琳', aliases: '银月剑士, Eileen', traits: '坚韧、正义感强、对背叛极度敏感', identity: '银月城骑士团前成员，因揭发腐败被驱逐', state: '右臂受伤未愈，持有诅咒之剑', goal: '阻止暗影领主复活', inventory: '诅咒之剑「黯灭」、莉娜的治愈护符（已失效）、银月城通行令', core_note: '对凯恩的信任仍然脆弱，莉娜之死是心结', addressing_user: '（第一人称视角）' } },
    char_kain: { id: 'char_kain', type: 'character_sheet', seqTo: 57, fields: { name: '凯恩', aliases: '黑骑士, Kain, 叛徒凯恩', traits: '冷酷、务实、隐藏的愧疚感', identity: '前暗影领主麾下将领，因目睹屠杀而叛变', state: '左眼失明（封印战受伤），暗影侵蚀缓慢扩散', goal: '赎罪，阻止暗影领主复活', inventory: '暗影铠甲（半损）、封印钥匙碎片', core_note: '知道封印的弱点但一直没有完全坦白', addressing_user: '艾琳' } },
    char_lina: { id: 'char_lina', type: 'character_sheet', seqTo: 35, fields: { name: '莉娜', aliases: '白鸽, Lina', traits: '温柔、自我牺牲、固执', identity: '流浪治愈师，艾琳的挚友', state: '已死亡（在黑森林为保护艾琳而牺牲）', goal: '（已故）', core_note: '死前将治愈护符交给艾琳，护符在莉娜死后逐渐失效' } },
    char_grey: { id: 'char_grey', type: 'character_sheet', seqTo: 58, fields: { name: '格雷', aliases: '老铁匠, Grey, 格雷老头', traits: '沉默寡言、技艺精湛、知道太多秘密', identity: '银月城铁匠，暗中是封印守护者之一', state: '身份暴露后躲藏在废弃矿洞', goal: '修复诅咒之剑的封印纹路', core_note: '诅咒之剑「黯灭」是他年轻时打造的，剑中封印着暗影领主的一缕意识' } },
    char_shadow_lord: { id: 'char_shadow_lord', type: 'character_sheet', seqTo: 55, fields: { name: '暗影领主', aliases: '虚无之王, Shadow Lord, 那位大人', traits: '残忍、狡诈、拥有腐蚀意志的能力', identity: '被封印的远古存在', state: '封印中，但封印正在弱化，意识通过诅咒之剑渗透', goal: '复活并吞噬银月城' } },
    loc_silver_moon: { id: 'loc_silver_moon', type: 'location_state', seqTo: 50, fields: { name: '银月城', aliases: 'Silver Moon City, 月城', controller: '骑士团（腐败的团长掌权）', danger: '中等', resources: '铁匠铺、骑士团训练场、中央图书馆', state: '表面平静，暗流涌动' } },
    loc_dark_forest: { id: 'loc_dark_forest', type: 'location_state', seqTo: 56, fields: { name: '黑森林', aliases: 'Dark Forest, 暗林', controller: '无', danger: '极高——暗影侵蚀加剧', state: '莉娜死后此地被暗影能量进一步污染，树木开始枯死' } },
    loc_mine: { id: 'loc_mine', type: 'location_state', seqTo: 58, fields: { name: '废弃矿洞', aliases: '旧矿, Old Mine', controller: '格雷（临时藏身处）', danger: '低', resources: '锻造炉、矿石', state: '格雷在此秘密修复诅咒之剑的封印纹路' } },
    loc_altar: { id: 'loc_altar', type: 'location_state', seqTo: 55, fields: { name: '封印祭坛', aliases: 'Seal Altar, 祭坛', controller: '无', danger: '极高——封印裂缝扩大', state: '封印出现三道裂缝，每道裂缝对应一个封印钥匙碎片' } },
    rule_cursed_sword: { id: 'rule_cursed_sword', type: 'rule_constraint', seqTo: 8, fields: { title: '诅咒之剑的规则', constraint: '使用者每次挥剑都会被暗影侵蚀一分。连续使用超过三次会暂时失去意识。剑不能被丢弃。', scope: '战斗系统', status: '生效中' } },
    rule_seal: { id: 'rule_seal', type: 'rule_constraint', seqTo: 15, fields: { title: '封印规则', constraint: '封印需要三把钥匙碎片同时插入祭坛才能修复。任何一把碎片被破坏，封印将永久崩溃。', scope: '主线剧情', status: '生效中' } },
    rule_healing: { id: 'rule_healing', type: 'rule_constraint', seqTo: 5, fields: { title: '治愈术限制', constraint: '治愈术无法治愈暗影侵蚀造成的伤害。只能延缓扩散速度。', scope: '魔法系统', status: '生效中' } },
    evt_01: { id: 'evt_01', type: 'event', seqTo: 3, fields: { summary: '艾琳在银月城揭发骑士团团长的腐败行为，被驱逐出城。', key_sentences: '艾琳被押出城门时回头怒吼。' } },
    evt_02: { id: 'evt_02', type: 'event', seqTo: 8, fields: { summary: '艾琳在银月城外遇到老铁匠格雷，格雷将诅咒之剑「黯灭」交给她。', key_sentences: '格雷警告她不要轻易使用这把剑。' } },
    evt_03: { id: 'evt_03', type: 'event', seqTo: 12, fields: { summary: '艾琳在黑森林首次遭遇凯恩。凯恩奉暗影领主之命追杀艾琳，两人激战。', key_sentences: '艾琳第一次使用了诅咒之剑，感到一阵眩晕。' } },
    evt_04: { id: 'evt_04', type: 'event', seqTo: 15, fields: { summary: '封印祭坛之战。艾琳、莉娜联手将暗影领主封印。凯恩在战斗中倒戈，失去左眼。', key_sentences: '封印完成的瞬间，暗影领主的怒吼震碎了祭坛周围的岩石。' } },
    evt_05: { id: 'evt_05', type: 'event', seqTo: 20, fields: { summary: '艾琳拒绝接受凯恩的同行请求。莉娜劝说无果。', key_sentences: '凯恩沉默地看着艾琳的背影，没有追上去。' } },
    evt_06: { id: 'evt_06', type: 'event', seqTo: 25, fields: { summary: '艾琳和莉娜在黑森林深处发现暗影侵蚀正在扩散。莉娜的治愈术只能暂时净化小范围区域。', key_sentences: '莉娜额头冒汗，治愈的光芒越来越微弱。' } },
    evt_07: { id: 'evt_07', type: 'event', seqTo: 30, fields: { summary: '凯恩独自出现在艾琳面前，带来封印正在弱化的消息。他交出一块封印钥匙碎片作为诚意。', key_sentences: '凯恩将碎片放在地上，退后三步。' } },
    evt_08: { id: 'evt_08', type: 'event', seqTo: 35, fields: { summary: '黑森林伏击。莉娜为保护受伤的艾琳，耗尽生命力施展最后一次大范围治愈术，当场死亡。', key_sentences: '莉娜微笑着将治愈护符塞进艾琳手中，身体化为白色光点消散。' } },
    evt_09: { id: 'evt_09', type: 'event', seqTo: 40, fields: { summary: '艾琳在莉娜墓前与凯恩达成正式同盟。两人决定一起寻找剩余的封印钥匙碎片。', key_sentences: '莉娜会希望我们合作。' } },
    evt_10: { id: 'evt_10', type: 'event', seqTo: 45, fields: { summary: '艾琳和凯恩在银月城地下水道找到第二块封印钥匙碎片，被骑士团追击。', key_sentences: '凯恩拉着艾琳的手在黑暗中奔跑。' } },
    evt_11: { id: 'evt_11', type: 'event', seqTo: 50, fields: { summary: '艾琳发现诅咒之剑开始在夜间低语，暗影领主的意识正在通过剑渗透。', key_sentences: '剑身上的纹路在黑暗中发出微弱的紫光。' } },
    evt_12: { id: 'evt_12', type: 'event', seqTo: 55, fields: { summary: '艾琳和凯恩到达封印祭坛，发现封印出现三道裂缝。凯恩承认第三块碎片在他的左眼中。', key_sentences: '第三块碎片嵌入了我的左眼。凯恩摘下眼罩。' } },
    evt_13: { id: 'evt_13', type: 'event', seqTo: 58, fields: { summary: '格雷在废弃矿洞中检查诅咒之剑，发现封印纹路已经磨损大半。', key_sentences: '暗影领主的意识已经侵蚀了七成的封印纹路。' } },
    evt_14: { id: 'evt_14', type: 'event', seqTo: 60, fields: { summary: '艾琳在矿洞外守夜时，诅咒之剑突然自行出鞘。她的意识被拉入剑中的暗影空间，与暗影领主的残影对峙。', key_sentences: '暗影领主的声音从四面八方传来。' } },
    evt_archived: { id: 'evt_archived', type: 'event', seqTo: 2, archived: true, fields: { summary: '（已归档）艾琳的日常训练。' } },
};

const edges = [
    { from: 'evt_01', to: 'char_eileen', type: 'involved_in' },
    { from: 'evt_02', to: 'char_eileen', type: 'involved_in' },
    { from: 'evt_02', to: 'char_grey', type: 'involved_in' },
    { from: 'evt_03', to: 'char_eileen', type: 'involved_in' },
    { from: 'evt_03', to: 'char_kain', type: 'involved_in' },
    { from: 'evt_04', to: 'char_eileen', type: 'involved_in' },
    { from: 'evt_04', to: 'char_lina', type: 'involved_in' },
    { from: 'evt_04', to: 'char_kain', type: 'involved_in' },
    { from: 'evt_04', to: 'char_shadow_lord', type: 'involved_in' },
    { from: 'evt_05', to: 'char_eileen', type: 'involved_in' },
    { from: 'evt_05', to: 'char_kain', type: 'involved_in' },
    { from: 'evt_05', to: 'char_lina', type: 'involved_in' },
    { from: 'evt_06', to: 'char_eileen', type: 'involved_in' },
    { from: 'evt_06', to: 'char_lina', type: 'involved_in' },
    { from: 'evt_07', to: 'char_kain', type: 'involved_in' },
    { from: 'evt_07', to: 'char_eileen', type: 'involved_in' },
    { from: 'evt_08', to: 'char_eileen', type: 'involved_in' },
    { from: 'evt_08', to: 'char_lina', type: 'involved_in' },
    { from: 'evt_08', to: 'char_kain', type: 'involved_in' },
    { from: 'evt_09', to: 'char_eileen', type: 'involved_in' },
    { from: 'evt_09', to: 'char_kain', type: 'involved_in' },
    { from: 'evt_10', to: 'char_eileen', type: 'involved_in' },
    { from: 'evt_10', to: 'char_kain', type: 'involved_in' },
    { from: 'evt_11', to: 'char_eileen', type: 'involved_in' },
    { from: 'evt_11', to: 'char_shadow_lord', type: 'involved_in' },
    { from: 'evt_12', to: 'char_eileen', type: 'involved_in' },
    { from: 'evt_12', to: 'char_kain', type: 'involved_in' },
    { from: 'evt_12', to: 'char_shadow_lord', type: 'involved_in' },
    { from: 'evt_13', to: 'char_grey', type: 'involved_in' },
    { from: 'evt_13', to: 'char_eileen', type: 'involved_in' },
    { from: 'evt_14', to: 'char_eileen', type: 'involved_in' },
    { from: 'evt_14', to: 'char_shadow_lord', type: 'involved_in' },
    { from: 'evt_01', to: 'loc_silver_moon', type: 'occurred_at' },
    { from: 'evt_02', to: 'loc_silver_moon', type: 'occurred_at' },
    { from: 'evt_03', to: 'loc_dark_forest', type: 'occurred_at' },
    { from: 'evt_04', to: 'loc_altar', type: 'occurred_at' },
    { from: 'evt_06', to: 'loc_dark_forest', type: 'occurred_at' },
    { from: 'evt_08', to: 'loc_dark_forest', type: 'occurred_at' },
    { from: 'evt_10', to: 'loc_silver_moon', type: 'occurred_at' },
    { from: 'evt_12', to: 'loc_altar', type: 'occurred_at' },
    { from: 'evt_13', to: 'loc_mine', type: 'occurred_at' },
    { from: 'evt_14', to: 'loc_mine', type: 'occurred_at' },
    { from: 'char_eileen', to: 'char_kain', type: 'related' },
    { from: 'char_eileen', to: 'char_lina', type: 'related' },
    { from: 'char_eileen', to: 'char_grey', type: 'related' },
    { from: 'char_kain', to: 'char_shadow_lord', type: 'related' },
    { from: 'rule_cursed_sword', to: 'char_eileen', type: 'mentions' },
    { from: 'rule_cursed_sword', to: 'char_shadow_lord', type: 'mentions' },
    { from: 'rule_seal', to: 'loc_altar', type: 'mentions' },
    { from: 'rule_healing', to: 'char_lina', type: 'mentions' },
    { from: 'evt_07', to: 'evt_09', type: 'advances' },
    { from: 'evt_08', to: 'evt_09', type: 'advances' },
    { from: 'evt_11', to: 'evt_13', type: 'advances' },
    { from: 'evt_12', to: 'evt_14', type: 'advances' },
    { from: 'evt_04', to: 'rule_seal', type: 'evidence' },
    { from: 'evt_11', to: 'rule_cursed_sword', type: 'evidence' },
];

const cooccurrenceCounts = {
    'char_eileen|char_kain': 12.5,
    'char_eileen|char_lina': 6.2,
    'char_kain|char_shadow_lord': 4.8,
    'char_eileen|char_shadow_lord': 3.1,
    'char_eileen|char_grey': 2.0,
    'char_kain|char_lina': 1.5,
    'char_grey|char_shadow_lord': 0.8,
};

export function buildTestStore() {
    return { nodes: { ...nodes }, edges: [...edges], cooccurrenceCounts: { ...cooccurrenceCounts } };
}

export const QUERIES = {
    lina_memory: '莉娜……如果她还在的话，一切会不会不一样？',
    sword_crisis: '诅咒之剑又开始低语了，格雷说封印纹路快要撑不住了',
    seal_planning: '我们需要讨论封印的事。三块碎片，我们有两块，第三块在凯恩的眼睛里',
    kain_trust: '凯恩，你还有什么瞒着我的？',
    dark_forest_return: '我们必须穿过黑森林才能到达祭坛',
    abstract_query: '背叛和信任之间的界限在哪里？',
    alias_query: '白鸽留下的护符还有用吗？',
    multi_entity: '凯恩和格雷都在矿洞里，暗影领主的意识越来越强了',
};

export const EXPECTED = {
    lina_memory: {
        mustInclude: ['char_lina', 'evt_08'],
        shouldInclude: ['evt_04', 'evt_06', 'evt_09', 'rule_healing'],
        mustExclude: ['evt_archived'],
    },
    sword_crisis: {
        mustInclude: ['char_grey'],
        shouldInclude: ['evt_14', 'evt_13', 'evt_11', 'char_shadow_lord', 'loc_mine'],
        mustExclude: ['evt_archived'],
        // Note: rule_cursed_sword is alwaysInject=true, so it bypasses recall entirely
    },
    seal_planning: {
        mustInclude: ['char_kain'],
        shouldInclude: ['evt_12', 'evt_07', 'loc_altar', 'evt_04'],
        mustExclude: ['evt_archived'],
        // Note: rule_seal is alwaysInject=true, so it bypasses recall entirely
    },
    kain_trust: {
        mustInclude: ['char_kain'],
        shouldInclude: ['evt_12', 'evt_05', 'evt_09'],
        mustExclude: ['evt_archived'],
    },
    dark_forest_return: {
        mustInclude: ['loc_dark_forest'],
        shouldInclude: ['evt_08', 'evt_03', 'evt_06', 'loc_altar'],
        mustExclude: ['evt_archived'],
    },
    alias_query: {
        mustInclude: ['char_lina'],
        shouldInclude: ['evt_08'],
        mustExclude: ['evt_archived'],
    },
    multi_entity: {
        mustInclude: ['char_kain', 'char_grey', 'char_shadow_lord'],
        shouldInclude: ['loc_mine', 'evt_13', 'evt_14'],
        mustExclude: ['evt_archived'],
    },
};
