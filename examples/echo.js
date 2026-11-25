// A minimal BotComm bot that echoes every message back to the sender.
//
// Configuration (environment):
//
//   CLIENT_ID     - bot client id (shown once on bot creation)
//   CLIENT_SECRET - bot client secret (shown once on bot creation)

import process from 'node:process';
import { Bot } from '../index.js'; // published package: import { Bot } from '@botcomm/sdk'

const { CLIENT_ID, CLIENT_SECRET } = process.env;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('[ERROR] CLIENT_ID and CLIENT_SECRET are required');
  process.exit(1);
}

const bot = new Bot({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
});

bot.inputMode = 'messages';

bot.on('new_session', async (session) => {
  console.log(`[INFO] new session ${session.id}`);
  try {
    await bot.send(session.id, 'Hello! I repeat everything you say.');
  } catch (err) {
    console.error(`[ERROR] failed to greet: ${err.message}`);
  }
});

bot.on('settings', ({ sessionID, settings }) => {
  console.log(`[INFO] settings of ${sessionID}: ${JSON.stringify(settings)}`);
});

bot.on('message', async (msg) => {
  try {
    await bot.typing(msg.sessionID);
    const reply = await bot.send(msg.sessionID, msg.content);
    console.log(`[INFO] replied with ${reply.id}`);
  } catch (err) {
    console.error(`[ERROR] failed to reply: ${err.message}`);
  }
});

bot.on('command', async (msg) => {
  try {
    if (msg.content === '/ping') {
      await bot.send(msg.sessionID, 'pong');
      return;
    }
    await bot.send(msg.sessionID, `command received: ${msg.content}`);
  } catch (err) {
    console.error(`[ERROR] failed to reply: ${err.message}`);
  }
});

bot.on('error', (err) => {
  console.error(`[ERROR] ${err.message}`);
});

await bot.run();
await bot.registerCommands([{ name: 'Ping', value: '/ping', description: 'Check the bot is alive' }]);
await bot.registerSettings([{ key: 'shout', label: 'Shout replies', type: 'toggle', default: 'false' }]);
console.log(`[INFO] echo bot ${bot.id} is running`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    bot.stop();
    process.exit(0);
  });
}
