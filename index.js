// Official JavaScript (Node) SDK for building BotComm bots.
//
// A bot authenticates with its client credentials (client_credentials grant,
// re-granted automatically before the access token expires), keeps an SSE
// stream from /updates and receives incoming traffic as events: 'message',
// 'command', 'new_session' and 'settings'. On every (re)connect the SDK back-fills unread
// messages via the REST API, so nothing is lost while the bot was offline.
// See examples/echo.js for a minimal bot.

export { Bot, Bot as default } from './bot.js';
export { _subFromToken, _regrantIntervalMs } from './auth.js';
