// 平衡观察：多种人数/凶手数组合下的胜负与节奏
import { playGame } from '../src/sim.js';

const combos = [
  [6, 1], [6, 2], [7, 1], [7, 2], [8, 2], [9, 2], [10, 2],
];
const GAMES = Number(process.argv[2]) || 10;

console.log('人数 凶手  胜场（侦探/凶手/平）  平均轮  平均分钟  平均淘汰  平均公开会');
for (const [pc, kc] of combos) {
  const wins = { detective: 0, killer: 0, draw: 0 };
  let round = 0, min = 0, elim = 0, meet = 0;
  for (let i = 1; i <= GAMES; i++) {
    const { s } = await playGame({ seed: 3000 + i * 7 + pc, playerCount: pc, killerCount: kc });
    wins[s.result.who] += 1;
    round += s.result.round; min += s.result.tick / 60; elim += s.stats.eliminations; meet += s.stats.meetings;
  }
  const f = (x) => (x / GAMES).toFixed(1);
  console.log(
    `${String(pc).padStart(3)}  ${kc}   ${String(wins.detective).padStart(2)} / ${String(wins.killer).padStart(2)} / ${String(wins.draw).padStart(2)}`
    + `            ${f(round).padStart(5)}   ${f(min).padStart(5)}      ${f(elim).padStart(5)}      ${f(meet).padStart(5)}`,
  );
}
