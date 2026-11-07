// 全机器人对局：用于回归测试与平衡观察
import { createGame, applyAction, pickActor, runMeeting, endGame, advance } from './engine.js';
import { botAct, botAnswer } from './ai.js';

export async function playGame(opts = {}) {
  const s = createGame({ ...opts, withHuman: false });
  const ctx = { ask: async (p, spec) => botAnswer(s, p, spec) };
  let acts = 0;
  while (!s.over && acts < 20000) {
    if (s.needMeeting) {
      s.needMeeting = false;
      await runMeeting(s, { id: null, name: '系统', node: '公共终端甲' }, ctx);
      continue;
    }
    const p = pickActor(s);
    if (!p) break;
    await applyAction(s, p, botAct(s, p), ctx);
    acts += 1;
    if (s.tick > 5400 && !s.over) endGame(s, 'draw');
  }
  if (!s.over) endGame(s, 'draw');
  return { s, acts };
}

const isMain = !!process.argv[1] && /sim\.js$/.test(process.argv[1]);
if (isMain) {
  const n = Number(process.argv[2]) || 20;
  const players = Number(process.argv[3]) || 6;
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const { s, acts } = await playGame({ seed: 1000 + i, playerCount: players });
    rows.push({
      seed: 1000 + i, who: s.result.who, round: s.result.round,
      minutes: Math.round(s.result.tick / 60), acts,
      elim: s.stats.eliminations, arrests: s.stats.arrests, meetings: s.stats.meetings,
      marks: s.players.reduce((a, p) => a + p.marks, 0),
      subs: s.stats.subs ?? 0, defWin: s.stats.defWin ?? 0, protect: s.stats.protects ?? 0,
    });
  }
  const avg = (k) => (rows.reduce((a, r) => a + r[k], 0) / rows.length).toFixed(1);
  console.log('seed  who        轮  分钟  行动  淘汰  逮捕  公开会  红标');
  for (const r of rows) {
    console.log(
      `${String(r.seed).padEnd(5)} ${r.who.padEnd(9)} ${String(r.round).padStart(3)} ${String(r.minutes).padStart(5)} ${String(r.acts).padStart(5)} ${String(r.elim).padStart(5)} ${String(r.arrests).padStart(5)} ${String(r.meetings).padStart(6)} ${String(r.marks).padStart(5)}`,
    );
  }
  const wins = rows.reduce((m, r) => { m[r.who] = (m[r.who] || 0) + 1; return m; }, {});
  console.log('-'.repeat(60));
  console.log(`平均轮数 ${avg('round')} · 平均时长 ${avg('minutes')} 分钟 · 平均行动 ${avg('acts')} · 平均淘汰 ${avg('elim')} · 平均公开会 ${avg('meetings')}`);
  console.log('胜负分布：', wins);
  console.log(`平均提交 ${avg('subs')} · 抗辩成功 ${avg('defWin')} · 保护生效 ${avg('protect')} · 平均红标 ${avg('marks')}`);
}
