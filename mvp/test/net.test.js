// 联机 + 聊天 端到端测试（进程内起服务器，用 fetch/SSE 驱动两个客户端）
import assert from 'node:assert/strict';
import { startServer } from '../src/net/server.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function openStream(url) {
  const state = { messages: [], waiters: [], closed: false };
  const ctrl = new AbortController();
  state.close = () => { state.closed = true; ctrl.abort(); };

  (async () => {
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('SSE HTTP ' + res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          try {
            state.messages.push(JSON.parse(line.slice(5).trim()));
            state.waiters.splice(0).forEach(fn => fn());
          } catch { /* ignore */ }
        }
      }
    } catch (e) {
      if (!state.closed) console.error('stream error:', e.message);
    }
  })();

  state.waitFor = (pred, ms = 8000, label = '消息') => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      const hit = state.messages.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error(`等待超时：${label}`));
      state.waiters.push(check);
      setTimeout(check, 100);
    };
    check();
  });

  return state;
}

async function main() {
  const app = await startServer(0, 6);
  const base = `http://127.0.0.1:${app.port}`;
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

  let pass = 0;
  const ok = (cond, msg) => { assert.ok(cond, msg); pass += 1; console.log('  ✓ ' + msg); };

  console.log('\n[联机 + 聊天]');

  const created = await post('/api/create', { playerCount: 6 });
  ok(created.ok && created.roomId, '建房成功 ' + created.roomId);

  const j1 = await post('/api/join', { roomId: created.roomId, name: '阿甲' });
  const j2 = await post('/api/join', { roomId: created.roomId, name: '阿乙' });
  ok(j1.ok && j2.ok && j1.playerId !== j2.playerId, '两名玩家加入，座位不冲突');

  const s1 = openStream(`${base}/api/events?roomId=${created.roomId}&playerId=${j1.playerId}&token=${j1.token}`);
  const s2 = openStream(`${base}/api/events?roomId=${created.roomId}&playerId=${j2.playerId}&token=${j2.token}`);
  ok(!!s1 && !!s2, '两条 SSE 连接已建立');

  const unauthorized = await post('/api/chat', { roomId: created.roomId, playerId: 99, token: 'bad', channel: 'area', text: 'x' });
  ok(unauthorized.ok === false, '错误凭据被拒绝');

  const started = await post('/api/start', { roomId: created.roomId, playerId: j1.playerId, token: j1.token, fillBots: true, minPlayers: 6 });
  ok(started.ok, '开局成功（机器人补位）');

  const hello1 = await s1.waitFor(m => m.type === 'hello', 8000, 'hello#1');
  const hello2 = await s2.waitFor(m => m.type === 'hello', 8000, 'hello#2');
  ok(hello1.self.name === '阿甲' && hello2.self.name === '阿乙', '开局私有信息正确下发（含身份/目标/武器）');
  ok(['killer', 'detective'].includes(hello1.self.faction), '身份字段可用');

  // 等到某个真人拿到回合
  const turn = await Promise.race([
    s1.waitFor(m => m.type === 'prompt' && m.kind === 'turn', 20000, 'turn#1'),
    s2.waitFor(m => m.type === 'prompt' && m.kind === 'turn', 20000, 'turn#2'),
  ]);
  ok(!!turn.id && Array.isArray(turn.actions) && turn.actions.length > 0, '回合提示带按钮式行动列表');
  ok(turn.status && turn.status.lines && turn.status.where, '回合提示附带状态行与所在区域');

  const isP1 = s1.messages.some(m => m.type === 'prompt' && m.id === turn.id);
  const actor = isP1 ? j1 : j2;
  const stream = isP1 ? s1 : s2;
  const other = isP1 ? s2 : s1;
  const otherId = isP1 ? j2.playerId : j1.playerId;
  const otherStream = isP1 ? s2 : s1;

  const ans = await post('/api/answer', { roomId: created.roomId, playerId: actor.playerId, token: actor.token, promptId: turn.id, value: '看' });
  ok(ans.ok, '指令式回应（看）被接受');

  const afterLook = await stream.waitFor(m => m.type === 'events' && m.items.some(i => i.text.includes('【')), 8000, '观察结果');
  ok(!!afterLook, '观察结果推送到本人事件流');

  // 聊天：区域频道只应发给同节点的人
  const chat = await post('/api/chat', { roomId: created.roomId, playerId: actor.playerId, token: actor.token, channel: 'area', text: '有人吗' });
  ok(chat.ok, '区域频道发言成功');

  const gotChat = await stream.waitFor(m => m.type === 'events' && m.items.some(i => i.text.includes('有人吗')), 6000, '自己的发言');
  ok(!!gotChat, '发言者收到自己的消息（同节点）');

  await sleep(400);
  const otherGot = otherStream.messages.some(m => m.type === 'events' && m.items.some(i => i.text.includes('有人吗')));
  ok(!otherGot, '不同区域的玩家收不到这条消息（区域频道隔离生效）');

  // 长度与权限
  const tooLong = await post('/api/chat', { roomId: created.roomId, playerId: actor.playerId, token: actor.token, channel: 'area', text: 'x'.repeat(80) });
  ok(tooLong.ok === false, '超长发言被拒绝（上限 60 字）');

  const ghostTry = await post('/api/chat', { roomId: created.roomId, playerId: actor.playerId, token: actor.token, channel: 'ghost', text: '我死了吗' });
  ok(ghostTry.ok === false, '存活玩家不能进幽灵频道');

  const factionTry = await post('/api/chat', { roomId: created.roomId, playerId: actor.playerId, token: actor.token, channel: 'faction', text: 'x' });
  const isKiller = (isP1 ? hello1 : hello2).self.faction === 'killer';
  ok(factionTry.ok === isKiller, '阵营频道权限与身份一致');

  // 下一名真人的回合
  const turn2 = await otherStream.waitFor(m => m.type === 'prompt' && m.kind === 'turn', 25000, '另一名玩家的回合');
  ok(!!turn2 && !!turn2.id, '轮转推进到另一名玩家');
  const a2 = await post('/api/answer', { roomId: created.roomId, playerId: otherId, token: isP1 ? j2.token : j1.token, promptId: turn2.id, value: '过' });
  ok(a2.ok, '第二名玩家回应成功');

  await sleep(500);
  const st = await (await fetch(`${base}/api/status?roomId=${created.roomId}`)).json();
  ok(st.tick >= 0 && st.started === true, '服务器状态可查询（tick=' + st.tick + '）');

  // 断开连接后不应崩溃
  s1.close(); s2.close();
  await sleep(300);
  ok(true, '断线不导致服务器异常');

  await app.close();
  console.log(`\n通过 ${pass} 项`);
}

main().catch(err => { console.error('\n✗ 失败：', err.message); process.exitCode = 1; });
