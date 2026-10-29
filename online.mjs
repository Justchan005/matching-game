import { createOnlineClient, validateOnlineConfig } from './online-api.mjs';

/** Shared-event controls. Host credentials and sessions remain in memory only. */
export function initOnline({ onJoin, onLeave, onScores, onBlocked, onActionBusy, getScenarios, notice }) {
  const panel = document.createElement('section');
  panel.id = 'online-panel';
  panel.className = 'online-panel panel';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'online-title');
  panel.innerHTML = `
    <div class="online-top"><div><p class="panel-kicker">BRING EVERYONE TOGETHER</p><h2 id="online-title">Play together</h2><p id="online-description">Join the same event from different devices and share a leaderboard.</p></div><div class="online-actions"><button class="button secondary" id="join-event-button" type="button">Join event</button><button class="button primary" id="host-event-button" type="button">Host event</button></div></div>
    <div id="shared-event-details" hidden><div class="shared-event-heading"><h3 id="shared-event-name"></h3><span class="chip" id="shared-event-state"></span></div><div class="share-row"><div class="field"><label for="share-url">Invite players with this link</label><input id="share-url" type="text" readonly></div><button class="button secondary" id="copy-invite" type="button">Copy link</button></div><p class="help-text">Names and scores are visible to anyone with this event link. Events expire after 7 days.</p></div>
    <div class="shared-toolbar"><p id="shared-status" role="status" aria-live="polite"></p><div class="online-actions"><button class="text-button" id="refresh-leaderboard" type="button" hidden>Refresh scores</button><button class="text-button" id="projector-toggle" type="button" hidden>Projector view</button><button class="text-button" id="close-event" type="button" hidden>Close new entries</button><button class="text-button" id="leave-event" type="button" hidden>Leave event</button></div></div>`;
  document.querySelector('.game-layout').before(panel);

  const dialogs = document.createElement('div');
  dialogs.innerHTML = `
    <dialog class="modal" id="join-event-dialog" aria-labelledby="join-event-title"><form id="join-form"><div class="modal-header"><h2 id="join-event-title">Join your event.</h2><button class="close-button" type="button" data-online-close="join-event-dialog" aria-label="Close join event">×</button></div><div class="modal-body"><p>Enter the event code your host shared with you.</p><div class="field"><label for="join-code">Event code</label><input id="join-code" type="text" required maxlength="200" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="12-character event code"></div><p class="form-error" id="join-error" role="alert" hidden></p></div><div class="modal-footer"><button class="button primary" id="join-submit" type="submit">Join event →</button></div></form></dialog>
    <dialog class="modal" id="host-event-dialog" aria-labelledby="host-event-title"><div class="modal-header"><h2 id="host-event-title">Host your event.</h2><button class="close-button" type="button" data-online-close="host-event-dialog" aria-label="Close host event">×</button></div><div class="modal-body"><form id="host-login-form" class="online-form"><p>Sign in with your event host account. Players can join without an account.</p><div class="field"><label for="host-email">Host email</label><input id="host-email" type="email" autocomplete="username" required></div><div class="field"><label for="host-password">Password</label><input id="host-password" type="password" autocomplete="current-password" required></div><button class="button primary" id="host-login-submit" type="submit">Sign in →</button></form><form id="host-create-form" class="online-form" hidden><p id="host-signed-in"></p><div class="field"><label for="host-title">Event name</label><input id="host-title" type="text" maxlength="80" required placeholder="e.g. Patient Journey Challenge"></div><div class="field"><label for="host-scenario">Scenario for everyone</label><select id="host-scenario" required></select></div><p class="help-text">To use your own scenario, close this window and choose Add your scenario first. Each event has its own leaderboard and lasts 7 days.</p><button class="button primary" id="host-create-submit" type="submit">Create event →</button><button class="text-button" id="host-signout" type="button">Sign out</button></form><p class="form-error" id="host-error" role="alert" hidden></p></div></dialog>`;
  document.body.append(dialogs);

  const $ = (id) => document.getElementById(id);
  let roundBusy = false;
  let actionBusy = false;
  let session = null;
  let hostEmail = '';
  let eventVersion = 0;
  let boardRequest = null;
  let boardCode = null;
  let disposed = false;
  let projector = new URL(location.href).searchParams.get('view') === 'leaderboard';
  const originalEvent = new URL(location.href).searchParams.get('event');
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
      session = null;
    },
  };

  function setError(id, message) { $(id).textContent = message; $(id).hidden = !message; }
  function status(message, failed = false) {
    $('shared-status').textContent = message;
    $('shared-status').classList.toggle('shared-status-error', failed);
  }
  function updateDisabled() {
    onActionBusy?.(actionBusy);
    const busy = roundBusy || actionBusy;
    for (const id of ['join-event-button', 'host-event-button', 'join-submit', 'host-login-submit', 'host-create-submit']) {
      $(id).disabled = busy || !controller.api;
    }
    for (const id of ['leave-event', 'close-event', 'host-signout']) $(id).disabled = busy;
    dialogs.querySelectorAll('[data-online-close]').forEach((button) => { button.disabled = actionBusy; });
    $('close-event').hidden = !session || !controller.event || !controller.event.active;
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
  function renderHost() {
    $('host-login-form').hidden = Boolean(session);
    $('host-create-form').hidden = !session;
    $('host-signed-in').textContent = session ? `Signed in as ${hostEmail}` : '';
    $('host-scenario').replaceChildren(...getScenarios().map((scenario) => {
      const option = document.createElement('option');
      option.value = scenario.id;
      option.textContent = scenario.title;
      return option;
    }));
    updateDisabled();
  }
  function renderEvent() {
    const event = controller.event;
    panel.hidden = !controller.api && !new URL(location.href).searchParams.has('event');
    $('shared-event-details').hidden = !event;
    $('refresh-leaderboard').hidden = !event;
    $('projector-toggle').hidden = !event;
    $('leave-event').hidden = !event && !new URL(location.href).searchParams.has('event');
    if (event) {
      $('online-description').textContent = 'You are playing together. All devices share this event’s leaderboard.';
      $('shared-event-name').textContent = event.title;
      $('shared-event-state').textContent = event.active ? `CODE ${event.code}` : 'CLOSED TO NEW ENTRIES';
      const url = new URL(location.href);
      url.searchParams.set('event', event.code);
      url.searchParams.delete('view');
      $('share-url').value = url.href;
    } else {
      $('online-description').textContent = 'Join the same event from different devices and share a leaderboard.';
    }
    updateDisabled();
  }
  async function acceptEvent(event) {
    eventVersion += 1;
    controller.event = event;
    const url = new URL(location.href);
    url.searchParams.set('event', event.code);
    history.replaceState(null, '', url);
    renderEvent();
    onJoin(event);
    setProjector(projector);
    status('Loading shared scores…');
    await refreshLeaderboard();
  }
  async function join(code, fromLink = false) {
    if (!controller.api || roundBusy || actionBusy) return;
    actionBusy = true;
    updateDisabled();
    setError('join-error', '');
    if (fromLink) onBlocked('Connecting to your shared event…');
    try {
      let normalized = code.trim();
      if (/^https?:\/\//i.test(normalized)) normalized = new URL(normalized).searchParams.get('event') || '';
      normalized = normalized.toLowerCase();
      if (!/^[a-f0-9]{12}$/.test(normalized)) throw new Error('Enter the 12-character event code or the full invite link.');
      await acceptEvent(await controller.api.getEvent(normalized));
      $('join-event-dialog').close();
    } catch (error) {
      setError('join-error', error.message);
      status(error.message, true);
      if (fromLink) { onBlocked(error.message); notice(error.message); }
    } finally { actionBusy = false; renderEvent(); }
  }
  function leave() {
    if (roundBusy || actionBusy) return;
    eventVersion += 1;
    controller.event = null;
    const url = new URL(location.href);
    url.searchParams.delete('event');
    url.searchParams.delete('view');
    history.replaceState(null, '', url);
    setProjector(false);
    status('You are now playing on this device only.');
    renderEvent();
    onLeave();
  }
  async function hostToken() {
    if (!session) throw new Error('Sign in with your host account first.');
    if (session.expires_at <= Math.floor(Date.now() / 1000) + 30) {
      try { session = await controller.api.refreshSession(session.refresh_token); }
      catch (error) { session = null; renderHost(); throw error; }
    }
    return session.access_token;
  }
  function refreshLeaderboard() {
    if (!controller.event || !controller.api || disposed) return Promise.resolve();
    const code = controller.event.code;
    const version = eventVersion;
    if (boardRequest && boardCode === code) return boardRequest;
    boardCode = code;
    const request = (async () => {
      try {
        const entries = await controller.api.leaderboard(code);
        if (version !== eventVersion || disposed) return;
        if (!Array.isArray(entries)) throw new Error('The scoreboard response was incomplete. Try refreshing.');
        onScores(entries);
        status('Scores are up to date · refreshes every 5 seconds');
      } catch (error) {
        if (version === eventVersion && !disposed) status(`Could not refresh scores. ${error.message}`, true);
      } finally {
        if (boardRequest === request) boardRequest = null;
      }
    })();
    boardRequest = request;
    return request;
  }

  $('join-event-button').addEventListener('click', () => {
    setError('join-error', '');
    $('join-event-dialog').showModal();
  });
  $('host-event-button').addEventListener('click', () => {
    renderHost();
    setError('host-error', '');
    $('host-event-dialog').showModal();
  });
  dialogs.querySelectorAll('[data-online-close]').forEach((button) => {
    button.addEventListener('click', () => { if (!actionBusy) $(button.dataset.onlineClose).close(); });
  });
  dialogs.querySelectorAll('dialog').forEach((dialog) => {
    dialog.addEventListener('cancel', (event) => { if (actionBusy) event.preventDefault(); });
  });
  $('join-form').addEventListener('submit', (event) => { event.preventDefault(); void join($('join-code').value); });
  $('leave-event').addEventListener('click', leave);
  $('refresh-leaderboard').addEventListener('click', () => { status('Refreshing scores…'); void refreshLeaderboard(); });
  $('projector-toggle').addEventListener('click', () => setProjector(!projector));
  $('copy-invite').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('share-url').value);
      status('Invite link copied. Share it with your players.');
    } catch {
      $('share-url').focus();
      $('share-url').select();
      status('Select and copy the invite link above.');
    }
  });
  $('host-login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (actionBusy || roundBusy) return;
    actionBusy = true;
    updateDisabled();
    setError('host-error', '');
    try {
      hostEmail = $('host-email').value.trim();
      session = await controller.api.signIn(hostEmail, $('host-password').value);
      renderHost();
    } catch (error) { setError('host-error', error.message); }
    finally { $('host-password').value = ''; actionBusy = false; updateDisabled(); }
  });
  $('host-create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (actionBusy || roundBusy) return;
    actionBusy = true;
    updateDisabled();
    setError('host-error', '');
    try {
      const scenario = getScenarios().find((entry) => entry.id === $('host-scenario').value);
      if (!scenario) throw new Error('Choose a scenario for your event.');
      const created = await controller.api.createEvent($('host-title').value.trim(), scenario, await hostToken());
      await acceptEvent(created);
      $('host-event-dialog').close();
    } catch (error) { setError('host-error', error.message); }
    finally { actionBusy = false; updateDisabled(); }
  });
  $('host-signout').addEventListener('click', async () => {
    if (actionBusy || roundBusy) return;
    actionBusy = true;
    updateDisabled();
    const oldSession = session;
    session = null;
    try { if (oldSession) await controller.api.signOut(oldSession.access_token); }
    catch { setError('host-error', 'Signed out on this page. The online sign-out request could not be confirmed.'); }
    finally { actionBusy = false; renderHost(); }
  });
  $('close-event').addEventListener('click', async () => {
    if (actionBusy || roundBusy || !controller.event) return;
    actionBusy = true;
    updateDisabled();
    try {
      await controller.api.closeEvent(controller.event.code, await hostToken());
      controller.event = await controller.api.getEvent(controller.event.code);
      renderEvent();
      onJoin(controller.event);
      status('New entries are closed. Players already in a round can finish.');
    } catch (error) { notice(error.message); }
    finally { actionBusy = false; updateDisabled(); }
  });

  const visibilityRefresh = () => { if (!document.hidden) void refreshLeaderboard(); };
  const poll = setInterval(visibilityRefresh, 5000);
  document.addEventListener('visibilitychange', visibilityRefresh);
  controller.ready = Promise.resolve().then(async () => {
    if (originalEvent) onBlocked('Connecting to your shared event…');
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10_000);
    try {
      const response = await fetch(new URL('./config.json', import.meta.url), { signal: abort.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Shared events are not available on this copy of the game yet.');
      const config = await response.json();
      if (!config.supabaseUrl && !config.supabaseKey && !originalEvent) return;
      const connection = { url: config.supabaseUrl, key: config.supabaseKey };
      if (!validateOnlineConfig(connection).valid) throw new Error('Shared events are not available on this copy of the game yet. Ask your host for the current event link.');
      controller.api = createOnlineClient(connection);
      renderEvent();
      if (originalEvent) await join(originalEvent, true);
    } catch {
      if (originalEvent) {
        panel.hidden = false;
        const message = 'Unable to connect to this shared event. Check your connection and reload, or leave the event to practice on this device.';
        status(message, true);
        $('leave-event').hidden = false;
        onBlocked(message);
        notice(message);
      } else notice('Shared play is unavailable right now. You can still practice on this device.');
    } finally { clearTimeout(timeout); updateDisabled(); }
  });
  return controller;
}
