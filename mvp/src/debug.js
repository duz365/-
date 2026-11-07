// 调试：打一局，把所有事件打印出来
import { createGame, applyAction, pickActor, runMeeting, endGame } from './engine.js';
import { botAct, botAnswer } from './ai.js';

const seed = Number(process.argv[2]) || 1001;
const players = Number(process.argv[3]) || 6;
const s = createGame({ seed, playerCount: players, withHuman: false });
const ctx = { ask: async (p, spec) => botAnswer(s, p, spec) };

console.log('玩家：', s.players.map(p => `${p.name}(${p.faction}${p.weapon ? ',' + p.weapon : ''})`).join(' '));
let acts = 0, printed = 0;
while (!s.over && acts < 3000) {
  const before = s.events.length;
  if (s.needMeeting) { s.needMeeting = false; await runMeeting(s, { id: null, name: '系统', node: '公共终端甲' }, ctx); }
  else {
    const p = pickActor(s);
    if (!p) break;
    const a = botAct(s, p);
    const res = await applyAction(s, p, a, ctx);
    if (!res?.ok) { /* 失败不推进 */ }
    acts++;
  }
  for (let i = Math.max(before, 0); i < s.events.length; i++) {
    const e = s.events[i];
    if (!['public','meet','elim','police','sys','end','fail','alarm','warn'].includes(e.kind)) continue;
    console.log(`[${String(Math.floor(s.tick / 60)).padStart(2)}m ${String(s.tick % 60).padStart(2)}s r${s.round}] ${e.text.split('\n')[0]}`);
    printed++;
  }
  if (printed > 400) { console.log('...'); break; }
}
console.log('---', s.result ?? 'no result', 'acts', acts);
console.log('players:', s.players.map(p => `${p.name} marks=${p.marks} alive=${p.alive} wanted=${p.wanted} rep=${p.rep} clues=${p.clues.length}`).join(' | '));
