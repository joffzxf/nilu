import {
  LIFE_ENGINE_VERSION,
  LIFETIME_DAYS,
  applyEffort,
  createLife,
  effortLength,
  endLife,
  fastForward,
  formatArea,
  formatDay,
  makeSequence,
  projectFastForward,
  settle,
} from './life.js?v=2.0.2';
import { LifeRenderer } from './render.js?v=2.0.2';
import { Sound } from './audio.js?v=2.0.2';
import { ApiClient, ApiError, makeNonce, randomSeed } from './api.js?v=2.0.2';
import { CONFIG } from './config.js?v=2.0.2';

const $ = (id) => document.getElementById(id);
const isGithubPages = window.location.hostname.endsWith('.github.io');

const state = {
  mode: 'local',
  online: false,
  health: null,
  user: null,
  baseLife: null,
  baseAt: 0,
  events: [],
  died: false,
  justDied: false,
  effort: null,
  effortBusy: false,
  fastOpen: false,
  fastMin: 0,
  endOpen: false,
  booted: false,
  pollTimer: 0,
  saveTimer: 0,
  loginNonce: '',
};

const api = new ApiClient(CONFIG.apiBase);
const sound = new Sound();
let renderer;
let areaFlashTimer = 0;
let lastAreaText = '';

const el = {};

function cacheElements() {
  const ids = [
    'stage', 'area', 'areaValue', 'accountBtn', 'accountAvatar', 'accountMenu', 'accountName',
    'logoutBtn', 'actions', 'fastPanel', 'fastDay', 'fastRange', 'fastWarning', 'fastCancel', 'fastConfirm',
    'effortPanel', 'effortKeys', 'effortProgress', 'effortPad', 'endPanel', 'endCancel',
    'endConfirm', 'veil', 'live',
  ];
  for (const id of ids) el[id] = $(id);
  el.actionButtons = [...el.actions.querySelectorAll('button[data-action]')];
  el.githubIcon = el.accountBtn.querySelector('.orb-github');
}

function copyLife(life) {
  return {
    id: life.id,
    bornAt: life.bornAt,
    age: life.age,
    day: life.day,
    slope: life.slope,
    height: life.height,
    area: life.area,
    efforts: life.efforts,
    status: life.status,
    endReason: life.endReason,
    seed: life.seed,
  };
}

function predictLife(now = Date.now()) {
  if (!state.baseLife) return null;
  const life = copyLife(state.baseLife);
  if (life.status === 'alive') {
    settle(life, Math.max(0, (now - state.baseAt) / 1000));
  }
  return life;
}

function announce(message) {
  if (el.live) el.live.textContent = message;
}

function flashArea() {
  clearTimeout(areaFlashTimer);
  el.area.classList.remove('is-flash');
  void el.area.offsetWidth;
  el.area.classList.add('is-flash');
  areaFlashTimer = window.setTimeout(() => el.area.classList.remove('is-flash'), 760);
}

function updateArea(life) {
  if (!life) return;
  const text = formatArea(life.area);
  if (text === lastAreaText) return;
  lastAreaText = text;
  el.areaValue.textContent = text;
}

function showActions(show) {
  el.actions.hidden = !show;
}

function setActionBusy(busy) {
  for (const button of el.actionButtons) button.disabled = busy;
}

function shake(button) {
  if (!button) return;
  button.classList.remove('is-shaking');
  void button.offsetWidth;
  button.classList.add('is-shaking');
  window.setTimeout(() => button.classList.remove('is-shaking'), 400);
}

function actionButton(name) {
  return el.actions.querySelector(`[data-action="${name}"]`);
}

/* ---------------- rendering loop ---------------- */

function frame(now) {
  requestAnimationFrame(frame);
  if (state.died) {
    renderer.draw(state.baseLife, state.events, now);
    return;
  }
  const life = predictLife();
  if (!life) {
    renderer.draw(null, [], now);
    return;
  }
  if (life.status !== 'alive') {
    triggerDeath(life.endReason || 'lifespan');
    return;
  }
  renderer.draw(life, state.events, now);
  if (!state.fastOpen) updateArea(life);
}

/* ---------------- base state ---------------- */

function setBase(life, events, atMs = Date.now()) {
  state.baseLife = copyLife(life);
  state.baseAt = atMs;
  state.events = Array.isArray(events) ? events.slice().sort((a, b) => a.at - b.at) : [];
  state.booted = true;
  document.body.classList.remove('is-booting');
  updateArea(predictLife());
  if (state.baseLife.status === 'ended') triggerDeath(state.baseLife.endReason || 'manual');
}

function applyServer(data) {
  if (!data || !data.account) return false;
  state.mode = 'online';
  const account = data.account;
  setBase(account, data.events || [], Date.now());
  if (account.status === 'alive') {
    showActions(true);
  }
  return true;
}

function triggerDeath(reason = 'manual') {
  if (state.died) return;
  state.died = true;
  if (state.baseLife) {
    state.baseLife.status = 'ended';
    state.baseLife.endReason = reason;
  }
  try {
    sessionStorage.setItem('nilu.justDied', '1');
  } catch {
    /* ignore */
  }
  closePanels();
  hideAccountMenu();
  el.accountBtn.hidden = true;
  if (!state.booted) el.veil.style.transition = 'none';
  el.area.classList.add('is-fading');
  document.body.classList.add('is-dead');
  showActions(false);
  if (state.mode === 'local') persistLocalEnded();
  sound.end();
  renderer.die(reason);
  announce('这一生结束了。');
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = 0;
  }
}

/* ---------------- local life ---------------- */

function readLocalLife() {
  try {
    const raw = localStorage.getItem('nilu.life');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.life) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistLocalEnded() {
  try {
    const life = state.baseLife;
    if (!life) return;
    localStorage.setItem('nilu.life', JSON.stringify({
      life,
      lastSettledAt: Date.now(),
      events: state.events,
    }));
  } catch {
    /* ignore */
  }
}

function persistLocal() {
  if (state.mode !== 'local' || state.died) return;
  if (state.fastOpen) return;
  const life = predictLife();
  if (!life) return;
  if (life.status !== 'alive') {
    triggerDeath(life.endReason || 'lifespan');
    return;
  }
  const now = Date.now();
  const settled = copyLife(life);
  try {
    localStorage.setItem('nilu.life', JSON.stringify({
      life: settled,
      lastSettledAt: now,
      events: state.events,
    }));
  } catch {
    /* ignore */
  }
  setBase(settled, state.events, now);
}

function createLocalLife() {
  const life = createLife({ seed: randomSeed() });
  life.id = 'local';
  setBase(life, [], Date.now());
  persistLocal();
  showActions(true);
  updateAccountButton();
  announce('开始了。');
}

function loadLocalLife() {
  state.mode = 'local';
  const saved = readLocalLife();
  if (!saved) {
    if (state.justDied) {
      triggerDeath('manual');
      return;
    }
    createLocalLife();
    return;
  }
  const life = saved.life;
  const last = Number(saved.lastSettledAt) || Date.now();
  const delta = Math.max(0, (Date.now() - last) / 1000);
  settle(life, delta);
  if (life.status === 'ended') {
    if (state.justDied) {
      setBase(life, saved.events || [], Date.now());
      triggerDeath(life.endReason || 'manual');
      return;
    }
    createLocalLife();
    return;
  }
  setBase(life, saved.events || [], Date.now());
  if (state.died) return;
  showActions(true);
  updateAccountButton();
  persistLocal();
}

/* ---------------- server account ---------------- */

async function loadServerAccount() {
  let data;
  try {
    data = await api.getAccount();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      api.setToken('');
      state.user = null;
      updateAccountButton();
    }
    loadLocalLife();
    return;
  }

  if (!data.account) {
    if (state.justDied) {
      triggerDeath(data.lastEnded?.endReason || 'manual');
      return;
    }
    try {
      data = await api.createAccount();
    } catch (error) {
      loadLocalLife();
      return;
    }
    if (!data.account) {
      triggerDeath(data.lastEnded?.endReason || 'lifespan');
      return;
    }
  }
  if (!applyServer(data)) {
    loadLocalLife();
    return;
  }
  state.online = true;
  if (state.died) return;
  showActions(true);
  updateAccountButton();
  announce('继续这一生。');
}

async function syncServer() {
  if (state.died || state.mode !== 'online' || !state.user) return;
  try {
    const data = await api.getAccount();
    if (!data.account) {
      triggerDeath(data.lastEnded?.endReason || 'lifespan');
      return;
    }
    applyServer(data);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      api.setToken('');
      state.user = null;
      updateAccountButton();
    }
  }
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = window.setInterval(syncServer, 20000);
}

/* ---------------- account ui ---------------- */

function safeAvatarUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') return '';
    if (url.hostname === 'avatars.githubusercontent.com' || url.hostname.endsWith('.githubusercontent.com')) {
      return url.toString();
    }
  } catch {
    /* ignore */
  }
  return '';
}

function updateAccountButton() {
  if (state.died) {
    el.accountBtn.hidden = true;
    return;
  }
  const canLogin = state.online && (state.user || state.health?.githubOAuth || state.health?.devAuth);
  el.accountBtn.hidden = !canLogin;
  if (!canLogin) return;
  const avatar = state.user ? safeAvatarUrl(state.user.avatarUrl) : '';
  if (avatar) {
    el.accountAvatar.src = avatar;
    el.accountAvatar.hidden = false;
    el.githubIcon.hidden = true;
    el.accountAvatar.onerror = () => {
      el.accountAvatar.hidden = true;
      el.githubIcon.hidden = false;
    };
  } else {
    el.accountAvatar.hidden = true;
    el.githubIcon.hidden = false;
  }
  el.accountBtn.setAttribute('aria-label', state.user ? `账号 ${state.user.login}` : '用 GitHub 登录');
}

function hideAccountMenu() {
  el.accountMenu.hidden = true;
}

function toggleAccountMenu() {
  if (!state.user) return;
  if (!el.accountMenu.hidden) {
    hideAccountMenu();
    return;
  }
  el.accountName.textContent = `@${state.user.login}`;
  el.accountMenu.hidden = false;
}

async function beginGithubLogin() {
  if (!state.online || !state.health?.githubOAuth) return;
  const nonce = makeNonce();
  try {
    sessionStorage.setItem('nilu.loginNonce', nonce);
  } catch {
    return;
  }
  const returnUrl = `${window.location.origin}${window.location.pathname}`;
  window.location.href = api.loginUrl(nonce, returnUrl);
}

async function consumeLoginFragment() {
  const raw = window.location.hash;
  if (!raw || raw.length < 2) return;
  const hashParams = new URLSearchParams(raw.slice(1));
  const code = hashParams.get('login');
  const errorCode = hashParams.get('login_error');
  const nonce = hashParams.get('nonce');
  if (!code && !errorCode) return;

  window.history.replaceState(null, '', `${window.location.origin}${window.location.pathname}${window.location.search}`);
  if (errorCode) return;
  let expected = '';
  try {
    expected = sessionStorage.getItem('nilu.loginNonce') || '';
    sessionStorage.removeItem('nilu.loginNonce');
  } catch {
    expected = '';
  }
  if (!expected || expected !== nonce) return;
  if (!state.online) return;
  try {
    const data = await api.exchange(code);
    api.setToken(data.token);
    state.user = data.user;
  } catch {
    api.setToken('');
    state.user = null;
  }
}

async function refreshMe() {
  if (!api.token || !state.online) return false;
  try {
    const data = await api.me();
    state.user = data.user;
    return true;
  } catch {
    api.setToken('');
    state.user = null;
    return false;
  }
}

async function loginWithDev() {
  if (!state.online || !state.health?.devAuth) return;
  try {
    const data = await api.devLogin('本地行人');
    api.setToken(data.token);
    state.user = data.user;
    updateAccountButton();
    await loadServerAccount();
    if (!state.died && state.mode === 'online') startPolling();
  } catch {
    el.accountBtn.classList.add('is-shaking');
    window.setTimeout(() => el.accountBtn.classList.remove('is-shaking'), 400);
  }
}

async function handleAccountClick() {
  if (state.user) {
    toggleAccountMenu();
    return;
  }
  if (state.health?.githubOAuth) {
    beginGithubLogin();
    return;
  }
  if (state.health?.devAuth) await loginWithDev();
}

async function logout() {
  try {
    await api.logout();
  } catch {
    /* ignore */
  }
  api.setToken('');
  state.user = null;
  state.mode = 'local';
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = 0;
  }
  hideAccountMenu();
  updateAccountButton();
  state.baseLife = null;
  loadLocalLife();
}

/* ---------------- actions ---------------- */

function canAct() {
  return !state.died && state.baseLife && predictLife()?.status === 'alive';
}

function closePanels() {
  el.fastPanel.hidden = true;
  el.effortPanel.hidden = true;
  el.endPanel.hidden = true;
  document.body.classList.remove('has-panel');
  state.fastOpen = false;
  state.endOpen = false;
  state.effort = null;
  setActionBusy(false);
}

async function openFast() {
  if (!canAct() || state.fastOpen) return;
  sound.unlock();
  const life = predictLife();
  const min = Math.min(LIFETIME_DAYS, Math.ceil(life.day));
  if (min >= LIFETIME_DAYS) {
    triggerDeath('lifespan');
    return;
  }
  state.fastOpen = true;
  state.fastMin = min;
  el.fastRange.min = String(min);
  el.fastRange.max = String(LIFETIME_DAYS);
  el.fastRange.value = String(min);
  el.fastPanel.hidden = false;
  document.body.classList.add('has-panel');
  updateFastPreview();
}

function updateFastPreview() {
  const life = predictLife();
  if (!life) return;
  const min = Math.max(state.fastMin, Math.ceil(life.day));
  const target = Math.max(min, Math.min(LIFETIME_DAYS, Number(el.fastRange.value) || min));
  el.fastDay.textContent = formatDay(target);
  const span = Math.max(1, LIFETIME_DAYS - state.fastMin);
  const pct = ((target - state.fastMin) / span) * 100;
  el.fastRange.style.setProperty('--p', `${Math.max(0, Math.min(100, pct))}%`);
  const terminal = target >= LIFETIME_DAYS;
  el.fastPanel.classList.toggle('is-terminal', terminal);
  el.fastWarning.hidden = !terminal;
  const preview = projectFastForward(life, target);
  if (preview.ok) {
    lastAreaText = '';
    updateArea(preview.life);
  }
}

function closeFast(restore = true) {
  el.fastPanel.hidden = true;
  state.fastOpen = false;
  el.fastPanel.classList.remove('is-terminal');
  el.fastWarning.hidden = true;
  document.body.classList.remove('has-panel');
  if (restore) {
    const life = predictLife();
    if (life) {
      lastAreaText = '';
      updateArea(life);
    }
  }
}

async function confirmFast() {
  if (!state.fastOpen || state.died) return;
  const current = predictLife();
  if (!current) return;
  const target = Math.max(Math.ceil(current.day), Math.min(LIFETIME_DAYS, Number(el.fastRange.value) || 0));
  el.fastConfirm.disabled = true;
  try {
    if (state.mode === 'online') {
      const data = await api.fastForward(target);
      closeFast(false);
      if (data.account) {
        applyServer(data);
        if (data.account.status !== 'alive') triggerDeath(data.account.endReason || 'lifespan');
      }
    } else {
      const life = predictLife();
      if (!life) return;
      const result = fastForward(life, target);
      if (!result.ok) {
        shake(actionButton('fast'));
        return;
      }
      closeFast(false);
      if (life.status !== 'alive') {
        setBase(life, state.events, Date.now());
        triggerDeath(life.endReason || 'lifespan');
      } else {
        setBase(life, state.events, Date.now());
        persistLocal();
      }
    }
    renderer.warp();
    flashArea();
  } catch {
    shake(actionButton('fast'));
  } finally {
    el.fastConfirm.disabled = false;
  }
}

/* ---------------- effort ---------------- */

function effortKeysMarkup(sequence) {
  el.effortKeys.replaceChildren();
  sequence.forEach((key, index) => {
    const span = document.createElement('span');
    span.className = 'effort-key';
    span.dataset.index = String(index);
    span.textContent = ['←', '↑', '→', '↓'][key];
    el.effortKeys.append(span);
  });
}

function renderEffortProgress() {
  if (!state.effort) return;
  const { sequence, index } = state.effort;
  [...el.effortKeys.children].forEach((node, i) => {
    node.classList.toggle('is-done', i < index);
    node.classList.toggle('is-current', i === index);
  });
  el.effortProgress.style.width = `${(index / sequence.length) * 100}%`;
}

function openEffortPanel(effort) {
  state.effort = effort;
  el.effortPanel.classList.remove('is-error');
  effortKeysMarkup(effort.sequence);
  renderEffortProgress();
  el.effortPanel.hidden = false;
  document.body.classList.add('has-panel');
  setActionBusy(false);
}

async function openEffort() {
  if (!canAct() || state.effortBusy || state.effort) return;
  sound.unlock();
  state.effortBusy = true;
  try {
    if (state.mode === 'online') {
      const data = await api.startEffort();
      if (data.account) applyServer(data);
      if (state.died) return;
      if (!data.sequence) return;
      openEffortPanel({ id: data.effortId, sequence: data.sequence, keys: [], index: 0 });
    } else {
      const life = predictLife();
      if (!life) return;
      const length = effortLength(life.efforts);
      openEffortPanel({
        id: null,
        sequence: makeSequence(life.seed, life.efforts, length),
        keys: [],
        index: 0,
      });
    }
  } catch {
    shake(actionButton('effort'));
  } finally {
    state.effortBusy = false;
  }
}

function closeEffort() {
  state.effort = null;
  el.effortPanel.hidden = true;
  el.effortPanel.classList.remove('is-error');
  document.body.classList.remove('has-panel');
  setActionBusy(false);
}

function effortWrong() {
  sound.miss();
  renderer.burst('wrong');
  el.effortPanel.classList.add('is-error');
  const effort = state.effort;
  if (effort) effort.locked = true;
  if (effort && effort.id && state.mode === 'online') {
    api.completeEffort(effort.id, effort.keys).catch(() => {});
  }
  window.setTimeout(() => closeEffort(), 360);
}

async function finishEffort() {
  const effort = state.effort;
  if (!effort) return;
  const keys = effort.keys.slice();
  closeEffort();
  if (state.mode === 'online' && effort.id) {
    try {
      const data = await api.completeEffort(effort.id, keys);
      if (data.account) applyServer(data);
      if (data.ok) {
        sound.success();
        renderer.burst('effort');
        flashArea();
      } else {
        sound.miss();
        renderer.burst('wrong');
      }
    } catch {
      shake(actionButton('effort'));
    }
    return;
  }

  const life = predictLife();
  if (!life) return;
  applyEffort(life);
  state.events.push({ at: life.age, slope: life.slope, type: 'effort' });
  state.events.sort((a, b) => a.at - b.at);
  setBase(life, state.events, Date.now());
  persistLocal();
  sound.success();
  renderer.burst('effort');
  flashArea();
}

async function handleEffortKey(index) {
  if (!state.effort || state.effort.locked || el.effortPanel.hidden) return;
  const effort = state.effort;
  const expected = effort.sequence[effort.index];
  if (index !== expected) {
    effort.keys.push(index);
    effortWrong();
    return;
  }
  effort.keys.push(index);
  effort.index += 1;
  sound.key(index, effort.index);
  renderEffortProgress();
  if (effort.index >= effort.sequence.length) {
    await finishEffort();
  }
}

/* ---------------- end ---------------- */

function openEnd() {
  if (!canAct() || state.endOpen) return;
  state.endOpen = true;
  el.endPanel.hidden = false;
  document.body.classList.add('has-panel');
}

function closeEnd() {
  state.endOpen = false;
  el.endPanel.hidden = true;
  document.body.classList.remove('has-panel');
}

async function confirmEnd() {
  if (!state.endOpen || state.died) return;
  el.endConfirm.disabled = true;
  try {
    if (state.mode === 'online') {
      await api.endAccount();
      closeEnd();
      triggerDeath('manual');
    } else {
      const life = predictLife();
      if (life) {
        endLife(life, 'manual');
        setBase(life, state.events, Date.now());
        persistLocalEnded();
      }
      closeEnd();
      triggerDeath('manual');
    }
  } catch {
    shake(actionButton('end'));
  } finally {
    el.endConfirm.disabled = false;
  }
}

/* ---------------- events ---------------- */

function bind() {
  el.accountBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    handleAccountClick();
  });
  el.logoutBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    logout();
  });
  document.addEventListener('click', (event) => {
    if (!el.accountMenu.hidden && !el.accountMenu.contains(event.target)) hideAccountMenu();
  });

  for (const button of el.actionButtons) {
    button.addEventListener('click', () => {
      const action = button.dataset.action;
      if (action === 'fast') openFast();
      else if (action === 'effort') openEffort();
      else if (action === 'end') openEnd();
    });
  }

  el.fastRange.addEventListener('input', updateFastPreview);
  el.fastCancel.addEventListener('click', () => closeFast(true));
  el.fastConfirm.addEventListener('click', confirmFast);
  el.fastPanel.addEventListener('click', (event) => {
    if (event.target === el.fastPanel) closeFast(true);
  });

  el.effortPad.addEventListener('pointerdown', (event) => {
    const button = event.target.closest('button[data-key]');
    if (!button) return;
    event.preventDefault();
    handleEffortKey(Number(button.dataset.key));
  });

  el.endCancel.addEventListener('click', closeEnd);
  el.endConfirm.addEventListener('click', confirmEnd);
  el.endPanel.addEventListener('click', (event) => {
    if (event.target === el.endPanel) closeEnd();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.effort) closeEffort();
      else if (state.fastOpen) closeFast(true);
      else if (state.endOpen) closeEnd();
      return;
    }
    if (state.effort && !el.effortPanel.hidden) {
      const map = { ArrowLeft: 0, ArrowUp: 1, ArrowRight: 2, ArrowDown: 3 };
      if (event.key in map) {
        event.preventDefault();
        if (!event.repeat) handleEffortKey(map[event.key]);
      }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.mode === 'local') persistLocal();
    } else {
      if (state.mode === 'online') syncServer();
      if (state.mode === 'local') persistLocal();
    }
  });

  window.addEventListener('pagehide', () => {
    if (state.mode === 'local') persistLocal();
  });

  window.setInterval(() => {
    if (state.mode === 'local' && !state.died) persistLocal();
  }, 15000);
}

/* ---------------- boot ---------------- */

async function boot() {
  cacheElements();
  try {
    state.justDied = sessionStorage.getItem('nilu.justDied') === '1';
  } catch {
    state.justDied = false;
  }
  renderer = new LifeRenderer(el.stage);
  bind();
  requestAnimationFrame(frame);

  if (!isGithubPages || CONFIG.apiBase) {
    const health = await api.probe();
    if (health && health.engineVersion === LIFE_ENGINE_VERSION) {
      state.online = true;
      state.health = health;
    }
  }

  if (state.online) {
    await consumeLoginFragment();
    if (api.token) await refreshMe();
    updateAccountButton();
    if (state.user) {
      await loadServerAccount();
      if (!state.died && state.mode === 'online') startPolling();
    } else {
      loadLocalLife();
    }
  } else {
    updateAccountButton();
    loadLocalLife();
  }
  updateAccountButton();
  document.body.classList.remove('is-booting');
}

boot().catch((error) => {
  console.error(error);
  loadLocalLife();
  document.body.classList.remove('is-booting');
});
