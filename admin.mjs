import { createOnlineClient, validateOnlineConfig } from './online-api.mjs';
import { SAMPLE_SCENARIOS, validateScenario } from './game-core.mjs';
import { createQrSvg } from './qr-code.mjs';

const $ = (id) => document.getElementById(id);
const SCENARIO_KEY = 'flow-state.scenarios.v1';
let api = null;
let session = null;
let hostEmail = '';
let busy = false;
let selectedEvent = null;
let eventVersion = 0;
let scoreRequest = null;
let pendingEventCode = new URL(location.href).searchParams.get('event');
let customScenarios = [];
let qrSvg = '';
try {
  const stored = JSON.parse(localStorage.getItem(SCENARIO_KEY) || '[]');
  if (Array.isArray(stored)) customScenarios = stored.filter((item) => typeof item?.id === 'string' && item.id.startsWith('custom-') && validateScenario(item).valid);
} catch { showNotice('Scenario drafts could not be read from this browser. You can still create new ones.'); }
const scenarios = [...SAMPLE_SCENARIOS, ...customScenarios];

function showNotice(message) { $('admin-notice').textContent = message; $('admin-notice').hidden = !message; }
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function formatTime(seconds) { return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }

export function makePlayerUrl(code, base = location.href) {
  const url = new URL('./', base);
  url.searchParams.set('event', code);
  return url;
}

function setBusy(value) {
  busy = value;
  for (const field of document.querySelectorAll('#admin-dashboard button, #admin-dashboard input, #admin-dashboard select, #admin-signout, #custom-form button, #custom-form input, #custom-form textarea')) field.disabled = busy || !session;
  for (const field of document.querySelectorAll('#admin-login-form input, #admin-login-form button')) field.disabled = busy || !api;
  $('admin-close-event').disabled = busy || !session || !selectedEvent?.active;
  for (const id of ['admin-download-qr', 'admin-print-qr']) $(id).disabled = busy || !session || !selectedEvent?.active || !qrSvg;
}

function renderScenarioOptions(preferred = $('admin-scenario').value) {
  $('admin-scenario').replaceChildren(...scenarios.map((scenario) => {
    const option = node('option', '', scenario.title);
    option.value = scenario.id;
    return option;
  }));
  if (scenarios.some((item) => item.id === preferred)) $('admin-scenario').value = preferred;
  renderScenarioPreview();
}

function renderScenarioPreview() {
  const scenario = scenarios.find((item) => item.id === $('admin-scenario').value);
  $('admin-preview-title').textContent = scenario?.title || '';
  $('admin-preview-description').textContent = scenario?.description || '';
  $('admin-preview-steps').replaceChildren(...(scenario?.steps || []).map((step) => node('li', '', step)));
}

function renderAuth() {
  $('admin-login-panel').hidden = Boolean(session);
  $('admin-dashboard').hidden = !session;
  $('admin-signout').hidden = !session;
  $('admin-signed-in').textContent = session ? `Signed in as ${hostEmail}` : '';
  if (session) renderScenarioOptions();
  setBusy(busy);
}

function clearSession() {
  session = null;
  hostEmail = '';
  selectedEvent = null;
  eventVersion += 1;
  $('admin-password').value = '';
  $('admin-email').value = '';
  $('admin-event-title').value = '';
  $('admin-event-panel').hidden = true;
  $('admin-share-url').value = '';
  qrSvg = '';
  $('admin-qr').replaceChildren();
  $('admin-qr-title').textContent = '';
  $('admin-event-name').textContent = '';
  $('admin-leaderboard').replaceChildren();
  $('custom-form').reset();
  $('custom-dialog').close();
  renderAuth();
}

async function hostToken() {
  if (!session) throw new Error('Sign in with your host account first.');
  if (session.expires_at <= Math.floor(Date.now() / 1000) + 30) {
    try { session = await api.refreshSession(session.refresh_token); }
    catch (error) { clearSession(); throw error; }
  }
  return session.access_token;
}

function setScoreStatus(message, failed = false) {
  $('admin-score-status').textContent = message;
  $('admin-score-status').classList.toggle('is-error', failed);
}

async function refreshScores() {
  if (!session || !selectedEvent) return;
  const version = eventVersion;
  const code = selectedEvent.code;
  if (scoreRequest?.version === version) return scoreRequest.promise;
  const request = { version, promise: null };
  request.promise = (async () => {
    try {
      const rows = await api.leaderboard(code);
      if (!session || version !== eventVersion) return;
      if (!Array.isArray(rows)) throw new Error('The scoreboard response was incomplete. Try refreshing.');
      $('admin-empty-scores').hidden = rows.length > 0;
      $('admin-leaderboard').replaceChildren(...rows.map((row, index) => {
        const entry = node('li', 'leaderboard-row');
        entry.append(node('span', 'rank', String(index + 1)), node('span', 'entry-name', row.name), node('span', 'entry-score', `${row.score} / 100 · ${formatTime(row.seconds)}`));
        return entry;
      }));
      setScoreStatus('Scores are up to date · refreshes every 5 seconds');
    } catch (error) {
      if (session && version === eventVersion) setScoreStatus(`Could not refresh scores. ${error.message}`, true);
    } finally { if (scoreRequest === request) scoreRequest = null; }
  })();
  scoreRequest = request;
  return request.promise;
}

function renderEvent() {
  $('admin-event-panel').hidden = !session || !selectedEvent;
  if (!selectedEvent || !session) return;
  $('admin-event-name').textContent = selectedEvent.title;
  $('admin-event-state').textContent = selectedEvent.active ? `OPEN · ${selectedEvent.code}` : 'CLOSED TO NEW ENTRIES';
  const playerUrl = makePlayerUrl(selectedEvent.code);
  $('admin-share-url').value = playerUrl.href;
  $('admin-qr-title').textContent = selectedEvent.title;
  $('admin-qr-availability').textContent = selectedEvent.active
    ? 'Display it at your event or print a poster. Download saves a crisp SVG image.'
    : 'This event is closed or expired. Create a new event and use its QR code to accept new players.';
  try {
    qrSvg = createQrSvg(playerUrl.href);
    const documentSvg = new DOMParser().parseFromString(qrSvg, 'image/svg+xml');
    $('admin-qr').replaceChildren(document.importNode(documentSvg.documentElement, true));
  } catch {
    qrSvg = '';
    $('admin-qr').replaceChildren();
    showNotice('The QR code could not be created. You can still copy the player invitation link below.');
  }
  $('admin-player-link').href = playerUrl.href;
  const projectorUrl = new URL(playerUrl);
  projectorUrl.searchParams.set('view', 'leaderboard');
  $('admin-projector-link').href = projectorUrl.href;
  $('admin-event-code').value = selectedEvent.code;
  setBusy(busy);
}

async function acceptEvent(event) {
  if (!session) return;
  if (selectedEvent?.code !== event.code) {
    $('admin-leaderboard').replaceChildren();
    $('admin-empty-scores').hidden = false;
  }
  selectedEvent = event;
  pendingEventCode = event.code;
  eventVersion += 1;
  const url = new URL(location.href);
  url.searchParams.set('event', event.code);
  history.replaceState(null, '', url);
  renderEvent();
  setScoreStatus('Loading scores…');
  await refreshScores();
}

function normalizeCode(value) {
  let code = value.trim();
  if (/^https?:\/\//i.test(code)) code = new URL(code).searchParams.get('event') || '';
  code = code.toLowerCase();
  if (!/^[a-f0-9]{12}$/.test(code)) throw new Error('Enter the 12-character event code or its player link.');
  return code;
}

async function runAction(operation) {
  if (busy || !session || !api) return;
  setBusy(true);
  showNotice('');
  try { await operation(); }
  catch (error) { showNotice(error.message); }
  finally { setBusy(false); }
}

$('admin-login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !api || session) return;
  setBusy(true);
  showNotice('');
  try {
    hostEmail = $('admin-email').value.trim();
    session = await api.signIn(hostEmail, $('admin-password').value);
    renderAuth();
    if (pendingEventCode) await acceptEvent(await api.getEvent(normalizeCode(pendingEventCode)));
  } catch (error) { showNotice(error.message); }
  finally {
    $('admin-password').value = '';
    setBusy(false);
    if (session) $('admin-event-title').focus();
  }
});

$('admin-signout').addEventListener('click', async () => {
  if (busy || !session) return;
  setBusy(true);
  const token = session.access_token;
  clearSession();
  showNotice('');
  try { await api.signOut(token); }
  catch { showNotice('You are signed out on this page. The online sign-out request could not be confirmed.'); }
  finally { setBusy(false); $('admin-email').focus(); }
});

$('admin-create-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void runAction(async () => {
    const title = $('admin-event-title').value.trim();
    if (!title) throw new Error('Enter an event name, not only spaces.');
    const scenario = scenarios.find((item) => item.id === $('admin-scenario').value);
    if (!scenario) throw new Error('Choose a scenario for the event.');
    const created = await api.createEvent(title, scenario, await hostToken());
    await acceptEvent(created);
    $('admin-event-panel').scrollIntoView({ block: 'nearest' });
  });
});
$('admin-open-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void runAction(async () => { await acceptEvent(await api.getEvent(normalizeCode($('admin-event-code').value))); });
});
$('admin-close-event').addEventListener('click', () => {
  if (!selectedEvent?.active) return;
  void runAction(async () => {
    const event = await api.closeEvent(selectedEvent.code, await hostToken());
    await acceptEvent(event);
    showNotice('New entries are closed. Players already in a round can still finish.');
  });
});
$('admin-refresh-scores').addEventListener('click', () => { setScoreStatus('Refreshing scores…'); void refreshScores(); });
$('admin-copy-link').addEventListener('click', async () => {
  if (!session || !selectedEvent) return;
  try { await navigator.clipboard.writeText($('admin-share-url').value); showNotice('Player link copied. Share it with your participants.'); }
  catch { $('admin-share-url').focus(); $('admin-share-url').select(); showNotice('Select and copy the player link above.'); }
});
$('admin-download-qr').addEventListener('click', () => {
  if (busy || !session || !selectedEvent?.active || !qrSvg) return;
  const objectUrl = URL.createObjectURL(new Blob([qrSvg], { type: 'image/svg+xml;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `flow-state-${selectedEvent.code.replace(/[^a-z0-9-]/gi, '')}.svg`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
});
$('admin-print-qr').addEventListener('click', () => {
  if (busy || !session || !selectedEvent?.active || !qrSvg) return;
  document.body.classList.add('print-event-qr');
  try { window.print(); }
  catch {
    document.body.classList.remove('print-event-qr');
    showNotice('Printing is unavailable in this browser. Download the QR image to print it instead.');
  }
});
window.addEventListener('afterprint', () => document.body.classList.remove('print-event-qr'));
$('admin-scenario').addEventListener('change', renderScenarioPreview);
$('admin-add-scenario').addEventListener('click', () => {
  if (busy || !session) return;
  $('custom-error').hidden = true;
  $('custom-dialog').showModal();
});
document.querySelectorAll('[data-close-custom]').forEach((button) => button.addEventListener('click', () => $('custom-dialog').close()));
$('custom-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy || !session) return;
  const scenario = {
    id: `custom-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`,
    title: $('custom-name').value.trim(), description: $('custom-description').value.trim(), category: 'YOUR EVENT',
    steps: $('custom-steps').value.trim().split(/\r?\n/).map((step) => step.trim()),
  };
  const validation = validateScenario(scenario);
  if (!validation.valid) { $('custom-error').textContent = validation.errors.join(' '); $('custom-error').hidden = false; return; }
  customScenarios.push(scenario);
  scenarios.push(scenario);
  try { localStorage.setItem(SCENARIO_KEY, JSON.stringify(customScenarios)); }
  catch { showNotice('The scenario is available this session, but this browser could not save the draft. Create its event before closing the page.'); }
  renderScenarioOptions(scenario.id);
  $('custom-dialog').close();
  $('custom-form').reset();
  $('admin-scenario').focus();
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshScores(); });
setInterval(() => { if (!document.hidden) void refreshScores(); }, 5000);

async function initialize() {
  setBusy(true);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  try {
    const response = await fetch(new URL('./config.json', import.meta.url), { signal: abort.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('The online game configuration could not be loaded. Reload to try again.');
    const stored = await response.json();
    const config = { url: stored.supabaseUrl, key: stored.supabaseKey };
    if (!validateOnlineConfig(config).valid) throw new Error('Admin access is not configured on this copy of the game. Ask the organiser to finish the online setup.');
    api = createOnlineClient(config);
    if (pendingEventCode) showNotice('Sign in to open this event in the admin dashboard.');
  } catch (error) { showNotice(error.name === 'AbortError' ? 'The connection timed out. Reload the page to try again.' : error.message); }
  finally { clearTimeout(timer); setBusy(false); }
}
renderAuth();
void initialize();
