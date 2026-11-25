const AUTH_HOST = 'https://oauth.botcomm.app'; // client_credentials token endpoint

export const REGRANT_RETRY_MS = 10_000; // retry interval after a failed re-grant
const REGRANT_EARLINESS_MS = 60_000; // re-grant this long before expiry

/**
 * Extracts the sub claim from a JWT without verifying it (the server is the
 * source of the token). Internal, exported for tests.
 *
 * @param {string} token
 * @returns {string}
 */
export function _subFromToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('invalid token format');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (err) {
    throw new Error(`failed to decode token payload: ${err.message}`);
  }
  if (typeof claims.sub !== 'string' || claims.sub === '') {
    throw new Error('sub claim not found in token');
  }
  return claims.sub;
}

/**
 * Delay before the next re-grant: REGRANT_EARLINESS_MS before the token
 * expires, never less than REGRANT_RETRY_MS. Internal, exported for tests.
 *
 * @param {number} expiresInSeconds
 * @returns {number} delay in milliseconds
 */
export function _regrantIntervalMs(expiresInSeconds) {
  const interval = expiresInSeconds * 1000 - REGRANT_EARLINESS_MS;
  return interval < REGRANT_RETRY_MS ? REGRANT_RETRY_MS : interval;
}

/**
 * Exchanges the client credentials for an access token. Bots get no refresh
 * token: they re-grant before expiry.
 *
 * @returns {Promise<{access_token: string, expires_in: number}>}
 */
export async function grant(clientId, clientSecret) {
  const res = await fetch(`${AUTH_HOST}/token`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (res.status !== 200) {
    const body = (await res.text()).trim();
    throw new Error(`${res.status}: ${body}`);
  }
  const tk = await res.json();
  if (!tk.access_token) throw new Error('empty access token in response');
  return tk;
}

