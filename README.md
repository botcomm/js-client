# BotComm JavaScript SDK

The official Node.js SDK for building [BotComm](https://botcomm.app) bots. It handles the bot loop for you: client-credentials auth with automatic re-grant before expiry, an SSE stream from `/updates` with reconnect, back-fill of unread messages after every (re)connect, and command routing.

Requires Node 18+. No dependencies; ships as ESM with TypeScript types included.

## Quickstart

Create a bot in the [BotComm console](https://web.botcomm.app/console/bots) and save its credentials. In the same terminal where you'll run the bot, set:

```sh
export CLIENT_ID='your-client-id'
export CLIENT_SECRET='your-client-secret'
```

Install the SDK in your project:

```sh
npm install @botcomm/sdk
```

Save this as `echo.mjs`:

```js
import { Bot } from '@botcomm/sdk';

const bot = new Bot({
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
});
bot.inputMode = 'messages';

bot.on('message', async (msg) => {
  try {
    await bot.send(msg.sessionID, msg.content);
  } catch (err) {
    console.error(err);
  }
});

await bot.run();
```

Run `node echo.mjs`, open your bot’s chat in BotComm, and send `hello`. The bot should reply with `hello`.

The [full echo example](https://github.com/botcomm/js-client/blob/HEAD/examples/echo.js) also handles commands and settings.

## Source layout

`index.js` preserves the package exports, with public types in `index.d.ts`.
`bot.js` contains the bot lifecycle, API methods, event routing and unread recovery.
`auth.js` handles token grants and renewal timing; `transport.js` handles HTTP requests and SSE parsing.

## API

- `new Bot({ clientId, clientSecret })` — construct.
- `await bot.run()` — grant + connect; throws on initial failure, self-healing afterwards.
- `bot.stop()` — close the connection and stop all timers.
- `await bot.send(sessionId, content, { subject, silent })` — post a message into a session; resolves to the created `Message`.
- `await bot.sendKeyboard(sessionId, content, options, { subject?, silent? })` — post a message with one-tap answer options, see [Keyboards](#keyboards); resolves to the created `Message`.
- `await bot.typing(sessionId)` — show a typing indicator for ~5s; repeat every 3-4s while working.
- `await bot.edit(sessionId, messageId, { content?, subject?, keyboard? })` — edit a message the bot sent (e.g. to stream a long reply or update a status); resolves to the updated `Message`. Rejects with 409 once the keyboard was answered.
- `await bot.delete(sessionId, messageId)` — delete a message the bot sent.
- `await bot.registerCommands([{ name, value, description }])` — publish commands; incoming messages matching a command `value` emit `'command'` instead of `'message'`.
- `await bot.registerSettings([{ key, label, type, options?, default? }])` — publish the per-session settings schema, see [Settings](#settings).
- `await bot.setSettings(sessionId, { key: value })` — change a session's settings on the user's behalf.
- `await bot.broadcast(content, { subject?, keyboard?, silent? })` — send one message to each connected account’s oldest chat as a server-side job; resolves to a `Broadcast` whose progress `bot.broadcastStatus(id)` returns.
- `await bot.sessions()` — all sessions of the bot.
- `bot.id` — the bot's ID, set by `run()`.

## Subjects

```js
await bot.send(sessionId, 'Your deployment finished!', { subject: 'Deployment' });
await bot.edit(sessionId, messageId, { subject: '' }); // clear the subject
```

Subjects are optional single-line plain text, up to 256 Unicode characters. Omitting `subject` during an edit preserves it. The same option is available for keyboards and broadcasts.

## Keyboards

Offer one-tap answers by attaching a keyboard to a message:

```js
await bot.sendKeyboard(msg.sessionID, 'Deploy to production?', [
  { label: 'Yes', value: 'deploy' },
  { label: 'No', value: 'cancel' },
]);

bot.on('message', (msg) => {
  if (msg.replyTo) console.log(`user chose ${msg.value}`); // content carries the label
});
```

The tap arrives as a regular message whose `content` is the chosen option's `label`, with `replyTo` set to the keyboard message's id and `value` to the option's machine value; a `value` matching a registered command emits `'command'` instead. The server stamps `keyboard.selected` on the original message once answered.

## Settings

Declare up to 20 fields once; every session then carries `session.settings` with defaults filled in, and changes by the user (or by `setSettings`) arrive as `'settings'` events:

```js
await bot.registerSettings([
  { key: 'digest', label: 'Daily digest', type: 'toggle', default: 'true' },
  { key: 'at', label: 'Send at', type: 'time', default: '08:00' },
  { key: 'units', label: 'Units', type: 'select', options: [{ label: 'Metric', value: 'c' }, { label: 'Imperial', value: 'f' }], default: 'c' },
]);
bot.on('settings', ({ sessionID, settings }) => console.log(sessionID, settings.digest, settings.at));
```

Values are always strings (`"true"`/`"false"` for toggles, `"HH:MM"` for times). The user's `timezone` and `locale` are on `session.user` when their client reported them.

## Events

| Event | Payload | When |
|---|---|---|
| `message` | `Message` | incoming message that is not a registered command |
| `command` | `Message` | incoming message matching a registered command value |
| `new_session` | `Session` | a user opened a session with the bot |
| `settings` | `SessionSettings` | a session's settings changed |
| `error` | `Error` | non-fatal background failure (logged to stderr when unhandled) |

Requests answered with `429` are retried once after the server's `Retry-After`. Received messages are confirmed read automatically.

## Commands-only input

```js
const bot = new Bot({ clientId, clientSecret });
bot.argumentCommands = true;
bot.startupCommands = [{ name: 'Set city', value: '/city', input: {
  type: 'text', label: 'City', placeholder: 'Warsaw', required: true,
} }];
bot.inputMode = 'commands';
bot.on('command', msg => {
  // msg.command === '/city', msg.argument === 'New York'
  // msg.content remains '/city New York'.
});
await bot.run();
```

`await bot.setInputMode('messages')` enables ordinary messages. Publish startup
commands before running so recovery and live traffic route identically.


## Online status visibility

After `await bot.run()`, use `await bot.setOnlineStatusVisible(true)` to show the bot's online/offline indicator in the web and iOS apps, or `false` to hide it. The setting defaults to hidden and persists between restarts. API failures reject the promise.

## Receive-only mode and collections

Use input mode `none` for a receive-only chat. The composer is hidden. Users can still answer buttons, respond to cards, react to messages, and change session settings. Publish native session collections with `registerCollections`, the `collection_request` event, and `respondCollection`. Register the schema before enabling `none`. Persist and atomically compare/increment list revisions on mutations, reject expired requests, and return results outside chat history.

## Streaming replies and reactions

```js
const message = await bot.startStream(sessionId);
await bot.updateStream(sessionId, message.id, { content: 'Hello', sequence: 1 });
await bot.updateStream(sessionId, message.id, { content: 'Hello world', sequence: 2, status: 'completed' });
await bot.react(sessionId, message.id, '❤️');
bot.on('reaction', message => console.log(message.reactions));
```

Batch accumulated text about every 500ms. Sequence numbers increase; identical retries are safe. Finish with `completed` or `failed`, preserving partial text on failure. Send unchanged heartbeats during provider pauses: idle streams expire after two minutes. `send` and `sendMessage` also accept `stream: true`. An empty emoji removes the bot's reaction. Reaction events are live hints; fetch message snapshots after reconnect to recover changes to already-read messages.


## Agent cards

Use `sendMessage(sessionId, { card })` and
`updateMessage(sessionId, messageId, { card: change })`. TypeScript exposes
`AgentCard`, `CardUpdate` and `CardTask` with the JSON field names below.

| Kind | Initial status | Other statuses |
|---|---|---|
| `plan` | `queued` | `running`, `waiting`, `completed`, `failed`, `cancelled` |
| `approval` | `pending` | `approved`, `rejected`, `expired`, `cancelled` |
| `form` | `pending` | `submitted`, `expired`, `cancelled` |
| `artifact` | `completed` | None; immutable |

The server sets the initial status and revision. Plan updates require
the latest `revision` and a status other than `queued`; completed, failed and
cancelled plans cannot be reopened. Stale revisions return 409. Approval/form
updates only cancel pending, unexpired requests; answers and expiration determine
their other statuses. Artifact cards cannot be updated.

An artifact requires an HTTP(S) `url` without credentials and may include
`parentID`, the message ID of an existing plan from the same bot in the same chat.

`sourceID` is different: only plans accept it, pointing to an approved approval
or submitted form from the same bot and chat. Each source permits one plan.
The server sets `planID` on that source; never supply `planID` yourself.
Links cannot be edited, and linking cards does not execute work.

A plan can contain up to 50 tasks. Updating its task list replaces the full list.
