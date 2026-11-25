import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from './index.js';

test('subjects accompany sends, keyboards and broadcasts and can be cleared independently', async () => {
  const bot = new Bot({ clientId: 'id', clientSecret: 'secret' });
  bot.id = 'bot';
  bot._request = async (_method, _path, body) => JSON.parse(JSON.stringify(body));
  assert.equal((await bot.send('s1', 'Sunny', { subject: 'Weather' })).subject, 'Weather');
  assert.equal((await bot.sendKeyboard('s1', 'Sunny', [{ label: 'OK', value: 'ok' }], { subject: 'Weather' })).subject, 'Weather');
  assert.equal((await bot.broadcast('Sunny', { subject: 'Weather' })).subject, 'Weather');
  assert.deepEqual(await bot.edit('s1', 'm1', { subject: '' }), { subject: '' });
  assert.equal(Object.hasOwn(await bot.send('s1', 'Legacy'), 'subject'), false);
});

test('agent cards use additive helpers and preserve structured replies', async () => {
  const bot = new Bot({ clientId: 'id', clientSecret: 'secret' });
  const calls = [];
  bot._request = async (method, path, body) => { calls.push({ method, path, body }); return { id: 'm', card: body?.card, fields: { targets: ['one'] } }; };
  const card = { kind: 'plan', title: 'Deploy', summary: 'Production' };
  assert.deepEqual((await bot.sendCard('s/1', card)).card, card);
  assert.equal(calls[0].path, '/session/s%2F1/message');
  await bot.updateCard('s1', 'm1', { revision: 1, status: 'running', progress: 25 });
  assert.equal(calls[1].body.card.revision, 1);
  assert.deepEqual((await bot.getCardMessage('s1', 'answer')).fields.targets, ['one']);
  assert.equal(calls[2].method, 'GET');
});


test('common message methods preserve actions, cards and structured fields', async () => {
  const bot = new Bot({ clientId: 'id', clientSecret: 'secret' });
  const calls = [];
  bot._request = async (method, path, body) => {
    calls.push({ method, path, body });
    return { id: 'm', ...body, fields: { targets: ['one'] } };
  };
  const actions = [{ label: 'OK', value: 'ok' }];
  assert.deepEqual((await bot.sendMessage('s1', { content: 'Continue?', actions })).actions, actions);
  const card = { revision: 1, status: 'completed' };
  assert.deepEqual((await bot.updateMessage('s1', 'm1', { card })).card, card);
  assert.deepEqual((await bot.getMessage('s1', 'answer')).fields.targets, ['one']);
  assert.equal(calls.length, 3);
});

test('metadata survives sends and broadcasts, and edits distinguish omission from null', async () => {
  const bot = new Bot({ clientId: 'id', clientSecret: 'secret' });
  const calls = [];
  bot._request = async (method, path, body) => {
    calls.push(JSON.parse(JSON.stringify(body)));
    return body;
  };
  const metadata = { debug: [true, null, { ms: 12 }] };
  assert.deepEqual((await bot.send('s', 'Answer', { metadata })).metadata, metadata);
  assert.deepEqual((await bot.sendKeyboard('s', 'Choose', [{ label: 'OK', value: 'ok' }], { metadata })).metadata, metadata);
  assert.deepEqual((await bot.broadcast('Answer', { metadata })).metadata, metadata);
  await bot.edit('s', 'm', { content: 'Changed' });
  assert.equal(Object.hasOwn(calls.at(-1), 'metadata'), false);
  await bot.edit('s', 'm', { metadata: null });
  assert.deepEqual(calls.at(-1), { metadata: null });
});


test('stream helpers preserve snapshot sequencing and reactions are separate events', async () => {
  const bot = new Bot({ clientId: 'id', clientSecret: 'secret' });
  const calls = [];
  bot._request = async (method, path, body) => { calls.push({ method, path, body }); return body; };
  assert.equal((await bot.startStream('s')).stream, true);
  await bot.updateStream('s', 'm', { content: 'Hello', sequence: 1 });
  assert.deepEqual(calls.at(-1).body, { content: 'Hello', sequence: 1, status: 'active' });
  await bot.updateStream('s', 'm', { content: 'Hello world', sequence: 2, status: 'completed' });
  assert.equal(calls.at(-1).path, '/session/s/message/m/stream');
  await bot.react('s', 'm', '❤️');
  assert.equal(calls.at(-1).path, '/session/s/message/m/reaction');
  await bot.react('s', 'm');
  assert.equal(calls.at(-1).body.emoji, '');
  let reaction;
  bot.on('reaction', value => { reaction = value; });
  bot.on('message', () => assert.fail('reaction must not become an incoming message'));
  bot._dispatch(JSON.stringify({ type: 'reaction', data: { id: 'm', reactions: { user: '❤️' }, reactionRevision: 2 } }));
  assert.equal(reaction.reactionRevision, 2);
});
