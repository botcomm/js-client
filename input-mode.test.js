import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from './index.js';

test('online status visibility sends both boolean values and returns failures', async () => {
  const bot = new Bot({ clientId: 'id', clientSecret: 'secret' });
  bot.id = 'bot/id';
  const calls = [];
  bot._request = async (...args) => {
    calls.push(args);
  };
  for (const visible of [true, false]) {
    await bot.setOnlineStatusVisible(visible);
  }
  assert.deepEqual(calls, [
    ['POST', '/bot/bot%2Fid', { onlineStatusVisible: true }],
    ['POST', '/bot/bot%2Fid', { onlineStatusVisible: false }],
  ]);
  bot._request = async () => { throw new Error('update failed'); };
  await assert.rejects(bot.setOnlineStatusVisible(true), /update failed/);
});

test('argument routing is opt-in and preserves content and keyboard routing', () => {
  for (const enabled of [false, true]) {
    const bot = new Bot({ clientId: 'id', clientSecret: 'secret' });
    bot.argumentCommands = enabled;
    bot._commands = new Map([['/now', {}], ['/city', { input: { type: 'text' } }]]);
    let routed;
    bot.on('command', () => {
      routed = 'command';
    });
    bot.on('message', () => {
      routed = 'message';
    });
    for (const [content, value, replyTo, command, argument, exact] of [
      ['/now', '', '', '/now', '', true],
      ['/city', '', '', '/city', '', true],
      ['/city \tNew  York 🙂\r\n', '', '', '/city', 'New  York 🙂', false],
      ['/citywrong Warsaw', '', '', undefined, undefined, false],
      ['/now args', '', '', undefined, undefined, false],
      ['Label', '/now', 'keyboard', undefined, undefined, true],
      ['Label', '/city Warsaw', 'keyboard', undefined, undefined, false],
      ['/city Warsaw', '', 'keyboard', undefined, undefined, false],
    ]) {
      const msg = { content, value, replyTo };
      bot._route(msg);
      assert.equal(routed, exact || (enabled && command) ? 'command' : 'message');
      assert.equal(msg.content, content);
      assert.equal(msg.command, enabled ? command : undefined);
      assert.equal(msg.argument, enabled ? argument : undefined);
    }
  }
});

test('startup publishes commands before mode and before recovering messages', async () => {
  const bot = new Bot({ clientId: 'id', clientSecret: 'secret' });
  const calls = [];
  bot.startupCommands = [{ name: 'City', value: '/city', input: { type: 'text' } }];
  bot.inputMode = 'commands';
  bot._grant = async () => ({
    access_token: `x.${Buffer.from('{"sub":"bot"}').toString('base64url')}.x`,
    expires_in: 3600,
  });
  bot._scheduleRegrant = () => {};
  bot._request = async (_, __, body) => {
    calls.push(body);
  };
  bot._connect = async () => {
    calls.push('connect');
  };
  await bot.run();
  assert.deepEqual(calls, [{ commands: bot.startupCommands }, { inputMode: 'commands' }, 'connect']);
  bot._request = async () => {
    throw new Error('registration failed');
  };
  calls.length = 0;
  await assert.rejects(bot.run(), /registration failed/);
  assert.equal(calls.length, 0);
});

test('backfill uses argument routing', async () => {
  const bot = new Bot({ clientId: 'id', clientSecret: 'secret' });
  bot.argumentCommands = true;
  bot._commands.set('/city', { input: { type: 'text' } });
  bot.sessions = async () => [{ id: 's', unreadCount: 1 }];
  const received = [];
  bot.on('command', msg => received.push(msg));
  bot._request = async method => method === 'GET'
    ? [{ id: 'm', sessionID: 's', content: '/city New York', createTS: '2026-01-01T00:00:00Z' }]
    : {};
  await bot._backfill();
  assert.equal(received[0].argument, 'New York');
});

test('collection requests are separate events and results use the settings endpoint', async () => {
  const bot = new Bot({ clientId: 'id', clientSecret: 'secret' });
  const request = {
    id: 'r',
    sessionID: 's',
    key: 'channels',
    action: 'list',
    expiresTS: '2026-10-09T20:00:00Z',
  };
  let received;
  bot.on('collection_request', data => {
    received = data;
  });
  bot.on('message', () => assert.fail('collection became a message'));
  bot._dispatch(JSON.stringify({ type: 'collection_request', data: request }));
  assert.deepEqual(received, request);
  let called;
  bot._request = async (...args) => {
    called = args;
  };
  const result = { items: [], revision: 0 };
  await bot.respondCollection(request, result);
  assert.deepEqual(called, ['POST', '/session/s/collections/channels/result/r', result]);
});
