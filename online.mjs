import { createOnlineClient, validateOnlineConfig } from './online-api.mjs';

/** QR invitations open the event directly; no player code entry is needed. */
export function initOnline({ onJoin, onLeave, onScores, onBlocked, onActionBusy, notice }) {
  const panel = document.createElement('section');
  panel.id = 'online-panel';
  panel.className = 'online-panel panel';
  panel.setAttribute('aria-label', 'Event invitation');
  panel.innerHTML = `
    <div class="online-top" id="qr-welcome"><div><p class="panel-kicker">SCAN. JOIN. PLAY.</p><h2 id="online-title">Scan your event QR code</h2><p id="online-description">Use your phone’s camera to scan the QR code your organiser displays, or open their invitation link. You’ll join the right event automatically.</p></div><div class="online-actions"><button class="button secondary" id="practice-button" type="button">Try a practice round</button></div></div>
    <div id="shared-event-details" hidden><div class="shared-event-heading"><h2 id="shared-event-name"></h2><span class="chip" id="shared-event-state"></span></div><p class="shared-join-instructions" id="shared-join-instructions">You’re in. Enter your name below, then start your round.</p><p class="help-text">Your name and score are visible to everyone with this event invitation.</p></div>
    <div class="shared-toolbar"><p id="shared-status" role="status" aria-live="polite"></p><div class="online-actions"><button class="button secondary" id="retry-connection" type="button" hidden>Retry connection</button><button class="text-button" id="refresh-leaderboard" type="button" hidden>Refresh scores</button><button class="text-button" id="projector-toggle" type="button" hidden>Projector view</button><button class="text-button" id="leave-event" type="button" hidden>Back to welcome</button></div></div>`;
  const game = document.querySelector('.game-layout');
  const leaderboard = document.querySelector('.leaderboard');
  game.before(panel);

  const $ = (id) => document.getElementById(id);
  let roundBusy = false;
  let actionBusy = false;
  let mode = 'welcome';
  let retryable = false;
  let eventVersion = 0;
  let boardRequest = null;
  let disposed = false;
  let projector = new URL(location.href).searchParams.get('view') === 'leaderboard';
  const controller = {
    api: null,
    event: null,
    ready: null,
    get busy() { return actionBusy; },
    setRoundBusy(value) { roundBusy = Boolean(value); updateDisabled(); },
    refreshLeaderboard,
    dispose() {
      disposed = true;
      clearInterval(poll);
      document.removeEventListener('visibilitychange', visibilityRefresh);
    },
  };

  function status(message, failed = false) {
    $('shared-status').textContent = message;
    $('shared-status').classList.toggle('shared-status-error', failed);
  }
  function updateDisabled() {
    onActionBusy?.(actionBusy);
    const busy = roundBusy || actionBusy;
    for (const id of ['practice-button', 'leave-event', 'retry-connection']) $(id).disabled = busy;
  }
  function setProjector(value) {
    projector = Boolean(value && controller.event);
    document.body.classList.toggle('projector-mode', projector);
    $('projector-toggle').textContent = projector ? 'Back to game' : 'Projector view';
    const url = new URL(location.href);
    if (projector) url.searchParams.set('view', 'leaderboard');
    else url.searchParams.delete('view');
    history.replaceState(null, '', url);
  }
  function renderMode() {
    const event = controller.event;
    const joined = mode === 'event' && Boolean(event);
    game.hidden = !joined && mode !== 'practice';
    leaderboard.hidden = !joined && mode !== 'practice';
    document.body.classList.toggle('event-joined', joined);
    $('qr-welcome').hidden = joined;
    $('shared-event-details').hidden = !joined;
    $('refresh-leaderboard').hidden = !joined;
    $('projector-toggle').hidden = !joined;
    $('practice-button').hidden = joined || mode === 'practice';
    $('retry-connection').hidden = mode !== 'error' || !retryable;
    $('leave-event').hidden = mode === 'welcome';
    $('leave-event').textContent = joined ? 'Leave event' : 'Back to welcome';
    if (joined) {
      $('shared-event-name').textContent = event.title;
      $('shared-event-state').textContent = event.active ? 'Joined event' : 'Closed to new entries';
      $('shared-join-instructions').textContent = event.active
        ? 'You’re in. Enter your name below, then start your round.'
        : 'This event is closed to new rounds. You can still view the leaderboard below.';
    } else {
      const copy = {
        welcome: ['Scan your event QR code', 'Use your phone’s camera to scan the QR code your organiser displays, or open their invitation link. You’ll join the right event automatically.'],
        connecting: ['Opening your event…', 'We’re connecting you to the event from your invitation. No code or account is needed.'],
        error: ['We couldn’t open your event', 'Check your connection and try again, or ask your organiser for the current QR code. Practice rounds stay on this device and do not enter the event leaderboard.'],
        practice: ['Practice on this device', 'This is a practice round. To join your event and its shared leaderboard, scan the QR code provided by your organiser.'],
      };
      [$('online-title').textContent, $('online-description').textContent] = copy[mode];
      $('practice-button').textContent = mode === 'error' ? 'Try practice instead' : 'Try a practice round';
    }
    updateDisabled();
  }
  function openPractice(practice) {
    if (roundBusy || actionBusy) return;
    eventVersion += 1;
    controller.event = null;
    const url = new URL(location.href);
    url.searchParams.delete('event');
    url.searchParams.delete('view');
    history.replaceState(null, '', url);
    setProjector(false);
    mode = practice ? 'practice' : 'welcome';
    retryable = false;
    onLeave();
    status(practice ? 'Practice only · scores stay in this browser.' : '');
    renderMode();
    if (practice) $('player-name').focus({ preventScroll: true });
  }
  async function loadApi() {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10_000);
    try {
      const response = await fetch(new URL('./config.json', import.meta.url), { signal: abort.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('The event connection could not be loaded. Please try again.');
      let config;
      try { config = await response.json(); }
      catch { throw new Error('The event connection could not be loaded. Please try again.'); }
      const connection = { url: config.supabaseUrl, key: config.supabaseKey };
      if (!validateOnlineConfig(connection).valid) throw new Error('Shared events are not ready on this copy of the game. Ask your organiser for the current invitation.');
      controller.api = createOnlineClient(connection);
    } finally { clearTimeout(timeout); }
  }
  async function connect() {
    if (roundBusy || actionBusy || disposed) return;
    const params = new URL(location.href).searchParams;
    if (!params.has('event')) { mode = 'welcome'; renderMode(); return; }
    actionBusy = true;
    mode = 'connecting';
    retryable = false;
    onBlocked('Connecting to your event…');
    status('');
    renderMode();
    try {
      const code = (params.get('event') || '').trim().toLowerCase();
      if (!/^[a-f0-9]{12}$/.test(code)) {
        const error = new Error('This invitation link is incomplete or invalid. Scan the organiser’s event QR code again.');
        error.code = 'invalid_invitation';
        throw error;
      }
      await loadApi();
      const event = await controller.api.getEvent(code);
      if (disposed) return;
      eventVersion += 1;
      controller.event = event;
      const url = new URL(location.href);
      url.searchParams.set('event', event.code);
      history.replaceState(null, '', url);
      mode = 'event';
      onJoin(event);
      notice('');
      renderMode();
      setProjector(projector);
      status('Loading shared scores…');
      void refreshLeaderboard();
    } catch (error) {
      if (disposed) return;
      mode = 'error';
      retryable = !['invalid_invitation', 'event_not_found'].includes(error.code);
      const message = error.code === 'event_not_found' ? 'This invitation does not open an event. Ask your organiser for the current QR code.'
        : error.code === 'backend_not_ready' ? 'This event is not ready to join yet. Ask your organiser to finish its setup.'
        : error.name === 'AbortError' ? 'The connection timed out. Please retry.'
        : error instanceof TypeError ? 'Unable to connect to your event. Check your internet connection and retry.' : error.message;
      onBlocked(message);
      status(message, true);
      renderMode();
    } finally { actionBusy = false; updateDisabled(); }
  }
  function refreshLeaderboard() {
    if (!controller.event || !controller.api || disposed) return Promise.resolve();
    const code = controller.event.code;
    const version = eventVersion;
    if (boardRequest?.version === version) return boardRequest.promise;
    const request = { version, promise: null };
    request.promise = (async () => {
      try {
        const entries = await controller.api.leaderboard(code);
        if (version !== eventVersion || disposed) return;
        if (!Array.isArray(entries)) throw new Error('The scoreboard response was incomplete. Try refreshing.');
        onScores(entries);
        status('Scores are up to date · refreshes every 5 seconds');
      } catch (error) {
        if (version === eventVersion && !disposed) status(`Could not refresh scores. ${error.message}`, true);
      } finally { if (boardRequest === request) boardRequest = null; }
    })();
    boardRequest = request;
    return request.promise;
  }

  $('practice-button').addEventListener('click', () => openPractice(true));
  $('leave-event').addEventListener('click', () => openPractice(false));
  $('retry-connection').addEventListener('click', () => { void connect(); });
  $('refresh-leaderboard').addEventListener('click', () => { status('Refreshing scores…'); void refreshLeaderboard(); });
  $('projector-toggle').addEventListener('click', () => setProjector(!projector));
  const visibilityRefresh = () => { if (!document.hidden) void refreshLeaderboard(); };
  const poll = setInterval(visibilityRefresh, 5000);
  document.addEventListener('visibilitychange', visibilityRefresh);
  renderMode();
  controller.ready = Promise.resolve().then(connect);
  return controller;
}
