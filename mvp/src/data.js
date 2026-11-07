// 《红黄绿》MVP 数据层
// 依据：红黄绿-MVP规则文档.md v0.2 第 10 章；红黄绿-文本资源清单.md v0.1
// 所有数值改动只改这里，不要在 engine 里写魔法数字。

// ---------------------------------------------------------------- 时间成本
// 回合制适配：1 点 tick = 1 虚拟秒。动作按规则文档的秒数推进时钟。
export const TICK = {
  move: 3,          // 相邻节点 3 秒/跳
  look: 1,
  search: 3,        // 搜证 3 秒
  attack: 2,        // 前摇 1.5 秒 → 取整 2
  execute: 3,       // 处决 3 秒
  rescue: 5,        // 救援 5 秒
  loot: 2,          // 搜身夺取 2 秒
  protect: 10,      // 挂保护 10 秒静默
  trade: 5,         // 交易 5 秒
  destroy: 30,      // 销毁证据 30 秒
  hide: 120,        // 躲藏 120 秒
  callMeeting: 3,   // 发起公开会
  assembly: 30,     // 集结 30 秒
  meetingTail: 20,  // 公开会收尾（MVP 压缩）
  police: 40,       // 警察阶段（MVP 压缩为 40 秒虚拟）
  custody: 60,      // 被捕 60 秒禁足
  downed: 30,       // 倒地 30 秒
  warn: 3,          // 逮捕警告 3 秒
};

// ---------------------------------------------------------------- 武器（10.3）
export const WEAPONS = [
  { id: 'pistol',  name: '消音手枪', dmg: 2, wanted: 25, weight: 30, ammo: 3, sound: 'node',   trail: '弹壳', note: '声音小，痕迹少' },
  { id: 'taser',   name: '电击器',   dmg: 1, wanted: 15, weight: 25, ammo: 4, sound: 'node',   trail: '焦痕', note: '命中 2 次即击倒，倒地 45 秒', stunHits: 2, downBonus: 15 },
  { id: 'blade',   name: '近战利器', dmg: 3, wanted: 35, weight: 20, ammo: 2, sound: 'near',   trail: '血迹', note: '需接近，痕迹明显' },
  { id: 'needle',  name: '毒针',     dmg: 2, wanted: 20, weight: 15, ammo: 2, sound: 'none',   trail: '针孔', note: '延迟发作，可制造不在场证明', delay: 30 },
  { id: 'shotgun', name: '短管霰弹', dmg: 3, wanted: 45, weight: 10, ammo: 2, sound: 'global', trail: '硝烟', note: '近距离强，声音大', initWanted: 10 },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map(w => [w.id, w]));

// ---------------------------------------------------------------- 区域（10.1）
// fatal / proof 分布见规则文档 3.5.4；cap 为该节点线索存量上限。
export const REGION_TYPES = {
  现场: { interval: 90,  wRed: 25, wYellow: 55, wGreen: 20, cap: 6,
    fatal: [[2, 60], [3, 40]], proof: [[1, 50], [2, 50]] },
  安全: { interval: 120, wRed: 5,  wYellow: 35, wGreen: 60, cap: 5,
    fatal: [[1, 100]],          proof: [[2, 50], [3, 50]] },
  危险: { interval: 100, wRed: 35, wYellow: 45, wGreen: 20, cap: 7,
    fatal: [[2, 40], [3, 60]],  proof: [[1, 70], [2, 30]] },
  终端: { interval: 150, wRed: 10, wYellow: 50, wGreen: 40, cap: 4,
    fatal: [[1, 20], [2, 80]],  proof: [[2, 40], [3, 60]] },
  线人: { interval: 180, wRed: 15, wYellow: 60, wGreen: 25, cap: 3,
    fatal: [[2, 100]],          proof: [[1, 40], [2, 60]] },
};

// ---------------------------------------------------------------- 节点图（11.2）
// 13 个节点、度数 2–3、邻接双向对称、直径 7 跳（已在 test/map.test.js 校验）
export const NODES = {
  案发现场甲:   { type: '现场', spawn: 3, hide: true,  adj: ['安全区甲', '危险区甲'] },
  案发现场乙:   { type: '现场', spawn: 3, hide: true,  adj: ['安全区乙', '危险区乙'] },
  安全区甲:     { type: '安全', spawn: 2, hide: true,  adj: ['案发现场甲', '危险区甲', '公共终端甲'] },
  安全区乙:     { type: '安全', spawn: 2, hide: true,  adj: ['案发现场乙', '危险区乙', '公共终端乙'] },
  安全区丙:     { type: '安全', spawn: 2, hide: true,  adj: ['线人点甲', '危险区丙'] },
  危险区甲:     { type: '危险', spawn: 3, hide: true,  destroy: true, adj: ['案发现场甲', '安全区甲', '公共终端甲'] },
  危险区乙:     { type: '危险', spawn: 3, hide: true,  destroy: true, adj: ['案发现场乙', '安全区乙', '线人点乙'] },
  危险区丙:     { type: '危险', spawn: 3, hide: true,  adj: ['安全区丙', '公共终端丙'] },
  公共终端甲:   { type: '终端', spawn: 2, hide: true,  terminal: true, adj: ['安全区甲', '危险区甲', '线人点甲'] },
  公共终端乙:   { type: '终端', spawn: 2, hide: true,  terminal: true, adj: ['安全区乙', '线人点甲'] },
  公共终端丙:   { type: '终端', spawn: 2, hide: true,  terminal: true, adj: ['危险区丙', '线人点乙'] },
  线人点甲:     { type: '线人', spawn: 2, hide: true,  informant: true, adj: ['安全区丙', '公共终端乙', '公共终端甲'] },
  线人点乙:     { type: '线人', spawn: 2, hide: true,  informant: true, adj: ['危险区乙', '公共终端丙'] },
};
export const NODE_NAMES = Object.keys(NODES);
export const START_NODES = ['案发现场甲', '案发现场乙', '安全区乙', '危险区丙', '线人点乙'];

// ---------------------------------------------------------------- 线索文案（CL）
export const CLUE_NAMES = {
  弹壳: '弹壳', 焦痕: '焦痕', 血迹: '血迹', 针孔: '针孔', 硝烟: '硝烟',
  二次创伤: '二次创伤', 内讧: '内讧痕迹',
  时间线碎片: '时间线碎片', 遗留物: '遗留物', 擦拭痕: '擦拭痕', 目击碎片: '目击碎片', 物品位移: '物品位移',
  反证: '反证', 证据链: '证据链',
};

export const SEARCH_TRACES = {
  弹壳: '你找到一枚 9mm 弹壳，余温尚存。地面有被擦拭过的血迹。',
  焦痕: '金属面上的焦痕还是新的。有人在这里接触过电。',
  血迹: '血迹的喷溅方向一致。倒下的人没有还手的余地。',
  针孔: '针孔在下颌侧面，位置很讲究。被扎的人当时应该没有防备。',
  硝烟: '墙面的熏黑范围很大。就算隔着两条街，也应该听得见。',
  二次创伤: '先被控制，再被处理。顺序不会错。',
  内讧: '两种手法，互相交错。有人在同一个人身上用了两种方式。',
};

// ---------------------------------------------------------------- 个人目标（10.7）
export const GOALS = {
  detective: [
    { id: 'shentan',   name: '神探',   type: 'event',   desc: '你公开的红线索导致至少 1 名凶手被淘汰' },
    { id: 'protector', name: '保护者', type: 'survive', desc: '指定一名侦探存活到终局' },
    { id: 'chain',     name: '证据链', type: 'event',   desc: '公开至少 1 条由黄色线索升级而来的红色线索' },
    { id: 'fixer',     name: '纠错者', type: 'event',   desc: '成功抗辩移除 1 个错误红标' },
  ],
  killer: [
    { id: 'perfect',   name: '完美犯罪', type: 'survive', desc: '你存活到终局，且从未被公开红标' },
    { id: 'framed',    name: '嫁祸成功', type: 'event',   desc: '指定一名侦探因你提供的线索被红标淘汰' },
    { id: 'cleaner',   name: '清道夫',   type: 'event',   desc: '销毁或夺取 3 条针对你的线索' },
    { id: 'mole',      name: '内鬼',     type: 'survive', desc: '你的同伙被淘汰，但你存活到终局' },
  ],
};

export const BOT_NAMES = ['陈某', '周某', '赵某', '孙某', '李某', '吴某', '郑某', '王某', '冯某'];

// ---------------------------------------------------------------- 文案（对应资源清单 ID）
export const T = {
  // --- 系统 / 阶段（SYS）
  phaseExplore: () => '=== 探索阶段。本轮不会结束，直到有人把话说出来。 ===',
  phaseMeeting: (r) => `=== 第 ${r} 轮 · 公开会开始。每人最多公开 1 条红线索。 ===`,
  phasePolice: (s) => `=== 警察阶段（${s} 秒）。通缉值将在本阶段结算。 ===`,
  spawnY: (n) => `>>> 【${n}】出现了新的痕迹。没人知道是谁留下的。`,
  coldCase: (a, b) => `>>> 本案已连续 8 分钟没有新的公开红标。两处高价值痕迹的位置已被标记：【${a}】、【${b}】。`,
  hotspot: (n) => `>>> 调查热点转移至【${n}】，持续 5 分钟。那里的线索更快成形。`,
  accel: (n) => `>>> 场上已淘汰 ${n} 人。线索生成加快，证据更容易拼合。`,
  converge: () => '>>> 本案已持续 60 分钟。系统将加快节奏：线索刷新加倍，每 10 分钟自动召集一次公开会。',

  // --- 区域（NODE）
  nodeEnter: (n) => `你到达【${n}】。`,
  nodeList: (l) => (l.length ? `在场：${l.join('、')}` : '此处只有你。'),
  nodeAdj: (a) => `相邻：${a.map(x => `${x}（3s）`).join('、')}`,

  // --- 线索（CL）
  clueCard: (c, targetName) => {
    const strength = c.color === 'red' ? `致命度 ${c.fatal}` : c.color === 'green' ? `反证强度 ${c.proof}` : '可疑证据';
    const col = c.color === 'red' ? '红' : c.color === 'yellow' ? '黄' : '绿';
    return `【${col}线索·${c.name}】来源：${c.region} · 指向：${targetName || '不明'} · ${strength}`;
  },
  clueDetail: {
    弹壳: '一枚 9mm 弹壳，底火有新鲜撞击痕。它落在离地不高的位置。',
    焦痕: '金属表面有一片焦黑，边缘呈放射状。空气里还留着一点焦糊味。',
    血迹: '血迹呈喷溅状，方向一致，不是自然滴落。',
    针孔: '皮肤上有一个几乎看不见的针孔，周围没有挣扎痕迹。发作得比预期慢。',
    硝烟: '墙面被高温熏黑，碎屑散到很远。声音一定大到让半个城区都听见了。',
    二次创伤: '颈部有二次创伤，伤口边缘整齐，是从背后下的手。',
    内讧: '两处伤痕来自两种手法，方向彼此交错。不是一方压制另一方。',
    时间线碎片: '一张被踩过的票据，时间戳是今晚的这个小时。',
    遗留物: '一枚不属于这个场合的袖扣，掉在角落。它没被带走，说明主人走得很急。',
    擦拭痕: '地面被反复擦过，擦的方向只朝着一个方向。有人想擦掉什么，但没擦完。',
    目击碎片: '半开的窗。从这里看出去，能看见走廊的全貌。',
    物品位移: '所有的椅子都被挪到了靠墙的一侧。有人需要一个开阔的中场。',
    反证: '一个说不通的小矛盾。它不足以推翻什么，但足以让人的话卡一下。',
    证据链: '两条互不相干的痕迹，拼出了同一段时间。它已经不只是"可疑"了。',
  },

  // --- 搜证（INV）
  searchStart: () => '你蹲下来，开始看这些不该存在的东西。（3 秒）',
  searchDone: (trail) => SEARCH_TRACES[trail] || '你找到了一点不该留下的东西。',
  searchEmpty: () => '这处痕迹已经被翻过了。地上只剩下被破坏的形状。',
  pickupDone: (c, targetName) => `你拾取了 ${T.clueCard(c, targetName)}。`,

  // --- 战斗（CMB）
  attackMiss: () => '你出手了，但对方退开了半步。没有打中。',
  attackHit: (p, hp, max) => `你击中了「${p}」。对方 ${hp}/${max}，动作开始变形。`,
  attackDown: (p, sec) => `「${p}」倒下了。倒地将持续 ${sec} 秒。`,
  beHit: (hp, max) => `你被击中了。体力 ${hp}/${max}。视野边缘在发白。`,
  beDown: (sec) => `你倒下了。${sec} 秒内没有人来，你就再也站不起来。`,
  execDone: (p) => `你完成了处决。「${p}」不再呼吸。`,
  rescueDone: (p) => `你把「${p}」拖了起来。对方体力恢复到 2。`,
  lootDone: (c) => `你从对方身上取走了 ${T.clueCard(c)}。`,

  // --- 公开会（PUB）
  meetCalled: (p, n) => `[全图] 有人在【${n}】发起公开会，30 秒后开始。`,
  meetOpen: (n) => `=== 公开会在【${n}】开始。到场：${n}。 ===`,
  submitOK: (p, f) => `>>> 你提交了证据，指向「${p}」。致命度 ${f}。`,
  submitBroadcast: (p, sec) => `>>> 「${p}」被公开了一条红色线索。验证期 T-${sec}s。`,
  defenseOK: (p, sum, f) => `>>> 抗辩成功。红标未记入「${p}」。反证强度合计 ${sum} ≥ 致命度 ${f}。`,
  defenseFail: (p, sum, f) => `>>> 抗辩失败。反证强度合计 ${sum} < 致命度 ${f}。绿线索已消耗。`,
  markAdd: (p, m) => `>>> 「${p}」红标 +1，现为 ${m}/3。`,
  protectTrigger: (p, rep) => `>>> 保护生效。「${p}」的红标被抵消。公开者信誉 -10（现 ${rep}）。`,
  repDrop: (r) => `你的信誉降至 ${r}。此后的公开线索验证期延长至 20 秒。`,
  fakeExposed: (r) => `>>> 该线索被判定为伪造。公开者信誉额外 -20（现 ${r}）。被指向者可在下一轮反诉。`,
  lawsuitOK: (p) => `>>> 反诉成立。「${p}」此前伪造的线索被推翻，同时记入「${p}」红标 +1。`,
  lawsuitFail: () => '>>> 反诉不成立。你消耗了一条绿线索，该红标维持。',

  // --- 警察（POL）
  polPursue: () => '!! 警察注意到了你。他们在区域内绕行，速度比刚才快。',
  polHunt: () => '!! 全城通缉。你走到哪里，警察都会在不久后出现。',
  polWarn: () => '!!! 警察直接朝你走来，开始 3 秒警告。服从，或者跑。',
  polArrested: (sec) => `你举起手。被捕 ${sec} 秒，期间不能行动，也不会被任何人攻击。一条线索被收走。`,
  polResist: () => '你转身就跑。警察的动作立刻变了——通缉值 +20。',
  polDown: () => '警察把你按在地上。这一次，你没有再站起来的机会。',
  polRelease: (sec) => `${sec} 秒后，你被放出。体力恢复到 3，但那条线索留在了证物池。`,
  polCount: (n) => `这是你第 ${n} 次被捕。3 次之后的下一次，没有警告。`,
  polOut: (p) => `### 警察出局：累计被捕已达上限。「${p}」不再参与本局。`,

  // --- 淘汰（ELM）
  elim: (p, faction, how, color, region, time) =>
    `### 淘汰公告\n玩家「${p}」已被淘汰。阵营：${faction}。方式：${how}。\n最近线索：${color} · ${region} · 淘汰前 ${time}。`,
  elimNoClue: (p, faction, how) =>
    `### 淘汰公告\n玩家「${p}」已被淘汰。阵营：${faction}。方式：${how}。\n最近线索：无关联线索记录。`,
  elimDestroyed: (p, faction, how, region, time) =>
    `### 淘汰公告\n玩家「${p}」已被淘汰。阵营：${faction}。方式：${how}。\n最近线索：线索已销毁（${region} · ${time}）。`,

  // --- 结算（END）
  endTitle: (r) => `### 案件终结 · 第 ${r} 轮`,
  endDetWin: () => '侦探阵营胜利。所有凶手已被淘汰。',
  endKillerWin: () => '凶手阵营胜利。所有侦探已被淘汰。',
  endDraw: () => '悬案。双方在同一时刻失去最后一人——没有人赢。',
  goalOK: (n) => `个人目标「${n}」：达成。`,
  goalNo: (n) => `个人目标「${n}」：未达成。`,
  scoreLine: (s) => `团队 ${s.team} · 目标 ${s.goal} · 行为 ${s.act} · 生存 ${s.life} · 信誉 ${s.rep} · 成就 ${s.ach} ＝ 总分 ${s.total}`,
  achUnlock: (n) => `成就解锁：${n}（+5）`,

  // --- 指令反馈（CMD）
  fail: {
    notHere: (p) => `${p} 不在这个区域。攻击、交易、救援都需要和对方在同一个地方。`,
    noClue: () => '你没有这条线索。用「线索」查看当前携带的内容。',
    lowRep: (rep, n) => `你的信誉只有 ${rep}，不足以这样做。（需要 ≥ ${n}）`,
    needYellow: () => '合并需要两条指向同一目标、来自不同区域的黄线索。你现在不够。',
    alreadySubmitted: () => '这一轮你已经公开过一条红线索了。要等下一次公开会。',
    targetMax: (p) => `「${p}」本轮已经记入 2 个红标。再快，也要等下一轮。`,
    custody: (s) => `你还在警察控制中，还剩 ${s} 秒。`,
    frozen: () => '公开会期间不能动手。所有人都在看着。',
    needTerminal: (n) => `这件事只能在公共终端做。最近的终端在【${n}】。`,
    ammo: (w) => `${w}已经没有余量了。它现在只是一件证据。`,
    selfDefense: () => '你不能为自己抗辩——需要别人替你说话。',
    notPresent: () => '你没有到场。远程提交只适用于提交红线索，抗辩必须站在这间屋子里。',
    cooldown: (s) => `还有 ${s} 秒才能做下一次。`,
    ghost: () => '你已经不在这个局面里了。你只能看。',
    badTarget: (x) => `没有这个人，或者对方已经不在了：${x}。`,
    cantDo: (x) => `现在不能这么做：${x}。`,
    notDowned: (p) => `「${p}」没有倒下。处决只能对倒地的人。`,
    noWeapon: () => '你手上没有任何能造成伤害的东西。',
    capacity: (color) => color === 'yellow' ? '黄线索最多带 5 条。先组合、交易或丢掉一些。' : color === 'green' ? '绿线索最多带 2 条。先挂保护或丢掉一条。' : '你身上的线索太多了。',
  },
};
