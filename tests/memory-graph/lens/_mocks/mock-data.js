// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Synthetic memory-graph snapshot for the lens tests.
// Shape mirrors memory-graph's read-api NodeView / EdgeView. The story is
// original sample content.

const C = (id, title, fields) => ({ id, type: 'character_sheet', level: 'semantic', title, fields: { title, ...fields }, seqTo: 1 });
const L = (id, title, fields) => ({ id, type: 'location_state', level: 'semantic', title, fields: { title, ...fields }, seqTo: 1 });
const T = (id, title, status, note, seqTo) => ({ id, type: 'thread', level: 'semantic', title, fields: { title, status, note }, seqTo });

const characters = [
    C('c_lin', '林栖', { aliases: '阿栖、灯塔看守', traits: '沉静、记性极好、习惯在本子上画潮汐表', identity: '雾港第七灯塔的看守人', goal: '找到十年前失踪的父亲留下的航海日志', inventory: '黄铜罗盘（父亲遗物）', addressing_user: '称用户为“船长”' }),
    C('c_wen', '温澜', { aliases: '温医生', traits: '理性、嘴硬心软、讨厌下雨', identity: '雾港唯一的诊所医生', goal: '查清港口怪病的来源', inventory: '一串打不开的旧钥匙' }),
    C('c_shen', '沈既白', { aliases: '白老板', traits: '圆滑、记账精确到分、对林栖格外宽容', identity: '“回声”酒馆老板，消息贩子', goal: '还清欠商会的旧债' }),
    C('c_gu', '顾长庚', { aliases: '老顾', traits: '寡言、左手有烧伤', identity: '退役领航员，林栖父亲的旧友', goal: '守住当年沉船的秘密' }),
    C('c_ye', '叶舟', { traits: '冲动、讲义气', identity: '码头搬运工，温澜的病人', goal: '赚钱给妹妹治病' }),
    C('c_qiao', '乔夫人', { aliases: '商会会长', traits: '优雅、从不正面回答问题', identity: '雾港商会会长', goal: '垄断港口的灯油生意' }),
    C('c_mo', '莫离', { traits: '神出鬼没、说话只说一半', identity: '自称“收雾人”的外乡人' }),
    C('c_xiao', '小满', { traits: '好奇、胆子大', identity: '叶舟的妹妹，十岁' }),
];

const locations = [
    L('l_tower', '第七灯塔', { aliases: '老灯塔', controller: '林栖', danger: '夜间涨潮会淹没下层', resources: '旧航海图、望远镜', state: '灯油所剩不多' }),
    L('l_clinic', '温氏诊所', { controller: '温澜', state: '病床已满' }),
    L('l_tavern', '回声酒馆', { controller: '沈既白', resources: '消息、廉价朗姆酒', state: '夜里最热闹' }),
    L('l_dock', '北码头', { controller: '商会(名义)/搬运工帮(实际)', danger: '雾天能见度不足五米' }),
    L('l_wreck', '黑礁沉船', { danger: '只有退潮时能进入', state: '船身刻着林家的徽记' }),
    L('l_guild', '商会大楼', { controller: '乔夫人', state: '戒备森严' }),
];

const threads = [
    T('t_log', '父亲的航海日志能否找到', 'active', '林栖相信日志藏在黑礁沉船里；顾长庚知道更多但不肯说。触发：下一次大退潮。', 14),
    T('t_sick', '港口怪病的源头', 'active', '温澜怀疑与商会的新灯油有关；叶舟是第一批病人。', 12),
    T('t_debt', '沈既白的旧债', 'active', '欠商会一笔钱，乔夫人以此要挟他提供林栖的行踪。', 9),
    T('t_key', '旧钥匙能打开什么', 'resolved', '温澜的钥匙原来对应灯塔地下室的铁门。已于第 11 段打开。', 11),
];

const ev = (n, title, time, place, prose, extra = {}) => ({
    id: `e${String(n).padStart(2, '0')}`,
    type: 'event',
    level: 'semantic',
    title,
    fields: {
        summary: [
            `时间: ${time}`,
            `地点: ${place}`,
            '',
            prose,
            extra.irreversible ? `\n不可逆:\n${extra.irreversible.map(x => `- ${x}`).join('\n')}` : '',
            extra.open ? `\n未结:\n${extra.open.map(x => `- → thread "${x}"`).join('\n')}` : '',
            extra.quotes ? `\n原文摘录:\n${extra.quotes.map(([who, q]) => `- ${who}: "${q}"`).join('\n')}` : '',
        ].filter(Boolean).join('\n'),
    },
    seqTo: n * 2,
    floorRange: { start: n * 4 - 3, end: n * 4 },
    semanticDepth: 0,
});

const events = [
    ev(1, '雾夜里的求救信号', '霜月三日 深夜', '第七灯塔', '林栖在例行巡灯时看到海面上闪了三下红光。她犹豫后没有上报商会，而是独自记下了方位，并在潮汐表背面画了一个问号。', { quotes: [['林栖', '三短，是父亲的暗号。']] }),
    ev(2, '诊所来了第一个怪病病人', '霜月四日 清晨', '温氏诊所', '叶舟被人抬进诊所，手指发黑、说胡话。温澜发现他身上有一股灯油的味道，于是把样本封存起来，决定暂时不告诉任何人。', { open: ['港口怪病的源头'] }),
    ev(3, '酒馆里的交易', '霜月四日 夜', '回声酒馆', '林栖用父亲的罗盘作抵押，从沈既白那里换到一条消息：黑礁沉船上刻着林家的徽记。沈既白没有收罗盘，只说“先欠着”。'),
    ev(4, '顾长庚的沉默', '霜月五日 午后', '北码头', '林栖去找顾长庚问沉船的事。顾长庚一口否认认识她父亲，但临走时塞给她一张退潮时刻表。', { open: ['父亲的航海日志能否找到'] }),
    ev(5, '商会的新灯油', '霜月六日', '商会大楼', '乔夫人宣布全港统一更换商会生产的新灯油。温澜在会上提出质疑，被礼貌地请了出去。', { quotes: [['乔夫人', '温医生，雾港需要的是光，不是问题。']] }),
    ev(6, '第一次进入沉船', '霜月七日 退潮', '黑礁沉船', '林栖和叶舟趁退潮摸进沉船。船长室被人翻过，日志不在，但墙上留下了一行用刀刻的坐标。涨潮前两人狼狈撤出，叶舟的腿被礁石划伤。', { irreversible: ['叶舟左腿留下长疤'], open: ['父亲的航海日志能否找到'] }),
    ev(7, '莫离出现', '霜月八日 雾', '第七灯塔', '一个自称“收雾人”的外乡人莫离敲开灯塔的门，说自己在找同一本日志，并提出合作。林栖没有答应，也没有拒绝。'),
    ev(8, '温澜与林栖结盟', '霜月九日', '温氏诊所', '温澜把封存的灯油样本给林栖看，两人发现样本在灯塔的望远镜下会发出微弱的蓝光。她们约定共享线索。', { irreversible: ['温澜与林栖正式结盟'] }),
    ev(9, '沈既白被要挟', '霜月九日 夜', '回声酒馆', '乔夫人的人来到酒馆，要沈既白交出林栖的行踪来抵债。沈既白给了一个假地址，事后独自喝到天亮。', { open: ['沈既白的旧债'] }),
    ev(10, '小满失踪', '霜月十日 清晨', '北码头', '叶舟的妹妹小满在码头附近不见了，只留下一只鞋。搬运工们怀疑是商会的人干的，码头气氛一触即发。'),
    ev(11, '地下室的铁门', '霜月十一日', '第七灯塔', '温澜的旧钥匙打开了灯塔地下室的铁门。里面是一整面墙的潮汐记录和一个空的铁盒，铁盒内侧刻着“给栖”。', { irreversible: ['灯塔地下室被打开'], quotes: [['温澜', '这把钥匙我带了十年，原来是给你的。']] }),
    ev(12, '诊所病人激增', '霜月十二日', '温氏诊所', '更换新灯油后的第六天，诊所一天收治了十一个病人。温澜确认症状与灯油燃烧后的烟有关，开始写给港务局的报告。', { open: ['港口怪病的源头'] }),
    ev(13, '顾长庚坦白', '霜月十三日 夜', '回声酒馆', '在沈既白的酒馆里，顾长庚终于承认当年沉船时他也在船上，是他把日志交给了乔夫人换取了自己的性命。林栖当场离席。', { irreversible: ['林栖与顾长庚决裂'], quotes: [['顾长庚', '我活下来了，你父亲没有。这就是全部。']] }),
    ev(14, '潜入商会', '霜月十四日 深夜', '商会大楼', '林栖、温澜和莫离分头潜入商会大楼。林栖在乔夫人的书房里看到了父亲的日志，但只来得及撕下最后一页。莫离借机拿走了别的东西后消失。', { irreversible: ['林栖拿到日志最后一页'], open: ['父亲的航海日志能否找到'] }),
    ev(15, '找到小满', '霜月十五日 清晨', '黑礁沉船', '按照日志最后一页的坐标，林栖在沉船底舱找到了被关着的小满。小满说抓她的人身上有灯油味。叶舟抱着妹妹哭了很久。'),
    ev(16, '灯塔重新点亮', '霜月十六日 夜', '第七灯塔', '林栖拒绝使用商会的新灯油，改用沈既白偷偷弄来的旧鲸油点亮了灯塔。整个北码头都看见了那道不一样的光。', { quotes: [['沈既白', '这批油的钱，也先欠着。']] }),
];

const rollup = (id, title, depth, childIds, prose, seqTo) => ({
    id,
    type: 'event',
    level: 'semantic',
    title,
    fields: { summary: prose },
    seqTo,
    childrenIds: childIds,
    semanticDepth: depth,
    semanticRollup: true,
});

const rollups = [
    rollup('r1_a', '雾港异象：信号、怪病与沉船线索', 1, ['e01', 'e02', 'e03'], '霜月初，林栖收到疑似父亲的暗号，温澜接到第一个怪病病人，沈既白透露沉船上有林家徽记。三条线索在同一周出现。', 6),
    rollup('r1_b', '退潮之前：顾长庚、新灯油与第一次探船', 1, ['e04', 'e05', 'e06'], '顾长庚否认过去却暗中帮忙；商会强推新灯油；林栖与叶舟第一次进入沉船，只找到坐标。', 12),
    rollup('r1_c', '结盟与要挟', 1, ['e07', 'e08', 'e09'], '莫离提出合作，温澜与林栖正式结盟，沈既白在乔夫人的要挟下选择保护林栖。', 18),
    rollup('r1_d', '失踪、铁门与真相', 1, ['e10', 'e11', 'e12'], '小满失踪，灯塔地下室被打开，怪病病人激增。所有线索开始指向商会。', 24),
    rollup('r2_a', '第一卷：雾港的秘密浮出水面', 2, ['r1_a', 'r1_b', 'r1_c', 'r1_d'], '从一道红光开始，林栖与温澜逐步发现父亲失踪、港口怪病与商会灯油生意之间的联系，盟友与敌人的轮廓逐渐清晰。', 24),
];

const nodes = [...characters, ...locations, ...threads, ...events, ...rollups];
for (const r of rollups) {
    for (const childId of r.childrenIds) {
        const child = nodes.find(n => n.id === childId);
        if (child) child.parentId = r.id;
    }
}
// One older, archived character version.
nodes.push({ ...C('c_lin_old', '林栖（旧档）', { identity: '灯塔看守学徒' }), archived: true });

const edges = [];
const E = (from, to, type) => edges.push({ from, to, type });
const involve = {
    e01: [['c_lin'], 'l_tower'], e02: [['c_wen', 'c_ye'], 'l_clinic'], e03: [['c_lin', 'c_shen'], 'l_tavern'],
    e04: [['c_lin', 'c_gu'], 'l_dock'], e05: [['c_qiao', 'c_wen'], 'l_guild'], e06: [['c_lin', 'c_ye'], 'l_wreck'],
    e07: [['c_lin', 'c_mo'], 'l_tower'], e08: [['c_lin', 'c_wen'], 'l_clinic'], e09: [['c_shen', 'c_qiao'], 'l_tavern'],
    e10: [['c_ye', 'c_xiao'], 'l_dock'], e11: [['c_lin', 'c_wen'], 'l_tower'], e12: [['c_wen', 'c_ye'], 'l_clinic'],
    e13: [['c_lin', 'c_gu', 'c_shen'], 'l_tavern'], e14: [['c_lin', 'c_wen', 'c_mo', 'c_qiao'], 'l_guild'],
    e15: [['c_lin', 'c_xiao', 'c_ye'], 'l_wreck'], e16: [['c_lin', 'c_shen'], 'l_tower'],
};
for (const [eventId, [chars, loc]] of Object.entries(involve)) {
    for (const c of chars) E(eventId, c, 'involved_in');
    E(eventId, loc, 'occurred_at');
}
for (const r of rollups) for (const childId of r.childrenIds) E(r.id, childId, 'semantic_contains');
E('e04', 't_log', 'advances'); E('e06', 't_log', 'advances'); E('e14', 't_log', 'advances');
E('e02', 't_sick', 'advances'); E('e12', 't_sick', 'advances'); E('e05', 't_sick', 'evidence');
E('e09', 't_debt', 'advances'); E('e11', 't_key', 'updates');
E('c_lin', 'c_wen', 'allied_with');
E('c_lin', 'c_gu', 'hostile_to');
E('c_shen', 'c_qiao', 'debt_owed_to');
E('c_ye', 'c_xiao', 'family_of');
E('c_gu', 'c_lin', 'deceiving');
E('c_qiao', 'c_wen', 'hostile_to');
E('c_gu', 'c_ye', 'mentor_of');
E('c_shen', 'c_lin', 'sworn_to');
E('c_mo', 'c_lin', 'deceiving');
E('c_lin', 'l_tower', 'related');
E('c_qiao', 'l_guild', 'related');

export function createMockSnapshot() {
    return {
        chatKey: 'preview-chat',
        chatLabel: '雾港灯塔（示例数据）',
        loadedAt: Date.now(),
        nodes: structuredClone(nodes),
        edges: structuredClone(edges),
        schema: { types: createMockSchema() },
        injection: {
            alwaysInjectIds: ['t_log', 't_sick', 't_debt', 'r2_a'],
            recallSelectedIds: ['e13', 'e14', 'e16', 'c_lin', 'c_shen', 'l_tower'],
            visibleIds: [],
        },
        tokens: {
            current: { at: Date.now() - 1000 * 60 * 3, core: 412, focus: 868 },
            entries: Array.from({ length: 26 }, (_, i) => ({
                at: Date.now() - (26 - i) * 1000 * 60 * 9,
                floor: 40 + i * 2,
                core: 300 + Math.round(i * 4.5),
                focus: [620, 810, 0, 940, 700, 1120, 560, 880, 760, 990, 1300, 640, 720, 870, 1010, 450, 930, 1180, 690, 760, 840, 1240, 980, 610, 1090, 868][i],
            })),
        },
        lastRecall: {
            at: Date.now() - 1000 * 60 * 3,
            blocks: {
                corePacket: '<memory_core>\n[thread] 父亲的航海日志能否找到 — active\n[thread] 港口怪病的源头 — active\n[event L2] 第一卷：雾港的秘密浮出水面\n</memory_core>',
                focusPacket: '<memory_focus>\n[event] 顾长庚坦白 (#49–52)\n[event] 潜入商会 (#53–56)\n[event] 灯塔重新点亮 (#61–64)\n[character] 林栖 / 沈既白\n[location] 第七灯塔\n</memory_focus>',
            },
        },
    };
}

/** Full type specs as memory-graph stores them (long English defaults included). */

export function createMockSchema() {
    const hints = {
        event: { summary: 'A prose body describing the event skeleton in chronological order, including the cause and the resulting change to the situation.' },
        character_sheet: {
            title: 'Canonical character name only. Do not include aliases, English names, titles or translations.',
            aliases: 'Nicknames, titles and how other characters address this person. Comma separated.',
            traits: 'Stable personality traits and habits that persist across scenes.',
            identity: 'Long-term identity and social role in the world.',
            goal: 'Long-term goals that drive the character across scenes.',
            inventory: 'Important items the character carries or owns.',
            language_sample: 'A short sample of the character voice, in their own words.',
            addressing_user: 'How this character addresses the user.',
        },
        location_state: {
            title: 'Place name as it appears in the story.',
            aliases: 'Other names for the same place.',
            controller: 'Who currently controls or occupies this place.',
            danger: 'Current danger level and its source.',
            resources: 'Notable resources available here.',
            state: 'Current physical and social state of the place.',
        },
        thread: {
            title: 'Short, self-identifying thread name. No 「主线」/「支线」 prefix.',
            status: 'active | resolved | stalled',
            note: 'What the thread is about and what would resolve it.',
        },
    };
    const make = (id, label, columns, extra = {}) => ({
        id,
        label,
        tableName: `${id}_table`,
        tableColumns: columns,
        embeddingColumns: columns.slice(),
        level: 'semantic',
        extractHint: DEFAULT_INTROS[id] || '',
        extractionInstructions: `${label} extraction rules …`.repeat(6),
        extractEveryN: 1,
        keywords: [],
        columnHints: hints[id] || {},
        requiredColumns: id === 'event' ? ['summary'] : ['title'],
        forceUpdate: id === 'event',
        editable: id !== 'event',
        alwaysInject: id === 'thread',
        latestOnly: id !== 'event',
        primaryKeyColumns: id === 'event' ? [] : ['title'],
        ragPerTypeK: 0,
        recordsFloorRange: false,
        compression: id === 'event'
            ? { mode: 'hierarchical', threshold: 6, fanIn: 3, maxDepth: 6, keepRecentLeaves: 3, rule: '', summarizeInstruction: 'Event summary writing rules …'.repeat(20) }
            : { mode: 'none', threshold: 6, fanIn: 3, maxDepth: 6, keepRecentLeaves: 0, rule: '', summarizeInstruction: '' },
        ...extra,
    });
    return [
        make('event', 'Event', ['summary']),
        make('character_sheet', 'Character Sheet', ['title', 'aliases', 'traits', 'identity', 'goal', 'inventory', 'language_sample', 'addressing_user']),
        make('location_state', 'Location State', ['title', 'aliases', 'controller', 'danger', 'resources', 'state']),
        make('thread', 'Thread', ['title', 'status', 'note']),
        {
            ...make('storyline', '剧情线', ['name', 'track', 'status', 'stage']),
            columnHints: {
                name: '剧情线名称，简短可指认，不带「主线」「支线」前缀本身（例如：神豪系统觉醒、横店剧组、刘家）',
                track: '所属线索，取值 main 或 side',
                status: 'active / resolved / stalled',
                stage: '当前推进到哪一步，一句话',
            },
            requiredColumns: ['name', 'track', 'status'],
            embeddingColumns: ['name', 'track', 'status'],
            primaryKeyColumns: ['name'],
            alwaysInject: true,
            latestOnly: true,
            extractHint: '追踪跨多个场景持续推进的剧情线。',
        },
    ];
}

const DEFAULT_INTROS = {
    event: 'Critical plot events that change the situation and should be remembered verbatim.',
    character_sheet: 'Stable character facts that remain true across scenes.',
    location_state: 'The current state of a place the story returns to.',
    thread: 'Open questions the story is still following.',
};

/** In-memory stand-in for memory-graph's schema read/write, for the preview. */

export function createLargeSnapshot(count = 600) {
    const base = createMockSnapshot();
    for (let i = 0; i < count; i++) {
        const id = `bulk_${i}`;
        base.nodes.push({
            id, type: 'event', level: 'semantic', title: `批量事件 ${i}`,
            fields: { summary: `时间: 第 ${i} 天\n地点: 北码头\n\n这是用于压力测试的第 ${i} 个事件。` },
            seqTo: 40 + i, floorRange: { start: 70 + i * 2, end: 71 + i * 2 }, semanticDepth: 0,
        });
        base.edges.push({ from: id, to: ['c_lin', 'c_wen', 'c_ye', 'c_shen'][i % 4], type: 'involved_in' });
        base.edges.push({ from: id, to: 'l_dock', type: 'occurred_at' });
    }
    return base;
}

/** Scripted stand-in for the AI schema assistant (preview only, no network). */
