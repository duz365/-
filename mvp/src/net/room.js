// 房间：把引擎的异步交互接成"等待真人输入"的循环
import { createGame, applyAction, pickActor, runMeeting, endGame, drain, aliveOf, playerById } from '../engine.js';
import { botAct, botAnswer } from '../ai.js';
import { findPlayer, parseCommand, suggestActions } from '../commands.js';
import { say, channelsFor } from '../chat.js';
import { NODES, NODE_NAMES } from '../data.js';
import { statusLine, clueList, lookAround } from '../view.js';

let roomSeq = 0;

export function createRoom({ playerCount = 8, killerCount, hostName = '房主' } = {}) {
  const room = {
    id: `R${(++roomSeq).toString().padStart(3, '0')}`,
    playerCount,
    killerCount,
    hostName,
    seats: [],            // {playerId, name, socket}
    started: false,
    over: false,
    game: null,
    pending: new Map(),   // promptId -> {resolve, timer, playerId}
    promptSeq: 0,
    log: [],              // 给新加入者回放
    sse: new Map(),       // playerId -> Set<res>
    loopPromise: null,
    chatChannels: [],
  };
  return room;
}

// ------------------------------------------------------------------ SSE
export function addStream(room, playerId, res) {
  if (!room.sse.has(playerId)) room.sse.set(playerId, new Set());
  room.sse.get(playerId).add(res);
}

export function removeStream(room, playerId, res) {
  room.sse.get(playerId)?.delete(res);
}

function sendTo(room, playerId, payload) {
  const set = room.sse.get(playerId);
  if (!set) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try { res.write(data); } catch { /* 断开由 close 处理 */ }
  }
}

function broadcast(room, payload, only = null) {
  const ids = only ?? room.seats.map(s => s.playerId);
  for (const id of ids) sendTo(room, id, payload);
}

// ------------------------------------------------------------------ 加入 / 开局
export function join(room, name) {
  if (room.started) return { ok: false, msg: '这局已经开始了。' };
  if (room.seats.length >= room.playerCount) return { ok: false, msg: `房间满了（${room.playerCount} 人）。` };
  const seatIndex = room.seats.length;
  const playerId = seatIndex; // 与引擎座位一一对应
  const seat = { playerId, name: String(name || `玩家${seatIndex + 1}`).slice(0, 6), socket: true };
  room.seats.push(seat);
  return { ok: true, playerId, roomId: room.id };
}

export function status(room) {
  return {
    roomId: room.id,
    started: room.started,
    over: room.over,
    seats: room.seats.map(s => ({ playerId: s.playerId, name: s.name })),
    capacity: room.playerCount,
    host: room.hostName,
    phase: room.game?.phase ?? 'lobby',
    tick: room.game?.tick ?? 0,
    round: room.game?.round ?? 0,
  };
}

// 开局：座位不够时用机器人补到 6 人（可配置）
export function start(room, { fillBots = true, minPlayers = 6 } = {}) {
  if (room.started) return { ok: false, msg: '已经开始了。' };
  if (!fillBots && room.seats.length < minPlayers) return { ok: false, msg: `至少要 ${minPlayers} 名玩家。` };
  if (fillBots && room.seats.length < minPlayers) {
    // 补机器人：先占座位，保证引擎里真人 playerId 与 seat 一致
    const need = minPlayers - room.seats.length;
    for (let i = 0; i < need; i++) {
      room.seats.push({ playerId: room.seats.length, name: null, socket: false, bot: true });
    }
  }
  const humanCount = room.seats.filter(s => s.socket).length;
  const game = createGame({
    playerCount: room.playerCount,
    killerCount: room.killerCount,
    withHuman: false,
    seed: (Date.now() & 0x7fffffff),
  });
  // 把人名与真人标记写回引擎
  room.seats.forEach((seat, i) => {
    const p = game.players[i];
    if (!p) return;
    p.bot = !seat.socket;
    if (seat.name) p.name = seat.name;
  });
  room.game = game;
  room.started = true;
  room.over = false;

  // 每人推送开局私有信息
  for (const seat of room.seats) {
    if (!seat.socket) continue;
    const p = game.players[seat.playerId];
    sendTo(room, seat.playerId, { type: 'hello', you: seat.playerId, self: privateInfo(game, p), status: status(room) });
  }
  room.loopPromise = runLoop(room).catch(err => {
    console.error('[room] loop error', err);
    room.over = true;
    broadcast(room, { type: 'error', msg: String(err?.message ?? err) });
  });
  return { ok: true };
}

function privateInfo(s, p) {
  return {
    id: p.id,
    name: p.name,
    faction: p.faction,
    goal: p.goal ? { name: p.goal.name, desc: p.goal.desc, target: p.goalTarget != null ? s.players[p.goalTarget]?.name : null } : null,
    weapon: p.weapon,
    ammo: p.ammo,
    node: p.node,
    marks: p.marks,
    rep: p.rep,
    wanted: p.wanted,
    clues: p.clues.map(c => ({ color: c.color, name: c.name, fatal: c.fatal, proof: c.proof, region: c.region, target: s.players[c.target]?.name ?? '不明' })),
    mates: p.faction === 'killer' ? s.players.filter(x => x.faction === 'killer' && x.id !== p.id).map(x => x.name) : [],
  };
}

// ------------------------------------------------------------------ 提示（等待真人）
function pendingPrompt(room, playerId, payload, timeoutMs, fallback) {
  return new Promise(resolve => {
    const id = `p${++room.promptSeq}`;
    const timer = setTimeout(() => {
      room.pending.delete(id);
      sendTo(room, playerId, { type: 'promptTimeout', id });
      resolve(fallback);
    }, timeoutMs);
    room.pending.set(id, { resolve, timer, playerId });
    sendTo(room, playerId, { type: 'prompt', id, ...payload });
  });
}

export function answer(room, playerId, promptId, value) {
  const entry = room.pending.get(promptId);
  if (!entry || entry.playerId !== playerId) return { ok: false, msg: '没有这个待回应提示。' };
  clearTimeout(entry.timer);
  room.pending.delete(promptId);
  entry.resolve(value);
  return { ok: true };
}

// 引擎的 ctx.ask：会议中的各种选择
function makeCtx(room) {
  return {
    ask: async (p, spec) => {
      if (p.bot) return botAnswer(room.game, p, spec);
      const value = await pendingPrompt(room, p.id, {
        kind: spec.kind,
        prompt: spec.prompt,
        options: spec.options ?? [],
      }, 25000, spec.options?.[spec.options.length - 1]?.value ?? 'pass');
      return value;
    },
  };
}

// ------------------------------------------------------------------ 主循环
async function runLoop(room) {
  const s = room.game;
  const ctx = makeCtx(room);

  while (!s.over && !room.over) {
    // 每次推进后把这个玩家该看的事件推给他
    flushEvents(room);

    if (s.needMeeting) {
      s.needMeeting = false;
      await runMeeting(s, { id: null, name: '系统', node: '公共终端甲' }, ctx);
      flushEvents(room);
      continue;
    }

    const p = pickActor(s);
    if (!p) break;

    if (p.bot) {
      const action = botAct(s, p);
      const res = await applyAction(s, p, action, ctx);
      if (!res?.ok) continue;
    } else {
      const action = await askTurn(room, p);
      const res = await applyAction(s, p, action, ctx);
      if (!res?.ok) {
        // 失败不消耗回合：把失败原因推给他，并再问一次（避免卡死）
        flushEvents(room);
        const retry = await askTurn(room, p);
        await applyAction(s, p, retry, ctx);
      }
    }

    if (s.tick > 5400 && !s.over) endGame(s, 'draw');
  }

  flushEvents(room);
  room.over = true;
  broadcast(room, { type: 'end', result: s.result, scoreboard: s.scoreboard ?? [], players: s.players.map(p => ({ name: p.name, faction: p.faction, marks: p.marks, alive: p.alive, goalDone: p.goalDone })) });
  for (const [, entry] of room.pending) { clearTimeout(entry.timer); entry.resolve('pass'); }
  room.pending.clear();
}

async function askTurn(room, p) {
  const s = room.game;
  const actions = suggestActions(s, p);
  const choice = await pendingPrompt(room, p.id, {
    kind: 'turn',
    prompt: `轮到你了（${p.node}）。选一个动作，或在下方直接输入指令。`,
    actions,
    status: {
      lines: statusLine(s, p),
      where: lookAround(s, p),
      clues: clueList(s, p),
      channels: channelsFor(s, p),
      phase: s.phase,
      round: s.round,
      tick: s.tick,
    },
  }, 60000, { type: 'pass' });

  if (choice && choice.type) return choice;
  if (choice && typeof choice === 'string') {
    const parsed = parseCommand(s, p, choice);
    if (parsed.type === '__bad') {
      sendTo(room, p.id, { type: 'notice', text: parsed.msg });
      return { type: 'pass' };
    }
    return parsed;
  }
  return { type: 'pass' };
}

// 把未读事件按玩家切片推送
export function flushEvents(room) {
  const s = room.game;
  for (const seat of room.seats) {
    if (!seat.socket) continue;
    if (!room.sse.get(seat.playerId)?.size) continue; // 没连着就别把事件标记成已读
    const p = s.players[seat.playerId];
    const evs = drain(s, p, 100);
    if (!evs.length) continue;
    sendTo(room, seat.playerId, {
      type: 'events',
      items: evs.map(e => ({ tick: e.tick, kind: e.kind, text: e.text })),
    });
  }
}

// 关房：终止循环、清理所有等待中的提示
export function stop(room) {
  room.over = true;
  for (const [, entry] of room.pending) { clearTimeout(entry.timer); entry.resolve('pass'); }
  room.pending.clear();
}