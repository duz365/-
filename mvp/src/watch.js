// 观战模式：全机器人对局，按时间线打印公开事件（用来快速看懂一局怎么走）
import { createGame, applyAction, pickActor, runMeeting, endGame } from './engine.js';
import { botAct, botAnswer } from './ai.js';
import { endReport } from './view.js';

const players = Number(process.argv[2]) || 8;
const seed = Number(process.argv[3]) || undefined;

const s = createGame({ playerCount: players, withHuman: false, seed });
const ctx = { ask: async (p, spec) => botAnswer(s, p, spec) };

const SHOW = new Set(['public', 'meet', 'elim', 'end']);
const fmt = (t) => `${String(Math.floor(t / 60)).padStart(2)}:${String(t % 60).padStart(2)}`;

console.log('='.repeat(64));
console.log(`观战 · ${players} 人局 · 种子 ${s.seed}`);
console.log('身份：' + s.players.map(p => `${p.name}=${p.faction === 'killer' ? '凶手' : '侦探'}`).join('  '));
console.log('='.repeat(64));

let shown = 0, acts = 0;
while (!s.over && acts < 20000) {
  const before = s.events.length;
  if (s.needMeeting) {
    s.needMeeting = false;
    await runMeeting(s, { id: null, name: '系统', node: '公共终端甲' }, ctx);
  } else {
    const p = pickActor(s);
    if (!p) break;
    const res = await applyAction(s, p, botAct(s, p), ctx);
    if (!res?.ok) { /* 失败动作不推进，避免刷屏 */ }
    acts += 1;
  }
  for (let i = before; i < s.events.length; i++) {
    const e = s.events[i];
    const isGlobal = e.scope === 'global';
    if (!isGlobal && !['elim', 'end'].includes(e.kind)) continue;
    if (e.kind === 'sys' && e.text.startsWith('===')) console.log(`\n[${fmt(e.tick)}] ${e.text}`);
    else console.log(`[${fmt(e.tick)}] ${e.text.split('\n')[0]}`);
    if (++shown > 400) { console.log('...（输出截断）'); break; }
  }
  if (s.tick > 5400 && !s.over) endGame(s, 'draw');
}
console.log(endReport(s));
