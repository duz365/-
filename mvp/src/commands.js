// 指令解析（CLI 与网页客户端共用）
import { NODES, NODE_NAMES } from './data.js';
import { capLeft, hasWeapon, aliveAt } from './engine.js';

export function findPlayer(s, token) {
  if (token == null) return null;
  const num = Number(token);
  if (Number.isInteger(num) && num >= 1 && num <= s.players.length) {
    const p = s.players[num - 1];
    if (p && p.alive) return p;
  }
  const byName = s.players.find(p => p.alive && p.name === token);
  if (byName) return byName;
  return s.players.find(p => p.alive && p.name.includes(token)) ?? null;
}

export function parseCommand(s, p, line) {
  const parts = (line || '').trim().split(/\s+/);
  const cmd = parts[0] || '';
  const a = parts.slice(1);
  const c = cmd.toLowerCase();
  const me = (x) => findPlayer(s, x);

  if (['看', 'look', 'l'].includes(c)) return { type: 'look' };
  if (['状态', 'status'].includes(c)) return { type: '__status' };
  if (['线索', 'clues', 'clue'].includes(c)) return { type: '__clues' };
  if (['帮助', 'help', '?'].includes(c)) return { type: '__help' };
  if (['过', 'pass', 'p'].includes(c)) return { type: 'pass' };
  if (['搜索', '搜证', 'search'].includes(c)) return { type: 'search' };
  if (['保护', 'protect'].includes(c)) return { type: 'protect' };
  if (['躲藏', '躲', 'hide'].includes(c)) return { type: 'hide' };
  if (['销毁', 'destroy'].includes(c)) return { type: 'destroy', clueId: a[0] };
  if (['自首', 'confess'].includes(c)) return { type: 'confess' };
  if (['反诉', 'lawsuit'].includes(c)) return { type: 'lawsuit' };
  if (['公开会', 'meeting', '开会'].includes(c)) return { type: 'callMeeting' };
  if (['移动', 'go', 'm'].includes(c)) {
    const target = a.join(' ');
    const node = NODE_NAMES.find(n => n === target) ?? NODE_NAMES.find(n => n.includes(target));
    return node ? { type: 'move', to: node } : { type: '__bad', msg: `没有这个区域：${target}。相邻：${NODES[p.node].adj.join('、')}` };
  }
  if (['拾取', 'take', 'pickup'].includes(c)) {
    const idx = Number(a[0]) - 1;
    const node = s.nodes[p.node];
    if (!Number.isInteger(idx) || !node.clues[idx]) return { type: '__bad', msg: `地面没有第 ${a[0]} 条线索。用「看」确认。` };
    return { type: 'pickup', clueId: node.clues[idx].id };
  }
  if (['攻击', 'attack', 'a'].includes(c)) {
    const t = me(a[0]); if (!t) return { type: '__bad', msg: `这里没有「${a[0]}」。` };
    return { type: 'attack', target: t.id };
  }
  if (['处决', 'execute', 'x'].includes(c)) {
    const t = me(a[0]); if (!t) return { type: '__bad', msg: `这里没有「${a[0]}」。` };
    return { type: 'execute', target: t.id };
  }
  if (['救援', 'rescue'].includes(c)) {
    const t = me(a[0]); if (!t) return { type: '__bad', msg: `这里没有「${a[0]}」。` };
    return { type: 'rescue', target: t.id };
  }
  if (['搜身', 'loot'].includes(c)) {
    const t = me(a[0]); if (!t) return { type: '__bad', msg: `这里没有「${a[0]}」。` };
    return { type: 'loot', target: t.id };
  }
  if (['组合', 'combine'].includes(c)) {
    const i1 = Number(a[0]) - 1, i2 = Number(a[1]) - 1;
    if (!p.clues[i1] || !p.clues[i2]) return { type: '__bad', msg: '用「线索」查看编号。' };
    return { type: 'combine', a: p.clues[i1].id, b: p.clues[i2].id };
  }
  if (['交易', 'trade'].includes(c)) {
    const t = me(a[0]);
    const i = Number(a[1]) - 1;
    if (!t) return { type: '__bad', msg: `这里没有「${a[0]}」。` };
    if (!p.clues[i]) return { type: '__bad', msg: '用「线索」查看编号。' };
    return { type: 'trade', target: t.id, clueId: p.clues[i].id };
  }
  if (['嫁祸', 'frame'].includes(c)) {
    const t = me(a[0]); if (!t) return { type: '__bad', msg: `这里没有「${a[0]}」。` };
    return { type: 'frame', target: t.id };
  }
  if (['报警', 'alarm'].includes(c)) {
    const node = NODE_NAMES.find(n => n === a.join(' ')) ?? p.node;
    return { type: 'alarm', node };
  }
  return { type: '__bad', msg: `不认识的指令：${cmd}。输入「帮助」查看。` };
}

// 给网页客户端的"按钮式"行动建议
export function suggestActions(s, p) {
  const out = [];
  const here = aliveAt(s, p.node).filter(x => x.id !== p.id);
  const node = s.nodes[p.node];

  if (node.clues.length) {
    node.clues.forEach((c, i) => {
      if (capLeft(p, c.color) > 0) {
        out.push({ label: `拾取 ${c.color === 'red' ? '红' : c.color === 'yellow' ? '黄' : '绿'}·${c.name}`, action: { type: 'pickup', clueId: c.id } });
      }
    });
  }
  if (node.traces.length && capLeft(p, 'yellow') > 0) out.push({ label: '搜证（3 秒）', action: { type: 'search' } });

  const downed = here.filter(x => x.down);
  for (const t of downed) {
    out.push({ label: `处决 ${t.name}`, action: { type: 'execute', target: t.id } });
    out.push({ label: `搜身 ${t.name}`, action: { type: 'loot', target: t.id } });
    out.push({ label: `救援 ${t.name}`, action: { type: 'rescue', target: t.id } });
  }
  const standing = here.filter(x => !x.down);
  if (standing.length) {
    const w = p.weapon;
    if (!w || p.ammo > 0) {
      for (const t of standing) out.push({ label: `攻击 ${t.name}`, action: { type: 'attack', target: t.id } });
    }
  }
  for (const n of NODES[p.node].adj) out.push({ label: `→ ${n}`, action: { type: 'move', to: n } });

  const pair = findPair(p);
  if (pair) out.push({ label: '组合黄线索升红', action: { type: 'combine', a: pair[0].id, b: pair[1].id } });
  if (p.clues.some(c => c.color === 'green') && !p.protect) out.push({ label: '挂保护', action: { type: 'protect' } });
  if (NODES[p.node].terminal) out.push({ label: '发起公开会', action: { type: 'callMeeting' } });
  if (NODES[p.node].hide && p.wanted > 0) out.push({ label: '躲藏（120 秒）', action: { type: 'hide' } });
  if (NODES[p.node].destroy && p.clues.some(c => c.target === p.id)) out.push({ label: '销毁指向自己的线索', action: { type: 'destroy' } });
  out.push({ label: '观察', action: { type: 'look' } });
  out.push({ label: '什么都不做', action: { type: 'pass' } });
  return out.slice(0, 14);
}

export function findPair(p) {
  const ys = p.clues.filter(c => c.color === 'yellow' && c.target !== 'unknown');
  for (let i = 0; i < ys.length; i++) {
    for (let j = i + 1; j < ys.length; j++) {
      if (ys[i].target === ys[j].target && ys[i].region !== ys[j].region) return [ys[i], ys[j]];
    }
  }
  return null;
}
