// 视角渲染：每个玩家只看到自己的事件流
import { NODES, NODE_NAMES, WEAPON_BY_ID, T } from './data.js';
import { drain } from './engine.js';

export function statusLine(s, p) {
  const w = p.weapon ? WEAPON_BY_ID[p.weapon] : null;
  const hp = p.down ? '倒地' : `${p.hp}/${p.hpMax}`;
  let state = '正常';
  if (p.down) state = `倒地 T-${Math.max(0, p.down.until - s.tick)}s`;
  else if (p.custodyUntil > s.tick) state = `被捕 T-${Math.ceil(p.custodyUntil - s.tick)}s`;
  else if (p.hideUntil > s.tick) state = `躲藏 T-${Math.ceil(p.hideUntil - s.tick)}s`;
  const count = p.clues.reduce((m, c) => { m[c.color] = (m[c.color] || 0) + 1; return m; }, {});
  return [
    `体力 ${hp} · 位置：${p.node} · ${state}`,
    `红标 ${p.marks}/3 · 通缉 ${p.wanted} · 信誉 ${p.rep} · 线索 红${count.red || 0} 黄${count.yellow || 0} 绿${count.green || 0}`,
    w ? `武器 ${w.name} ${p.ammo}/${w.ammo}` : '武器 无（赤手 1 点伤害）',
  ];
}

export function renderIncoming(s, p, limit = 80) {
  const evs = drain(s, p, limit);
  return evs.map(e => e.text).filter(Boolean).join('\n');
}

export function clueList(s, p) {
  if (!p.clues.length) return '你身上没有任何线索。';
  return p.clues.map((c, i) => `${i + 1}. ` + T.clueCard(c, s.players[c.target]?.name)).join('\n');
}

export function lookAround(s, p) {
  const here = s.players.filter(x => x.alive && x.node === p.node && x.id !== p.id);
  const node = s.nodes[p.node];
  const lines = [`【${p.node}】${node.type}区域`];
  lines.push(`在场：${here.length ? here.map(x => x.name + (x.down ? '（倒地）' : '')).join('、') : '只有你'}`);
  lines.push(`相邻：${NODES[p.node].adj.map(n => `${n}（3s）`).join('、')}`);
  if (node.clues.length) lines.push(`地面线索：${node.clues.length} 条 —— ${node.clues.map(c => `${c.color}·${c.name}`).join('、')}`);
  if (node.traces.length) lines.push(`可搜证的痕迹：${node.traces.map(t => t.type).join('、')}`);
  const fac = [];
  if (NODES[p.node].terminal) fac.push('公共终端');
  if (NODES[p.node].destroy) fac.push('销毁点');
  if (NODES[p.node].informant) fac.push('线人');
  if (NODES[p.node].hide) fac.push('藏匿点');
  if (fac.length) lines.push(`设施：${fac.join('、')}`);
  return lines.join('\n');
}

export function endReport(s) {
  const lines = [];
  lines.push('');
  lines.push('='.repeat(56));
  const who = s.result.who === 'detective' ? '侦探阵营胜利' : s.result.who === 'killer' ? '凶手阵营胜利' : '平局（悬案）';
  lines.push(`案件终结 · 第 ${s.result.round} 轮 · 虚拟时间 ${Math.floor(s.result.tick / 60)} 分钟`);
  lines.push(who);
  lines.push('-'.repeat(56));
  for (const p of s.players) {
    const fac = p.faction === 'killer' ? '凶手' : '侦探';
    lines.push(`${p.name.padEnd(4, '　')} ${fac} · 目标「${p.goal?.name}」${p.goalDone ? '达成' : '未达成'} · 红标 ${p.marks} · 淘汰${p.alive ? '否' : '是'}`);
  }
  lines.push('-'.repeat(56));
  for (const row of s.scoreboard) {
    const s2 = row.score;
    lines.push(`${String(row.score.total).padStart(3)} 分  ${row.name.padEnd(4, '　')}  ${T.scoreLine(s2)}${s2.achNames.length ? '  [' + s2.achNames.join('、') + ']' : ''}`);
  }
  lines.push('='.repeat(56));
  return lines.join('\n');
}

export function helpText() {
  return [
    '指令（中英文皆可）：',
    '  看 / look               观察当前区域',
    '  状态 / status           状态行',
    '  线索 / clues            列出携带线索',
    '  移动 <区域> / go <区域>  去相邻区域',
    '  搜证 / search           搜证（3 秒，出黄线索）',
    '  拾取 <编号> / take <n>  拾取地面线索',
    '  攻击 <人> / attack <人>      攻击同区域的人',
    '  处决 <人> / execute <人>     处决倒地的人',
    '  救援 <人> / rescue <人>      扶起倒地的人',
    '  搜身 <人> / loot <人>        从倒地者身上夺 1 条线索',
    '  组合 <编号> <编号> / combine  两条异区域同目标黄线索升红',
    '  保护 / protect          挂绿保护（抵消下一次红标）',
    '  躲藏 / hide             120 秒，结束后通缉 -20',
    '  销毁 / destroy          在销毁点烧掉指向自己的线索',
    '  交易 <人> <编号> / trade',
    '  嫁祸 <人> / frame       凶手专属：布置伪证',
    '  报警 [区域] / alarm      叫警察过来',
    '  自首 / confess          通缉降到 49（每局一次）',
    '  反诉 / lawsuit          推翻被识破的伪造线索',
    '  公开会 / meeting        在公共终端发起公开会',
    '  过 / pass               什么都不做（推进 5 秒）',
    '  帮助 / help  ·  退出 / quit',
  ].join('\n');
}
