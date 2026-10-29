/** Browser-safe Supabase REST client. No service-role key belongs in this app. */
export const REQUEST_TIMEOUT_MS = 15_000;

export class OnlineApiError extends Error {
  constructor(message, code = 'request_failed', status = 0) {
    super(message);
    this.name = 'OnlineApiError';
    this.code = code;
    this.status = status;
  }
}

function keyKind(key) {
  if (typeof key !== 'string') return null;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return 'publishable';
  const parts = key.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    const decode = (part) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    return header && typeof header.alg === 'string' && payload?.role === 'anon' ? 'anon' : null;
  } catch { return null; }
}

/** Returns a validation result; never includes a supplied key in errors. */
export function validateOnlineConfig(config) {
  let url;
  try { url = new URL(config?.url); }
  catch { return { valid: false, error: 'Enter the Supabase project URL from its Connect dialog.' }; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    return { valid: false, error: 'Use an HTTPS project URL without credentials, a path, or query parameters.' };
  }
  if (!keyKind(config?.key?.trim?.())) {
    return { valid: false, error: 'Use a publishable key or legacy anon key. Never use a secret or service-role key in this game.' };
  }
  return { valid: true, error: '' };
}

const AUTH_MESSAGES = {
  invalid_credentials: 'The email or password is incorrect.',
  email_not_confirmed: 'Confirm the host account email before signing in.',
  invalid_grant: 'Your sign-in has expired. Please sign in again.',
  refresh_token_not_found: 'Your sign-in has expired. Please sign in again.',
  refresh_token_already_used: 'Your sign-in has expired. Please sign in again.',
  session_not_found: 'Your sign-in has expired. Please sign in again.',
  bad_jwt: 'Your sign-in has expired. Please sign in again.',
  user_banned: 'This host account cannot sign in. Check it in Supabase.',
};

// Only known, fixed database messages are reflected to players. Provider debug
// messages may contain request details and must never be displayed verbatim.
const EVENT_MESSAGES = new Map([
  ['Event not found. Check the event link or code.', 'event_not_found'],
  ['Round not found. Start a new round.', 'round_not_found'],
  ['This event is closed. Ask the host for a new event link.', 'event_closed'],
  ['This event has expired. Ask the host for a new event link.', 'event_expired'],
  ['Submit every step exactly once for this round.', 'invalid_order'],
  ['Enter a player or team name between 1 and 30 characters.', 'invalid_name'],
  ['Sign in with a host account to create an event.', 'unauthorized'],
  ['Sign in with the event host account.', 'unauthorized'],
  ['Only the host can close this event.', 'forbidden'],
  ['This event has reached its limit of 5000 rounds.', 'event_limit'],
  ['This host has reached the limit of 50 events per day.', 'host_limit'],
]);

function responseError(status, payload) {
  const providerCode = typeof payload?.code === 'string' ? payload.code
    : typeof payload?.error_code === 'string' ? payload.error_code
      : typeof payload?.error === 'string' ? payload.error : '';
  if (Object.hasOwn(AUTH_MESSAGES, providerCode)) {
    return new OnlineApiError(AUTH_MESSAGES[providerCode], providerCode, status);
  }
  if (EVENT_MESSAGES.has(payload?.message)) {
    return new OnlineApiError(payload.message, EVENT_MESSAGES.get(payload.message), status);
  }
  if (status === 401 || providerCode === 'PGRST301' || providerCode === 'PGRST303') {
    return new OnlineApiError('Your sign-in has expired or the public project key is invalid. Check the connection and sign in again.', 'unauthorized', status);
  }
  if (status === 403 || providerCode === '42501') {
    return new OnlineApiError('You do not have permission to do that. Sign in with the event host account.', 'forbidden', status);
  }
  if (status === 429) {
    return new OnlineApiError('Too many requests. Wait a moment and try again.', 'rate_limited', status);
  }
  if (providerCode === 'PGRST202' || providerCode === '42883') {
    return new OnlineApiError('Online events are not set up in this project yet. Ask the host to apply the database setup.', 'backend_not_ready', status);
  }
  if (status >= 500) {
    return new OnlineApiError('The online service is temporarily unavailable. Please try again.', 'service_unavailable', status);
  }
  return new OnlineApiError('The request could not be completed. Check the event details and try again.', 'request_failed', status);
}

function requireAccessToken(token) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new OnlineApiError('Sign in as the event host first.', 'unauthorized', 401);
  }
  return token;
}

function sessionFrom(payload) {
  if (typeof payload?.access_token !== 'string' || typeof payload?.refresh_token !== 'string'
    || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
    throw new OnlineApiError('The sign-in response was incomplete. Please try signing in again.', 'invalid_response');
  }
  return { ...payload, expires_at: Math.floor(Date.now() / 1000) + payload.expires_in };
}

export function createOnlineClient(config, fetchImpl = globalThis.fetch) {
  const normalized = { url: config?.url?.trim?.(), key: config?.key?.trim?.() };
  const validation = validateOnlineConfig(normalized);
  if (!validation.valid) throw new OnlineApiError(validation.error, 'invalid_config');
  if (typeof fetchImpl !== 'function') throw new OnlineApiError('This browser does not support online play.', 'unsupported_browser');
  const origin = new URL(normalized.url).origin;
  const legacyAnon = keyKind(normalized.key) === 'anon';

  async function request(path, body, accessToken) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const headers = { apikey: normalized.key, 'Content-Type': 'application/json', Accept: 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    else if (legacyAnon) headers.Authorization = `Bearer ${normalized.key}`;
    try {
      const response = await fetchImpl(`${origin}${path}`, {
        method: 'POST', headers, body: JSON.stringify(body ?? {}), signal: controller.signal,
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      const text = await response.text();
      let payload = null;
      if (text) {
        try { payload = JSON.parse(text); }
        catch {
          if (!response.ok) throw responseError(response.status, null);
          throw new OnlineApiError('The online service returned an unexpected response. Please try again.', 'invalid_response', response.status);
        }
      }
      if (!response.ok) throw responseError(response.status, payload);
      return payload;
    } catch (error) {
      if (error instanceof OnlineApiError) throw error;
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new OnlineApiError('The request timed out. Please try again.', 'timeout');
      }
      throw new OnlineApiError('Unable to reach the online game. Check your internet connection and try again.', 'network_error');
    } finally { clearTimeout(timeout); }
  }

  const rpc = (name, params, accessToken) => request(`/rest/v1/rpc/${name}`, params, accessToken);
  return Object.freeze({
    async signIn(email, password) {
      return sessionFrom(await request('/auth/v1/token?grant_type=password', { email, password }));
    },
    async refreshSession(refreshToken) {
      return sessionFrom(await request('/auth/v1/token?grant_type=refresh_token', { refresh_token: refreshToken }));
    },
    signOut(accessToken) { return request('/auth/v1/logout', {}, requireAccessToken(accessToken)); },
    createEvent(title, scenario, accessToken) {
      return rpc('create_event', { p_title: title, p_scenario: scenario }, requireAccessToken(accessToken));
    },
    getEvent(code) { return rpc('get_event', { p_code: code }); },
    startRound(code, name) { return rpc('start_round', { p_code: code, p_name: name }); },
    submitRound(token, order) { return rpc('submit_round', { p_token: token, p_order: order }); },
    leaderboard(code) { return rpc('get_leaderboard', { p_code: code }); },
    closeEvent(code, accessToken) { return rpc('close_event', { p_code: code }, requireAccessToken(accessToken)); },
  });
}
