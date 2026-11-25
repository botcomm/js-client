import { EventEmitter } from 'node:events';

import { _regrantIntervalMs, _subFromToken, grant, REGRANT_RETRY_MS } from './auth.js';
import { API_HOST, connect, readEvents, request } from './transport.js';

const RECONNECT_DELAY_MS = 5_000; // pause between reconnect attempts
const READ_WAIT_MS = 90_000; // liveness deadline, reset by every received byte

/** @typedef {import('./index.js').Message} Message */
/** @typedef {import('./index.js').Command} Command */
/** @typedef {import('./index.js').Keyboard} Keyboard */
/** @typedef {import('./index.js').KeyboardOption} KeyboardOption */
/** @typedef {import('./index.js').SettingField} SettingField */
/** @typedef {import('./index.js').Broadcast} Broadcast */
/** @typedef {import('./index.js').Session} Session */

/**
 * A BotComm bot: an authenticated client streaming /updates over SSE.
 *
 * Events:
 *  - 'message'     {Message}  incoming message that is not a registered command
 *  - 'command'     {Message}  incoming message matching a registered command value
 *  - 'new_session' {Session}  a user opened a session with the bot
 *  - 'settings'    {{sessionID: string, settings: Record<string, string>}} a session's settings changed
 *  - 'error'       {Error}    non-fatal background failure (re-grant, reconnect,
 *                             back-fill, read confirmation); logged to stderr
 *                             when no listener is attached
 */
export class Bot extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.clientId - bot client id (shown once on bot creation)
   * @param {string} options.clientSecret - bot client secret (shown once on bot creation)
   */
  constructor({ clientId, clientSecret } = {}) {
    super();
    if (!clientId || !clientSecret) {
      throw new TypeError('clientId and clientSecret are required');
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;

    /** @type {string|null} bot ID, resolved from the access token subject on run */
    this.id = null;
    this.argumentCommands = false;
    this.startupCommands = null;
    this.inputMode = null;

    this._accessToken = null;
    this._stream = null;
    this._stopped = false;
    this._regrantTimer = null;
    this._reconnectTimer = null;
    this._livenessTimer = null;
    /** @type {Map<string, Command>} registered commands keyed by value */
    this._commands = new Map();
    /** @type {Set<string>} message IDs delivered by the latest backfill, pruned by dispatch */
    this._backfilled = new Set();
  }

  /**
   * Authorizes the bot, opens the /updates stream and starts listening.
   * Rejects if the initial grant or connect fails; after that the SDK keeps
   * the token fresh and reconnects on its own.
   *
   * @returns {Promise<void>}
   */
  async run() {
    this._stopped = false;

    const tk = await this._grant();
    this._accessToken = tk.access_token;
    this.id = _subFromToken(tk.access_token);
    this._scheduleRegrant(_regrantIntervalMs(tk.expires_in));

    try {
      if (this.startupCommands !== null) await this.registerCommands(this.startupCommands);
      if (this.inputMode !== null) await this.setInputMode(this.inputMode);
      await this._connect();
    } catch (err) {
      clearTimeout(this._regrantTimer);
      throw err;
    }
  }

  /** Closes the stream, stops all timers and prevents reconnects. */
  stop() {
    this._stopped = true;
    clearTimeout(this._regrantTimer);
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._livenessTimer);
    this._stream?.abort();
  }

  /**
   * Posts a message into a session.
   *
   * @param {string} sessionId
   * @param {string} content
   * @param {object} [options]
   * @param {Object|null} [options.metadata] - optional JSON object, up to 4096 bytes
   * @param {string} [options.subject] - optional plain-text subject (up to 256 characters)
   * @param {boolean} [options.silent=false] - no push notification for the recipient
   * @returns {Promise<Message>}
   */
  async send(sessionId, content, { subject, metadata, silent = false, stream = false } = {}) {
    return this.sendMessage(sessionId, {
      content,
      stream,
      subject,
      metadata,
      silent,
      ts: new Date().toISOString(),
    });
  }

  /**
   * Sends one message to every session of the bot as a server-side job.
   *
   * @param {string} content
   * @param {{subject?: string, metadata?: Object | null, keyboard?: Pick<Keyboard, 'options'>, silent?: boolean}} [options]
   * @returns {Promise<Broadcast>}
   */
  async broadcast(content, { subject, metadata, keyboard, silent = false } = {}) {
    return this._request('POST', `/bot/${encodeURIComponent(this.id)}/broadcast`, { content, subject, metadata, keyboard, silent });
  }

  /**
   * @param {string} id
   * @returns {Promise<Broadcast>}
   */
  async broadcastStatus(id) {
    return this._request('GET', `/bot/${encodeURIComponent(this.id)}/broadcast/${encodeURIComponent(id)}`);
  }

  async sendMessage(sessionId, message) {
    return this._request('POST', `/session/${encodeURIComponent(sessionId)}/message`, { ts: new Date().toISOString(), ...message });
  }

  async updateMessage(sessionId, messageId, change) {
    return this._request('POST', `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`, change);
  }

  async getMessage(sessionId, messageId) {
    return this._request('GET', `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`);
  }

  async sendCard(sessionId, card) {
    return this.sendMessage(sessionId, { card });
  }

  async updateCard(sessionId, messageId, change) {
    return this.updateMessage(sessionId, messageId, { card: change });
  }

  async getCardMessage(sessionId, messageId) {
    return this.getMessage(sessionId, messageId);
  }

  async registerCollections(collections) {
    await this._request('POST', `/bot/${encodeURIComponent(this.id)}`, { collections });
  }

  async respondCollection(request, result) {
    await this._request(
      'POST',
      `/session/${encodeURIComponent(request.sessionID)}/collections/${encodeURIComponent(request.key)}/result/${encodeURIComponent(request.id)}`,
      result,
    );
  }

  /**
   * Publishes the per-session settings schema; changes arrive as 'settings' events.
   *
   * @param {SettingField[]} settings
   * @returns {Promise<void>}
   */
  async registerSettings(settings) {
    await this._request('POST', `/bot/${encodeURIComponent(this.id)}`, { settings });
  }

  /**
   * Sets settings values on behalf of the user.
   *
   * @param {string} sessionId
   * @param {Record<string, string>} values
   * @returns {Promise<{sessionID: string, settings: Record<string, string>}>}
   */
  async setSettings(sessionId, values) {
    return this._request('POST', `/session/${encodeURIComponent(sessionId)}/settings`, values);
  }

  /**
   * Posts a message with one-tap answer options. The user's tap arrives as a
   * 'message' event whose content is the chosen option's label, with replyTo
   * set to the keyboard message's id and value to the option's value (a value
   * matching a registered command emits 'command' instead).
   *
   * @param {string} sessionId
   * @param {string} content
   * @param {KeyboardOption[]} options
   * @param {{subject?: string, metadata?: Object | null, silent?: boolean}} [messageOptions]
   * @returns {Promise<void>}
   */
  async sendKeyboard(sessionId, content, options, { subject, metadata, silent = false } = {}) {
    return this.sendMessage(sessionId, {
      content,
      keyboard: { options },
      subject,
      metadata,
      silent,
      ts: new Date().toISOString(),
    });
  }

  /**
   * Shows a typing indicator to the user for ~5s; call again every 3-4s while
   * still working.
   *
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async typing(sessionId) {
    await this._request('POST', `/session/${encodeURIComponent(sessionId)}/typing`);
  }

  async startStream(sessionId) {
    return this.sendMessage(sessionId, { stream: true });
  }

  // Send accumulated text at ~500ms intervals; finish with completed or failed.
  async updateStream(sessionId, messageId, { content, sequence, status = 'active' }) {
    return this._request('POST', `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}/stream`, { content, sequence, status });
  }

  async react(sessionId, messageId, emoji = '') {
    return this._request('POST', `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}/reaction`, { emoji });
  }

  /**
   * Edits a message the bot authored. An answered keyboard cannot be replaced.
   *
   * @param {string} sessionId
   * @param {string} messageId
   * @param {{content?: string, subject?: string, metadata?: Object | null, keyboard?: Keyboard}} changes - empty subject clears it
   * @returns {Promise<Message>} the updated message
   */
  async edit(sessionId, messageId, changes) {
    return this.updateMessage(sessionId, messageId, changes);
  }

  /**
   * Deletes a message the bot authored.
   *
   * @param {string} sessionId
   * @param {string} messageId
   * @returns {Promise<void>}
   */
  async delete(sessionId, messageId) {
    await this._request(
      'DELETE',
      `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
    );
  }

  async setInputMode(inputMode) {
    await this._request('POST', `/bot/${encodeURIComponent(this.id)}`, { inputMode });
  }

  /**
   * Controls whether apps show the bot's connection status.
   *
   * @param {boolean} visible
   * @returns {Promise<void>}
   */
  async setOnlineStatusVisible(visible) {
    await this._request('POST', `/bot/${encodeURIComponent(this.id)}`, { onlineStatusVisible: visible });
  }

  /**
   * Publishes the bot commands to the API and routes incoming messages whose
   * content equals a command value to the 'command' event.
   *
   * @param {Command[]} commands
   * @returns {Promise<void>}
   */
  async registerCommands(commands) {
    await this._request('POST', `/bot/${encodeURIComponent(this.id)}`, { commands });
    this._commands = new Map(commands.map((cmd) => [cmd.value, cmd]));
  }

  /**
   * Fetches all sessions of the bot.
   *
   * @returns {Promise<Session[]>}
   */
  async sessions() {
    return (await this._request('GET', '/session')) ?? [];
  }

  // -- internals ------------------------------------------------------------

  async _grant() {
    return grant(this.clientId, this.clientSecret);
  }

  /** @param {number} delayMs */
  _scheduleRegrant(delayMs) {
    clearTimeout(this._regrantTimer);
    this._regrantTimer = setTimeout(async () => {
      if (this._stopped) return;
      try {
        const tk = await this._grant();
        this._accessToken = tk.access_token;
        this._scheduleRegrant(_regrantIntervalMs(tk.expires_in));
      } catch (err) {
        this._emitError(new Error(`failed to refresh access token: ${err.message}`));
        this._scheduleRegrant(REGRANT_RETRY_MS);
      }
    }, delayMs);
  }

  /**
   * Opens the /updates SSE stream with the current access token. Resolves once
   * the response headers arrive; a later disconnect triggers the reconnect loop.
   *
   * @returns {Promise<void>}
   */
  async _connect() {
    const url = API_HOST + '/updates';
    const ctrl = new AbortController();
    this._stream = ctrl;
    let res;
    try {
      res = await connect(this._accessToken, ctrl.signal);
    } catch (err) {
      ctrl.abort();
      if (this._stream === ctrl) this._stream = null;
      throw new Error(`failed to dial ${url}: ${err.message}`);
    }

    // Keep run() responsive while ensuring buffered SSE messages cannot race
    // backfill's deduplication set.
    this._consume(res.body, ctrl);
  }

  async _consume(body, ctrl) {
    await this._backfill().catch((err) => {
      this._emitError(new Error(`failed to backfill: ${err.message}`));
    });
    if (this._stopped || this._stream !== ctrl) return;
    this._resetLiveness(ctrl);
    await this._read(body, ctrl);
  }

  /**
   * Consumes the stream: `data:` lines accumulate until a blank line ends the
   * event, comments and other fields are ignored.
   *
   * @param {ReadableStream<Uint8Array>} body
   * @param {AbortController} ctrl
   */
  async _read(body, ctrl) {
    try {
      await readEvents(body, () => this._resetLiveness(ctrl), (frame) => this._dispatch(frame));
    } catch (err) {
      if (!ctrl.signal.aborted) this._emitError(err);
    } finally {
      clearTimeout(this._livenessTimer);
      if (this._stream === ctrl) this._stream = null;
      if (!this._stopped) this._scheduleReconnect(0);
    }
  }

  /** @param {number} delayMs */
  _scheduleReconnect(delayMs) {
    if (this._stopped) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (this._stopped) return;
      this._connect().catch((err) => {
        this._emitError(new Error(`failed to reconnect: ${err.message}`));
        this._scheduleReconnect(RECONNECT_DELAY_MS);
      });
    }, delayMs);
  }

  /**
   * Arms the liveness deadline: the stream is aborted (and thereby
   * reconnected) when nothing arrives for READ_WAIT_MS.
   *
   * @param {AbortController} ctrl
   */
  _resetLiveness(ctrl) {
    clearTimeout(this._livenessTimer);
    this._livenessTimer = setTimeout(() => ctrl.abort(), READ_WAIT_MS);
  }

  /**
   * Parses one event payload and routes it: "message" envelopes go to the
   * 'message' or 'command' event and get confirmed read, "new_session" emits
   * 'new_session'. Other types carry nothing for the SDK.
   *
   * @param {string} frame
   */
  _dispatch(frame) {
    let env;
    try {
      env = JSON.parse(frame);
    } catch (err) {
      this._emitError(new Error(`failed to parse envelope: ${err.message}`));
      return;
    }

    switch (env?.type) {
      case 'message': {
        const msg = env.data;
        if (!msg || typeof msg.id !== 'string') return;
        if (this._backfilled.delete(msg.id)) {
          return; // already delivered (and confirmed read) by the backfill
        }
        this._route(msg);
        this._confirmRead(msg.sessionID, msg.id);
        break;
      }
      case 'reaction':
        this.emit('reaction', env.data);
        break;
      case 'new_session':
        this.emit('new_session', env.data);
        break;
      case 'collection_request':
        this.emit('collection_request', env.data);
        break;
      case 'settings':
        this.emit('settings', env.data);
        break;
      case 'read':
        // the counterpart read one of the bot's messages: nothing to do here
        break;
      default:
        console.debug(`[botcomm] unknown envelope type ${JSON.stringify(env?.type)}`);
    }
  }

  /**
   * Emits a message as 'command' when its content (or, for keyboard answers,
   * its machine value) matches a registered command value, as 'message'
   * otherwise.
   *
   * @param {Message} msg
   */
  _route(msg) {
    const key = msg.value || msg.content;
    let isCommand = this._commands.has(key);
    if (this.argumentCommands && !msg.value && !msg.replyTo) {
      if (isCommand) {
        msg.command = key;
        msg.argument = '';
      } else {
        const command = msg.content.split(/[ \t\r\n]/, 1)[0];
        if (this._commands.get(command)?.input) {
          isCommand = true;
          msg.command = command;
          msg.argument = msg.content.slice(command.length).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
        }
      }
    }
    this.emit(isCommand ? 'command' : 'message', msg);
  }

  /**
   * Loads the sessions and re-delivers messages that arrived while the bot was
   * offline, oldest first, confirming each as read. Runs on every (re)connect.
   */
  async _backfill() {
    const sessions = await this.sessions();

    const delivered = new Set();
    for (const session of sessions) {
      if (!session.unreadCount) continue;
      let after = null;
      while (!this._stopped) {
        const query = new URLSearchParams({ order: 'asc' });
        if (after) {
          query.set('afterID', after.id);
          query.set('afterTS', after.createTS);
        }
        let unread;
        try {
          unread = (await this._request('GET', `/session/${encodeURIComponent(session.id)}/message/unread?${query}`)) ?? [];
        } catch (err) {
          this._emitError(new Error(`failed to load unread messages: ${err.message}`));
          break;
        }
        for (const msg of unread) {
          if (delivered.has(msg.id)) continue;
          delivered.add(msg.id);
          this._route(msg);
          await this._confirmRead(msg.sessionID, msg.id);
        }
        if (unread.length < 100) break;
        const last = unread[unread.length - 1];
        if (last.id === after?.id) break;
        after = last;
      }
    }

    // remember what was just delivered so dispatch can drop a duplicate that
    // arrived over the stream while the backfill was running
    this._backfilled = delivered;
  }

  /**
   * @param {string} sessionId
   * @param {string} messageId
   */
  _confirmRead(sessionId, messageId) {
    return this._request(
      'POST',
      `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}/read`,
    ).catch((err) => {
      this._emitError(new Error(`failed to confirm message read: ${err.message}`));
    });
  }

  async _request(method, path, body) {
    return request(this._accessToken, method, path, body);
  }

  /** @param {Error} err */
  _emitError(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err);
    else console.error('[botcomm]', err.message ?? err);
  }
}
