// 联机服务器：HTTP + SSE（零依赖）
//   node src/net/server.js            # 默认端口 8787
//   node src/net/server.js 9000 8     # 端口 9000，默认 8 人局
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join as pathJoin } from 'node:path';
import * as Room from './room.js';
import { say, CHANNELS, channelsFor } from '../chat.js';
import { statusLine, clueList, lookAround } from '../view.js';
import { playerById } from '../engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI = readFileSync(pathJoin(__dirname, 'ui.html'), 'utf8');

const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 8787;
const DEFAULT_PLAYERS = Number(process.argv[3]) || 8;
const IS_MAIN = !!process.argv[1] && /server\.js$/.test(process.argv[1]);

const rooms = new Map();   // roomId -> room

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => {
      buf += c;
      if (buf.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function newRoom(playerCount) {
  const room = Room.createRoom({ playerCount: Math.min(10, Math.max(6, playerCount)), hostName: '房主' });
  room.tokens = new Map();
  rooms.set(room.id, room);
  return room;
}

function auth(room, playerId, token) {
  if (!room) return false;
  return room.tokens.get(Number(playerId)) === token;
}

export function startServer(port = PORT, defaultPlayers = DEFAULT_PLAYERS) {
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(UI);
    }

    if (req.method === 'GET' && path === '/api/ping') {
      return json(res, 200, { ok: true, version: '0.4', rooms: rooms.size, uptime: Math.round(process.uptime()) });
    }

    if (path === '/healthz') {
      return json(res, 200, { ok: true, uptime: Math.round(process.uptime()), rooms: rooms.size });
    }

    if (req.method === 'GET' && path === '/api/channels') {
      return json(res, 200, { channels: CHANNELS });
    }

    // 建房
    if (req.method === 'POST' && path === '/api/create') {
      const body = await readBody(req);
      const room = newRoom(Number(body.playerCount) || defaultPlayers);
      return json(res, 200, { ok: true, roomId: room.id, capacity: room.playerCount });
    }

    // 加入
    if (req.method === 'POST' && path === '/api/join') {
      const body = await readBody(req);
      const room = rooms.get(body.roomId);
      if (!room) return json(res, 404, { ok: false, msg: '没有这个房间。' });
      const r = Room.join(room, body.name);
      if (!r.ok) return json(res, 400, r);
      const token = randomUUID();
      room.tokens.set(r.playerId, token);
      return json(res, 200, { ok: true, roomId: room.id, playerId: r.playerId, token, status: Room.status(room) });
    }

    // 开局
    if (req.method === 'POST' && path === '/api/start') {
      const body = await readBody(req);
      const room = rooms.get(body.roomId);
      if (!room) return json(res, 404, { ok: false, msg: '没有这个房间。' });
      if (!auth(room, body.playerId, body.token)) return json(res, 403, { ok: false, msg: '凭据无效。' });
      const r = Room.start(room, { fillBots: body.fillBots !== false, minPlayers: Number(body.minPlayers) || 6 });
      return json(res, 200, r);
    }

    // 状态下发（SSE）
    if (req.method === 'GET' && path === '/api/events') {
      const room = rooms.get(url.searchParams.get('roomId'));
      const playerId = Number(url.searchParams.get('playerId'));
      const token = url.searchParams.get('token');
      if (!room) return json(res, 404, { ok: false, msg: '没有这个房间。' });
      if (!auth(room, playerId, token)) return json(res, 403, { ok: false, msg: '凭据无效。' });

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      Room.addStream(room, playerId, res);

      const p = room.game?.players?.[playerId];
      if (p) {
        res.write(`data: ${JSON.stringify({ type: 'resync', status: Room.status(room), self: room.game.players[playerId].name, where: p.node })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: 'lobby', status: Room.status(room), you: playerId })}\n\n`);
      }

      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { } }, 15000);
      req.on('close', () => { clearInterval(ping); Room.removeStream(room, playerId, res); });
      return;
    }

    // 回应提示（行动 / 会议选择）
    if (req.method === 'POST' && path === '/api/answer') {
      const body = await readBody(req);
      const room = rooms.get(body.roomId);
      if (!room) return json(res, 404, { ok: false, msg: '没有这个房间。' });
      if (!auth(room, body.playerId, body.token)) return json(res, 403, { ok: false, msg: '凭据无效。' });
      const r = Room.answer(room, Number(body.playerId), body.promptId, body.value);
      return json(res, 200, r);
    }

    // 聊天
    if (req.method === 'POST' && path === '/api/chat') {
      const body = await readBody(req);
      const room = rooms.get(body.roomId);
      if (!room) return json(res, 404, { ok: false, msg: '没有这个房间。' });
      if (!auth(room, body.playerId, body.token)) return json(res, 403, { ok: false, msg: '凭据无效。' });
      const s = room.game;
      if (!s) return json(res, 400, { ok: false, msg: '还没开局。' });
      const p = playerById(s, Number(body.playerId));
      const r = say(s, p, body.channel || 'area', body.text);
      if (r.ok) Room.flushEvents(room);
      return json(res, 200, r);
    }

    // 查询状态（给客户端刷新用）
    if (req.method === 'GET' && path === '/api/status') {
      const room = rooms.get(url.searchParams.get('roomId'));
      if (!room) return json(res, 404, { ok: false, msg: '没有这个房间。' });
      return json(res, 200, Room.status(room));
    }

    json(res, 404, { ok: false, msg: 'not found' });
  } catch (e) {
    json(res, 500, { ok: false, msg: String(e?.message ?? e) });
  }
});

  const sockets = new Set();
  server.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });

  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      const realPort = server.address().port;
      console.log('《红黄绿》联机服务器已启动');
      console.log('  本机：http://127.0.0.1:' + realPort);
      console.log('  局域网：http://<本机IP>:' + realPort);
      console.log('  默认每房 ' + defaultPlayers + ' 人，最少 6 人开局（不足由机器人补位）');
      console.log('  healthcheck: /healthz');
      resolve({
        server, port: realPort, rooms,
        close: () => new Promise((r) => {
          for (const room of rooms.values()) Room.stop(room);
          for (const sock of sockets) { try { sock.destroy(); } catch { } }
          server.close(() => r());
        }),
      });
    });
  });
}

if (IS_MAIN) {
  startServer(PORT, DEFAULT_PLAYERS).catch(err => {
    console.error('启动失败：', err);
    process.exit(1);
  });
}
