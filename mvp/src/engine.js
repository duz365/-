// 《红黄绿》MVP 引擎
// 单一状态树 + 事件日志（按可见性下发）+ 回合制时钟（1 tick = 1 虚拟秒）
import {
  TICK, WEAPONS, WEAPON_BY_ID, REGION_TYPES, NODES, NODE_NAMES, START_NODES,
  GOALS, BOT_NAMES, T,
} from './data.js';

// ------------------------------------------------------------------ 随机
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = (s) => s.rng();
const randInt = (s, n) => Math.floor(rnd(s) * n);
const pick = (s, arr) => arr[randInt(s, arr.length)];
const chance = (s, p) => rnd(s) < p;
function weighted(s, pairs) {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  let r = rnd(s) * total;
  for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
  return pairs[pairs.length - 1][0];
}
function shuffle(s, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(s, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export const aliveOf = (s) => s.players.filter(p => p.alive);

// ------------------------------------------------------------------ 建局
export function createGame(opts = {}) {
  const seed = opts.seed ?? (Date.now() & 0x7fffffff);
  const playerCount = Math.min(10, Math.max(6, opts.playerCount ?? 6));
  const killerCount = opts.killerCount ?? (playerCount >= 8 ? 2 : 1);
  const humanName = opts.humanName ?? '你';
  const withHuman = opts.withHuman ?? true;

  const s = {
    seed, rng: mulberry32(seed), tick: 0, round: 1, phase: 'explore',
    players: [], nodes: {}, events: [], seq: 0, turnIdx: 0,
    meeting: null, testimonies: [], lawsuits: [], evidencePool: [],
    stats: { eliminations: 0, meetings: 0, arrests: 0 },
    pressure: { lastYellowAt: 0, lastMarkAt: 0, nextHotspot: 600, hotspot: null, converged: false, nextAuto: 3600 },
    markLimit: 3,
    over: false, result: null, scoreboard: null, needMeeting: false,
  };

  for (const name of NODE_NAMES) {
    s.nodes[name] = { name, type: NODES[name].type, clues: [], traces: [], nextAt: REGION_TYPES[NODES[name].type].interval };
  }

  const names = shuffle(s, BOT_NAMES.slice());
  for (let i = 0; i < playerCount; i++) {
    const isHuman = withHuman && i === 0;
    s.players.push({
      id: i,
      name: isHuman ? humanName : names[i % names.length],
      bot: !isHuman,
      faction: 'detective',
      alive: true,
      node: START_NODES[i % START_NODES.length],
      hp: 3, hpMax: 3,
      clues: [], marks: 0, rep: 100, wanted: 0,
      arrests: 0, resisted: 0,
      down: null, custodyUntil: 0, hideUntil: 0, poison: null, taserHits: 0,
      protect: null, weapon: null, ammo: 0,
      items: { alarm: 0, freeAlarm: 0 }, alarmCd: 0, confessed: false,
      goal: null, goalDone: false, goalLocked: false, goalTarget: null,
      subsRound: 0, subsCount: 0, protectRound: 0, greenRound: 0, lastSeen: 0, grudge: [],
      stats: { kills: 0, marksMade: 0, marksTaken: 0, stolen: 0, stolenTargeted: 0, destroyed: 0, destroyedTargeted: 0, searched: 0, defended: 0, defendedFor: [], redWins: 0, frames: 0, clues: 0 },
    });
  }

  const order = shuffle(s, s.players.map(p => p.id));
  for (let i = 0; i < killerCount; i++) s.players[order[i]].faction = 'killer';

  const killers = s.players.filter(p => p.faction === 'killer');
  const dets = s.players.filter(p => p.faction === 'detective');

  // 凶手武器：同局优先不重复
  let pool = WEAPONS.slice();
  for (const k of killers) {
    const w = weighted(s, pool.map(x => [x, x.weight]));
    pool = pool.filter(x => x.id !== w.id);
    k.weapon = w.id; k.ammo = w.ammo;
    if (w.initWanted) k.wanted = w.initWanted;
  }
  // 6–7 人单凶手局：凶手获得额外弹药与 1 条绿线索（平衡补丁）
  if (killers.length === 1) {
    for (const k of killers) {
      k.ammo += 1;
      k.clues.push(makeClue(s, k.node, 'green', { source: 'compensation' }));
    }
  }

  // 个人目标
  const detGoals = shuffle(s, GOALS.detective.slice());
  dets.forEach((p, i) => {
    const g = detGoals[i % detGoals.length];
    p.goal = { ...g };
    if (g.id === 'protector') p.goalTarget = pick(s, dets.filter(x => x.id !== p.id))?.id ?? null;
  });
  const kilPool = GOALS.killer.filter(g => g.id !== 'mole' || killers.length > 1);
  const kilGoals = shuffle(s, kilPool);
  killers.forEach((p, i) => {
    const g = kilGoals[i % kilGoals.length];
    p.goal = { ...g };
    if (g.id === 'framed') p.goalTarget = pick(s, dets)?.id ?? null;
  });

  // 侦探开局补偿（三选一）
  for (const d of dets) {
    const role = pick(s, ['green', 'alarm', 'freeAlarm']);
    if (role === 'green') d.clues.push(makeClue(s, d.node, 'green', { source: 'compensation' }));
    else if (role === 'alarm') d.items.alarm = 1;
    else d.items.freeAlarm = 1;
  }

  emit(s, { kind: 'sys', scope: 'global', text: T.phaseExplore() });
  return s;
}

// ------------------------------------------------------------------ 事件
function recipientsOf(s, { scope, node, to }) {
  const ids = new Set();
  const alive = s.players.filter(p => p.alive);
  if (scope === 'global') { s.players.forEach(p => ids.add(p.id)); }
  else if (scope === 'node') { alive.filter(p => p.node === node).forEach(p => ids.add(p.id)); }
  else if (scope === 'near') {
    const near = [node, ...NODES[node].adj];
    alive.filter(p => near.includes(p.node)).forEach(p => ids.add(p.id));
  } else if (scope === 'private') {
    if (Array.isArray(to)) to.forEach(id => ids.add(id));
    else if (to != null) ids.add(to);
  }
  return ids;
}

export function emit(s, ev) {
  const rec = recipientsOf(s, ev);
  s.seq += 1;
  s.events.push({ seq: s.seq, tick: s.tick, kind: ev.kind ?? 'info', scope: ev.scope ?? 'private', text: ev.text, to: [...rec] });
  if (s.events.length > 5000) s.events.splice(0, 1500);
  return rec;
}

export function drain(s, p, limit = 200) {
  const out = s.events.filter(e => e.seq > p.lastSeen && e.to.includes(p.id));
  if (out.length) p.lastSeen = out[out.length - 1].seq;
  return out.slice(-limit);
}

// ------------------------------------------------------------------ 线索
let clueSeq = 1;
export function makeClue(s, region, color, extra = {}) {
  const cfg = REGION_TYPES[NODES[region].type];
  const alive = aliveOf(s);
  const c = {
    id: `c${clueSeq++}`, color, region,
    name: '线索', fatal: 0, proof: 0, target: 'unknown',
    fake: false, source: extra.source ?? 'spawn', maker: extra.maker ?? null,
    createdAt: s.tick, dropped: !!extra.dropped,
  };
  delete extra.source; delete extra.maker; delete extra.dropped;
  if (color === 'red') {
    c.fatal = extra.fatal ?? weighted(s, cfg.fatal);
    c.name = extra.name ?? '物证';
    // 散落的红线索不预设指向：公开时由公开者指定目标（规则 3.5.2）
    if (c.target === 'unknown') c.target = extra.target ?? 'unknown';
  } else if (color === 'green') {
    c.proof = extra.proof ?? weighted(s, cfg.proof);
    c.name = '反证';
  } else {
    c.name = extra.name ?? pick(s, ['时间线碎片', '遗留物', '擦拭痕', '目击碎片', '物品位移']);
    if (c.target === 'unknown') {
      if (extra.target != null) c.target = extra.target;
      else if (alive.length) {
        // 让黄线索的指向有重复度：否则两两组合几乎凑不出来
        s.yellowPool = s.yellowPool ?? [];
        if (s.yellowPool.length && chance(s, 0.6)) c.target = pick(s, s.yellowPool);
        else { c.target = pick(s, alive).id; s.yellowPool.push(c.target); }
        if (s.yellowPool.length > 8) s.yellowPool = s.yellowPool.slice(-8);
      } else c.target = 'unknown';
    }
  }
  Object.assign(c, extra);
  return c;
}

export const CLUE_CAP = { red: Infinity, yellow: 5, green: 2 };
export function capLeft(p, color) {
  const cap = CLUE_CAP[color];
  if (!isFinite(cap)) return Infinity;
  return cap - p.clues.filter(c => c.color === color).length;
}

export function countUnlistedReds(s) {
  let n = 0;
  for (const p of s.players) n += p.clues.filter(c => c.color === 'red').length;
  for (const n2 of NODE_NAMES) n += s.nodes[n2].clues.filter(c => c.color === 'red').length;
  return n;
}

function spawnAt(s, node, forceColor) {
  const cfg = REGION_TYPES[NODES[node].type];
  const hot = s.pressure.hotspot?.node === node && s.tick < s.pressure.hotspot.until;
  const cap = cfg.cap + (hot ? 1 : 0);
  if (s.nodes[node].clues.length >= cap) return null;
  let color = forceColor;
  if (!color) {
    const wRed = cfg.wRed + (hot ? 15 : 0), wY = Math.max(5, cfg.wYellow - (hot ? 15 : 0));
    color = weighted(s, [['red', wRed], ['yellow', wY], ['green', cfg.wGreen]]);
  }
  if (color === 'red' && countUnlistedReds(s) >= 8) color = 'yellow';
  const c = makeClue(s, node, color, { source: 'spawn' });
  s.nodes[node].clues.push(c);
  return c;
}

// ------------------------------------------------------------------ 时钟
export function accel(s) { return 1 + 0.1 * Math.min(3, s.stats.eliminations); }

export function advance(s, dt) {
  if (s.over) return;
  const target = s.tick + Math.max(0, dt);
  let guard = 0;
  while (s.tick < target && guard++ < 2000) {
    s.tick = Math.min(target, s.tick + 5);
    processSpawns(s);
    processDowned(s);
    processCustody(s);
    processHiding(s);
    processPoison(s);
    processPressure(s);
    if (s.over) return;
  }
  s.tick = target;
}

function processSpawns(s) {
  const slow = s.pressure.converged ? 0.5 : 1;
  for (const name of NODE_NAMES) {
    const node = s.nodes[name];
    const cfg = REGION_TYPES[node.type];
    let guard = 0;
    while (s.tick >= node.nextAt && guard++ < 30) {
      spawnAt(s, name);
      node.nextAt = s.tick + Math.max(20, (cfg.interval * slow) / accel(s));
    }
  }
}

function processDowned(s) {
  for (const p of s.players) {
    if (!p.alive || !p.down) continue;
    if (s.tick >= p.down.until) {
      const by = s.players[p.down.by];
      p.down = null;
      eliminate(s, p, '暴力淘汰（失血）', by);
    }
  }
}

function processCustody(s) {
  for (const p of s.players) {
    if (!p.alive || !p.custodyUntil) continue;
    if (s.tick >= p.custodyUntil) {
      p.custodyUntil = 0; p.hp = p.hpMax; p.taserHits = 0;
      emit(s, { kind: 'police', scope: 'private', to: p.id, text: T.polRelease(TICK.custody) });
    }
  }
}

function processHiding(s) {
  for (const p of s.players) {
    if (!p.alive || !p.hideUntil) continue;
    if (s.tick >= p.hideUntil) {
      p.hideUntil = 0;
      changeWanted(s, p, -20, '躲藏');
      emit(s, { kind: 'self', scope: 'private', to: p.id, text: `你从躲藏处出来。通缉值 -20（现 ${p.wanted}）。` });
    }
  }
}

function processPoison(s) {
  for (const p of s.players) {
    if (!p.alive || !p.poison) continue;
    if (s.tick >= p.poison.at) {
      const { by, dmg } = p.poison;
      p.poison = null;
      emit(s, { kind: 'combat', scope: 'node', node: p.node, text: '有人突然踉跄两步，扶住了墙。' });
      damage(s, s.players[by], p, dmg || 2, { silent: true });
    }
  }
}

function processPressure(s) {
  const pr = s.pressure;
  const guarantee = s.pressure.converged ? 120 : 300;
  if (s.tick - pr.lastYellowAt >= guarantee) {
    const node = pick(s, NODE_NAMES);
    // 收束模式下保底改为红线索（否则残局无证据可用，对局无法收尾）
    spawnAt(s, node, s.pressure.converged ? 'red' : 'yellow');
    pr.lastYellowAt = s.tick;
    emit(s, { kind: 'sys', scope: 'global', text: T.spawnY(node) });
  }
  if (s.tick - pr.lastMarkAt >= 480) {
    const withYellow = NODE_NAMES.filter(n => s.nodes[n].clues.some(c => c.color === 'yellow'));
    const a = withYellow[0] ?? pick(s, NODE_NAMES);
    const b = withYellow[1] ?? pick(s, NODE_NAMES.filter(n => n !== a));
    pr.lastMarkAt = s.tick;
    emit(s, { kind: 'sys', scope: 'global', text: T.coldCase(a, b) });
  }
  if (s.tick >= pr.nextHotspot) {
    const node = pick(s, NODE_NAMES);
    pr.hotspot = { node, until: s.tick + 300 };
    pr.nextHotspot += 600;
    emit(s, { kind: 'sys', scope: 'global', text: T.hotspot(node) });
  }
  if (!pr.converged && s.tick >= 3600) {
    pr.converged = true; pr.nextAuto = s.tick + 300; s.needMeeting = true;
    emit(s, { kind: 'sys', scope: 'global', text: T.converge() });
  } else if (pr.converged && s.tick >= pr.nextAuto) {
    pr.nextAuto = s.tick + 300; s.needMeeting = true;
  }
}

// ------------------------------------------------------------------ 淘汰
function fmtAgo(sec) {
  const m = Math.floor(sec / 60), r = sec % 60;
  return m <= 0 ? `${r} 秒` : `${m} 分 ${String(r).padStart(2, '0')} 秒`;
}

function nearestClueOf(s, p) {
  let best = null;
  const consider = (c) => { if (!best || c.createdAt >= best.createdAt) best = c; };
  p.clues.forEach(consider);
  for (const n of NODE_NAMES) s.nodes[n].clues.filter(c => c.target === p.id).forEach(consider);
  s.evidencePool.filter(c => c.target === p.id).forEach(consider);
  s.destroyedClues = s.destroyedClues ?? [];
  s.destroyedClues.filter(c => c.target === p.id).forEach(consider);
  return best;
}

export function eliminate(s, p, how, by) {
  if (!p.alive) return;
  p.alive = false; p.down = null; p.custodyUntil = 0; p.hideUntil = 0; p.protect = null;
  s.stats.eliminations += 1;

  // 掉落：1–2 条未公开线索，绿保护不掉落
  const droppable = p.clues.filter(c => c.color !== 'green').slice(0, 2);
  for (const c of droppable) {
    p.clues = p.clues.filter(x => x.id !== c.id);
    c.dropped = true; c.region = p.node;
    s.nodes[p.node].clues.push(c);
  }
  if (droppable.length) {
    emit(s, { kind: 'warn', scope: 'node', node: p.node, text: '有东西从身上掉了出来，滚到墙角。' });
    emit(s, { kind: 'warn', scope: 'near', node: p.node, text: `你听到【${p.node}】方向有东西落地。` });
  }

  const near = nearestClueOf(s, p);
  const cmap = { red: '红色', yellow: '黄色', green: '绿色' };
  const fac = p.faction === 'killer' ? '凶手' : '侦探';
  const text = near
    ? T.elim(p.name, fac, how, cmap[near.color], near.region, fmtAgo(s.tick - near.createdAt))
    : T.elimNoClue(p.name, fac, how);
  emit(s, { kind: 'elim', scope: 'global', text });
  s.testimonies.push({ seq: s.seq, tick: s.tick, player: p.name, faction: p.faction, how, clue: near ? { color: cmap[near.color], region: near.region } : null });

  emit(s, { kind: 'sys', scope: 'global', text: T.accel(s.stats.eliminations) });

  // 计分：敌对阵营淘汰
  if (by && by.id !== p.id && by.faction !== p.faction) by.stats.kills += 1;
  // 内鬼：同伙被淘汰
  checkEnd(s);
}

// ------------------------------------------------------------------ 通缉
export function changeWanted(s, p, delta, reason) {
  const before = tierOf(p.wanted);
  p.wanted = Math.max(0, Math.min(200, p.wanted + delta));
  const after = tierOf(p.wanted);
  if (after > before) {
    if (after === 3) emit(s, { kind: 'police', scope: 'private', to: p.id, text: T.polHunt() });
    else if (after === 2) emit(s, { kind: 'police', scope: 'private', to: p.id, text: T.polHunt() });
    else if (after === 1) emit(s, { kind: 'police', scope: 'private', to: p.id, text: T.polPursue() });
  }
}

export function tierOf(w) { return w >= 100 ? 3 : w >= 80 ? 2 : w >= 50 ? 1 : 0; }

// ------------------------------------------------------------------ 战斗
function damage(s, attacker, victim, dmg, opts = {}) {
  if (!victim.alive || victim.down) return;
  victim.hp -= dmg;
  if (victim.hp <= 0) {
    const sec = TICK.downed;
    victim.down = { until: s.tick + sec, by: attacker?.id ?? null };
    emit(s, { kind: 'combat', scope: 'private', to: victim.id, text: T.beDown(sec) });
    emit(s, { kind: 'combat', scope: 'node', node: victim.node, text: `「${victim.name}」倒下了。倒地将持续 ${sec} 秒。` });
    if (attacker) changeWanted(s, attacker, attacker.faction === victim.faction ? 40 : 30, '击杀');
  } else if (!opts.silent) {
    emit(s, { kind: 'combat', scope: 'private', to: victim.id, text: T.beHit(victim.hp, victim.hpMax) });
  }
}

// ------------------------------------------------------------------ 查询
export function busy(p, tick) {
  return !p.alive || (p.down && p.down.until > tick) || p.custodyUntil > tick || p.hideUntil > tick;
}
export function hasWeapon(p) { return !!(p.weapon && p.ammo > 0); }
export function playerById(s, id) { return s.players[id] ?? null; }
export function aliveAt(s, node) { return s.players.filter(p => p.alive && p.node === node); }

export function pickActor(s) {
  if (s.over) return null;
  const alive = aliveOf(s);
  if (!alive.length) return null;
  for (let i = 0; i < s.players.length * 2; i++) {
    const p = s.players[s.turnIdx % s.players.length];
    s.turnIdx = (s.turnIdx + 1) % s.players.length;
    if (!busy(p, s.tick)) return p;
  }
  const times = alive.map(p => Math.max(p.down?.until ?? 0, p.custodyUntil ?? 0, p.hideUntil ?? 0)).filter(t => t > s.tick);
  const next = times.length ? Math.min(...times) : s.tick + 10;
  advance(s, Math.max(5, next - s.tick));
  return s.over ? null : pickActor(s);
}

export function nearestTerminal(s, from) {
  const seen = new Set([from]); let frontier = [from];
  while (frontier.length) {
    const nxt = [];
    for (const n of frontier) {
      if (NODES[n].terminal) return n;
      for (const m of NODES[n].adj) if (!seen.has(m)) { seen.add(m); nxt.push(m); }
    }
    frontier = nxt;
  }
  return '公共终端甲';
}
export function pathToTerminal(s, from) {
  const target = nearestTerminal(s, from);
  const prev = new Map([[from, null]]); const q = [from];
  while (q.length) {
    const cur = q.shift();
    if (cur === target) break;
    for (const n of NODES[cur].adj) if (!prev.has(n)) { prev.set(n, cur); q.push(n); }
  }
  const path = []; let cur = target;
  while (cur != null && cur !== from) { path.unshift(cur); cur = prev.get(cur); }
  return { target, path };
}

// ------------------------------------------------------------------ 行动
function fail(s, p, msg) {
  emit(s, { kind: 'fail', scope: 'private', to: p.id, text: msg });
  return { ok: false, msg };
}

export async function applyAction(s, p, a, ctx) {
  if (s.over) return { ok: false };
  if (!p.alive) return fail(s, p, T.fail.ghost());
  if (p.custodyUntil > s.tick) return fail(s, p, T.fail.custody(Math.ceil(p.custodyUntil - s.tick)));
  if (p.down && p.down.until > s.tick) return fail(s, p, '你倒在地上，什么都做不了。');
  if (s.phase === 'public') return fail(s, p, T.fail.frozen());

  switch (a.type) {
    case 'pass': advance(s, 5); return { ok: true };
    case 'move': return doMove(s, p, a);
    case 'look': return doLook(s, p, a);
    case 'search': return doSearch(s, p, a);
    case 'pickup': return doPickup(s, p, a);
    case 'drop': return doDrop(s, p, a);
    case 'attack': return doAttack(s, p, a);
    case 'execute': return doExecute(s, p, a);
    case 'rescue': return doRescue(s, p, a);
    case 'loot': return doLoot(s, p, a);
    case 'combine': return doCombine(s, p, a);
    case 'protect': return doProtect(s, p, a);
    case 'hide': return doHide(s, p, a);
    case 'destroy': return doDestroy(s, p, a);
    case 'trade': return doTrade(s, p, a);
    case 'frame': return doFrame(s, p, a);
    case 'alarm': return doAlarm(s, p, a);
    case 'confess': return doConfess(s, p, a);
    case 'lawsuit': return doLawsuit(s, p, a);
    case 'callMeeting': {
      if (!NODES[p.node].terminal) return fail(s, p, T.fail.needTerminal(nearestTerminal(s, p.node)));
      if (p.rep < 30) return fail(s, p, T.fail.lowRep(p.rep, 30));
      advance(s, TICK.callMeeting);
      await runMeeting(s, p, ctx);
      return { ok: true };
    }
    default: return fail(s, p, T.fail.cantDo(a.type));
  }
}

function doMove(s, p, a) {
  if (!NODES[p.node].adj.includes(a.to)) return fail(s, p, `【${a.to}】不相邻。相邻：${NODES[p.node].adj.join('、')}。`);
  p.hideUntil = 0;
  advance(s, TICK.move);
  if (s.over) return { ok: true };
  p.node = a.to;
  emit(s, { kind: 'self', scope: 'private', to: p.id, text: T.nodeEnter(a.to) });
  emit(s, { kind: 'sys', scope: 'node', node: a.to, text: `「${p.name}」走了进来。` });
  const others = aliveAt(s, a.to).filter(x => x.id !== p.id).map(x => x.name + (x.down ? '（倒地）' : ''));
  emit(s, { kind: 'scope', scope: 'private', to: p.id, text: `${T.nodeList(others)}  ${T.nodeAdj(NODES[a.to].adj)}` });
  return { ok: true };
}

function doLook(s, p) {
  advance(s, TICK.look);
  const node = s.nodes[p.node];
  const here = aliveAt(s, p.node).filter(x => x.id !== p.id);
  const lines = [`【${p.node}】${node.type}区域`];
  lines.push(`在场：${here.length ? here.map(x => x.name + (x.down ? '（倒地）' : '')).join('、') : '只有你'}`);
  lines.push(`相邻：${NODES[p.node].adj.map(n => `${n}（3s）`).join('、')}`);
  if (node.clues.length) lines.push(`地面线索：${node.clues.length} 条`);
  if (node.traces.length) lines.push(`可搜证的痕迹：${node.traces.length} 处`);
  const fac = [];
  if (NODES[p.node].terminal) fac.push('公共终端');
  if (NODES[p.node].destroy) fac.push('销毁点');
  if (NODES[p.node].informant) fac.push('线人');
  if (NODES[p.node].hide) fac.push('藏匿点');
  if (fac.length) lines.push(`设施：${fac.join('、')}`);
  emit(s, { kind: 'self', scope: 'private', to: p.id, text: lines.join('\n') });
  return { ok: true };
}

function doSearch(s, p) {
  const node = s.nodes[p.node];
  if (!node.traces.length) return fail(s, p, '这里没有可以搜证的痕迹。');
  if (capLeft(p, 'yellow') <= 0) return fail(s, p, T.fail.capacity('yellow'));
  advance(s, TICK.search);
  const trace = node.traces.shift();
  p.stats.searched += 1;
  const target = trace.by != null ? trace.by : 'unknown';
  const c = makeClue(s, p.node, 'yellow', { name: trace.type, source: 'search', target });
  p.clues.push(c);
  emit(s, {
    kind: 'search', scope: 'private', to: p.id,
    text: `${T.searchStart()}\n${T.searchDone(trace.type)}\n获得 ${T.clueCard(c, nameOf(s, c.target))}`,
  });
  return { ok: true };
}

function doPickup(s, p, a) {
  const node = s.nodes[p.node];
  const c = node.clues.find(x => x.id === a.clueId);
  if (!c) return fail(s, p, '这里没有这条线索了。');
  if (capLeft(p, c.color) <= 0) return fail(s, p, T.fail.capacity(c.color));
  node.clues = node.clues.filter(x => x.id !== c.id);
  p.clues.push(c);
  p.stats.clues += 1;
  emit(s, { kind: 'self', scope: 'private', to: p.id, text: T.pickupDone(c, nameOf(s, c.target)) });
  return { ok: true };
}

function doDrop(s, p, a) {
  const c = p.clues.find(x => x.id === a.clueId) ?? p.clues.find(x => x.color === 'yellow');
  if (!c) return fail(s, p, '你身上没有可以丢下的线索。');
  p.clues = p.clues.filter(x => x.id !== c.id);
  c.dropped = true; c.region = p.node;
  s.nodes[p.node].clues.push(c);
  emit(s, { kind: 'self', scope: 'private', to: p.id, text: `你把 ${T.clueCard(c, nameOf(s, c.target))} 丢在了地上。` });
  emit(s, { kind: 'scope', scope: 'node', node: p.node, text: '有人在地上留下了一条线索。' });
  return { ok: true };
}

function doAttack(s, p, a) {
  const t = playerById(s, a.target);
  if (!t || !t.alive) return fail(s, p, T.fail.badTarget(a.target));
  if (t.node !== p.node) return fail(s, p, T.fail.notHere(t.name));
  if (t.down) return fail(s, p, `「${t.name}」已经倒下了。要动手就处决（execute ${t.id}）。`);
  const w = p.weapon ? WEAPON_BY_ID[p.weapon] : null;
  if (w && p.ammo <= 0) return fail(s, p, T.fail.ammo(w.name));
  advance(s, TICK.attack);
  if (s.over) return { ok: true };
  if (w) p.ammo -= 1;
  const dmg = w ? w.dmg : 1;

  if (w && chance(s, 0.15)) {
    emit(s, { kind: 'combat', scope: 'private', to: p.id, text: T.attackMiss() });
    return { ok: true };
  }

  // 电击器：命中 2 次直接击倒
  if (w?.id === 'taser') {
    t.taserHits += 1;
    if (t.taserHits >= (w.stunHits ?? 2)) t.hp = 0;
  }
  damage(s, p, t, dmg);
  emit(s, {
    kind: 'combat', scope: 'private', to: p.id,
    text: t.down ? T.attackDown(t.name, TICK.downed) : T.attackHit(t.name, t.hp, t.hpMax),
  });

  const trail = w ? w.trail : '血迹';
  s.nodes[t.node].traces.push({ type: trail, by: p.id });
  if (w) {
    changeWanted(s, p, w.wanted, '暴力');
    emit(s, { kind: 'combat', scope: 'node', node: t.node, text: soundText(w) });
    if (w.sound === 'near') emit(s, { kind: 'combat', scope: 'near', node: t.node, text: '附近传来惨叫与打斗声。' });
    if (w.sound === 'global') emit(s, { kind: 'combat', scope: 'global', text: `[全图] 全城都听见了枪响——【${t.node}】。` });
    if (w.delay) t.poison = { at: s.tick + w.delay, by: p.id, dmg: 2 };
  }
  if (p.faction === t.faction && p.id !== t.id) s.nodes[t.node].traces.push({ type: '内讧', by: p.id });
  t.grudge = [...new Set([...(t.grudge ?? []), p.id])];

  if (t.items.alarm > 0) {
    t.items.alarm -= 1;
    s.players.filter(x => x.alive && x.faction === 'detective' && x.id !== t.id)
      .forEach(x => emit(s, { kind: 'alarm', scope: 'private', to: x.id, text: `!! 防身警报：【${t.node}】有人动手。攻击者：「${p.name}」。` }));
    emit(s, { kind: 'alarm', scope: 'private', to: t.id, text: '你的防身警报器触发了。所有侦探都知道了攻击者的位置。' });
  }
  return { ok: true };
}

function soundText(w) {
  switch (w.trail) {
    case '弹壳': return '你听到一声闷响，像是什么东西倒了。';
    case '焦痕': return '空气里有焦糊味，隐约一阵电流嗡鸣。';
    case '血迹': return '一声闷哼，紧接着是身体撞在硬物上的声音。';
    case '针孔': return '针尖刺入的声音很轻，轻到只有贴着的人能听见。';
    case '硝烟': return '墙面的熏黑范围很大。就算隔着两条街，也应该听得见。';
    default: return '有动静。';
  }
}

function doExecute(s, p, a) {
  const t = playerById(s, a.target);
  if (!t || !t.alive) return fail(s, p, T.fail.badTarget(a.target));
  if (t.node !== p.node) return fail(s, p, T.fail.notHere(t.name));
  if (!t.down) return fail(s, p, T.fail.notDowned(t.name));
  advance(s, TICK.execute);
  t.down = null;
  changeWanted(s, p, 20, '处决');
  emit(s, { kind: 'combat', scope: 'private', to: p.id, text: T.execDone(t.name) });
  emit(s, { kind: 'combat', scope: 'node', node: t.node, text: '一声短促的闷哼，之后彻底安静。' });
  emit(s, { kind: 'combat', scope: 'near', node: t.node, text: '远处传来一声很短的闷哼，然后什么都没有了。' });
  s.nodes[t.node].traces.push({ type: '二次创伤', by: p.id });
  eliminate(s, t, '暴力淘汰（处决）', p);
  return { ok: true };
}

function doRescue(s, p, a) {
  const t = playerById(s, a.target);
  if (!t || !t.alive) return fail(s, p, T.fail.badTarget(a.target));
  if (t.node !== p.node) return fail(s, p, T.fail.notHere(t.name));
  if (!t.down) return fail(s, p, `「${t.name}」没有倒下。`);
  advance(s, TICK.rescue);
  t.down = null; t.hp = 2; t.taserHits = 0;
  emit(s, { kind: 'combat', scope: 'private', to: p.id, text: T.rescueDone(t.name) });
  emit(s, { kind: 'combat', scope: 'private', to: t.id, text: `你被「${p.name}」拖了起来。体力恢复到 2。` });
  emit(s, { kind: 'combat', scope: 'node', node: t.node, text: `「${p.name}」把「${t.name}」扶了起来。` });
  return { ok: true };
}

function doLoot(s, p, a) {
  const t = playerById(s, a.target);
  if (!t || !t.alive) return fail(s, p, T.fail.badTarget(a.target));
  if (t.node !== p.node) return fail(s, p, T.fail.notHere(t.name));
  if (!t.down) return fail(s, p, '对方没有倒下，搜不了身。');
  if (!t.clues.length) return fail(s, p, '对方身上什么都没有。');
  advance(s, TICK.loot);
  const c = t.clues.find(x => capLeft(p, x.color) > 0) ?? t.clues[0];
  if (capLeft(p, c.color) <= 0) return fail(s, p, T.fail.capacity(c.color));
  t.clues = t.clues.filter(x => x.id !== c.id);
  p.clues.push(c);
  p.stats.stolen += 1;
  if (c.target === p.id) p.stats.stolenTargeted += 1;
  s.nodes[t.node].traces.push({ type: '擦拭痕', by: p.id });
  emit(s, { kind: 'self', scope: 'private', to: p.id, text: T.lootDone(c, nameOf(s, c.target)) });
  emit(s, { kind: 'self', scope: 'private', to: t.id, text: `「${p.name}」从你身上搜走了一条线索。` });
  return { ok: true };
}

function doCombine(s, p, a) {
  const c1 = p.clues.find(c => c.id === a.a), c2 = p.clues.find(c => c.id === a.b);
  if (!c1 || !c2) return fail(s, p, T.fail.noClue());
  if (c1.color !== 'yellow' || c2.color !== 'yellow') return fail(s, p, '只有黄线索可以两两组合升红。');
  if (c1.target === 'unknown' || c2.target === 'unknown' || c1.target !== c2.target) return fail(s, p, T.fail.needYellow());
  if (c1.region === c2.region) return fail(s, p, '两条线索来自同一区域，重复证据无法升红。需要不同区域。');
  const hot = s.pressure.hotspot?.node === p.node && s.tick < s.pressure.hotspot.until;
  const cost = Math.max(5, Math.round(8 * (1 - 0.1 * Math.min(3, s.stats.eliminations)) * (hot ? 0.8 : 1)));
  advance(s, cost);
  if (s.over) return { ok: true };
  p.clues = p.clues.filter(c => c.id !== c1.id && c.id !== c2.id);
  const red = makeClue(s, p.node, 'red', { fatal: 2, name: '证据链', target: c1.target, source: 'upgrade', maker: p.id });
  p.clues.push(red);
  emit(s, {
    kind: 'self', scope: 'private', to: p.id,
    text: `两条互不相干的痕迹，拼出了同一段时间。（${cost} 秒）\n获得 ${T.clueCard(red, s.players[c1.target]?.name)}\n它指向「${s.players[c1.target]?.name ?? '某人'}」。`,
  });
  return { ok: true };
}

function doProtect(s, p) {
  const g = p.clues.find(c => c.color === 'green');
  if (!g) return fail(s, p, '你没有绿线索，挂不了保护。');
  if (p.protect) return fail(s, p, '你已经挂着一个保护了。每名玩家最多 1 个。');
  if (p.greenRound === s.round) return fail(s, p, '这一轮你已经用过一条绿线索了（抗辩或保护，每轮各一次）。');

  advance(s, TICK.protect);
  p.clues = p.clues.filter(c => c.id !== g.id);
  p.protect = { proof: g.proof }; p.protectRound = s.round; p.greenRound = s.round;
  emit(s, { kind: 'self', scope: 'private', to: p.id, text: `你把一条绿线索收在袖口里（反证强度 ${g.proof}）。下一次有人指你，它会先说话。` });
  return { ok: true };
}

function doHide(s, p) {
  if (!NODES[p.node].hide) return fail(s, p, '这里没有可以藏身的地方。');
  emit(s, { kind: 'self', scope: 'private', to: p.id, text: '你把自己塞进角落。（120 秒内不会行动，结束后通缉值 -20）' });
  advance(s, TICK.hide);
  p.hideUntil = s.tick + TICK.hide;
  return { ok: true };
}

function doDestroy(s, p, a) {
  if (!NODES[p.node].destroy) return fail(s, p, '这里不是销毁点。销毁只能在危险区的销毁点进行。');
  const own = p.clues.filter(c => c.target === p.id);
  const c = own.find(x => x.id === a.clueId) ?? own[0];
  if (!c) return fail(s, p, '你手上没有指向自己的线索可以销毁。');
  advance(s, TICK.destroy);
  p.clues = p.clues.filter(x => x.id !== c.id);
  (s.destroyedClues ??= []).push(c);
  changeWanted(s, p, -15, '销毁');
  p.stats.destroyed += 1; p.stats.destroyedTargeted += 1;
  emit(s, { kind: 'self', scope: 'private', to: p.id, text: `你在销毁点烧掉了 ${T.clueCard(c, nameOf(s, c.target))}。通缉值 -15。` });
  return { ok: true };
}

function doTrade(s, p, a) {
  const t = playerById(s, a.target);
  if (!t || !t.alive) return fail(s, p, T.fail.badTarget(a.target));
  if (t.node !== p.node) return fail(s, p, T.fail.notHere(t.name));
  const mine = p.clues.find(c => c.id === a.clueId);
  if (!mine) return fail(s, p, T.fail.noClue());
  if (!t.clues.length) return fail(s, p, `「${t.name}」身上没有线索可以换。`);
  advance(s, TICK.trade);
  const theirs = t.clues[0];
  p.clues = p.clues.filter(c => c.id !== mine.id); t.clues = t.clues.filter(c => c.id !== theirs.id);
  p.clues.push(theirs); t.clues.push(mine);
  emit(s, { kind: 'self', scope: 'private', to: p.id, text: `你和「${t.name}」做了交换：给出 ${mine.color}线索·${mine.name}，得到 ${theirs.color}线索·${theirs.name}。` });
  emit(s, { kind: 'self', scope: 'private', to: t.id, text: `「${p.name}」和你做了交换：给出 ${mine.color}线索·${mine.name}，得到 ${theirs.color}线索·${theirs.name}。` });
  s.nodes[p.node].traces.push({ type: '物品位移', by: null });
  return { ok: true };
}

function doFrame(s, p, a) {
  if (p.faction !== 'killer') return fail(s, p, '只有凶手能嫁祸。');
  const t = playerById(s, a.target);
  if (!t || !t.alive) return fail(s, p, T.fail.badTarget(a.target));
  if (t.node !== p.node) return fail(s, p, T.fail.notHere(t.name));
  const witness = aliveAt(s, p.node).filter(x => x.id !== p.id && x.id !== t.id);
  if (witness.length) return fail(s, p, '这里还有第三个人。嫁祸必须在没人看着的时候做。');
  const y = p.clues.find(c => c.color === 'yellow');
  if (!y) return fail(s, p, '嫁祸需要一条黄线索作为材料。');
  advance(s, 15);
  p.clues = p.clues.filter(c => c.id !== y.id);
  s.nodes[p.node].clues.push(makeClue(s, p.node, 'yellow', { name: '遗留物', fake: true, source: 'frame', maker: p.id, target: t.id }));
  p.stats.frames += 1;
  emit(s, { kind: 'self', scope: 'private', to: p.id, text: `你布置了一条指向「${t.name}」的伪证。它混在这片区域里，和真的没两样。` });
  return { ok: true };
}

function doAlarm(s, p, a) {
  const free = p.items.freeAlarm > 0;
  if (!free && p.alarmCd > s.tick) return fail(s, p, T.fail.cooldown(Math.ceil(p.alarmCd - s.tick)));
  const node = a.node ?? p.node;
  if (!NODE_NAMES.includes(node)) return fail(s, p, T.fail.badTarget(node));
  if (free) p.items.freeAlarm -= 1; else p.alarmCd = s.tick + 180;
  advance(s, 1);
  emit(s, { kind: 'alarm', scope: 'global', text: `>>> 有人报警：【${node}】。警察会在 ${free ? 30 : 60} 秒内抵达。` });
  return { ok: true };
}

function doConfess(s, p) {
  if (!NODES[p.node].terminal) return fail(s, p, T.fail.needTerminal(nearestTerminal(s, p.node)));
  if (p.confessed) return fail(s, p, '你已经自首过一次了。');
  const y = p.clues.find(c => c.color === 'yellow');
  if (!y) return fail(s, p, '自首要交出一条黄线索。');
  p.clues = p.clues.filter(c => c.id !== y.id);
  p.confessed = true;
  p.wanted = Math.min(p.wanted, 49);
  advance(s, 5);
  emit(s, { kind: 'self', scope: 'private', to: p.id, text: `你在终端自首了。通缉值降到 ${p.wanted}。系统只记了一句"有人自首"。` });
  emit(s, { kind: 'sys', scope: 'global', text: '>>> 有人自首。系统没有说他叫什么。' });
  return { ok: true };
}

function doLawsuit(s, p) {
  if (!NODES[p.node].terminal) return fail(s, p, T.fail.needTerminal(nearestTerminal(s, p.node)));
  const q = s.lawsuits.find(x => x.victim === p.id && x.untilRound >= s.round);
  if (!q) return fail(s, p, '你现在没有可以反诉的伪造线索。');
  const g = p.clues.find(c => c.color === 'green');
  if (!g) return fail(s, p, '反诉需要一条绿线索。');
  advance(s, 5);
  p.clues = p.clues.filter(c => c.id !== g.id);
  s.lawsuits = s.lawsuits.filter(x => x !== q);
  const maker = s.players[q.by];
  if (g.proof >= (q.fatal ?? 2)) {
    addMark(s, maker, 1);
    maker.rep = Math.max(0, maker.rep - 10);
    emit(s, { kind: 'public', scope: 'global', text: T.lawsuitOK(maker.name) });
  } else {
    emit(s, { kind: 'public', scope: 'private', to: p.id, text: T.lawsuitFail() });
  }
  return { ok: true };
}

// ------------------------------------------------------------------ 红标
export function addMark(s, target, n) {
  target.marks += n;
  target.stats.marksTaken += n;
  s.pressure.lastMarkAt = s.tick;
  emit(s, { kind: 'public', scope: 'global', text: T.markAdd(target.name, target.marks, s.markLimit) });
  if (target.marks >= s.markLimit) eliminate(s, target, `红标淘汰（第 ${target.marks} 个红标）`, null);
}

// ------------------------------------------------------------------ 公开会
async function ask(ctx, p, spec) {
  if (ctx?.ask) return ctx.ask(p, spec);
  return spec.options?.[0]?.value;
}

export async function runMeeting(s, caller, ctx) {
  if (s.over) return;
  const node = caller.node;
  s.phase = 'public';
  s.stats.meetings += 1;
  const m = s.meeting = { node, caller: caller.id, round: s.round, redTotal: 0, perTarget: {} };
  emit(s, { kind: 'meet', scope: 'global', text: T.meetCalled(caller.name, node) });
  advance(s, TICK.assembly);
  if (s.over) { s.phase = 'explore'; s.meeting = null; return; }

  // 集结：隔壁的人可以过来
  for (const p of s.players.filter(x => x.alive)) {
    if (p.node === node || !NODES[p.node].adj.includes(node)) continue;
    const choice = await ask(ctx, p, {
      kind: 'assembly', prompt: `【${node}】正在开公开会，你就在隔壁。要过去吗？`,
      options: [{ label: '过去', value: 'go' }, { label: '不去', value: 'stay' }],
    });
    if (choice === 'go') { p.node = node; emit(s, { kind: 'sys', scope: 'node', node, text: `「${p.name}」走了进来。` }); }
  }

  const present = s.players.filter(p => p.alive && p.node === node);
  emit(s, { kind: 'meet', scope: 'node', node, text: `=== 公开会在【${node}】开始。到场：${present.map(p => p.name).join('、')}。 ===` });

  for (const p of s.players.filter(x => x.alive)) {
    if (s.over || m.redTotal >= 4) break;
    const isPresent = p.node === node;
    const canRemote = !isPresent && p.rep >= 70;
    if (!isPresent && !canRemote) continue;
    const redLimit = s.pressure.converged ? 2 : 1;
    if (p.subsRound === s.round && p.subsCount >= redLimit) continue;
    const reds = p.clues.filter(c => c.color === 'red');
    if (!reds.length) continue;
    const opts = [{ label: '不公开', value: 'pass' },
      ...reds.map(c => ({ label: `公开 ${c.name}（致命度 ${c.fatal}）${c.target === 'unknown' ? '' : '→ ' + nameOf(s, c.target)}`, value: c.id }))];
    const choice = await ask(ctx, p, { kind: 'submit', prompt: '公开会：要公开一条红线索吗？', options: opts, data: { reds: reds.map(c => ({ id: c.id, fatal: c.fatal, fixed: c.target !== 'unknown' ? Number(c.target) : null })) } });
    if (!choice || choice === 'pass') continue;
    const clue = reds.find(c => c.id === choice);
    if (!clue) continue;

    // 指定目标：黄升红/嫁祸产物自带目标；散落的红线索由公开者指定（3.5.2）
    let targetId = clue.target === 'unknown' ? null : Number(clue.target);
    if (targetId == null) {
      const cands = s.players.filter(x => x.alive && x.id !== p.id && (m.perTarget[x.id] ?? 0) < 2);
      if (!cands.length) continue;
      const ans = await ask(ctx, p, {
        kind: 'target', prompt: '这条线索指向谁？',
        options: cands.map(x => ({ label: `${x.name}（红标 ${x.marks}/3）`, value: String(x.id) })),
        data: { targetId: null },
      });
      targetId = Number(ans);
      if (!Number.isInteger(targetId) || !s.players[targetId]?.alive) continue;
    }
    if ((m.perTarget[targetId] ?? 0) >= 2) {
      emit(s, { kind: 'fail', scope: 'private', to: p.id, text: T.fail.targetMax(nameOf(s, targetId)) });
      continue;
    }
    await resolveSubmission(s, p, clue, targetId, m, ctx);
  }

  advance(s, TICK.meetingTail);
  s.meeting = null;
  s.phase = 'police';
  if (!s.over) await runPolicePhase(s, ctx);
  if (!s.over) {
    s.round += 1;
    s.phase = 'explore';
    emit(s, { kind: 'sys', scope: 'global', text: T.phaseExplore() });
  }
}

function nameOf(s, id) { return s.players[id]?.name ?? '某人'; }

async function resolveSubmission(s, p, clue, targetId, m, ctx) {
  p.clues = p.clues.filter(c => c.id !== clue.id);
  if (p.subsRound !== s.round) { p.subsRound = s.round; p.subsCount = 0; }
  p.subsCount += 1;
  m.redTotal += 1;
  s.stats.subs = (s.stats.subs ?? 0) + 1;
  const target = s.players[targetId];
  if (!target || !target.alive) {
    emit(s, { kind: 'fail', scope: 'private', to: p.id, text: '这条线索指向的人已经不在了。线索作废。' });
    return;
  }
  clue.target = targetId;
  emit(s, { kind: 'public', scope: 'global', text: T.submitBroadcast(target.name, p.rep < 50 ? 20 : 10) });
  emit(s, { kind: 'public', scope: 'private', to: p.id, text: T.submitOK(target.name, clue.fatal) });

  if (target.protect && !s.pressure.converged) {
    if (clue.fatal >= 3) {
      // 致命度 3 的证据压过保护（平衡补丁，见 README「与规则文档的差异」）
      target.protect = null;
      emit(s, { kind: 'public', scope: 'global', text: `>>> 保护不足以抵消致命度 3 的证据。「${target.name}」的保护已耗尽。` });
    } else {
      s.stats.protects = (s.stats.protects ?? 0) + 1;
      target.protect = null;
      p.rep = Math.max(0, p.rep - 10);
      emit(s, { kind: 'public', scope: 'global', text: T.protectTrigger(target.name, p.rep) });
      return;
    }
  }

  // 抗辩名额：默认 1 人；公开者信誉 < 50 时放宽到 2 人（对应"验证期延长"）
  // 收束模式：不再采信反证（7.6 强化）
  const slots = s.pressure.converged ? 0 : (p.rep < 50 ? 2 : 1);
  const candidates = s.players
    .filter(x => x.alive && x.node === m.node && x.id !== p.id && x.greenRound !== s.round && x.clues.some(c => c.color === 'green'))
    .sort((a, b) => (a.id === target.id ? -1 : 0) - (b.id === target.id ? -1 : 0));

  let sum = 0, used = 0;
  const defenders = [];
  for (const d of candidates) {
    if (used >= slots) break;
    const g = d.clues.find(c => c.color === 'green');
    if (!g) continue;
    const choice = await ask(ctx, d, {
      kind: 'defend',
      prompt: `「${target.name}」被指了一条致命度 ${clue.fatal} 的红线索。要出反证吗？（当前合计 ${sum}）`,
      options: [{ label: '不出', value: 'pass' }, { label: `出反证（强度 ${g.proof}）`, value: g.id }],
      data: { targetId: target.id, fatal: clue.fatal, sum },
    });
    if (!choice || choice === 'pass' || choice !== g.id) continue;
    d.clues = d.clues.filter(c => c.id !== g.id);
    d.greenRound = s.round;
    sum += g.proof; used += 1; defenders.push(d.id);
    d.stats.defended += 1; d.stats.defendedFor.push(target.id);
    emit(s, { kind: 'public', scope: 'private', to: d.id, text: `你提交了反证，为「${target.name}」辩护。反证强度 ${g.proof}。` });
  }

  const ok = sum >= clue.fatal;
  if (ok) {
    p.rep = Math.max(0, p.rep - 20);
    s.stats.defWin = (s.stats.defWin ?? 0) + 1;
    emit(s, { kind: 'public', scope: 'global', text: T.defenseOK(target.name, sum, clue.fatal) });
    for (const id of defenders) {
      const d = s.players[id];
      if (d.goal?.id === 'fixer' && !d.goalLocked) { d.goalLocked = true; d.goalDone = true; }
    }
    if (clue.fake) {
      p.rep = Math.max(0, p.rep - 20);
      emit(s, { kind: 'public', scope: 'global', text: T.fakeExposed(p.rep) });
      s.lawsuits.push({ victim: target.id, by: clue.maker ?? p.id, untilRound: s.round + 1, fatal: clue.fatal });
    }
  } else {
    emit(s, { kind: 'public', scope: 'global', text: T.defenseFail(target.name, sum, clue.fatal) });
    m.perTarget[target.id] = (m.perTarget[target.id] ?? 0) + 1;
    p.stats.marksMade += 1;
    if (clue.target != null && target.faction === 'killer') {
      p.stats.redWins += 1;
      p.rep = Math.min(100, p.rep + 10);
      if (p.goal?.id === 'shentan' && !p.goalLocked) { p.goalLocked = true; p.goalDone = true; }
    }
    if (clue.maker != null && clue.maker !== p.id) {
      const maker = s.players[clue.maker];
      if (maker?.goal?.id === 'framed' && maker.goalTarget === clue.target && !maker.goalLocked) {
        maker.goalLocked = true; maker.goalDone = true;
      }
    }
    addMark(s, target, 1);
  }
  if (clue.source === 'upgrade' && p.goal?.id === 'chain' && !p.goalLocked) { p.goalLocked = true; p.goalDone = true; }
  if (p.rep < 50) emit(s, { kind: 'public', scope: 'private', to: p.id, text: T.repDrop(p.rep) });
}

// ------------------------------------------------------------------ 警察阶段
export async function runPolicePhase(s, ctx) {
  if (s.over) return;
  s.phase = 'police';
  const hot = s.players.some(p => p.alive && tierOf(p.wanted) >= 1);
  emit(s, { kind: 'sys', scope: 'global', text: T.phasePolice(hot ? TICK.police : 10) });
  advance(s, hot ? TICK.police : 10);
  if (s.over) return;

  for (const p of s.players.filter(x => x.alive)) {
    if (tierOf(p.wanted) < 3) continue;
    emit(s, { kind: 'police', scope: 'private', to: p.id, text: T.polWarn() });
    const choice = await ask(ctx, p, {
      kind: 'arrest', prompt: '警察要求你停下。',
      options: [{ label: '服从（被捕 60 秒，掉 1 条线索）', value: 'arrest' }, { label: '拒捕（通缉 +20）', value: 'resist' }],
    });
    if (choice === 'resist') {
      changeWanted(s, p, 20, '拒捕');
      p.resisted += 1;
      emit(s, { kind: 'police', scope: 'private', to: p.id, text: T.polResist() });
      if (p.resisted >= 3) {
        emit(s, { kind: 'police', scope: 'private', to: p.id, text: T.polDown() });
        eliminate(s, p, '警察出局（连续拒捕）', null);
        emit(s, { kind: 'police', scope: 'global', text: T.polOut(p.name) });
      }
    } else {
      p.arrests += 1;
      if (p.arrests > 3) {
        eliminate(s, p, '警察出局（累计被捕）', null);
        emit(s, { kind: 'police', scope: 'global', text: T.polOut(p.name) });
        continue;
      }
      p.custodyUntil = s.tick + TICK.custody;
      p.wanted = 0; p.resisted = 0;
      const droppable = p.clues.filter(c => c.color !== 'green');
      if (droppable.length) {
        const c = droppable[0];
        p.clues = p.clues.filter(x => x.id !== c.id);
        s.evidencePool.push(c);
      }
      s.stats.arrests += 1;
      emit(s, {
        kind: 'police', scope: 'private', to: p.id,
        text: T.polArrested(TICK.custody) + '\n' + T.polCount(p.arrests),
      });
      emit(s, { kind: 'police', scope: 'global', text: `[全图] 警察在【${p.node}】实施逮捕。` });
    }
    if (s.over) return;
  }
  for (const p of s.players) if (p.wanted >= 80) changeWanted(s, p, -5, '警方收缩');
}

// ------------------------------------------------------------------ 终局
export function checkEnd(s) {
  if (s.over) return;
  const k = s.players.filter(p => p.alive && p.faction === 'killer').length;
  const d = s.players.filter(p => p.alive && p.faction === 'detective').length;
  if (k === 0 && d === 0) return endGame(s, 'draw');
  if (k === 0) return endGame(s, 'detective');
  if (d === 0) return endGame(s, 'killer');
}

function scoreOf(p, win) {
  const s = { team: win === 'win' ? 30 : win === 'draw' ? 10 : 0 };
  s.goal = p.goalDone ? 20 : 0;
  s.act = p.stats.kills * 15 - p.stats.marksTaken * 5;
  s.life = p.alive ? 10 : 0;
  s.rep = p.rep >= 80 ? 5 : p.rep < 50 ? -5 : 0;
  const ach = [];
  if (p.stats.marksMade >= 3) ach.push('铁证如山');
  if (p.alive && p.marks === 0) ach.push('清白之身');
  if (p.alive && p.rep === 100) ach.push('金字招牌');
  if (!p.alive && win === 'win') ach.push('幽灵侦探');
  s.achNames = ach.slice(0, 2);
  s.ach = s.achNames.length * 5;
  s.total = s.team + s.goal + s.act + s.life + s.rep + s.ach;
  return s;
}

export function endGame(s, who) {
  if (s.over) return;
  s.phase = 'end';
  s.result = { who, round: s.round, tick: s.tick, eliminations: s.stats.eliminations };

  for (const p of s.players) {
    if (p.goalLocked) { p.goalDone = true; continue; }
    if (!p.alive) continue;
    if (p.goal?.type === 'survive') {
      if (p.goal.id === 'perfect') p.goalDone = p.marks === 0;
      else if (p.goal.id === 'protector') {
        const t = s.players[p.goalTarget];
        p.goalDone = !!t && t.alive && t.faction === 'detective';
      } else if (p.goal.id === 'mole') {
        const mates = s.players.filter(x => x.faction === 'killer' && x.id !== p.id);
        p.goalDone = mates.length > 0 && mates.some(x => !x.alive);
      }
    }
  }

  emit(s, { kind: 'end', scope: 'global', text: T.endTitle(s.round) });
  const who2 = who === 'detective' ? T.endDetWin() : who === 'killer' ? T.endKillerWin() : T.endDraw();
  emit(s, { kind: 'end', scope: 'global', text: who2 });

  s.scoreboard = s.players.map(p => {
    const win = (p.faction === 'detective' && who === 'detective') || (p.faction === 'killer' && who === 'killer')
      ? 'win' : who === 'draw' ? 'draw' : 'lose';
    return { id: p.id, name: p.name, faction: p.faction, win, score: scoreOf(p, win), goalDone: p.goalDone };
  }).sort((a, b) => b.score.total - a.score.total);
  s.over = true;
}
