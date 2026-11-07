// 单机客户端：1 个真人 + 机器人
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createGame, applyAction, pickActor, runMeeting, endGame, advance } from './engine.js';
import { WEAPON_BY_ID } from './data.js';
import { botAct, botAnswer } from './ai.js';
import { parseCommand } from './commands.js';
import { statusLine, renderIncoming, clueList, endReport, helpText } from './view.js';

const rl = createInterface({ input: stdin, output: stdout });
const say = (t = '') => stdout.write(t + '\n');

let current = null;
const ctx = {
  async ask(p, spec) {
    if (p.bot) return botAnswer(current, p, spec);
    return askHuman(current, p, spec);
  },
};

async function askHuman(s, p, spec) {
  say('');
  say(`>>> ${spec.prompt}`);
  spec.options.forEach((o, i) => say(`  ${i + 1}. ${o.label}`));
  for (;;) {
    const ans = (await rl.question('你的选择> ')).trim();
    if (ans === '') return spec.options[spec.options.length - 1].value;
    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= spec.options.length) return spec.options[n - 1].value;
    const hit = spec.options.find(o => o.label.includes(ans));
    if (hit) return hit.value;
    say('输入编号。');
  }
}

async function humanTurn(s, p) {
  for (;;) {
    if (!p.alive) return { type: 'pass' };
    say('');
    say('—'.repeat(52));
    say(statusLine(s, p).join('\n'));
    const inc = renderIncoming(s, p);
    if (inc) say(inc);
    const line = (await rl.question('\n指令> ')).trim();
    if (!line) { say(helpText()); continue; }
    const low = line.toLowerCase();
    if (['退出', 'quit', 'exit'].includes(low)) return { type: '__quit' };

    const a = parseCommand(s, p, line);
    if (a.type === '__bad') { say(a.msg); continue; }
    if (a.type === '__help') { say(helpText()); continue; }
    if (a.type === '__status') { say(statusLine(s, p).join('\n')); continue; }
    if (a.type === '__clues') { say(clueList(s, p)); continue; }
    return a;
  }
}

function intro(s, me) {
  const w = me.weapon ? WEAPON_BY_ID[me.weapon] : null;
  say('');
  say('='.repeat(56));
  say('《红黄绿》');
  say('='.repeat(56));
  say(`你是「${me.name}」，阵营：${me.faction === 'killer' ? '凶手' : '侦探'}。`);
  if (w) say(`你的武器：${w.name}（${w.note}），可用 ${me.ammo} 次。`);
  say(`你的个人目标：${me.goal.name} —— ${me.goal.desc}`);
  if (me.goalTarget != null) say(`目标对象：${s.players[me.goalTarget]?.name}`);
  if (me.faction === 'killer') {
    const mates = s.players.filter(p => p.faction === 'killer' && p.id !== me.id);
    if (mates.length) say(`你的同伙：${mates.map(m => m.name).join('、')}`);
  }
  say(`起始位置：${me.node}`);
  say('输入「帮助」查看指令。目标：一方阵营全部淘汰。');
  say('（想和朋友一起玩：npm run net，然后浏览器打开 http://127.0.0.1:8787）');
  say('='.repeat(56));
}

async function main() {
  const playerCount = Number(process.argv[2]) || 8;
  current = createGame({ playerCount, withHuman: true, humanName: '你', seed: Number(process.argv[3]) || undefined });
  const s = current;
  const me = s.players[0];
  intro(s, me);

  let guard = 0;
  while (!s.over && guard++ < 4000) {
    if (s.needMeeting) {
      s.needMeeting = false;
      await runMeeting(s, { id: null, name: '系统', node: '公共终端甲' }, ctx);
      const inc = renderIncoming(s, me);
      if (inc) say(inc);
      continue;
    }
    const p = pickActor(s);
    if (!p) break;
    const action = p.bot ? botAct(s, p) : await humanTurn(s, p);
    if (action.type === '__quit') break;
    const res = await applyAction(s, p, action, ctx);
    if (!res?.ok) advance(s, 3);
    if (p.id !== 0) {
      const inc = renderIncoming(s, me);
      if (inc) say(inc);
    }
    if (s.tick > 5400 && !s.over) { say('>>> 时间耗尽，系统判定为悬案。'); endGame(s, 'draw'); }
  }

  say(endReport(s));
  rl.close();
}

main().catch(err => { console.error(err); process.exit(1); });
