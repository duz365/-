// 自包含测试运行器（不依赖 node:test 的子进程，避免沙箱里 spawn 受限）
import assert from 'node:assert/strict';
import { NODES, NODE_NAMES, REGION_TYPES, WEAPONS } from '../src/data.js';
import {
  createGame, makeClue, addMark, capLeft, tierOf,
  runMeeting, eliminate, endGame, advance,
} from '../src/engine.js';
import { playGame } from '../src/sim.js';

let pass = 0;
const fails = [];

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fails.push({ name, e });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

const scriptedCtx = (script) => ({ ask: async (p, spec) => (script(p, spec) ?? 'pass') });

console.log('\n[地图]');
await check('13 个节点，度数 2–3，邻接对称', () => {
  assert.equal(NODE_NAMES.length, 13);
  for (const n of NODE_NAMES) {
    const deg = NODES[n].adj.length;
    assert.ok(deg >= 2 && deg <= 3, `${n} 度数 ${deg}`);
    for (const m of NODES[n].adj) {
      assert.ok(NODES[m], `${n} → 未知节点 ${m}`);
      assert.ok(NODES[m].adj.includes(n), `${n} → ${m} 不对称`);
    }
  }
});

await check('全图连通，直径 7 跳', () => {
  const dist = (from) => {
    const d = { [from]: 0 }; const q = [from];
    while (q.length) {
      const c = q.shift();
      for (const m of NODES[c].adj) if (!(m in d)) { d[m] = d[c] + 1; q.push(m); }
    }
    return d;
  };
  const d = dist(NODE_NAMES[0]);
  assert.equal(Object.keys(d).length, 13);
  let diam = 0;
  for (const n of NODE_NAMES) diam = Math.max(diam, ...Object.values(dist(n)));
  assert.equal(diam, 7);
});

await check('区域权重合计 100%', () => {
  for (const [k, v] of Object.entries(REGION_TYPES)) {
    assert.equal(v.wRed + v.wYellow + v.wGreen, 100, k);
  }
});

await check('武器表 5 把，霰弹初始通缉 +10', () => {
  assert.equal(WEAPONS.length, 5);
  const sg = WEAPONS.find(w => w.id === 'shotgun');
  assert.equal(sg.wanted, 45);
  assert.equal(sg.initWanted, 10);
});

console.log('\n[线索]');
await check('致命度 / 反证强度落在 1–3', () => {
  const s = createGame({ seed: 7, playerCount: 6, withHuman: false });
  for (let i = 0; i < 200; i++) {
    const r = makeClue(s, '危险区甲', 'red');
    assert.ok(r.fatal >= 1 && r.fatal <= 3);
    const g = makeClue(s, '安全区甲', 'green');
    assert.ok(g.proof >= 1 && g.proof <= 3);
  }
});

await check('携带上限：黄 5 / 绿 2 / 红不限', () => {
  const s = createGame({ seed: 8, playerCount: 6, withHuman: false });
  const p = s.players[0];
  for (let i = 0; i < 5; i++) p.clues.push(makeClue(s, '安全区甲', 'yellow'));
  assert.equal(capLeft(p, 'yellow'), 0);
  for (let i = 0; i < 2; i++) p.clues.push(makeClue(s, '安全区甲', 'green'));
  assert.equal(capLeft(p, 'green'), 0);
  assert.equal(capLeft(p, 'red'), Infinity);
});

console.log('\n[红标与通缉]');
await check('3 个红标立即淘汰，公告含阵营与线索来源', () => {
  const s = createGame({ seed: 9, playerCount: 6, withHuman: false });
  const p = s.players[1];
  p.clues.push(makeClue(s, '危险区甲', 'red', { target: p.id }));
  addMark(s, p, 1); addMark(s, p, 1);
  assert.ok(p.alive);
  addMark(s, p, 1);
  assert.equal(p.alive, false);
  const notice = s.events.filter(e => e.kind === 'elim').at(-1);
  assert.match(notice.text, /阵营：/);
  assert.match(notice.text, /最近线索：/);
  assert.match(notice.text, /红标淘汰/);
});

await check('通缉档位映射 0/50/80/100', () => {
  assert.equal(tierOf(0), 0);
  assert.equal(tierOf(49), 0);
  assert.equal(tierOf(50), 1);
  assert.equal(tierOf(79), 1);
  assert.equal(tierOf(80), 2);
  assert.equal(tierOf(100), 3);
});

console.log('\n[公开会与抗辩]');
await check('无人抗辩：红标 +1', async () => {
  const s = createGame({ seed: 11, playerCount: 6, withHuman: false });
  const [a, b] = s.players;
  a.node = '公共终端甲'; b.node = '公共终端甲';
  a.clues.push(makeClue(s, '危险区甲', 'red', { fatal: 2 }));
  const ctx = scriptedCtx((p, spec) => {
    if (spec.kind === 'assembly') return 'stay';
    if (spec.kind === 'submit' && p.id === a.id) return a.clues.find(c => c.color === 'red').id;
    if (spec.kind === 'target') return String(b.id);
    if (spec.kind === 'arrest') return 'arrest';
    return 'pass';
  });
  await runMeeting(s, a, ctx);
  assert.equal(b.marks, 1);
});

await check('抗辩成功：反证强度 2 ≥ 致命度 2，红标不记入且公开者 -20', async () => {
  const s = createGame({ seed: 12, playerCount: 6, withHuman: false });
  const [a, b] = s.players;
  a.node = '公共终端甲'; b.node = '公共终端甲';
  b.clues.push(makeClue(s, '安全区甲', 'green', { proof: 2 }));
  a.clues.push(makeClue(s, '危险区甲', 'red', { fatal: 2 }));
  const ctx = scriptedCtx((p, spec) => {
    if (spec.kind === 'assembly') return 'stay';
    if (spec.kind === 'submit' && p.id === a.id) return a.clues.find(c => c.color === 'red').id;
    if (spec.kind === 'target') return String(b.id);
    if (spec.kind === 'defend' && p.id === b.id) return p.clues.find(c => c.color === 'green').id;
    if (spec.kind === 'arrest') return 'arrest';
    return 'pass';
  });
  await runMeeting(s, a, ctx);
  assert.equal(b.marks, 0);
  assert.equal(a.rep, 80);
});

await check('保护：抵消红标并耗尽保护槽', async () => {
  const s = createGame({ seed: 13, playerCount: 6, withHuman: false });
  const [a, b] = s.players;
  a.node = '公共终端甲'; b.node = '公共终端甲';
  b.protect = { proof: 3 };
  a.clues.push(makeClue(s, '危险区甲', 'red', { fatal: 1 }));
  const ctx = scriptedCtx((p, spec) => {
    if (spec.kind === 'assembly') return 'stay';
    if (spec.kind === 'submit' && p.id === a.id) return a.clues.find(c => c.color === 'red').id;
    if (spec.kind === 'target') return String(b.id);
    if (spec.kind === 'arrest') return 'arrest';
    return 'pass';
  });
  await runMeeting(s, a, ctx);
  assert.equal(b.marks, 0);
  assert.equal(b.protect, null);
});

await check('致命度 3 穿透保护', async () => {
  const s = createGame({ seed: 14, playerCount: 6, withHuman: false });
  const [a, b] = s.players;
  a.node = '公共终端甲'; b.node = '公共终端甲';
  b.protect = { proof: 3 };
  a.clues.push(makeClue(s, '危险区甲', 'red', { fatal: 3 }));
  const ctx = scriptedCtx((p, spec) => {
    if (spec.kind === 'assembly') return 'stay';
    if (spec.kind === 'submit' && p.id === a.id) return a.clues.find(c => c.color === 'red').id;
    if (spec.kind === 'target') return String(b.id);
    if (spec.kind === 'arrest') return 'arrest';
    return 'pass';
  });
  await runMeeting(s, a, ctx);
  assert.equal(b.marks, 1);
});

console.log('\n[终局与目标]');
await check('凶手全灭 → 侦探胜利，记分板完整', () => {
  const s = createGame({ seed: 15, playerCount: 6, withHuman: false, killerCount: 1 });
  const k = s.players.find(p => p.faction === 'killer');
  eliminate(s, k, '测试', null);
  assert.equal(s.over, true);
  assert.equal(s.result.who, 'detective');
  assert.equal(s.scoreboard.length, 6);
});

await check('完美犯罪：存活且 0 红标才算达成', () => {
  const s = createGame({ seed: 16, playerCount: 8, withHuman: false, killerCount: 2 });
  const k = s.players.find(p => p.faction === 'killer' && p.goal.id === 'perfect');
  if (!k) return;
  k.marks = 0;
  endGame(s, 'killer');
  assert.equal(k.goalDone, true);
});

await check('倒地 30 秒无人救援 → 失血淘汰', () => {
  const s = createGame({ seed: 17, playerCount: 6, withHuman: false, killerCount: 1 });
  const p = s.players[1];
  p.down = { until: s.tick + 30, by: null };
  advance(s, 35);
  assert.equal(p.alive, false);
});

console.log('\n[整局回归]');
await check('6 局全机器人对局都能在 90 分钟内结束', async () => {
  for (let i = 0; i < 6; i++) {
    const { s } = await playGame({ seed: 500 + i, playerCount: 8, killerCount: 2 });
    assert.equal(s.over, true, `seed ${500 + i} 未结束`);
    assert.ok(s.result.tick <= 5400, `seed ${500 + i} 超时 ${s.result.tick}`);
    assert.ok(['detective', 'killer', 'draw'].includes(s.result.who));
  }
});

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  for (const f of fails) console.error(`\n${f.name}\n${f.e.stack}`);
  process.exit(1);
}
