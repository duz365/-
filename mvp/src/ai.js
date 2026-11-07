// 机器人 AI —— 只使用"公开可见信息 + 自己的私密信息"做决策
import { NODES, NODE_NAMES } from './data.js';
import {
  aliveAt, hasWeapon, nearestTerminal, pathToTerminal, tierOf, playerById, capLeft,
} from './engine.js';

const rnd = (s) => s.rng();
const chance = (s, p) => rnd(s) < p;
const pick = (s, a) => a[Math.floor(rnd(s) * a.length)];

// 只按公开信息 + 自身经历估计某人嫌疑
export function suspicion(s, me, other) {
  if (!other || other.id === me.id) return 0;
  let x = other.marks * 3;
  if (me.grudge?.includes(other.id)) x += 6;
  if (me.clues?.some(c => (c.color === 'yellow' || c.color === 'red') && Number(c.target) === other.id)) x += 3;
  x += rnd(s) * 0.9;
  if (other.stats?.marksMade >= 2) x += 2;
  if (me.faction === 'killer') x += other.faction === 'killer' ? -10 : 2;
  return x;
}

function bestTarget(s, me) {
  const others = s.players.filter(p => p.alive && p.id !== me.id);
  if (!others.length) return null;
  return others.sort((a, b) => suspicion(s, me, b) - suspicion(s, me, a))[0];
}

// 朝满足 predicate 的最近节点走一步
function stepToward(s, from, predicate) {
  const seen = new Set([from]);
  const q = [[from, null]];
  while (q.length) {
    const [cur, first] = q.shift();
    if (cur !== from && predicate(cur)) return first;
    for (const n of NODES[cur].adj) {
      if (seen.has(n)) continue;
      seen.add(n);
      q.push([n, first ?? n]);
    }
  }
  return null;
}

function pickBestClueHere(s, p) {
  const node = s.nodes[p.node];
  if (!node.clues.length) return null;
  const usable = node.clues.filter(c => capLeft(p, c.color) > 0);
  if (!usable.length) return null;
  const score = (c) => (c.color === 'red' ? 3 : c.color === 'yellow' ? 2 : 1) + (c.target === p.id ? 0.5 : 0);
  return usable.sort((a, b) => score(b) - score(a))[0];
}

function findCombinePair(p) {
  const ys = p.clues.filter(c => c.color === 'yellow' && c.target !== 'unknown');
  for (let i = 0; i < ys.length; i++) {
    for (let j = i + 1; j < ys.length; j++) {
      if (ys[i].target === ys[j].target && ys[i].region !== ys[j].region) return [ys[i], ys[j]];
    }
  }
  return null;
}

export function botAct(s, p) {
  const here = aliveAt(s, p.node).filter(x => x.id !== p.id);
  const nodeDef = NODES[p.node];
  const reds = p.clues.filter(c => c.color === 'red');
  const greens = p.clues.filter(c => c.color === 'green');

  // 1. 被通缉：先躲
  if (tierOf(p.wanted) >= 2 && p.hideUntil === 0 && chance(s, 0.6)) return { type: 'hide' };

  // 2. 处决眼前倒下的敌人
  const downedFoe = here.find(x => x.down && (p.faction === 'killer' ? x.faction !== 'killer' : p.grudge?.includes(x.id)));
  if (downedFoe) return { type: 'execute', target: downedFoe.id };

  // 3. 救援同阵营（凶手救凶手；侦探救有恩于己的人）
  const downedMate = here.find(x => x.down && p.faction === 'killer' && x.faction === 'killer');
  if (downedMate && chance(s, 0.5)) return { type: 'rescue', target: downedMate.id };

  // 4. 凶手攻击：优先对"没人看见"的人下手
  if (p.faction === 'killer' && hasWeapon(p) && tierOf(p.wanted) < 2) {
    const prey = here.filter(x => x.faction !== 'killer' && !x.down);
    if (prey.length) {
      const victim = pick(s, prey);
      const others = here.filter(x => x.id !== victim.id);
      if (others.length === 0 || chance(s, 0.2)) return { type: 'attack', target: victim.id };
    }
    // 追击：朝人最多的相邻节点移动（凶手要主动找人）
    const busy = NODES[p.node].adj
      .map(n => ({ n, c: s.players.filter(x => x.alive && x.node === n).length }))
      .sort((a, b) => b.c - a.c)[0];
    if (busy && busy.c > 0 && chance(s, 0.7)) return { type: 'move', to: busy.n };
  }

  // 5. 侦探反击：只打有仇的人
  if (p.faction === 'detective' && p.hp <= 1) {
    const foe = here.find(x => p.grudge?.includes(x.id) && !x.down);
    if (foe && chance(s, 0.5)) return { type: 'attack', target: foe.id };
  }

  // 6. 挂保护
  if (greens.length && !p.protect && p.marks > 0) return { type: 'protect' };

  // 7. 凑黄升红
  const pair = findCombinePair(p);
  if (pair && chance(s, 0.8)) return { type: 'combine', a: pair[0].id, b: pair[1].id };

  // 8. 手上的红线索 → 有像样的目标才去终端开公开会（否则继续收集）
  const suspect = bestTarget(s, p);
  const sus = suspect ? suspicion(s, p, suspect) : 0;
  const eager = p.faction === 'killer'
    ? !!suspect && suspect.faction !== 'killer'
    : (sus >= 3 || reds.length >= 2 || p.marks > 0);
  const redLimit = s.pressure.converged ? 2 : 1;
  const usedRed = p.subsRound === s.round ? p.subsCount : 0;
  if (reds.length && usedRed < redLimit && p.rep >= 30 && eager) {
    if (nodeDef.terminal) return { type: 'callMeeting' };
    const step = stepToward(s, p.node, (n) => NODES[n].terminal);
    if (step) return { type: 'move', to: step };
  }

  // 9. 就地搜集
  if (s.nodes[p.node].traces.length && capLeft(p, 'yellow') > 0) return { type: 'search' };
  const ground = pickBestClueHere(s, p);
  if (ground) return { type: 'pickup', clueId: ground.id };

  // 10. 嫁祸（凶手，安静、有黄线索）
  if (p.faction === 'killer' && p.clues.some(c => c.color === 'yellow') && here.length === 1) {
    const t = here[0];
    if (t && chance(s, 0.35)) return { type: 'frame', target: t.id };
  }

  // 11. 交易（同阵营、自己有重复黄）
  const mate = here.find(x => x.faction === p.faction && x.clues.length > 0);
  if (mate) {
    const spare = p.clues.find(c => c.color === 'yellow');
    if (spare && chance(s, 0.3)) return { type: 'trade', target: mate.id, clueId: spare.id };
  }

  // 12. 有通缉 → 找销毁点毁掉指向自己的线索
  const targeted = p.clues.find(c => c.target === p.id);
  if (targeted && p.wanted >= 30) {
    if (nodeDef.destroy) return { type: 'destroy', clueId: targeted.id };
    const step = stepToward(s, p.node, (n) => NODES[n].destroy);
    if (step) return { type: 'move', to: step };
  }

  // 13. 去有线索的节点
  const step = stepToward(s, p.node, (n) => s.nodes[n].clues.length > 0 || s.nodes[n].traces.length > 0);
  if (step && chance(s, 0.85)) return { type: 'move', to: step };

  // 14. 手上黄线索满了又凑不成对 → 丢掉指向不明的
  const ys = p.clues.filter(c => c.color === 'yellow');
  if (ys.length >= 5) {
    const junk = ys.find(c => c.target === 'unknown') ?? ys[0];
    return { type: 'drop', clueId: junk.id };
  }

  // 15. 随便走走（避免原地打转）
  const adj = NODES[p.node].adj;
  if (chance(s, 0.5)) return { type: 'move', to: pick(s, adj) };
  return { type: 'look' };
}

export function botAnswer(s, p, spec) {
  const opts = spec.options ?? [];
  const val = (v) => opts.find(o => o.value === v)?.value;

  if (spec.kind === 'assembly') {
    const wants = p.clues.some(c => c.color === 'red') || p.faction === 'killer';
    return wants ? 'go' : (chance(s, 0.4) ? 'go' : 'stay');
  }

  if (spec.kind === 'submit') {
    const reds = p.clues.filter(c => c.color === 'red');
    if (!reds.length) return 'pass';
    const t = bestTarget(s, p);
    if (!t) return 'pass';
    if (p.faction === 'killer' && t.faction === 'killer') return 'pass';
    const sus = suspicion(s, p, t);
    if (p.faction === 'detective' && sus < 2 && chance(s, 0.75)) return 'pass';
    // 优先用已经指向这个人的线索，否则任意一条
    const fixed = reds.find(c => c.target !== 'unknown' && Number(c.target) === t.id);
    const clue = fixed ?? reds[0];
    return val(clue.id) ?? 'pass';
  }

  if (spec.kind === 'target') {
    const t = bestTarget(s, p);
    if (!t) return opts[0]?.value;
    const hit = opts.find(o => o.value === String(t.id));
    return hit?.value ?? opts[0]?.value;
  }

  if (spec.kind === 'defend') {
    const g = p.clues.find(c => c.color === 'green');
    if (!g) return 'pass';
    const targetId = spec.data?.targetId;
    const target = targetId != null ? s.players[targetId] : null;
    if (target && target.id === p.id) return val(g.id) ?? 'pass';
    if (target && p.faction === 'killer' && target.faction === 'killer') return val(g.id) ?? 'pass';
    if (target && suspicion(s, p, target) <= 1 && chance(s, 0.5)) return val(g.id) ?? 'pass';
    return 'pass';
  }

  if (spec.kind === 'arrest') {
    // 拒捕最多 2 次，第 3 次必出局
    if (p.resisted < 2 && chance(s, 0.5)) return 'resist';
    return 'arrest';
  }
  return opts[0]?.value;
}
