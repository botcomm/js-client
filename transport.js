export const API_HOST = 'https://api.botcomm.app'; // resource API

/**
 * Performs an authenticated JSON request against the API.
 *
 * @param {string} accessToken
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<any>}
 */
export async function request(accessToken, method, path, body) {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };
  /** @type {RequestInit} */
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res = await fetch(API_HOST + path, init);
  if (res.status === 429) {
    const retry = Math.min(Number(res.headers.get('Retry-After')) || 1, 30);
    await new Promise((resolve) => setTimeout(resolve, retry * 1000));
    res = await fetch(API_HOST + path, init);
  }
  if (!res.ok) {
    const text = (await res.text()).trim();
    throw new Error(`${method} ${path}: ${res.status} - ${text}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

export async function connect(accessToken, signal) {
  const res = await fetch(API_HOST + '/updates', {
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  return res;
}

export async function readEvents(body, onActivity, onFrame) {
  let buf = '';
  let data = [];
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    onActivity();
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line === '') {
        if (data.length) onFrame(data.join('\n'));
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
}
