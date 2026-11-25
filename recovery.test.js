import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Bot, { Bot as NamedBot, _regrantIntervalMs, _subFromToken } from './index.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./testdata/recovery.json', import.meta.url)));

test('shared recovery contract: all pages, oldest first, route before ack, dedup SSE', async () => {
  const bot = new Bot({ clientId: 'id', clientSecret: 'secret' });
  const received = [];
  const read = [];
  bot._commands.set('/help', {});
  bot.on('message', m => received.push(m.id));
  bot.on('command', m => received.push(m.id));
  bot.sessions = async () => [{ id: 's', unreadCount: 205 }];
  bot._request = async (method, path) => {
    const url = new URL(path, 'https://test');
    if (method === 'POST') {
      const id = url.pathname.split('/').at(-2);
      assert.ok(received.includes(id), 'acknowledged before emitting');
      read.push(id);
      return;
    }

    assert.equal(url.searchParams.get('order'), 'asc');
    const after = url.searchParams.get('afterID');
    if (after) assert.ok(url.searchParams.get('afterTS'));
    const start = after ? fixture.messages.findIndex(m => m.id === after) + 1 : 0;
    return fixture.messages.slice(start, start + fixture.pageSize);
  };

  await bot._backfill();
  assert.deepEqual(received, fixture.messages.map(m => m.id));
  assert.deepEqual(read, received);
  bot._dispatch(JSON.stringify({ type: 'message', data: fixture.messages.at(-1) }));
  assert.equal(received.length, 205);
});

test('stream consumption waits until backfill installs deduplication state', async () => {
  const bot = new Bot({ clientId: 'id', clientSecret: 'secret' });
  let finish;
  const recovery = new Promise(resolve => {
    finish = resolve;
  });
  let consumed = false;
  bot._backfill = () => recovery;
  bot._resetLiveness = () => {};
  bot._read = async () => {
    consumed = true;
  };

  const ctrl = new AbortController();
  bot._stream = ctrl;
  const work = bot._consume({}, ctrl);
  await Promise.resolve();
  assert.equal(consumed, false);

  finish();
  await work;
  assert.equal(consumed, true);
});

test('authentication preserves exports and sends client credentials', async (t) => {
  assert.equal(Bot, NamedBot);
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'bot' })).toString('base64url')}.signature`;
  assert.equal(_subFromToken(token), 'bot');
  assert.throws(() => _subFromToken('invalid'), /invalid token format/);
  assert.equal(_regrantIntervalMs(3600), 3_540_000);
  assert.equal(_regrantIntervalMs(0), 10_000);

  const bot = new Bot({ clientId: 'id', clientSecret: 'secret' });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://oauth.botcomm.app/token');
    assert.equal(init.body.get('grant_type'), 'client_credentials');
    assert.equal(init.body.get('client_id'), 'id');
    assert.equal(init.body.get('client_secret'), 'secret');
    return Response.json({ access_token: token, expires_in: 3600 });
  });
  assert.deepEqual(await bot._grant(), { access_token: token, expires_in: 3600 });
});

test('HTTP requests preserve authentication, retry payloads, empty responses and errors', async (t) => {
  const bot = new Bot({ clientId: 'id', clientSecret: 'secret' });
  bot._accessToken = 'token';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, ...init });
    if (calls.length === 1) return new Response('', { status: 429, headers: { 'Retry-After': '0.001' } });
    if (calls.length === 2) return Response.json({ id: 'message' });
    if (calls.length === 3) return new Response(null, { status: 204 });
    return new Response(' rejected ', { status: 403 });
  });

  assert.deepEqual(await bot._request('POST', '/session/s/message', { content: 'hello' }), { id: 'message' });
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].headers.Authorization, 'Bearer token');
  assert.equal(calls[0].body, '{"content":"hello"}');
  assert.equal(await bot._request('DELETE', '/session/s/message/m'), undefined);
  await assert.rejects(bot._request('GET', '/forbidden'), /GET \/forbidden: 403 - rejected/);
  assert.equal(calls.length, 4);
});

test('SSE parsing handles split UTF-8, multiline events and reconnect cleanup', async () => {
  const bot = new Bot({ clientId: 'id', clientSecret: 'secret' });
  const frames = [];
  let activity = 0;
  let reconnect;
  bot._dispatch = frame => frames.push(JSON.parse(frame));
  bot._resetLiveness = () => activity++;
  bot._scheduleReconnect = delay => { reconnect = delay; };
  const ctrl = new AbortController();
  bot._stream = ctrl;
  const bytes = new TextEncoder().encode(': ping\r\nid: ignored\r\ndata: {"id":"m",\r\ndata: "content":"🙂"}\r\n\r\n');
  const body = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });

  await bot._read(body, ctrl);
  assert.deepEqual(frames, [{ id: 'm', content: '🙂' }]);
  assert.ok(activity > 0);
  assert.equal(bot._stream, null);
  assert.equal(reconnect, 0);
});
