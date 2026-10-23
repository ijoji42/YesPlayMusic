/**
 * 「继续收听」的本地会话快照。
 *
 * 目标：首页第一块内容不依赖任何网络请求就能渲染出来。
 * 做法：把「播放到哪了」序列化成极小的快照（当前歌曲的最小元信息 +
 * 播放列表 ID + 进度），落在 localStorage 里。冷启动时直接读本地，
 * 用户点一下就能回到上次的位置。
 *
 * 三条硬约束：
 * 1. 快照必须小。播放列表可能上万首，只保留当前歌曲附近的一段窗口
 *    （MAX_TRACK_IDS），否则单条记录就能把 5MB 配额吃掉。
 * 2. 写盘必须节流。采样是 2 秒一次，每次都同步 JSON.stringify + 写盘
 *    会造成可感知的掉帧，所以合并到 5 秒一次的窗口里。
 * 3. 续播精度 ≤3 秒。progressMs 直接取 player.progress（秒）× 1000，
 *    并在切歌 / 暂停 / 页面关闭时强制落盘，保证最后写入的是最新位置。
 */

export const LISTEN_HISTORY_KEY = 'ypm.listenHistory';

// 最多保留的会话条数
const MAX_SESSIONS = 8;
// 单条会话最多保留的歌曲 ID 数（围绕当前歌曲取窗口）
const MAX_TRACK_IDS = 500;
// 落盘节流窗口
const PERSIST_INTERVAL = 5000;
// 会话采样间隔。要满足 3 秒的续播精度，采样间隔必须明显小于 3 秒。
const SAMPLE_INTERVAL = 2000;
// 配额不足时退让到的条数
const QUOTA_FALLBACK_SESSIONS = 4;

/**
 * 已解析的快照缓存。null 表示「还没从 localStorage 读过」。
 * 之所以缓存而不是每次重读：recordSession 会在两次落盘之间更新内存中的
 * 进度，重读会把这段还没落盘的更新丢掉。
 *
 * @type {Array<object>|null}
 */
let cache = null;
/** @type {number|null} */
let persistTimer = null;
let lastPersistAt = 0;

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

function clampProgress(value, durationMs) {
  if (!isNumber(value) || value <= 0) return 0;
  const rounded = Math.round(value);
  if (durationMs > 0 && rounded > durationMs) return durationMs;
  return rounded;
}

function normalizeTrackMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isNumber(raw.id) || raw.id <= 0) return null;
  return {
    id: raw.id,
    name: isNonEmptyString(raw.name) ? raw.name : '',
    artistNames: typeof raw.artistNames === 'string' ? raw.artistNames : '',
    albumName: typeof raw.albumName === 'string' ? raw.albumName : '',
    coverUrl: typeof raw.coverUrl === 'string' ? raw.coverUrl : '',
    durationMs:
      isNumber(raw.durationMs) && raw.durationMs > 0 ? raw.durationMs : 0,
  };
}

/**
 * 会话去重键：同一「来源 + 当前歌曲」视为同一个会话，
 * 反复收听只会把它挪到最前面，不会堆出十几张一样的卡片。
 *
 * @param {string} sourceType
 * @param {number} sourceID
 * @param {number} trackID
 * @returns {string}
 */
function sessionIDOf(sourceType, sourceID, trackID) {
  return `${sourceType}:${sourceID}:${trackID}`;
}

/**
 * 校验并规整一条快照。任何一处不合法就整条丢弃 ——
 * 展示层不应该为脏数据写防御代码。
 *
 * @param {object} raw
 * @returns {object|null}
 */
function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const trackMeta = normalizeTrackMeta(raw.trackMeta);
  if (!trackMeta) return null;

  const sourceType = typeof raw.sourceType === 'string' ? raw.sourceType : '';
  const sourceID = isNumber(raw.sourceID) ? raw.sourceID : 0;

  let trackIDs = Array.isArray(raw.trackIDs)
    ? raw.trackIDs.filter(isNumber).slice(0, MAX_TRACK_IDS)
    : [];
  if (trackIDs.length === 0) trackIDs = [trackMeta.id];

  // currentIndex 由 trackIDs 推导，而不是相信传入值：
  // 窗口裁剪之后，调用方给的下标已经对不上了。
  const found = trackIDs.indexOf(trackMeta.id);

  return {
    id: sessionIDOf(sourceType, sourceID, trackMeta.id),
    trackIDs,
    sourceType,
    sourceID,
    currentIndex: found >= 0 ? found : 0,
    progressMs: clampProgress(raw.progressMs, trackMeta.durationMs),
    trackMeta,
    playedAt: isNumber(raw.playedAt) ? raw.playedAt : Date.now(),
  };
}

function readStorage() {
  try {
    const raw = localStorage.getItem(LISTEN_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const sessions = [];
    for (const item of parsed) {
      const snapshot = normalizeSnapshot(item);
      if (snapshot) sessions.push(snapshot);
      if (sessions.length >= MAX_SESSIONS) break;
    }
    return sessions;
  } catch (error) {
    // 被别的东西写坏、隐私模式下 localStorage 抛异常……
    // 这里永远不该让首页挂掉。
    console.warn('[listenHistory] failed to read sessions', error);
    return [];
  }
}

function ensureCache() {
  if (cache === null) cache = readStorage();
  return cache;
}

function writeStorage(list) {
  localStorage.setItem(LISTEN_HISTORY_KEY, JSON.stringify(list));
}

function persistNow() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  lastPersistAt = Date.now();

  const list = ensureCache();
  if (list.length === 0) {
    try {
      localStorage.removeItem(LISTEN_HISTORY_KEY);
    } catch (error) {
      /* 忽略：删不掉也不影响功能 */
    }
    return;
  }

  try {
    writeStorage(list);
  } catch (error) {
    // QuotaExceededError：先砍到 4 条再试一次，还失败就彻底放弃，
    // 静默降级（内存里的快照本次会话内依然可用）。
    if (list.length > QUOTA_FALLBACK_SESSIONS) {
      try {
        const trimmed = list.slice(0, QUOTA_FALLBACK_SESSIONS);
        writeStorage(trimmed);
        cache = trimmed;
        return;
      } catch (retryError) {
        /* 放弃 */
      }
    }
    console.warn('[listenHistory] failed to persist sessions', error);
  }
}

function schedulePersist() {
  if (persistTimer !== null) return;
  const elapsed = Date.now() - lastPersistAt;
  if (elapsed >= PERSIST_INTERVAL) {
    persistNow();
    return;
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, PERSIST_INTERVAL - elapsed);
}

/**
 * 读取所有会话快照（最新在前）。
 * 任何异常都退化成空数组，调用方不需要 try/catch。
 *
 * @returns {Array<object>}
 */
export function loadSessions() {
  return ensureCache().slice();
}

/**
 * 记录一条会话。同一来源 + 同一首歌会被去重并挪到最前面。
 * 写盘是节流的，高频调用不会打爆主线程。
 *
 * @param {object} snapshot
 * @returns {object|null} 规整后的快照，数据不合法时返回 null
 */
export function recordSession(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  if (!normalized) return null;

  const list = ensureCache();
  cache = [normalized, ...list.filter(item => item.id !== normalized.id)].slice(
    0,
    MAX_SESSIONS
  );
  schedulePersist();
  return normalized;
}

/**
 * 强制把内存里的会话立即落盘。切歌、暂停、页面关闭时调用。
 */
export function flushSessions() {
  persistNow();
}

/**
 * 清空全部会话记录。
 */
export function clearSessions() {
  cache = [];
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  lastPersistAt = Date.now();
  try {
    localStorage.removeItem(LISTEN_HISTORY_KEY);
  } catch (error) {
    console.warn('[listenHistory] failed to clear sessions', error);
  }
}

/**
 * 相对时间标签。纯函数，方便单独验证。
 *
 * @param {number} playedAt 毫秒时间戳
 * @param {number} [now] 当前时间戳
 * @returns {string}
 */
export function formatRelativeTime(playedAt, now = Date.now()) {
  const time = Number(playedAt);
  if (!Number.isFinite(time) || time <= 0) return '';
  const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();

  const diff = current - time;
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  // 时钟回拨 / 未来时间也当成「刚刚」，不要显示「-3 分钟前」
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`;

  const date = new Date(time);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/* ------------------------------------------------------------------ *
 * 会话追踪
 *
 * 播放器状态不是 Vuex mutation（state.player 是普通对象 + Proxy），
 * 所以不能靠 store.subscribe 捕获「进度变化」。这里用两条腿：
 *   - 每 2 秒采样一次（保证 3 秒续播精度）
 *   - 订阅 updateTitle（Player.setTitle 在切歌 / 暂停时都会 commit）
 *     作为即时信号，比等下一次轮询更准
 *
 * 已知限制：追踪器由首页（ContinueListening 的 created）启动。
 * 首页是默认落地路由，所以实际效果是「启动即开始记录」；
 * 但如果用户从不经过首页，就不会有记录。要彻底解决需要把
 * initSessionTracking(store) 挪到 App.vue 或 main.js —— 那不在本次改动范围。
 * ------------------------------------------------------------------ */

const tracker = {
  /** @type {object|null} */
  player: null,
  /** @type {number|null} */
  timer: null,
  lastTrackID: 0,
  lastPlaying: false,
  lastProgressMs: 0,
  lastPlayedAt: 0,
  bound: false,
  subscribed: false,
};

/**
 * 从播放列表里取「当前歌曲附近」的一段窗口。
 * 直接 slice(0, MAX) 会把第 9000 首在播时当前歌曲裁掉，续播就失效了。
 *
 * @param {number[]} list
 * @param {number} index
 * @param {number} limit
 * @returns {number[]}
 */
function sliceWindow(list, index, limit) {
  if (list.length <= limit) return list.slice();
  const half = Math.floor(limit / 2);
  let start = Math.max(0, index - half);
  if (start + limit > list.length) start = list.length - limit;
  return list.slice(start, start + limit);
}

/**
 * 把播放器当前状态转成一条快照。只读公开 getter + 少量稳定字段。
 *
 * @param {object} player
 * @returns {object|null}
 */
function snapshotFromPlayer(player) {
  if (!player) return null;
  const track = player.currentTrack;
  // 冷启动时 _currentTrack 只是个占位对象（{ id: 86827685 }），
  // 没有 name，不能当成一次真实收听写进历史。
  if (!track || !isNumber(track.id) || track.id <= 0) return null;
  if (!isNonEmptyString(track.name)) return null;

  const list = Array.isArray(player.list) ? player.list : [];
  const index = list.indexOf(track.id);
  const trackIDs = sliceWindow(
    list.length > 0 ? list : [track.id],
    index < 0 ? 0 : index,
    MAX_TRACK_IDS
  );

  const artists = Array.isArray(track.ar)
    ? track.ar
    : Array.isArray(track.artists)
    ? track.artists
    : [];
  const album = track.al || track.album || {};
  const source = player.playlistSource || {};

  return {
    trackIDs,
    sourceType: typeof source.type === 'string' ? source.type : '',
    sourceID: isNumber(source.id) ? source.id : 0,
    progressMs: Math.max(0, Math.round((Number(player.progress) || 0) * 1000)),
    trackMeta: {
      id: track.id,
      name: track.name,
      artistNames: artists
        .map(artist => artist && artist.name)
        .filter(Boolean)
        .join(' / '),
      albumName: typeof album.name === 'string' ? album.name : '',
      coverUrl: typeof album.picUrl === 'string' ? album.picUrl : '',
      durationMs: isNumber(track.dt) ? track.dt : 0,
    },
    playedAt: Date.now(),
  };
}

/**
 * 采样一次并写入内存。force=true 时无视「暂停中不刷新」的优化并强制落盘。
 *
 * @param {boolean} force
 * @returns {object|null}
 */
function captureSession(force = false) {
  const player = tracker.player;
  if (!player) return null;

  const snapshot = snapshotFromPlayer(player);
  if (!snapshot) return null;

  const playing = !!player.playing;
  const firstCapture = tracker.lastTrackID === 0;
  const trackChanged =
    !firstCapture && tracker.lastTrackID !== snapshot.trackMeta.id;
  const justPaused = tracker.lastPlaying === true && playing === false;
  // 暂停状态下进度也可能变（用户拖了进度条、或者启动时刚从
  // playerCurrentTrackTime 恢复位置），变化超过 1 秒就补记一次。
  const progressDrifted =
    Math.abs(snapshot.progressMs - tracker.lastProgressMs) >= 1000;

  // 切歌的那一瞬间 player.progress 还是上一首的位置，
  // 直接沿用会把新歌的续播点写成上一首的进度。
  if (trackChanged) snapshot.progressMs = 0;

  tracker.lastTrackID = snapshot.trackMeta.id;
  tracker.lastPlaying = playing;

  // 暂停期间没有任何变化就不采样，否则 playedAt 会一直刷新，
  // 卡片上的「刚刚」永远停不下来。
  if (!force && !playing && !trackChanged && !justPaused && !progressDrifted) {
    return null;
  }

  // playedAt 只在真正播放时推进：暂停后 playedAt 冻结在暂停那一刻，
  // 卡片上才会从「刚刚」慢慢变成「N 分钟前」。
  if (playing) {
    tracker.lastPlayedAt = snapshot.playedAt;
  } else if (tracker.lastPlayedAt > 0) {
    snapshot.playedAt = tracker.lastPlayedAt;
  }
  tracker.lastProgressMs = snapshot.progressMs;

  const stored = recordSession(snapshot);
  if (force || trackChanged || justPaused) flushSessions();
  return stored;
}

function safeCapture(force = false) {
  try {
    return captureSession(force);
  } catch (error) {
    console.warn('[listenHistory] failed to capture session', error);
    return null;
  }
}

/**
 * 启动会话追踪（幂等）。
 *
 * @param {object} store Vuex store 实例
 */
export function initSessionTracking(store) {
  if (tracker.timer !== null) return;

  const player = store && store.state ? store.state.player : null;
  if (!player) return;

  tracker.player = player;
  tracker.lastTrackID = 0;
  tracker.lastPlaying = !!player.playing;
  tracker.lastProgressMs = 0;
  tracker.lastPlayedAt = 0;

  // 先抓一次，让首页在「上次没关干净」的情况下也有内容
  safeCapture(true);

  tracker.timer = setInterval(() => {
    safeCapture(false);
  }, SAMPLE_INTERVAL);

  if (!tracker.bound && typeof window !== 'undefined') {
    tracker.bound = true;
    const flush = () => safeCapture(true);
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
      });
    }
  }

  if (!tracker.subscribed && store.subscribe) {
    tracker.subscribed = true;
    store.subscribe(mutation => {
      if (mutation.type === 'updateTitle') safeCapture(true);
    });
  }
}
