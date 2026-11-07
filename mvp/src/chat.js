// 文字聊天频道（规则 1.1 / 11.1 / 11.6）
import { emit } from './engine.js';

export const CHANNELS = [
  { key: 'area',    name: '区域',   hint: '同一区域节点内的玩家可见' },
  { key: 'public',  name: '公开会', hint: '全场可见，仅公开阶段开放' },
  { key: 'faction', name: '阵营',   hint: '仅凶手阵营可见' },
  { key: 'ghost',   name: '幽灵',   hint: '仅已被淘汰的玩家可见' },
];

export const MAX_LEN = 60;      // 单条 ≤ 60 字（11.6）
const COOLDOWN_MS = 2000;       // 每条 2 秒冷却
const FOLD_WINDOW_MS = 10000;   // 10 秒内
const FOLD_LIMIT = 5;           // 超过 5 条折叠

export function channelsFor(s, p) {
  if (!p.alive) return ['ghost'];
  const out = ['area'];
  if (s.phase === 'public') out.push('public');
  if (p.faction === 'killer') out.push('faction');
  return out;
}

export function say(s, p, channel, rawText) {
  const text = String(rawText ?? '').trim();
  if (!text) return { ok: false, msg: '空消息。' };
  if ([...text].length > MAX_LEN) return { ok: false, msg: `太长了（上限 ${MAX_LEN} 字）。` };
  if (!channelsFor(s, p).includes(channel)) {
    return { ok: false, msg: channel === 'ghost' ? '只有被淘汰的人能在幽灵频道发言。' : channel === 'faction' ? '你没有这个频道。' : channel === 'public' ? '公开会频道只在公开阶段开放。' : '没有这个频道。' };
  }

  const now = Date.now();
  p.chatLog = (p.chatLog ?? []).filter(t => now - t < FOLD_WINDOW_MS);
  if (now - (p.lastChatAt ?? 0) < COOLDOWN_MS) return { ok: false, msg: '说太快了，缓 2 秒。' };
  if (p.chatLog.length >= FOLD_LIMIT) return { ok: false, msg: '你刚才说太多了（10 秒内 5 条），系统暂时折叠你的发言。' };
  p.lastChatAt = now;
  p.chatLog.push(now);

  const label = CHANNELS.find(c => c.key === channel)?.name ?? channel;
  const line = `[${label}] ${p.name}：${text}`;

  if (channel === 'area') {
    emit(s, { kind: 'chat', scope: 'node', node: p.node, text: line });
  } else if (channel === 'public') {
    emit(s, { kind: 'chat', scope: 'global', text: line });
  } else if (channel === 'faction') {
    const killers = s.players.filter(x => x.faction === 'killer').map(x => x.id);
    emit(s, { kind: 'chat', scope: 'private', to: killers, text: line });
  } else if (channel === 'ghost') {
    const dead = s.players.filter(x => !x.alive).map(x => x.id);
    emit(s, { kind: 'chat', scope: 'private', to: dead, text: line });
  }
  return { ok: true };
}
