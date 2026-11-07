// 找出一个平局局，打印后半段事件
import { playGame } from '../src/sim.js';

for (let seed = 3100; seed < 3140; seed++) {
  const { s } = await playGame({ seed, playerCount: 8, killerCount: 2 });
  if (s.result.who !== 'draw') continue;
  console.log('draw seed', seed, 'round', s.result.round, 'tick', s.result.tick);
  const tail = s.events.slice(-40);
  for (const e of tail) console.log(`[${Math.floor(e.tick / 60)}m] ${e.kind} ${e.text.split('\n')[0]}`);
  console.log('存活：', s.players.map(p => `${p.name}(${p.faction})${p.alive ? '' : '✝'}=${p.marks}标/${p.clues.length}线索`).join(' '));
  break;
}
