import {
  advance,
  createRun,
  getResult,
  ENGINE_VERSION,
  TICK_MS,
  DEFAULT_DURATION_TICKS,
  KEY_TO_INDEX,
  ARROW_GLYPHS,
} from './engine.js';
import { StageRenderer, renderCurvePreview, sparklineSvg } from './render.js';
import { Sound } from './audio.js';
import { ApiClient, ApiError, randomSeed, makeNonce } from './api.js';
import { CONFIG } from './config.js';

const $ = (id) => document.getElementById(id);
const numberFmt = new Intl.NumberFormat('zh-CN');
const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);

const params = new URLSearchParams(window.location.search);
const fastSeconds = isLocalHost ? Number(params.get('fast')) : 0;
const FAST_TICKS = Number.isFinite(fastSeconds) && fastSeconds >= 10 && fastSeconds <= 60
  ? Math.round(fastSeconds * 60)
  : 0;

const state = {
  screen: 'landing',
  run: null,
  result: null,
  challenge: null,
  inputs: [],
  pendingInputs: new Map(),
  lastScheduledTick: -1,
  startedAt: 0,
  pausedAt: 0,
  pausedTotal: 0,
  accumulator: 0,
  lastFrame: 0,
  countdownToken: 0,
  online: false,
  health: null,
  user: null,
  localRuns: [],
  soundOn: true,
  boardScope: 'all',
  boardData: null,
  boardBusy: false,
  submitted: false,
  submitState: 'idle',
  rank: null,
  totalAccounts: 0,
  earlyEnd: false,
  promptNodeKey: '',
  boardReturnFocus: null,
  starting: false,
  isCoarse: false,
};

const api = new ApiClient(CONFIG.apiBase);
const sound = new Sound();
let renderer;
let gainTimer = 0;
let toastTimer = 0;
let lastCardFlash = 0;

const el = {};

function cacheElements() {
  const ids = [
    'stage', 'landing', 'startBtn', 'boardBtnLanding', 'bestLocal', 'bestLocalMeta', 'landingHint',
    'versionTag', 'ghLink', 'hud', 'scoreValue', 'slopeValue', 'comboValue', 'timeValue', 'gainToast',
    'timeBar', 'deck', 'promptCard', 'promptLabel', 'promptKeys', 'promptTimer', 'promptTimerText',
    'promptHint', 'countdown', 'countdownNum', 'pause', 'resumeBtn', 'pauseQuitBtn', 'end', 'endScore',
    'endLine', 'endSlope', 'endCombo', 'endSuccesses', 'endMisses', 'endInsight', 'againBtn',
    'endBoardBtn', 'shareBtn', 'endRank', 'endAuth', 'retrySubmitBtn', 'touchPad', 'soundBtn',
    'pauseBtn', 'boardBtn', 'accountArea', 'boardDialog', 'boardTitle', 'boardSub', 'boardClose',
    'boardTabs', 'boardList', 'boardEmpty', 'boardFootNote', 'boardLoginBtn', 'loginDialog',
    'loginClose', 'loginBody', 'loginIntro', 'loginSmall', 'githubLoginBtn', 'devLoginBtn', 'offlineStartBtn', 'loginNote', 'runDialog', 'runClose',    'runTitle', 'runMeta', 'runCanvas', 'runStats', 'toast', 'live',
  ];
  for (const id of ids) el[id] = $(id);
  el.soundOnIcon = el.soundBtn.querySelector('.icon-sound-on');
  el.soundOffIcon = el.soundBtn.querySelector('.icon-sound-off');
}

function show(node) { if (node) node.hidden = false; }
function hide(node) { if (node) node.hidden = true; }

function toast(message, error = false) {
  if (!el.toast) return;
  clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.toggle('is-error', error);
  el.toast.classList.add('is-on');
  toastTimer = window.setTimeout(() => el.toast.classList.remove('is-on'), 2800);
}

function announce(message) {
  if (el.live) el.live.textContent = message;
}

function formatScore(value) {
  return numberFmt.format(Math.max(0, Math.round(Number(value) || 0)));
}

function formatClock(seconds) {
  const safe = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}.${day}`;
}

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

function readLocalRuns() {
  try {
    const raw = localStorage.getItem('nilu.localRuns');
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((run) => run && Number.isFinite(run.score) && Number.isFinite(run.date)).slice(0, 20);
  } catch {
    return [];
  }
}

function writeLocalRuns(runs) {
  try {
    localStorage.setItem('nilu.localRuns', JSON.stringify(runs.slice(0, 20)));
  } catch {
    /* ignore */
  }
}

function saveLocalRun(result, source = 'local') {
  if (!result) return;
  const entry = {
    score: Math.round(result.score),
    maxSlope: Number(result.slope || result.maxSlope || 0),
    successes: Number(result.successes || 0),
    misses: Number(result.misses || 0),
    maxCombo: Number(result.maxCombo || 0),
    curve: Array.isArray(result.curve) ? result.curve.slice(0, 240) : [],
    date: Date.now(),
    durationTicks: Number(result.durationTicks || DEFAULT_DURATION_TICKS),
    source,
  };
  state.localRuns = [entry, ...state.localRuns].slice(0, 20);
  writeLocalRuns(state.localRuns);
  updateBest();
}

function updateBest() {
  if (!el.bestLocal) return;
  if (!state.localRuns.length) {
    el.bestLocal.textContent = '—';
    el.bestLocalMeta.textContent = '';
    return;
  }
  const best = state.localRuns.reduce((top, run) => (run.score > top.score ? run : top), state.localRuns[0]);
  el.bestLocal.textContent = formatScore(best.score);
  el.bestLocalMeta.textContent = `· ${state.localRuns.length} 程留在这台设备`;
}

function updateLandingMeta() {
  if (el.versionTag) el.versionTag.textContent = state.online ? 'v1.0 · 账号已接通' : 'v1.0 · 本地 Demo';
  if (el.landingHint) {
    if (!state.online) {
      el.landingHint.textContent = '← ↑ → ↓　·　账号服务未接通，成绩只留本机';
    } else if (!state.health?.githubOAuth && !state.health?.devAuth) {
      el.landingHint.textContent = '← ↑ → ↓　·　无需登录也能走，账号登录暂未配置';
    } else {
      el.landingHint.textContent = '← ↑ → ↓　·　无需登录也能走，登录后进入总榜';
    }
  }
  if (el.ghLink) el.ghLink.href = CONFIG.repoUrl;
}

function updateSoundUi() {
  if (!el.soundBtn) return;
  el.soundBtn.setAttribute('aria-label', state.soundOn ? '关闭声音' : '开启声音');
  el.soundBtn.title = state.soundOn ? '关闭声音' : '开启声音';
  if (el.soundOnIcon) el.soundOnIcon.hidden = !state.soundOn;
  if (el.soundOffIcon) el.soundOffIcon.hidden = state.soundOn;
}

/* ---------------- account ---------------- */

function githubIcon() {
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';
}

function updateAccountUi() {
  const area = el.accountArea;
  if (!area) return;
  area.replaceChildren();

  if (state.user) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'account-btn';
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    const avatar = safeAvatarUrl(state.user.avatarUrl);
    if (avatar) {
      const img = document.createElement('img');
      img.src = avatar;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => img.replaceWith(avatarFallback(state.user.name || state.user.login));
      button.append(img);
    } else {
      button.append(avatarFallback(state.user.name || state.user.login));
    }
    const name = document.createElement('span');
    name.className = 'account-name';
    name.textContent = state.user.name || state.user.login;
    button.append(name);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleAccountMenu(area, button);
    });
    area.append(button);
    return;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'login-btn';
  button.innerHTML = `${githubIcon()}<span>登录</span>`;
  button.title = '用 GitHub 登录';
  button.addEventListener('click', openLoginDialog);
  area.append(button);
}

function avatarFallback(login) {
  const span = document.createElement('span');
  span.className = 'avatar-fallback';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = String(login || '行').slice(0, 1);
  return span;
}

function toggleAccountMenu(area, button) {
  const existing = area.querySelector('.account-menu');
  if (existing) {
    existing.remove();
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'account-menu';
  const identity = document.createElement('div');
  identity.className = 'menu-id';
  identity.textContent = `@${state.user.login}`;
  menu.append(identity);

  const mine = document.createElement('button');
  mine.type = 'button';
  mine.textContent = '我的轨迹';
  mine.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.remove();
    button.setAttribute('aria-expanded', 'false');
    openBoard('mine');
  });

  const logout = document.createElement('button');
  logout.type = 'button';
  logout.textContent = '退出登录';
  logout.addEventListener('click', async (event) => {
    event.stopPropagation();
    menu.remove();
    button.setAttribute('aria-expanded', 'false');
    try {
      await api.logout();
    } catch {
      /* 令牌可能已失效 */
    }
    api.setToken('');
    state.user = null;
    updateAccountUi();
    toast('已退出登录');
  });

  menu.append(mine, logout);
  area.append(menu);
  button.setAttribute('aria-expanded', 'true');
}

function openLoginDialog() {
  const online = state.online;
  const canGithub = online && Boolean(state.health?.githubOAuth);
  const canDev = online && Boolean(state.health?.devAuth);
  el.githubLoginBtn.disabled = false;
  el.devLoginBtn.disabled = false;
  show(el.githubLoginBtn);
  el.githubLoginBtn.hidden = !canGithub;
  el.devLoginBtn.hidden = !canDev;
  el.offlineStartBtn.hidden = canGithub || canDev;

  if (!online) {
    el.loginIntro.textContent = '当前没有连接到账号服务。页面仍可完整游玩，只是成绩不会离开这台设备。';
    el.loginSmall.textContent = '启动本地 server 或部署 API 后，所有账户就能一起排名。';
    el.loginNote.textContent = '这是演示版。正式版会记录每一程，并让所有账户一起排名。';
  } else if (!canGithub && canDev) {
    el.loginIntro.textContent = '这是本地演示环境。用下面的测试账号体验完整的复核与排行榜流程。';
    el.loginSmall.textContent = '测试账号不会读取任何真实资料；正式上线时换成 GitHub 登录。';
    el.loginNote.textContent = '测试账号只存在于本地数据库。部署线上版本时请关闭 DEV_AUTH。';
  } else if (!canGithub && !canDev) {
    el.loginIntro.textContent = '账号服务已连接，但还没有配置 GitHub OAuth。';
    el.loginSmall.textContent = '配置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET 后重启服务即可登录。';
    el.loginNote.textContent = 'API 已连接，但登录入口尚未启用。';
  } else {
    el.loginIntro.textContent = '用 GitHub 账号登录。只读取你的公开用户名与头像，不读取仓库、邮箱或关注关系。';
    el.loginSmall.textContent = '登录后，每一程由服务器复核并计入总榜；所有账户都在榜上，包括还没走出第一步的人。';
    el.loginNote.textContent = '登录只读取公开头像与用户名；不读取仓库、邮箱或关注关系。登录后每一程由服务器复核，所有账户一起排名。';
  }
  if (!el.loginDialog.open) el.loginDialog.showModal();
}

async function beginGithubLogin() {
  if (!state.online || !state.health?.githubOAuth) {
    toast('账号服务尚未配置 GitHub OAuth', true);
    return;
  }
  const nonce = makeNonce();
  try {
    sessionStorage.setItem('nilu.loginNonce', nonce);
  } catch {
    toast('浏览器禁用了会话存储，无法安全登录', true);
    return;
  }
  el.githubLoginBtn.disabled = true;
  const returnUrl = `${window.location.origin}${window.location.pathname}`;
  window.location.href = api.loginUrl(nonce, returnUrl);
}

async function devLogin() {
  if (!state.online || !state.health?.devAuth) return;
  el.devLoginBtn.disabled = true;
  try {
    const data = await api.devLogin('本地行人');
    api.setToken(data.token);
    state.user = data.user;
    updateAccountUi();
    el.loginDialog.close();
    toast(`已用本地账号登录：${state.user.login}`);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : '本地登录失败';
    el.loginNote.textContent = message;
    toast(message, true);
  } finally {
    el.devLoginBtn.disabled = false;
  }
}

async function refreshMe() {
  if (!api.token || !state.online) return;
  try {
    const data = await api.me();
    state.user = data.user;
    state.totalAccounts = data.totalAccounts || 0;
    updateAccountUi();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      api.setToken('');
      state.user = null;
      updateAccountUi();
    }
  }
}

async function consumeLoginFragment() {
  const raw = window.location.hash;
  if (!raw || raw.length < 2) return;
  const hashParams = new URLSearchParams(raw.slice(1));
  const code = hashParams.get('login');
  const errorCode = hashParams.get('login_error');
  const nonce = hashParams.get('nonce');
  if (!code && !errorCode) return;

  const cleanUrl = `${window.location.origin}${window.location.pathname}${window.location.search}`;
  window.history.replaceState(null, '', cleanUrl);

  if (errorCode) {
    toast(`登录未完成：${errorCode}`, true);
    return;
  }
  let expected = '';
  try {
    expected = sessionStorage.getItem('nilu.loginNonce') || '';
    sessionStorage.removeItem('nilu.loginNonce');
  } catch {
    expected = '';
  }
  if (!expected || expected !== nonce) {
    toast('登录会话已失效，请重新登录', true);
    return;
  }
  if (!state.online) {
    toast('账号服务未接通，登录未完成', true);
    return;
  }
  try {
    const data = await api.exchange(code);
    api.setToken(data.token);
    state.user = data.user;
    updateAccountUi();
    await refreshMe();
    toast(`已登录：${state.user.login}`);
  } catch (error) {
    toast(error instanceof ApiError ? error.message : '登录失败', true);
  }
}

/* ---------------- game ---------------- */

function setScreen(screen) {
  state.screen = screen;
  const playing = screen === 'playing';
  el.pauseBtn.hidden = !(playing || screen === 'paused');
  el.pauseBtn.setAttribute('aria-label', screen === 'paused' ? '继续' : '暂停');
  const inRun = ['countdown', 'playing', 'paused'].includes(screen);
  el.boardBtn.hidden = inRun;
  el.accountArea.hidden = inRun;
  if (el.touchPad && (state.isCoarse || window.matchMedia('(pointer: coarse)').matches)) {
    el.touchPad.hidden = !playing;
  }
}

async function startRun() {
  if (state.starting) return;
  if (['countdown', 'playing', 'paused'].includes(state.screen)) return;
  state.starting = true;
  sound.unlock();
  const startButton = state.screen === 'ended' ? el.againBtn : el.startBtn;
  if (startButton) startButton.disabled = true;

  let challenge = null;
  if (state.online && state.user) {
    try {
      challenge = await api.createChallenge();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        api.setToken('');
        state.user = null;
        updateAccountUi();
        toast('登录已过期，这一程先留在本机', true);
      } else {
        toast('账号服务暂时不可用，这一程先留在本机', true);
      }
    }
  }

  const durationTicks = challenge?.durationTicks || FAST_TICKS || DEFAULT_DURATION_TICKS;
  const seed = challenge?.seed ?? randomSeed();
  state.challenge = challenge;
  state.run = createRun({ seed, durationTicks });
  state.inputs = [];
  state.pendingInputs.clear();
  state.lastScheduledTick = -1;
  state.startedAt = 0;
  state.pausedAt = 0;
  state.pausedTotal = 0;
  state.accumulator = 0;
  state.lastFrame = 0;
  state.result = null;
  state.submitted = false;
  state.submitState = 'idle';
  state.rank = null;
  state.earlyEnd = false;
  state.promptNodeKey = '';
  state.localSavedForRun = false;
  state.boardData = null;
  renderer.resetForRun(state.run);

  hide(el.landing);
  hide(el.end);
  hide(el.pause);
  hide(el.retrySubmitBtn);
  show(el.hud);
  hide(el.deck);
  el.timeBar.classList.add('is-on');
  updateHud();
  setScreen('countdown');
  show(el.countdown);
  if (startButton) startButton.disabled = false;
  state.starting = false;
  await runCountdown();
}

async function runCountdown() {
  const token = ++state.countdownToken;
  const labels = ['三', '二', '一'];
  for (const label of labels) {
    if (token !== state.countdownToken || state.screen !== 'countdown') return;
    el.countdownNum.textContent = label;
    el.countdown.classList.remove('is-tick');
    void el.countdown.offsetWidth;
    el.countdown.classList.add('is-tick');
    await new Promise((resolve) => setTimeout(resolve, 560));
  }
  if (token !== state.countdownToken || state.screen !== 'countdown') return;
  hide(el.countdown);
  beginPlaying();
}

function beginPlaying() {
  state.startedAt = performance.now();
  state.pausedAt = 0;
  state.pausedTotal = 0;
  state.accumulator = 0;
  state.lastFrame = performance.now();
  state.pendingInputs.clear();
  state.lastScheduledTick = -1;
  setScreen('playing');
  show(el.deck);
  announce('开始。按顺序敲下箭头。');
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

function updateHud() {
  const run = state.run;
  if (!run) return;
  el.scoreValue.textContent = formatScore(run.area);
  el.slopeValue.textContent = run.slope.toFixed(3);
  el.comboValue.textContent = `×${run.combo}`;
  const remainingTicks = Math.max(0, run.durationTicks - run.tick);
  el.timeValue.textContent = formatClock(remainingTicks / 60);
  const ratio = Math.max(0, Math.min(1, remainingTicks / run.durationTicks));
  el.timeBar.firstElementChild.style.transform = `scaleX(${ratio})`;
}

function handleDirection(index) {
  if (state.screen !== 'playing' || !state.run || state.run.status !== 'running') return false;
  if (!state.run.prompt) return false;
  if (document.querySelector('dialog[open]')) return false;
  const wallTick = Math.floor((performance.now() - state.startedAt - state.pausedTotal) / TICK_MS);
  let tick = Math.max(wallTick, state.run.tick + 1, state.lastScheduledTick + 1);
  if (tick >= state.run.durationTicks) return false;
  state.pendingInputs.set(tick, index);
  state.lastScheduledTick = tick;
  state.inputs.push({ t: tick, k: index });
  sound.key(index, state.run.combo);
  el.promptCard.classList.remove('is-error');
  return true;
}

function drainEvents() {
  const run = state.run;
  if (!run) return;
  const events = run.events.splice(0, run.events.length);
  for (const event of events) {
    if (event.type === 'success') {
      renderer.burst('success', run);
      sound.success(run.level);
      showGain(event.gain);
      flashCard('is-success');
      announce(`完成。第 ${run.level} 次抬升。`);
    } else if (event.type === 'miss') {
      renderer.burst('miss', run);
      sound.miss();
      flashCard('is-error');
      announce(event.reason === 'timeout' ? '时间到了。' : '方向不对。');
    } else if (event.type === 'prompt') {
      const glyphs = run.prompt ? run.prompt.seq.map((key) => ARROW_GLYPHS[key]).join(' ') : '';
      announce(`第 ${run.level + 1} 组：${glyphs}`);
    }
  }
}

function flashCard(className) {
  const now = performance.now();
  if (now - lastCardFlash < 60) return;
  lastCardFlash = now;
  el.promptCard.classList.remove('is-success', 'is-error');
  void el.promptCard.offsetWidth;
  el.promptCard.classList.add(className);
  window.setTimeout(() => el.promptCard.classList.remove(className), 360);
}

function showGain(gain) {
  clearTimeout(gainTimer);
  el.gainToast.textContent = `斜率 +${Number(gain).toFixed(3)}`;
  el.gainToast.classList.add('is-on');
  gainTimer = window.setTimeout(() => el.gainToast.classList.remove('is-on'), 900);
}

function updatePromptUi() {
  const run = state.run;
  if (!run || state.screen === 'countdown') return;
  if (!run.prompt) {
    const gap = run.nextPromptTick - run.tick;
    if (gap > 20 && state.promptNodeKey !== 'idle') {
      state.promptNodeKey = 'idle';
      el.promptCard.classList.remove('is-success', 'is-error', 'is-entering');
      el.promptCard.classList.add('is-idle');
      el.promptLabel.textContent = run.missStreak > 0 ? '喘息' : '准备';
      el.promptKeys.replaceChildren();
      const idle = document.createElement('span');
      idle.className = 'idle-mark';
      idle.textContent = '· · ·';
      el.promptKeys.append(idle);
      el.promptTimerText.textContent = '—';
      el.promptTimer.style.transform = 'scaleX(0)';
      el.promptHint.textContent = run.missStreak > 0 ? '高度没有丢，只是少走了一段' : '光点已经出发';
    }
    return;
  }

  const key = `${run.prompt.deadlineTick}:${run.prompt.seq.join('')}`;
  if (state.promptNodeKey !== key) {
    state.promptNodeKey = key;
    el.promptCard.classList.remove('is-idle', 'is-success', 'is-error');
    el.promptCard.classList.remove('is-entering');
    void el.promptCard.offsetWidth;
    el.promptCard.classList.add('is-entering');
    el.promptLabel.textContent = `第 ${run.level + 1} 次抬升 · ${run.prompt.len} 键`;
    el.promptHint.textContent = '按顺序敲下箭头';
    el.promptKeys.replaceChildren();
    for (const keyIndex of run.prompt.seq) {
      const span = document.createElement('span');
      span.className = 'key';
      span.textContent = ARROW_GLYPHS[keyIndex];
      el.promptKeys.append(span);
    }
  }

  const nodes = el.promptKeys.children;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    node.classList.toggle('is-done', i < run.prompt.index);
    node.classList.toggle('is-current', i === run.prompt.index);
  }

  const remaining = Math.max(0, run.prompt.deadlineTick - run.tick);
  const ratio = Math.max(0, Math.min(1, remaining / run.prompt.windowTicks));
  el.promptTimer.style.transform = `scaleX(${ratio})`;
  el.promptTimer.classList.toggle('is-low', ratio < 0.3);
  el.promptTimerText.textContent = `${(remaining * TICK_MS / 1000).toFixed(1)}s`;
}

function togglePause(forcePause = false) {
  if (state.screen === 'playing') {
    state.pausedAt = performance.now();
    setScreen('paused');
    show(el.pause);
    hide(el.touchPad);
    announce('已暂停');
    return;
  }
  if (state.screen === 'paused' && !forcePause) {
    state.pausedTotal += performance.now() - state.pausedAt;
    state.pausedAt = 0;
    state.accumulator = 0;
    state.lastFrame = performance.now();
    state.pendingInputs.clear();
    state.lastScheduledTick = -1;
    hide(el.pause);
    setScreen('playing');
    if (state.isCoarse) show(el.touchPad);
    announce('继续');
  }
}

function finishRun(options = {}) {
  if (state.screen === 'ended') return;
  const run = state.run;
  if (!run) return;
  const abandoned = options.abandoned === true;
  state.earlyEnd = abandoned;
  state.result = getResult(run);
  state.result.durationTicks = run.durationTicks;
  hide(el.deck);
  hide(el.hud);
  hide(el.pause);
  hide(el.touchPad);
  hide(el.countdown);
  el.timeBar.classList.remove('is-on');
  setScreen('ended');
  sound.end();
  show(el.end);
  renderer.drawRun(run, performance.now(), { ending: true });

  if (!abandoned && (!state.challenge || !state.user)) saveLocalRun(state.result, 'local');
  if (!abandoned && state.challenge && state.user) state.localSavedForRun = false;
  state.boardData = null;
  populateEnd(abandoned);

  if (!abandoned && state.online && state.user && state.challenge) {
    submitCurrentRun();
  } else {
    setEndAuthForNoSubmit(abandoned);
  }
}

function populateEnd(abandoned = false) {
  const result = state.result;
  if (!result) return;
  el.endScore.textContent = formatScore(result.score);
  el.endSlope.textContent = Number(result.slope || 0).toFixed(3);
  el.endCombo.textContent = `×${Number(result.maxCombo || 0)}`;
  el.endSuccesses.textContent = String(Number(result.successes || 0));
  el.endMisses.textContent = String(Number(result.misses || 0));

  if (abandoned) {
    el.endLine.textContent = '路没有走完。面积停在这里。';
  } else if (!result.successes) {
    el.endLine.textContent = '你只是走完了这段路。';
  } else if (!result.misses) {
    el.endLine.textContent = '一次也没有踏空。';
  } else {
    el.endLine.textContent = `踏空 ${result.misses} 次。高度没有丢，只是少走了一段。`;
  }
  el.endInsight.textContent = computeInsight(result);
  el.endRank.hidden = true;
  el.endRank.textContent = '';
  hide(el.retrySubmitBtn);
}

function computeInsight(result) {
  const curve = Array.isArray(result.curve) ? result.curve : [];
  if (!curve.length || !result.successes) {
    return `最高斜率 ${Number(result.slope || 0).toFixed(3)}。你一直贴着地面走。平，也是一种走法。`;
  }
  let total = 0;
  let late = 0;
  for (let i = 1; i < curve.length; i += 1) {
    const piece = (Number(curve[i]) + Number(curve[i - 1])) / 2;
    total += piece;
    if (i / curve.length > 2 / 3) late += piece;
  }
  const pct = total > 0 ? Math.round((late / total) * 100) : 0;
  if (pct >= 55) return `最后三分之一的路，贡献了 ${pct}% 的面积。越往后，每一秒越重。`;
  if (pct <= 38) return `只有 ${pct}% 的面积来自最后三分之一。早一点抬头，复利会更明显。`;
  return `时间把斜率变成了面积：同样抬一次头，越早，越算数。`;
}

function setEndAuthForNoSubmit(abandoned) {
  if (abandoned) {
    el.endAuth.textContent = '这一程提前结束，没有记入排行榜。';
    return;
  }
  if (!state.online) {
    el.endAuth.textContent = '账号服务未接通；这一程只留在这台设备。';
    return;
  }
  if (!state.user) {
    el.endAuth.textContent = '这一程只留在这台设备。登录后，下一程会被记入总榜。';
    return;
  }
  if (!state.challenge) {
    el.endAuth.textContent = '这一程没有取得服务器凭证，只留在这台设备。';
    return;
  }
  el.endAuth.textContent = '';
}

async function submitCurrentRun() {
  if (!state.online || !state.user || !state.challenge || !state.result) return;
  if (state.submitted || state.submitState === 'submitting') return;
  state.submitState = 'submitting';
  el.endAuth.textContent = '';
  el.endRank.hidden = false;
  el.endRank.textContent = '正在把这一程交给服务器复核……';
  hide(el.retrySubmitBtn);
  const inputs = state.inputs.filter((item) => item.t < state.challenge.durationTicks);
  try {
    const data = await api.submit({ challengeId: state.challenge.id, inputs });
    state.submitted = true;
    state.submitState = 'done';
    state.rank = data.rank;
    state.totalAccounts = data.totalAccounts || state.totalAccounts;
    if (data.run) {
      state.result = {
        ...state.result,
        score: data.run.score,
        slope: data.run.maxSlope,
        maxSlope: data.run.maxSlope,
        successes: data.run.successes,
        misses: data.run.misses,
        maxCombo: data.run.maxCombo,
        curve: data.run.curve || state.result.curve,
      };
      populateEnd(false);
    }
    el.endRank.hidden = false;
    el.endRank.textContent = `已记入总榜 · 第 ${data.rank} 名${state.totalAccounts ? ` / 共 ${state.totalAccounts} 人` : ''} · 服务器已复核`;
    el.endAuth.textContent = data.personalBest ? `个人最佳：${formatScore(data.personalBest)}` : '';
    if (!state.localSavedForRun) {
      saveLocalRun(state.result, 'verified');
      state.localSavedForRun = true;
    }
  } catch (error) {
    state.submitState = 'error';
    if (!state.localSavedForRun) {
      saveLocalRun(state.result, 'local');
      state.localSavedForRun = true;
    }
    const message = error instanceof ApiError ? error.message : '提交失败';
    if (error instanceof ApiError && (error.status === 401 || error.code === 'unauthorized')) {
      api.setToken('');
      state.user = null;
      updateAccountUi();
      el.endAuth.textContent = '登录已过期，这一程未能记入总榜；本地成绩已保留。';
    } else if (error instanceof ApiError && (error.status === 410 || error.code === 'challenge_expired')) {
      el.endAuth.textContent = '这一程的复核凭证已过期，未能记入总榜；本地成绩已保留。';
    } else if (error instanceof ApiError && (error.status === 409 || error.code === 'challenge_used')) {
      el.endAuth.textContent = '这一程已经提交过了，无需重复提交。';
    } else {
      el.endAuth.textContent = `复核未完成：${message}。本地成绩已保留。`;
      if (error instanceof ApiError && error.status === 0) storePending(inputs);
      show(el.retrySubmitBtn);
    }
    el.endRank.textContent = '';
    el.endRank.hidden = true;
  }
}

function storePending(inputs) {
  try {
    localStorage.setItem('nilu.pending', JSON.stringify({
      challengeId: state.challenge.id,
      inputs,
      at: Date.now(),
    }));
  } catch {
    /* ignore */
  }
}

async function retryPendingIfAny() {
  if (!state.online || !state.user) return;
  let pending = null;
  try {
    const raw = localStorage.getItem('nilu.pending');
    pending = raw ? JSON.parse(raw) : null;
  } catch {
    pending = null;
  }
  if (!pending || !pending.challengeId || !Array.isArray(pending.inputs)) return;
  if (Date.now() - Number(pending.at || 0) > 30 * 60 * 1000) {
    localStorage.removeItem('nilu.pending');
    return;
  }
  try {
    const data = await api.submit({ challengeId: pending.challengeId, inputs: pending.inputs });
    localStorage.removeItem('nilu.pending');
    toast(`上一程已补交，第 ${data.rank} 名`);
  } catch (error) {
    if (error instanceof ApiError && [403, 404, 409, 410].includes(error.status)) {
      localStorage.removeItem('nilu.pending');
    }
  }
}

/* ---------------- leaderboard ---------------- */

async function openBoard(scope = 'all') {
  if (scope === 'mine' && !state.user) {
    openLoginDialog();
    return;
  }
  state.boardScope = scope;
  if (!el.boardDialog.open) el.boardDialog.showModal();
  updateBoardChrome();
  await loadBoard();
}

function updateBoardChrome() {
  const scope = state.boardScope;
  if (scope === 'mine') {
    el.boardTitle.textContent = '我的轨迹';
    el.boardSub.textContent = '每一程都算数，榜上只取最好的一次。';
    el.boardFootNote.textContent = '只显示服务器复核过的记录。';
  } else if (scope === 'week') {
    el.boardTitle.textContent = '本周同行者';
    el.boardSub.textContent = '本周一以来，最好的那一程。';
    el.boardFootNote.textContent = '成绩由服务器按输入回放复核；所有账户都在榜上。';
  } else {
    el.boardTitle.textContent = '同行者';
    el.boardSub.textContent = '所有走过的账户，都在这里。';
    el.boardFootNote.textContent = '成绩由服务器按输入回放复核；所有账户都在榜上，包括还没走出第一步的人。';
  }
  el.boardLoginBtn.hidden = Boolean(state.user) || !state.online;
  for (const tab of el.boardTabs.querySelectorAll('.tab')) {
    const active = tab.dataset.scope === scope;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }
}

function showBoardMessage(text) {
  el.boardList.replaceChildren();
  el.boardList.hidden = true;
  el.boardEmpty.hidden = false;
  el.boardEmpty.textContent = text;
  const old = el.boardDialog.querySelector('.board-self');
  if (old) old.remove();
}

function showBoardList() {
  el.boardEmpty.hidden = true;
  el.boardList.hidden = false;
}

async function loadBoard() {
  if (state.boardBusy) return;
  state.boardBusy = true;
  updateBoardChrome();
  const oldSelf = el.boardDialog.querySelector('.board-self');
  if (oldSelf) oldSelf.remove();

  if (!state.online) {
    renderLocalBoard();
    state.boardBusy = false;
    return;
  }

  showBoardMessage('正在取回轨迹……');
  try {
    if (state.boardScope === 'mine') {
      const data = await api.myRuns(30);
      state.boardData = { kind: 'mine', entries: data.entries || [] };
      renderBoard(state.boardData);
    } else {
      const data = await api.leaderboard(state.boardScope, 50, 0);
      state.boardData = { kind: 'board', ...data };
      renderBoard(state.boardData);
    }
  } catch (error) {
    showBoardMessage(error instanceof ApiError ? `没有取回榜单：${error.message}` : '没有取回榜单。');
  } finally {
    state.boardBusy = false;
  }
}

function renderLocalBoard() {
  const now = Date.now();
  const weekStart = startOfWeek(now);
  let runs = state.localRuns.slice().sort((a, b) => b.score - a.score);
  if (state.boardScope === 'week') runs = runs.filter((run) => run.date >= weekStart);
  if (state.boardScope === 'mine') runs = state.localRuns.slice();
  el.boardSub.textContent = '账号服务未接通，这里只显示这台设备的记录。';
  el.boardTitle.textContent = '本机记录';
  el.boardFootNote.textContent = '启动本地 server 或部署 API 后，所有账户会一起排名。';
  el.boardLoginBtn.hidden = true;
  if (!runs.length) {
    showBoardMessage('这台设备还没有留下轨迹。先走一程。');
    return;
  }
  showBoardList();
  el.boardList.replaceChildren();
  runs.forEach((run, index) => {
    el.boardList.append(buildBoardRow({
      rank: index + 1,
      login: '本机',
      name: '这台设备',
      score: run.score,
      maxSlope: run.maxSlope,
      successes: run.successes,
      misses: run.misses,
      maxCombo: run.maxCombo,
      curve: run.curve,
      createdAt: run.date,
    }, { local: true }));
  });
}

function startOfWeek(timestamp) {
  const date = new Date(timestamp);
  const day = date.getDay();
  const diff = (day + 6) % 7;
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - diff);
  return date.getTime();
}

function renderBoard(data) {
  showBoardList();
  el.boardList.replaceChildren();
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (data.kind === 'board' && data.total) {
    el.boardSub.textContent = state.boardScope === 'week'
      ? `共 ${data.total} 位账户 · 本周最好的那一程。`
      : `共 ${data.total} 位账户 · 所有走过的账户，都在这里。`;
  }
  if (!entries.length) {
    showBoardMessage(data.kind === 'mine' ? '还没有服务器复核过的记录。先走一程。' : '还没有人留下轨迹。');
    return;
  }
  entries.forEach((entry, index) => {
    el.boardList.append(buildBoardRow(entry, { mine: data.kind === 'mine', index }));
  });

  if (data.kind === 'board' && data.me && data.me.rank > entries.length) {
    const self = document.createElement('div');
    self.className = 'board-self';
    const text = document.createElement('span');
    text.textContent = `你排在第 ${data.me.rank} 名`;
    const score = document.createElement('strong');
    score.textContent = formatScore(data.me.score);
    self.append(text, score);
    el.boardDialog.querySelector('.dialog-foot').before(self);
  }
}

function buildBoardRow(entry, options = {}) {
  const isMine = options.mine === true;
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'board-row';
  const zero = !entry.score;
  if (zero) row.classList.add('is-zero');
  if (state.user && (entry.userId === state.user.id || isMine)) row.classList.add('is-me');

  const rank = document.createElement('span');
  rank.className = 'rank';
  if (options.local) {
    rank.textContent = String(entry.rank);
    if (entry.rank <= 3) rank.classList.add('top');
  } else if (isMine) {
    rank.textContent = '·';
  } else {
    rank.textContent = String(entry.rank ?? options.index + 1);
    if ((entry.rank ?? options.index + 1) <= 3) rank.classList.add('top');
  }

  const avatarCell = document.createElement('span');
  avatarCell.className = 'board-avatar-cell';
  const avatar = safeAvatarUrl(entry.avatarUrl);
  if (avatar) {
    const img = document.createElement('img');
    img.className = 'board-avatar';
    img.src = avatar;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => img.replaceWith(avatarFallback(entry.name || entry.login || '行'));
    avatarCell.append(img);
  } else {
    const fallback = avatarFallback(entry.name || entry.login || '行');
    fallback.classList.add('board-avatar');
    avatarCell.append(fallback);
  }

  const name = document.createElement('span');
  name.className = 'board-name';
  const strong = document.createElement('strong');
  strong.textContent = entry.name || entry.login || '未署名';
  const meta = document.createElement('span');
  if (zero) meta.textContent = '还没走出第一步';
  else meta.textContent = `最高斜率 ${Number(entry.maxSlope || 0).toFixed(3)}`;
  name.append(strong, meta);

  const spark = document.createElement('span');
  spark.className = 'spark';
  spark.innerHTML = sparklineSvg(entry.curve, 92, 25);

  const score = document.createElement('span');
  score.className = 'board-score';
  score.textContent = zero ? '未走' : formatScore(entry.score);

  const date = document.createElement('span');
  date.className = 'board-date';
  date.textContent = zero ? '' : formatDate(entry.createdAt);

  row.append(rank, avatarCell, name, spark, score, date);
  row.addEventListener('click', () => openRunDetail(entry, options));
  return row;
}

function openRunDetail(entry, options = {}) {
  el.runTitle.textContent = entry.name || entry.login || '一条轨迹';
  const bits = [formatDate(entry.createdAt)];
  if (options.local) bits.push('本机记录');
  else if (entry.rank) bits.push(`第 ${entry.rank} 名`);
  if (entry.misses) bits.push(`踏空 ${entry.misses} 次`);
  el.runMeta.textContent = bits.join(' · ');
  el.runStats.replaceChildren();
  const stats = [
    ['面积', formatScore(entry.score)],
    ['最高斜率', Number(entry.maxSlope || 0).toFixed(3)],
    ['最长连续', `×${Number(entry.maxCombo || 0)}`],
    ['抬升', String(Number(entry.successes || 0))],
  ];
  for (const [label, value] of stats) {
    const item = document.createElement('div');
    const span = document.createElement('span');
    span.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    item.append(span, strong);
    el.runStats.append(item);
  }
  el.runDialog.showModal();
  requestAnimationFrame(() => renderCurvePreview(el.runCanvas, entry.curve, { durationTicks: entry.durationTicks }));
}

/* ---------------- frame loop ---------------- */

function frame(now) {
  requestAnimationFrame(frame);
  if (state.screen === 'playing' && state.run) {
    if (!state.lastFrame) state.lastFrame = now;
    const delta = Math.min(90, Math.max(0, now - state.lastFrame));
    state.lastFrame = now;
    state.accumulator += delta;
    let guard = 0;
    while (state.accumulator >= TICK_MS && state.run.status === 'running' && guard < 12) {
      const tick = state.run.tick;
      const key = state.pendingInputs.get(tick);
      if (key !== undefined) state.pendingInputs.delete(tick);
      advance(state.run, key === undefined ? [] : [key]);
      state.accumulator -= TICK_MS;
      guard += 1;
      drainEvents();
    }
    for (const tick of state.pendingInputs.keys()) {
      if (tick < state.run.tick) state.pendingInputs.delete(tick);
    }
    updateHud();
    updatePromptUi();
    if (state.run.status === 'ended') finishRun();
  }

  if (state.run && ['countdown', 'playing', 'paused', 'ended'].includes(state.screen)) {
    renderer.drawRun(state.run, now, { ending: state.screen === 'ended' });
  } else {
    renderer.drawAttract(now);
  }
}

/* ---------------- sharing ---------------- */

function shareText() {
  const result = state.result;
  if (!result) return '';
  const seconds = Math.round((result.durationTicks || DEFAULT_DURATION_TICKS) / 60);
  return `我在《逆旅》走了 ${seconds} 秒，轨迹下的面积是 ${formatScore(result.score)}。\n光点不会回头。\n${CONFIG.pagesUrl}`;
}

async function copyShare() {
  const text = shareText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('这一程已复制，去发小红书吧');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      document.execCommand('copy');
      toast('这一程已复制，去发小红书吧');
    } catch {
      toast('复制失败，请手动选择文字', true);
    }
    area.remove();
  }
}

/* ---------------- events ---------------- */

function bindEvents() {
  el.startBtn.addEventListener('click', () => startRun());
  el.againBtn.addEventListener('click', () => startRun());
  el.boardBtn.addEventListener('click', () => openBoard('all'));
  el.boardBtnLanding.addEventListener('click', () => openBoard('all'));
  el.endBoardBtn.addEventListener('click', () => openBoard('all'));
  el.boardLoginBtn.addEventListener('click', () => {
    el.boardDialog.close();
    openLoginDialog();
  });
  el.shareBtn.addEventListener('click', copyShare);
  el.retrySubmitBtn.addEventListener('click', () => {
    state.submitState = 'idle';
    submitCurrentRun();
  });

  el.soundBtn.addEventListener('click', () => {
    state.soundOn = !state.soundOn;
    sound.setEnabled(state.soundOn);
    updateSoundUi();
  });
  el.pauseBtn.addEventListener('click', () => {
    if (state.screen === 'paused') togglePause(false);
    else if (state.screen === 'playing') togglePause(true);
  });
  el.resumeBtn.addEventListener('click', () => togglePause(false));
  el.pauseQuitBtn.addEventListener('click', () => {
    hide(el.pause);
    state.pausedAt = 0;
    finishRun({ abandoned: true });
  });

  el.boardTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    const scope = tab.dataset.scope;
    if (scope === 'mine' && !state.user) {
      el.boardDialog.close();
      openLoginDialog();
      return;
    }
    if (scope === state.boardScope && state.boardData) {
      updateBoardChrome();
      return;
    }
    state.boardScope = scope;
    updateBoardChrome();
    loadBoard();
  });

  el.boardClose.addEventListener('click', () => el.boardDialog.close());
  el.loginClose.addEventListener('click', () => el.loginDialog.close());
  el.runClose.addEventListener('click', () => el.runDialog.close());
  el.loginDialog.addEventListener('click', (event) => {
    if (event.target === el.loginDialog) el.loginDialog.close();
  });
  el.boardDialog.addEventListener('click', (event) => {
    if (event.target === el.boardDialog) el.boardDialog.close();
  });
  el.runDialog.addEventListener('click', (event) => {
    if (event.target === el.runDialog) el.runDialog.close();
  });

  el.githubLoginBtn.addEventListener('click', beginGithubLogin);
  el.devLoginBtn.addEventListener('click', devLogin);
  el.offlineStartBtn.addEventListener('click', () => {
    el.loginDialog.close();
    startRun();
  });

  el.touchPad.addEventListener('pointerdown', (event) => {
    const button = event.target.closest('button[data-key]');
    if (!button) return;
    event.preventDefault();
    handleDirection(Number(button.dataset.key));
  });

  document.addEventListener('click', (event) => {
    if (!el.accountArea.contains(event.target)) {
      const menu = el.accountArea.querySelector('.account-menu');
      if (menu) {
        menu.remove();
        const button = el.accountArea.querySelector('.account-btn');
        if (button) button.setAttribute('aria-expanded', 'false');
      }
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (document.querySelector('dialog[open]')) return;
    const target = event.target;
    const typing = target instanceof HTMLElement && target.closest('button, a, input, textarea, select');

    if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
      if (state.screen === 'playing') {
        event.preventDefault();
        if (!event.repeat) handleDirection(KEY_TO_INDEX[event.key]);
      }
      return;
    }

    if (event.key === 'Escape' || event.key.toLowerCase() === 'p') {
      if (state.screen === 'playing' || state.screen === 'paused') {
        event.preventDefault();
        togglePause(state.screen === 'playing');
        return;
      }
      const menu = el.accountArea.querySelector('.account-menu');
      if (menu) {
        menu.remove();
        const button = el.accountArea.querySelector('.account-btn');
        if (button) button.setAttribute('aria-expanded', 'false');
      }
      return;
    }

    if (typing && (event.key === ' ' || event.key === 'Enter')) return;
    if (event.key === ' ' || event.key === 'Enter') {
      if (state.screen === 'landing' || state.screen === 'ended') {
        event.preventDefault();
        startRun();
      }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.screen === 'playing') togglePause(true);
  });
}

/* ---------------- boot ---------------- */

async function boot() {
  cacheElements();
  state.localRuns = readLocalRuns();
  state.soundOn = sound.enabled;
  state.isCoarse = window.matchMedia('(pointer: coarse)').matches;
  renderer = new StageRenderer(el.stage);
  bindEvents();
  updateSoundUi();
  updateBest();
  updateLandingMeta();
  updateAccountUi();
  updateHud();
  requestAnimationFrame(frame);

  const isGithubPages = window.location.hostname.endsWith('.github.io');
  const shouldProbe = Boolean(CONFIG.apiBase) || !isGithubPages;
  const health = shouldProbe ? await api.probe() : null;
  if (health && health.engineVersion === ENGINE_VERSION) {
    state.online = true;
    state.health = health;
    state.totalAccounts = health.totalAccounts || 0;
  } else if (health) {
    state.online = false;
    toast('服务器引擎版本不一致，已切回本地模式', true);
  }
  updateLandingMeta();

  await consumeLoginFragment();
  if (api.token) await refreshMe();
  updateAccountUi();
  await retryPendingIfAny();

  if (isLocalHost && params.get('autostart') === '1') {
    window.setTimeout(() => startRun(), 500);
  }
}

boot().catch((error) => {
  console.error(error);
  toast('页面初始化失败，请刷新重试', true);
});
