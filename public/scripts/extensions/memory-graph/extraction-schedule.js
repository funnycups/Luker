// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

/**
 * Pure helpers controlling per-type extraction cadence and prompt assembly.
 *
 * Lives outside main.js so unit tests can import without dragging the whole
 * SillyTavern script.js / lib.js runtime in. main.js re-exports the
 * symbols for the public API surface.
 */

export const DEFAULT_PER_TYPE_INSTRUCTIONS = {
    event: [
        'Event decision: MANDATORY — exactly ONE event node per batch. Even routine turns (路过/休整/闲聊/单次场景) produce an event (final summary string can be one line for routine; but the writing standard\'s 7-step CoT in <thought> [1] is still mandatory before the tool call); compression handles routine noise at rollup via the writing standard\'s event retention judgment.',
        'If multiple sub-events happened, merge into one coherent summary.',
        'High-consequence events (契约/誓言/婚约/师徒关系 建立或破裂、不可逆物理状态变化、长期身份/立场变更、新角色登场并被命名、新地点建立长期 controller、获得/转让重要物品) get full causal detail.',
        'Routine events (单次场景姿态/当前心情/临时性服务关系/对话氛围/已被某主线事件因果包含的子动作) get a brief final summary string (one line) so the timeline is continuous; their detail will be dropped at compression.',
        'Summary must start with "时间：<具体时间>；" using complete in-world date/time and follow the event summary writing standard.',
        'Never copy quoted dialogue verbatim into summary — paraphrase to action description.',
    ].join('\n'),
    character_sheet: [
        'Character decision: SKIP unless the character\'s long-term traits/identity/goal/aliases changed in this batch.',
        'Character consistency rule: if a character is grounded by card/world-info baseline and no character_sheet exists for them, create one. If an existing sheet conflicts with baseline, emit edit to align.',
        'Alias quality: when dialogue uses nicknames/short names/titles, fill aliases.',
        'language_sample edit rule: existing samples are scene templates. Scan before editing. Only rewrite the whole sample group on identity/stance reversal (faction switch, brainwashing, awakening, long-term role transition). A new scene materially different from all logged ones can ADD (cap at 3 total); already-logged scene samples are not rewritten to match the current scene\'s mood.',
        'Single-scene tone shifts, intimate-mode dialogue, situational politeness = SKIP for language_sample.',
        'identity rule: long-term identity only. Temporary roles (服侍员, 临时随从, 患者) = SKIP.',
    ].join('\n'),
    location_state: [
        'Location decision: SKIP unless controller / danger / resources / state changed in this batch.',
        '"Entering a new location" alone = SKIP — that\'s event territory. Only create / edit when the location\'s long-term properties shifted.',
        '',
        'state 字段路由测试（硬要求）: 写入前问 "故事时间往后推 24 小时,再有别人到这个地方,他/她还会观察到这条吗?" ✅ 会 → 写进 state/resources; ❌ 不会 → 路由到 event.summary 或 DROP。state 是地点"长期身份证",不是事件流水。',
        '',
        'state 应写: 长期归属/用途定性("X 的据点" / "X 的私密空间" / "X 的主控基地"); 跨多次访问稳定的关系性事实(门槛: ≥3 次同类事件 OR 持续 ≥1 周的关系据点); 不可逆的物理/控制权变化("已被占领" / "已封印" / "已解锁"); 长期标志性事件锚点(极少数: 地点因某事件被永久定义,如某秘密的长期存档点)。',
        '',
        'state 不该写(全部走 event.summary 或 DROP): 单次访问事件流水(时间戳 + 动作 + 对话);活动留下的临时物理痕迹(体液 / 衣物散落 / 按印 / 湿润感 / 灰尘脚印等单次产生的痕迹);临时角色状态(睡相 / 单次穿着 / 单次表情 / 单次姿势 / 单次心情);单次访问的对白引述 / 视线 / 表情 / 肢体反应;瞬时感官(空气味 / 温度 / 光线 / 声响等会随时间散去的现场感受);已发生事件的镜头编号 / 具体姿势 / 动作次数清单;事件流水信号词("本批次" / "本次" / "刚刚" / "目前已" / "现已" / "已完成");拟人化事件升华("见证 X" / "承载 XY" / "X 的舞台" — 把地点写成有意识的旁观者);关系条款细节(金额 / 协议名 / 约定内容 — 这属于相关角色的 character_sheet,不属于地点)。',
        '',
        'state 长度上限: ≤ 50 字(中文) / ≤ 30 words(英文)。超过几乎必有事件流水混入,回头检查每个短句能否挪去 event.summary。',
        '',
        'resources 字段: 长期常驻设施 / 家具 / 视觉特征 / 地理特征。不带事件痕迹("某契约存放于此" 应进 event 不进 resources)。单次出现的临时物品 = DROP。',
        '',
        'controller 字段: 当前实际控制者。可接受 "X(名义)/Y(实际)" 双层格式。不写 "X 临时担任 Y" — 除非"临时"本身已成长期状态(如长期临时工)。',
        '',
        'danger 字段: 风险等级 + 主要威胁来源。不写单次访问遭遇的具体冲突(那是 event)。',
        '',
        'aliases 字段: 真正的别称 / 简称 / 双语名 / in-world 通称。不重复 name 字段值; 不把其他子节点名当 aliases 塞进来(套房 aliases 不应写所属会所名)。',
    ].join('\n'),
};

export function computeActiveExtractionTypes(schema, currentSeq) {
    const active = new Set();
    const seq = Math.max(0, Math.floor(Number.isFinite(Number(currentSeq)) ? Number(currentSeq) : 0));
    for (const entry of Array.isArray(schema) ? schema : []) {
        const typeId = String(entry?.id || '').trim().toLowerCase();
        if (!typeId) continue;
        const everyN = Math.max(1, Math.floor(Number(entry?.extractEveryN ?? 1)) || 1);
        if (seq % everyN === 0) {
            active.add(typeId);
        }
    }
    return active;
}

export function buildPerTypeRulesBlock(schema, activeTypes) {
    const sections = [];
    const activeSet = activeTypes instanceof Set ? activeTypes : new Set();
    for (const entry of Array.isArray(schema) ? schema : []) {
        const typeId = String(entry?.id || '').trim().toLowerCase();
        if (!typeId || !activeSet.has(typeId)) continue;
        const instructions = String(entry?.extractionInstructions || '').trim();
        if (!instructions) continue;
        sections.push(`[${typeId}]\n${instructions}`);
    }
    if (sections.length === 0) return '';
    return `=== Per-type extraction rules (active this round) ===\n\n${sections.join('\n\n')}`;
}

/**
 * Trivially returns the base prompt. Kept as a wrapper so existing callers
 * and the public API surface re-export don't churn; per-type rules are now
 * appended to the user prompt via {@link buildPerTypeRulesBlock} so the
 * system prompt remains byte-stable across cadence rounds (Anthropic
 * prompt-cache friendliness).
 *
 * @param {string} basePrompt
 * @returns {string}
 */
export function assembleExtractionSystemPrompt(basePrompt) {
    return String(basePrompt || '').trim();
}
