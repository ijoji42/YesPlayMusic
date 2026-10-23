import { getAlbum } from '@/api/album';
import { getArtist } from '@/api/artist';
import { trackScrobble, trackUpdateNowPlaying } from '@/api/lastfm';
import { fmTrash, personalFM } from '@/api/others';
import { getPlaylistDetail, intelligencePlaylist } from '@/api/playlist';
import { getLyric, getMP3, getTrackDetail, scrobble } from '@/api/track';
import store from '@/store';
import { isAccountLoggedIn } from '@/utils/auth';
import { cacheTrackSource, getTrackSource } from '@/utils/db';
import { isCreateMpris, isCreateTray } from '@/utils/platform';
import { Howl } from 'howler';
import shuffle from 'lodash/shuffle';
import { decode as base642Buffer } from '@/utils/base64';

const PLAY_PAUSE_FADE_DURATION = 200;
// 切歌交叉淡化时长，用于掩盖 html5 音频源切换时的解码空隙
const TRACK_CROSSFADE_DURATION = 160;
// 播放器状态持久化的合并窗口：同一窗口内的高频变更只序列化一次
const PERSIST_THROTTLE = 800;
// 进度持久化间隔（独立的轻量 key，不参与 player 快照序列化）
const PROGRESS_SAVE_INTERVAL = 2000;
// 当前曲目起播后延迟这么久再开始预载下一首。
// 立刻预载会和当前曲目自己的缓冲抢带宽，弱网下反而推迟「多久能听见声音」。
const PRELOAD_DELAY = 1500;
// 预载实例的保鲜期。音源 URL 会过期，太旧的预载宁可丢掉重新取一次。
const PRELOAD_MAX_AGE = 5 * 60 * 1000;
// 拖动进度条会连续触发 seek，松手之后再重新预载
const SEEK_PRELOAD_DELAY = 1200;
// 加载态兜底超时：任何异常路径都不应该让播放按钮一直转圈
const LOADING_NEXT_TIMEOUT = 15000;
// 提升预载实例后迟迟没有起播时的等待时间，超时则回退到常规取源流程
const PRELOAD_PROMOTE_TIMEOUT = 3000;
// 同时存活的 Blob URL 上限：当前 + 交叉淡化中 + 预载 + 一次切换的余量。
// 上限过低会 revoke 掉正在播放的 URL（历史 bug），过高则白白占住内存。
const MAX_BLOB_URLS = 4;

const INDEX_IN_PLAY_NEXT = -1;

/**
 * 需要跨会话保留的播放器字段。
 * 显式白名单而非遍历实例：避免把 howler 引用、blob 记录、定时器句柄
 * 这类运行时对象写进 localStorage，也避免列表很长时产生无意义的序列化开销。
 */
const PERSISTED_KEYS = [
  '_enabled',
  '_repeatMode',
  '_shuffle',
  '_reversed',
  '_volume',
  '_volumeBeforeMuted',
  '_list',
  '_current',
  '_shuffledList',
  '_shuffledCurrent',
  '_playlistSource',
  '_currentTrack',
  '_playNextList',
  '_personalFMTrack',
  '_personalFMNextTrack',
  // 当前实例是不是 Web Audio 模式（原始值）。恢复会话时先按快照占位，
  // 真正的实例建好后会被 _playAudioSource 覆盖成实际值。
  // _currentSource 刻意不在这里：它是 blob URL，跨会话必然失效。
  '_howlerWebAudio',
];

/**
 * @readonly
 * @enum {string}
 */
const UNPLAYABLE_CONDITION = {
  PLAY_NEXT_TRACK: 'playNextTrack',
  PLAY_PREV_TRACK: 'playPrevTrack',
};

const electron =
  process.env.IS_ELECTRON === true ? window.require('electron') : null;
const ipcRenderer =
  process.env.IS_ELECTRON === true ? electron.ipcRenderer : null;
const delay = ms =>
  new Promise(resolve => {
    setTimeout(() => {
      resolve('');
    }, ms);
  });

// 用户是否指定了非默认输出设备。'default' 和空值都表示「系统默认」。
function hasCustomOutputDevice() {
  const device = store.state.settings?.outputDevice;
  return Boolean(device) && device !== 'default';
}

/**
 * 律动背景需要音频真正流过 Web Audio 图，AnalyserNode 才能读到频谱。
 *
 * Howler 的 html5 模式把播放交给 <audio> 元素直接输出到硬件，信号不经过
 * Howler.masterGain，挂在 masterGain 上的 analyser 读到的永远是全 0，
 * 界面上就是「当前音源无法读取频谱，背景已降级为静态效果」。
 *
 * 但也**不能**无条件关掉 html5：Web Audio 模式会把整首歌解码成 PCM 常驻内存
 * （一首 4 分钟的 FLAC 约 80~130MB）。律动是默认不启用的功能，只有它真的被
 * 选中时才值得付这份内存代价。
 *
 * 还有一层设备约束：Web Audio 模式下 `_sounds[0]._node` 是音频节点而不是
 * <audio>，没有 setSinkId，而 Electron 13 的 Chromium 91 里 AudioContext
 * 也还没有 setSinkId —— 一旦切到 Web Audio，用户选的输出设备就会静默失效。
 * 设备路由是硬功能、律动是装饰，所以有自定义输出设备时优先保住设备，
 * 让律动退回静态（设置面板里有对应提示和「切回系统默认」按钮）。
 */
function needsWebAudioAnalysis() {
  return (
    store.state.settings?.lyricsBackground === 'reactive' &&
    !hasCustomOutputDevice()
  );
}

function setTitle(track) {
  document.title = track
    ? `${track.name} · ${track.ar[0].name} - YesPlayMusic`
    : 'YesPlayMusic';
  if (isCreateTray) {
    ipcRenderer?.send('updateTrayTooltip', document.title);
  }
  store.commit('updateTitle', document.title);
}

function setTrayLikeState(isLiked) {
  if (isCreateTray) {
    ipcRenderer?.send('updateTrayLikeState', isLiked);
  }
}

export default class {
  constructor() {
    // 播放器状态
    this._playing = false; // 是否正在播放中
    this._progress = 0; // 当前播放歌曲的进度
    this._enabled = false; // 是否启用Player
    this._repeatMode = 'off'; // off | on | one
    this._shuffle = false; // true | false
    this._reversed = false;
    this._volume = 1; // 0 to 1
    this._volumeBeforeMuted = 1; // 用于保存静音前的音量
    this._personalFMLoading = false; // 是否正在私人FM中加载新的track
    this._personalFMNextLoading = false; // 是否正在缓存私人FM的下一首歌曲
    this._lastSeekAt = 0; // 最近一次用户 seek 的时间戳
    this._lastProgressSave = 0; // 最近一次进度落盘的时间戳
    this._desiredPlaying = false; // 用户期望的播放状态（用于淡入淡出竞态判定）
    this._pauseSeq = 0; // 用户主动暂停的次数，用于取消「等待音源期间」的自动播放
    this._pendingFadeIn = null; // 下一次起播后使用的淡入时长（交叉淡化用）
    this._loadingNext = false; // 是否正在为下一首等待音源（驱动播放按钮的加载态）
    this._loadingTimer = null; // 加载态的兜底计时器
    this._playWatchdog = null; // 预载实例提升后的起播看门狗
    this._outputDeviceSyncTimer = null; // 换输出设备时的防抖计时器
    Object.defineProperty(this, '_outputDeviceSyncTimer', {
      enumerable: false,
    });
    this._currentSource = null; // 当前音源字符串，升级到 Web Audio 模式时重建要用
    this._howlerWebAudio = false; // 当前实例是否走 Web Audio 模式（可被 analyser 读取）
    this._analyserRebuild = null; // 升级中的 Promise，用于挡住并发调用
    // 并发锁没有任何视图依赖它，没必要让 Vue 把它变成响应式对象
    Object.defineProperty(this, '_analyserRebuild', {
      enumerable: false,
    });

    // 设置项 watch 的注册时机见 bindSettingsWatchers() 的注释。
    this._settingsWatchersBound = false;
    Object.defineProperty(this, '_settingsWatchersBound', {
      enumerable: false,
    });
    Promise.resolve().then(() => this.bindSettingsWatchers());

    // 播放信息
    this._list = []; // 播放列表
    this._current = 0; // 当前播放歌曲在播放列表里的index
    this._shuffledList = []; // 被随机打乱的播放列表，随机播放模式下会使用此播放列表
    this._shuffledCurrent = 0; // 当前播放歌曲在随机列表里面的index
    this._playlistSource = { type: 'album', id: 123 }; // 当前播放列表的信息
    this._currentTrack = { id: 86827685 }; // 当前播放歌曲的详细信息
    this._playNextList = []; // 当这个list不为空时，会优先播放这个list的歌
    this._isPersonalFM = false; // 是否是私人FM模式
    this._personalFMTrack = { id: 0 }; // 私人FM当前歌曲
    this._personalFMNextTrack = {
      id: 0,
    }; // 私人FM下一首歌曲信息（为了快速加载下一首）

    /**
     * The blob records for cleanup.
     *
     * @private
     * @type {string[]}
     */
    this.createdBlobRecords = [];

    // 持久化调度（不参与序列化）
    this._persistDirty = false;
    this._persistTimer = null;

    // howler (https://github.com/goldfire/howler.js)
    this._howler = null;
    Object.defineProperty(this, '_howler', {
      enumerable: false,
    });

    // 上一个 howler 实例，切歌时用于交叉淡化后卸载
    this._fadingHowler = null;

    /**
     * 下一首的预载槽位（单槽）。
     *
     * 结构：{ trackID, track, source, howl, createdAt }
     * 只有一份实例：任何一次「换下一首」都会先卸载旧的再建新的，
     * 否则每次切歌都会多留一个 <audio> 节点 + 一个 Blob URL。
     */
    this._preload = null;
    // 预载任务的序号守卫：连续切歌时，先发出的预载不能覆盖后发出的结果
    this._preloadSeq = 0;
    this._preloadTimer = null;

    // 这两个字段都持有 Howl 实例。Vue 会对 store.state.player 的可枚举属性
    // 做深度 observe，把整棵 Howl 对象树变成响应式对象既无意义、又会在每次
    // 切歌时产生一次深遍历，所以和 _howler 一样声明为非枚举。
    Object.defineProperty(this, '_fadingHowler', {
      enumerable: false,
    });
    Object.defineProperty(this, '_preload', {
      enumerable: false,
    });

    // init
    this._init();

    if (typeof window !== 'undefined') {
      // 关闭 / 隐藏页面时把合并窗口内未落盘的状态立即写掉
      window.addEventListener('pagehide', () =>
        this._flushSelfToLocalStorage()
      );
      window.addEventListener('beforeunload', () =>
        this._flushSelfToLocalStorage()
      );
    }

    window.yesplaymusic = {};
    window.yesplaymusic.player = this;
  }

  /**
   * 注册依赖设置项的 watch。
   *
   * **不能**写在构造函数里直接调用 store.watch()：
   * src/store/index.js 第 108 行 `new Player()`，而它的 `export default store`
   * 在第 120 行。Player 与 store 互相 import，构造函数执行的那一刻，本文件
   * 从 '@/store' 读到的默认导出还是 undefined，`store.watch(...)` 会抛
   * `TypeError: Cannot read property 'watch' of undefined`。
   *
   * 这是**模块求值期**的异常，会中断整个 renderer 的启动 —— 用户看到的就是
   * 「打开后一片白」。构造函数里用 Promise.resolve().then 推到微任务注册，
   * 那时 store/index.js 的同步求值已结束，默认导出就位。
   * 方法本身再兜一层判空，避免任何时序意外把整个应用带崩。
   */
  bindSettingsWatchers() {
    if (this._settingsWatchersBound || !store) return;
    this._settingsWatchersBound = true;

    // 切到律动：允许升级，当前这首立刻生效。
    // 反方向（律动关掉）由 syncAudioMode 内部的「降级需授权」挡掉。
    store.watch(
      state => state.settings?.lyricsBackground,
      () => {
        this.syncAudioMode(false);
      }
    );

    // 换输出设备：模式可能双向变化，所以允许降级。
    // 250ms 防抖有两个作用：一是把设备列表里的连点合并成一次重建，
    // 二是避开 syncAudioMode 的单槽锁——升级要等解码（0.3~2s），
    // 途中再来的请求会被锁直接吞掉，最终实例会停在错误的音频模式上。
    store.watch(
      state => state.settings?.outputDevice,
      () => {
        if (this._outputDeviceSyncTimer !== null) {
          clearTimeout(this._outputDeviceSyncTimer);
        }
        this._outputDeviceSyncTimer = setTimeout(() => {
          this._outputDeviceSyncTimer = null;
          this.syncAudioMode(true);
        }, 250);
      }
    );
  }

  get repeatMode() {
    return this._repeatMode;
  }
  set repeatMode(mode) {
    if (this._isPersonalFM) return;
    if (!['off', 'on', 'one'].includes(mode)) {
      console.warn("repeatMode: invalid args, must be 'on' | 'off' | 'one'");
      return;
    }
    this._repeatMode = mode;
    // 循环模式变了，「下一首」就不再是同一首歌，预载作废并重建
    this._refreshPreload();
  }
  get shuffle() {
    return this._shuffle;
  }
  set shuffle(shuffle) {
    if (this._isPersonalFM) return;
    if (shuffle !== true && shuffle !== false) {
      console.warn('shuffle: invalid args, must be Boolean');
      return;
    }
    this._shuffle = shuffle;
    if (shuffle) {
      this._shuffleTheList();
    }
    // 同步当前歌曲在列表中的下标
    this.current = this.list.indexOf(this.currentTrackID);
    // 随机顺序变了，「下一首」整条链路都变了，预载作废并重建
    this._refreshPreload();
  }
  get reversed() {
    return this._reversed;
  }
  set reversed(reversed) {
    if (this._isPersonalFM) return;
    if (reversed !== true && reversed !== false) {
      console.warn('reversed: invalid args, must be Boolean');
      return;
    }
    console.log('changing reversed to:', reversed);
    this._reversed = reversed;
    // 倒序模式下「下一首」方向相反，预载作废并重建
    this._refreshPreload();
  }
  get volume() {
    return this._volume;
  }
  set volume(volume) {
    this._volume = volume;
    this._howler?.volume(volume);
  }
  get list() {
    return this.shuffle ? this._shuffledList : this._list;
  }
  set list(list) {
    this._list = list;
  }
  get current() {
    return this.shuffle ? this._shuffledCurrent : this._current;
  }
  set current(current) {
    if (this.shuffle) {
      this._shuffledCurrent = current;
    } else {
      this._current = current;
    }
  }
  get enabled() {
    return this._enabled;
  }
  get playing() {
    return this._playing;
  }
  /**
   * 是否正在为「下一首」等待音源。
   *
   * 命中预载时整条链路都是同步的，这个值根本不会变 true；
   * 只有真的要走网络取歌单详情 / 音源时才会亮起来，用来驱动播放按钮上的加载环。
   */
  get loadingNext() {
    return this._loadingNext;
  }
  get currentTrack() {
    return this._currentTrack;
  }
  get currentTrackID() {
    return this._currentTrack?.id ?? 0;
  }
  get playlistSource() {
    return this._playlistSource;
  }
  get playNextList() {
    return this._playNextList;
  }
  get isPersonalFM() {
    return this._isPersonalFM;
  }
  get personalFMTrack() {
    return this._personalFMTrack;
  }
  get currentTrackDuration() {
    const trackDuration = this._currentTrack.dt || 1000;
    let duration = ~~(trackDuration / 1000);
    return duration > 1 ? duration - 1 : duration;
  }
  get progress() {
    return this._progress;
  }
  set progress(value) {
    if (this._howler) {
      // 与 seek() 保持一致：记录 seek 时间并立刻回写进度。
      // 原实现只调 _howler.seek()，不更新 _progress 也不打时间戳，
      // 导致歌词页的进度条松手后会被 1 秒一次的采样「弹回」旧位置。
      this._lastSeekAt = Date.now();
      this._progress = value;
      this._howler.seek(value);
      if (isCreateMpris) {
        ipcRenderer?.send('seeked', this._howler.seek());
      }
      this._onUserSeek();
    }
  }
  get isCurrentTrackLiked() {
    return store.state.liked.songs.includes(this.currentTrack.id);
  }

  _init() {
    this._loadSelfFromLocalStorage();
    // 运行时字段不接受历史快照的影响：否则上一次会话残留的 true
    // 会让播放按钮一启动就转圈。
    this._loadingNext = false;
    this._pendingFadeIn = null;
    this._howler?.volume(this.volume);

    if (this._enabled) {
      // 恢复当前播放歌曲
      this._replaceCurrentTrack(this.currentTrackID, false)
        .then(() => {
          const savedTime = Number(
            localStorage.getItem('playerCurrentTrackTime')
          );
          if (Number.isFinite(savedTime) && savedTime > 0) {
            this._howler?.seek(savedTime);
          }
        })
        .catch(error => {
          console.warn('[Player] failed to restore last track', error);
        }); // update audio source and init howler
      this._initMediaSession();
    }

    this._setIntervals();

    // 初始化私人FM
    if (
      this._personalFMTrack.id === 0 ||
      this._personalFMNextTrack.id === 0 ||
      this._personalFMTrack.id === this._personalFMNextTrack.id
    ) {
      personalFM().then(result => {
        this._personalFMTrack = result.data[0];
        this._personalFMNextTrack = result.data[1];
        return this._personalFMTrack;
      });
    }
  }
  _setPlaying(isPlaying) {
    this._playing = isPlaying;
    if (isCreateTray) {
      ipcRenderer?.send('updateTrayPlayState', this._playing);
    }
  }
  _setIntervals() {
    // 同步播放进度
    // 修掉了原先的覆盖问题：用户刚 seek 过的 1.2s 内不用定时器采样值覆盖，
    // 否则拖动进度条会被每秒一次的采样「弹回去」。
    this._progressTimer = setInterval(() => {
      if (this._howler === null) return;
      if (Date.now() - this._lastSeekAt < 1200) return;

      const progress = this._howler.seek();
      if (typeof progress !== 'number' || Number.isNaN(progress)) return;
      this._progress = progress;

      // 进度单独用轻量 key 持久化，且降频到 2s 一次，避免每秒同步写盘
      const now = Date.now();
      if (now - this._lastProgressSave >= PROGRESS_SAVE_INTERVAL) {
        this._lastProgressSave = now;
        try {
          localStorage.setItem('playerCurrentTrackTime', String(progress));
        } catch (e) {
          /* ignore quota errors */
        }
      }
      if (isCreateMpris) {
        ipcRenderer?.send('playerCurrentTrackTime', progress);
      }
    }, 1000);
  }
  _getNextTrack() {
    const next = this._reversed ? this.current - 1 : this.current + 1;

    if (this._playNextList.length > 0) {
      let trackID = this._playNextList[0];
      return [trackID, INDEX_IN_PLAY_NEXT];
    }

    // 循环模式开启，则重新播放当前模式下的相对的下一首
    if (this.repeatMode === 'on') {
      if (this._reversed && this.current === 0) {
        // 倒序模式，当前歌曲是第一首，则重新播放列表最后一首
        return [this.list[this.list.length - 1], this.list.length - 1];
      } else if (this.list.length === this.current + 1) {
        // 正序模式，当前歌曲是最后一首，则重新播放第一首
        return [this.list[0], 0];
      }
    }

    // 返回 [trackID, index]
    return [this.list[next], next];
  }
  _getPrevTrack() {
    const next = this._reversed ? this.current + 1 : this.current - 1;

    // 循环模式开启，则重新播放当前模式下的相对的下一首
    if (this.repeatMode === 'on') {
      if (this._reversed && this.current === 0) {
        // 倒序模式，当前歌曲是最后一首，则重新播放列表第一首
        return [this.list[0], 0];
      } else if (this.list.length === this.current + 1) {
        // 正序模式，当前歌曲是第一首，则重新播放列表最后一首
        return [this.list[this.list.length - 1], this.list.length - 1];
      }
    }

    // 返回 [trackID, index]
    return [this.list[next], next];
  }
  async _shuffleTheList(firstTrackID = this.currentTrackID) {
    let list = this._list.filter(tid => tid !== firstTrackID);
    if (firstTrackID === 'first') list = this._list;
    this._shuffledList = shuffle(list);
    if (firstTrackID !== 'first') this._shuffledList.unshift(firstTrackID);
  }
  async _scrobble(track, time, completed = false) {
    console.debug(
      `[debug][Player.js] scrobble track 👉 ${track.name} by ${track.ar[0].name} 👉 time:${time} completed: ${completed}`
    );
    const trackDuration = ~~(track.dt / 1000);
    time = completed ? trackDuration : ~~time;

    // 一次播放只上报一次：歌曲自然播完时会先走 _nextTrackCallback，
    // 紧接着切歌又会走 _replaceCurrentTrack，两边都会调用到这里。
    // 没有真正播放过的歌曲 (时长为 0) 也不需要上报。
    const howler = this._howler;
    if (howler?._scrobbled || time < 1) return;
    if (howler) howler._scrobbled = true;

    scrobble({
      id: track.id,
      sourceid: this.playlistSource.id,
      time,
    }).catch(error => {
      console.debug('[debug][Player.js] scrobble failed', error);
    });
    if (
      store.state.lastfm.key !== undefined &&
      (time >= trackDuration / 2 || time >= 240)
    ) {
      const timestamp = ~~(new Date().getTime() / 1000) - time;
      trackScrobble({
        artist: track.ar[0].name,
        track: track.name,
        timestamp,
        album: track.al.name,
        trackNumber: track.no,
        duration: trackDuration,
      });
    }
  }
  /**
   * 把一个音源变成「当前正在播的 howler」。
   *
   * @param {string} source 音源 URL（预载命中时只作为日志/兜底信息）
   * @param {boolean} autoplay 是否立即起播
   * @param {import('howler').Howl=} preloadedHowl 命中预载槽位时直接提升的实例
   */
  _playAudioSource(source, autoplay = true, preloadedHowl = null) {
    const previous = this._howler;
    const crossfade = this._getCrossfadeDuration();
    // 只有律动开启时才值得把整首歌解码进内存，其余场景继续用 html5 省内存
    const useWebAudio = needsWebAudioAnalysis();

    let howl = preloadedHowl;
    if (!howl) {
      howl = new Howl({
        src: [source],
        html5: !useWebAudio,
        preload: true,
        format: ['mp3', 'flac'],
      });
      // 标记实例的音频模式，供 syncAudioMode() 判断要不要重建。
      // 它挂在 Howl 实例上，而 Howl 实例从不参与序列化，所以不必担心落盘。
      howl._ypmWebAudio = useWebAudio;
    }
    this._howler = howl;
    // 重建实例（升级 Web Audio 模式 / 音源失效重取）都要靠这两个字段还原现场
    this._currentSource = source;
    this._howlerWebAudio = preloadedHowl
      ? Boolean(preloadedHowl._ypmWebAudio)
      : useWebAudio;
    this._bindHowlEvents(howl);

    // 交叉淡化：旧实例淡出后单独卸载。
    // 不使用 Howler.unload()（全局卸载会连带销毁预加载实例），
    // 也不会在切歌瞬间硬切造成可听见的爆音。
    if (previous && previous !== howl) {
      const fadeOut = crossfade > 0 ? crossfade : TRACK_CROSSFADE_DURATION;
      this._fadingHowler = previous;
      try {
        const fromVolume = previous.volume();
        previous.fade(fromVolume, 0, fadeOut);
        setTimeout(() => {
          if (this._fadingHowler === previous) this._fadingHowler = null;
          this._unloadHowl(previous);
          // 淡出结束后旧实例不再持有 Blob URL，顺手回收更早的记录
          this._trimBlobRecords();
        }, fadeOut + 60);
      } catch (e) {
        this._fadingHowler = null;
      }
    }

    if (autoplay) {
      if (crossfade > 0) {
        // 先静音再起播：howler 的 fade() 是 10ms 一档的定时器，
        // 起播到第一次 fade 之间会有一个满音量的窗口，听起来是「咔」一声。
        this._pendingFadeIn = crossfade;
        howl.volume(0);
      }
      this.play();
      if (this._currentTrack.name) {
        setTitle(this._currentTrack);
      }
      setTrayLikeState(store.state.liked.songs.includes(this.currentTrack.id));
      // 预载实例也可能是「加载过但已经失效」的（音源 URL 过期）。
      // 这种情况下 howler 会一直停在 loading、play() 永远排队，
      // 表现为播放按钮一直转圈，所以给一个有限次数的回退。
      if (preloadedHowl) this._armPlayWatchdog(howl);
    } else {
      howl.volume(this.volume);
      this._setLoadingNext(false);
    }
    this.setOutputDevice();
    // 起播之后再预载下一首，避免抢走当前曲目自己的带宽
    this._schedulePreload();
  }
  /**
   * 让当前实例的音频模式与设置保持一致。
   *
   * 两个方向触发条件不同：
   * - 升级（html5 → Web Audio）由「切到律动」触发，任何时候都允许；
   * - 降级（Web Audio → html5）默认**不允许**：那会让正在播的歌重新解码一次、
   *   中途断音，而省下来的内存对已经开始的这次播放没有意义。
   *   唯一的例外是用户换了输出设备——设备路由只有 html5 的 <audio> 支持
   *   （见 needsWebAudioAnalysis），此时宁可断一下也必须重建，否则用户
   *   会以为设备选择失效了。这种场景由调用方传 allowDowngrade = true。
   *
   * 注意：选了非默认输出设备时 needsWebAudioAnalysis() 恒为 false，
   * 所以此时本方法的目标模式就是 html5。
   *
   * @param {boolean} allowDowngrade 是否允许从 Web Audio 退回 html5
   * @returns {Promise<boolean>} 是否已处于目标模式
   */
  syncAudioMode(allowDowngrade = false) {
    const wantWebAudio = needsWebAudioAnalysis();
    if (!this._currentTrack || !this._currentSource || !this._howler) {
      return Promise.resolve(false);
    }
    if (this._howlerWebAudio === wantWebAudio) return Promise.resolve(true);
    // 降级需要显式授权
    if (!wantWebAudio && !allowDowngrade) return Promise.resolve(false);
    // 重入保护：设置页连点、watch 与起播同时触发时只重建一次
    if (this._analyserRebuild) return this._analyserRebuild;

    const previous = this._howler;
    let wasPlaying = false;
    let position = 0;
    try {
      wasPlaying = previous.playing();
      position = previous.seek() || 0;
    } catch (e) {
      // 取不到现场就当作从头暂停状态重建，至少比停在原地好
      wasPlaying = false;
      position = 0;
    }

    this._analyserRebuild = new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      try {
        // autoplay 传 false：解码期间不出声，就绪后再按原状态恢复，
        // 否则用户会听到「先从头响一下、再跳回去」。
        this._playAudioSource(this._currentSource, false);
      } catch (e) {
        finish(false);
        return;
      }

      const howl = this._howler;
      if (!howl) {
        finish(false);
        return;
      }

      const resume = () => {
        if (this._howler !== howl) {
          finish(false);
          return;
        }
        try {
          if (position > 0) howl.seek(position);
        } catch (e) {
          /* seek 失败就从头开始，不值得中断升级 */
        }
        if (wasPlaying) {
          try {
            this.play();
          } catch (e) {
            /* ignore */
          }
        }
        finish(true);
      };

      if (howl.state() === 'loaded') {
        resume();
      } else {
        howl.once('load', resume);
      }
      // 兜底：音源加载失败时不能让这个 Promise 永远挂着，否则后续调用
      // 会被重入保护挡住，律动再也升不上去。
      howl.once('loaderror', () => finish(false));
    }).then(
      value => {
        this._analyserRebuild = null;
        return value;
      },
      () => {
        // 理论上不会走到这里；但一旦 reject 而不清锁，后续所有调用都会被
        // 重入保护挡掉，律动就永久升不上去了。
        this._analyserRebuild = null;
        return false;
      }
    );

    return this._analyserRebuild;
  }
  _bindHowlEvents(howl) {
    if (!howl || howl._ypmBound) return;
    howl._ypmBound = true;

    howl.on('end', () => {
      // 已经被替换掉的实例（交叉淡化中的旧实例）不再触发切歌
      if (this._howler !== howl) return;
      this._nextTrackCallback();
    });
    howl.on('loaderror', (_, errCode) => {
      // 旧实例的加载错误不再影响当前播放
      if (this._howler !== howl) return;
      this._setLoadingNext(false);
      // https://developer.mozilla.org/en-US/docs/Web/API/MediaError/code
      // code 3: MEDIA_ERR_DECODE
      if (errCode === 3) {
        this._playNextTrack(this._isPersonalFM);
      } else if (errCode === 4) {
        // code 4: MEDIA_ERR_SRC_NOT_SUPPORTED
        store.dispatch('showToast', `无法播放: 不支持的音频格式`);
        this._playNextTrack(this._isPersonalFM);
      } else {
        const t = this.progress;
        this._replaceCurrentTrackAudio(this.currentTrack, false, false).then(
          replaced => {
            // 如果 replaced 为 false，代表当前的 track 已经不是这里想要替换的track
            // 此时则不修改当前的歌曲进度
            if (replaced) {
              this._howler?.seek(t);
              this.play();
            }
          }
        );
      }
    });
  }
  /**
   * 预载实例起播看门狗。
   *
   * 正常预载在提升之前就应该已经缓冲完毕，提升后 3s 还没出声，
   * 基本可以确定这个音源已经失效（URL 过期 / 被 CDN 踢掉）。
   * 此时回退到一次常规的取源流程：这条路径不会重新装看门狗，
   * 所以最多重试一次，不会无限循环。
   */
  _armPlayWatchdog(howl) {
    this._clearPlayWatchdog();
    this._playWatchdog = setTimeout(() => {
      this._playWatchdog = null;
      if (this._howler !== howl) return;
      // 用户自己按了暂停，不要因为「没声音」就去重新取源
      if (!this._desiredPlaying) return;
      if (this._playing || howl.playing()) return;
      console.debug(
        '[debug][Player.js] preload promote timeout, refetch source'
      );
      this._replaceCurrentTrackAudio(this.currentTrack, true, false).catch(
        () => {}
      );
    }, PRELOAD_PROMOTE_TIMEOUT);
  }
  _clearPlayWatchdog() {
    if (this._playWatchdog !== null) {
      clearTimeout(this._playWatchdog);
      this._playWatchdog = null;
    }
  }
  _getCrossfadeDuration() {
    const raw = Number(store.state.settings?.crossfadeDuration);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    // 设置项理论上是 0~3000，越界值直接夹住，避免一次错误的配置把淡变拉成几十秒
    return Math.min(raw, 3000);
  }
  _getAudioSourceBlobURL(data) {
    // Create a new object URL.
    const source = URL.createObjectURL(new Blob([data]));
    this.createdBlobRecords.push(source);
    this._trimBlobRecords();
    return source;
  }
  /**
   * 回收不再被任何 howler 引用的 Blob URL。
   *
   * 原实现用 `for...in` 遍历数组，拿到的是下标字符串（"0"、"1"），
   * URL.revokeObjectURL("0") 什么都不会释放，Blob 内存持续泄漏；
   * 后来改成「只保留最近两个」，但引入预载之后同时存活的 URL 变成三个
   * （当前 + 交叉淡化中 + 预载），按位置裁剪会 revoke 掉正在播放的那一个。
   * 所以这里改成按「是否仍被实例引用」来判定，位置只用来决定回收顺序。
   */
  _trimBlobRecords() {
    const inUse = new Set();
    for (const howl of [
      this._howler,
      this._fadingHowler,
      this._preload?.howl,
    ]) {
      const src = howl?._src;
      if (typeof src === 'string') {
        inUse.add(src);
      } else if (Array.isArray(src)) {
        src.forEach(s => inUse.add(s));
      }
    }

    while (this.createdBlobRecords.length > MAX_BLOB_URLS) {
      const index = this.createdBlobRecords.findIndex(url => !inUse.has(url));
      // 全都在用：宁可多留一份，也绝不回收正在播放的 URL
      if (index === -1) return;
      const [stale] = this.createdBlobRecords.splice(index, 1);
      try {
        URL.revokeObjectURL(stale);
      } catch (e) {
        /* ignore */
      }
    }
  }
  _unloadHowl(howl) {
    if (!howl) return;
    // 当前 / 正在淡出的实例由各自的生命周期负责卸载，这里绝不能碰
    if (howl === this._howler || howl === this._fadingHowler) return;
    try {
      // 只调 howl.unload() 时，<audio> 节点有可能在后台继续把整首歌下载完，
      // 直到 GC 才真正停下。先手动断开 src 才能真正释放掉这次预载。
      const node = howl._sounds?.[0]?._node;
      if (node) {
        node.pause();
        node.removeAttribute('src');
        node.load();
      }
    } catch (e) {
      /* ignore */
    }
    try {
      howl.unload();
    } catch (e) {
      /* already unloaded */
    }
  }
  _getAudioSourceFromCache(id) {
    return getTrackSource(id).then(t => {
      if (!t) return null;
      return this._getAudioSourceBlobURL(t.source);
    });
  }
  _getAudioSourceFromNetease(track) {
    if (isAccountLoggedIn()) {
      return getMP3(track.id).then(result => {
        if (!result.data[0]) return null;
        if (!result.data[0].url) return null;
        if (result.data[0].freeTrialInfo !== null) return null; // 跳过只能试听的歌曲
        const source = result.data[0].url.replace(/^http:/, 'https:');
        if (store.state.settings.automaticallyCacheSongs) {
          cacheTrackSource(track, source, result.data[0].br);
        }
        return source;
      });
    } else {
      return new Promise(resolve => {
        resolve(`https://music.163.com/song/media/outer/url?id=${track.id}`);
      });
    }
  }
  async _getAudioSourceFromUnblockMusic(track) {
    console.debug(`[debug][Player.js] _getAudioSourceFromUnblockMusic`);

    if (
      process.env.IS_ELECTRON !== true ||
      store.state.settings.enableUnblockNeteaseMusic === false
    ) {
      return null;
    }

    /**
     *
     * @param {string=} searchMode
     * @returns {import("@unblockneteasemusic/rust-napi").SearchMode}
     */
    const determineSearchMode = searchMode => {
      /**
       * FastFirst = 0
       * OrderFirst = 1
       */
      switch (searchMode) {
        case 'fast-first':
          return 0;
        case 'order-first':
          return 1;
        default:
          return 0;
      }
    };

    const retrieveSongInfo = await ipcRenderer.invoke(
      'unblock-music',
      store.state.settings.unmSource,
      track,
      {
        enableFlac: store.state.settings.unmEnableFlac || null,
        proxyUri: store.state.settings.unmProxyUri || null,
        searchMode: determineSearchMode(store.state.settings.unmSearchMode),
        config: {
          'joox:cookie': store.state.settings.unmJooxCookie || null,
          'qq:cookie': store.state.settings.unmQQCookie || null,
          'ytdl:exe': store.state.settings.unmYtDlExe || null,
        },
      }
    );

    if (store.state.settings.automaticallyCacheSongs && retrieveSongInfo?.url) {
      // 对于来自 bilibili 的音源
      // retrieveSongInfo.url 是音频数据的base64编码
      // 其他音源为实际url
      const url =
        retrieveSongInfo.source === 'bilibili'
          ? `data:application/octet-stream;base64,${retrieveSongInfo.url}`
          : retrieveSongInfo.url;
      cacheTrackSource(track, url, 128000, `unm:${retrieveSongInfo.source}`);
    }

    if (!retrieveSongInfo) {
      return null;
    }

    if (retrieveSongInfo.source !== 'bilibili') {
      return retrieveSongInfo.url;
    }

    const buffer = base642Buffer(retrieveSongInfo.url);
    return this._getAudioSourceBlobURL(buffer);
  }
  _getAudioSource(track) {
    return this._getAudioSourceFromCache(String(track.id))
      .then(source => {
        return source ?? this._getAudioSourceFromNetease(track);
      })
      .then(source => {
        return source ?? this._getAudioSourceFromUnblockMusic(track);
      });
  }
  _replaceCurrentTrack(
    id,
    autoplay = true,
    ifUnplayableThen = UNPLAYABLE_CONDITION.PLAY_NEXT_TRACK
  ) {
    if (autoplay && this._currentTrack.name) {
      this._scrobble(this.currentTrack, this._howler?.seek());
    }

    // 序号守卫：连续点「下一首」时，先发出的详情请求可能后返回，
    // 没有守卫就会「跳回去再跳回来」。只有最后一次请求的结果会被应用。
    this._replaceSeq = (this._replaceSeq || 0) + 1;
    const seq = this._replaceSeq;

    // 记录发起切歌时的「暂停代数」：等待音源期间用户点了暂停，
    // 音源就绪之后不应该再把声音放出来。
    const pauseSeq = this._pauseSeq;

    // 快路径：下一首已经在预载槽里，直接提升。
    // 不需要歌单详情请求、不需要音源请求、不需要重新建 <audio> 节点，
    // 整条链路是同步的，用户点下「下一首」的当帧就开始出声。
    const preload = this._takePreload(id);
    if (preload) {
      this._currentTrack = preload.track;
      this._updateMediaSessionMetaData(preload.track);
      this._playAudioSource(
        preload.source,
        autoplay && pauseSeq === this._pauseSeq,
        preload.howl
      );
      return Promise.resolve(true);
    }

    this._setLoadingNext(true);
    return getTrackDetail(id)
      .then(data => {
        if (seq !== this._replaceSeq) return false;
        const track = data?.songs?.[0];
        if (!track) {
          store.dispatch('showToast', `无法获取歌曲 ${id} 的信息`);
          this._setLoadingNext(false);
          return false;
        }
        this._currentTrack = track;
        this._updateMediaSessionMetaData(track);
        return this._replaceCurrentTrackAudio(
          track,
          autoplay && pauseSeq === this._pauseSeq,
          true,
          ifUnplayableThen
        );
      })
      .catch(error => {
        if (seq !== this._replaceSeq) return false;
        console.warn('[Player] failed to load track detail', id, error);
        store.dispatch('showToast', '加载歌曲失败，请检查网络');
        this._setPlaying(false);
        this._setLoadingNext(false);
        return false;
      });
  }
  /**
   * @returns 是否成功加载音频，并使用加载完成的音频替换了howler实例
   */
  _replaceCurrentTrackAudio(
    track,
    autoplay,
    isCacheNextTrack,
    ifUnplayableThen = UNPLAYABLE_CONDITION.PLAY_NEXT_TRACK
  ) {
    return this._getAudioSource(track).then(source => {
      if (source) {
        let replaced = false;
        if (track.id === this.currentTrackID) {
          this._playAudioSource(source, autoplay);
          replaced = true;
        }
        if (isCacheNextTrack) {
          this._cacheNextTrack();
        }
        return replaced;
      } else {
        store.dispatch('showToast', `无法播放 ${track.name}`);
        switch (ifUnplayableThen) {
          case UNPLAYABLE_CONDITION.PLAY_NEXT_TRACK:
            this._playNextTrack(this.isPersonalFM);
            break;
          case UNPLAYABLE_CONDITION.PLAY_PREV_TRACK:
            this.playPrevTrack();
            break;
          default:
            store.dispatch(
              'showToast',
              `undefined Unplayable condition: ${ifUnplayableThen}`
            );
            break;
        }
        return false;
      }
    });
  }
  /**
   * 预载下一首。
   *
   * 原实现只是把「下一首」的歌单详情和音源 URL 预热进 HTTP / Dexie 缓存，
   * 但没有建立任何可播放实例，切歌时仍然要重新 new Howl 并等 canplaythrough，
   * 弱网下这段时间就是用户听到的「点了下一首没反应」。
   * 现在改成完整的单槽位预载（歌单详情 + 音源 + 已开始缓冲的 Howl 实例），
   * 旧的缓存预热语义被完全包含在内。
   */
  _cacheNextTrack() {
    this._schedulePreload();
  }
  /**
   * 安排一次预载。
   *
   * 永远延迟执行：当前曲目刚起播时立刻去拉下一首会抢带宽，
   * 弱网下反而推迟「多久能听见声音」。多次调用只会保留最后一次。
   */
  _schedulePreload(delay = PRELOAD_DELAY) {
    this._clearPreloadTimer();
    this._preloadTimer = setTimeout(() => {
      this._preloadTimer = null;
      this._preloadNextTrack();
    }, delay);
  }
  _clearPreloadTimer() {
    if (this._preloadTimer !== null) {
      clearTimeout(this._preloadTimer);
      this._preloadTimer = null;
    }
  }
  /**
   * 「下一首」到底是谁。
   *
   * 私人FM 用 _personalFMNextTrack（接口已经提前给了下一首的信息），
   * 其余情况走 _getNextTrack()，与自动切歌 / 手动切歌用的是同一套规则
   * （playNextList 优先、repeatMode=on 时回绕、reversed 反向）。
   */
  _getPreloadTarget() {
    if (this._isPersonalFM) {
      const id = this._personalFMNextTrack?.id ?? 0;
      return id && id !== this.currentTrackID ? id : 0;
    }
    const [nextID] = this._getNextTrack();
    if (!nextID || nextID === this.currentTrackID) return 0;
    return nextID;
  }
  /**
   * 丢弃预载槽位。
   *
   * 必须真的 unload()：howler 把实例挂在全局 Howler._howls 上，
   * 不卸载就是「每切一首多一个 <audio> 节点 + 一个 Blob URL」，
   * 正是之前修过一次的那类泄漏。
   */
  _invalidatePreload() {
    // 序号 +1：仍在飞行中的预载任务拿到结果后会发现自己已经过期
    this._preloadSeq += 1;
    this._clearPreloadTimer();
    const slot = this._preload;
    this._preload = null;
    if (!slot) return;
    this._unloadHowl(slot.howl);
    this._trimBlobRecords();
  }
  /**
   * 用户操作导致「下一首」变了：丢掉旧预载，并为新的下一首重新预载。
   *
   * 只丢弃不重建会让「开随机 / 切循环模式 / 往队列插歌」之后的第一次切歌
   * 退回慢路径 —— 而这些恰好都是用户马上就会点「下一首」的时刻。
   * 还没有任何曲目被加载时不预载，避免冷启动就发起网络请求。
   */
  _refreshPreload() {
    this._invalidatePreload();
    if (this._howler) this._schedulePreload();
  }
  /**
   * 取出预载实例用于提升。
   *
   * 只有「目标就是它」且「还没过期」才会返回；不匹配时保留槽位不动
   * （用户可能只是点了别的歌，槽位里的那一首对后续仍然有意义），
   * 由随后的 _preloadNextTrack() 判定要不要换。
   */
  _takePreload(trackID) {
    const slot = this._preload;
    if (!slot) return null;
    if (slot.trackID !== trackID) return null;
    // 用户刚把背景切成律动时，槽位里可能还是一个 html5 实例。提升它上来
    // 依然读不到频谱（界面上就是「律动又没了」），所以宁可退回慢路径重取。
    if (Boolean(slot.howl?._ypmWebAudio) !== needsWebAudioAnalysis()) {
      this._invalidatePreload();
      return null;
    }
    if (Date.now() - slot.createdAt > PRELOAD_MAX_AGE) {
      this._invalidatePreload();
      return null;
    }
    this._clearPreloadTimer();
    this._preload = null;
    // 让仍在飞行中的预载任务失效，避免它把槽位又填回去
    this._preloadSeq += 1;
    return slot;
  }
  _preloadNextTrack() {
    const targetID = this._getPreloadTarget();
    if (!targetID) {
      this._invalidatePreload();
      return Promise.resolve(null);
    }

    const slot = this._preload;
    // 音频模式变了（用户开关律动）就作废旧槽位，按新模式重新预载
    const modeMatches =
      slot && Boolean(slot.howl?._ypmWebAudio) === needsWebAudioAnalysis();
    if (
      slot &&
      modeMatches &&
      slot.trackID === targetID &&
      Date.now() - slot.createdAt < PRELOAD_MAX_AGE
    ) {
      return Promise.resolve(slot);
    }

    // 目标变了：先清掉旧槽位，保证同一时刻最多只有一个预载实例
    this._invalidatePreload();
    const seq = ++this._preloadSeq;

    return getTrackDetail(targetID)
      .then(data => {
        if (seq !== this._preloadSeq) return null;
        const track = data?.songs?.[0];
        if (!track) return null;
        return this._getAudioSource(track).then(source => {
          if (!source) return null;
          // 走的是和正常播放完全相同的音源获取路径：
          // 优先命中 src/utils/db.js 的缓存并生成 Blob URL，
          // 所以预载既不会绕过缓存，也不会额外多下一遍音频。
          const useWebAudio = needsWebAudioAnalysis();
          const howl = new Howl({
            src: [source],
            html5: !useWebAudio,
            preload: true,
            format: ['mp3', 'flac'],
          });
          // 预载实例的模式必须和提升时一致：律动开着却提升一个 html5 实例，
          // analyser 依然读不到频谱，等于白升级一次。
          howl._ypmWebAudio = useWebAudio;
          // 预载实例不出声：音量跟随用户设置，真正提升时再按需从 0 淡入
          howl.volume(this.volume);

          if (seq !== this._preloadSeq) {
            this._unloadHowl(howl);
            this._trimBlobRecords();
            return null;
          }

          // 预载期间音源就失败了：立刻丢掉，别让提升路径拿到一个永远
          // 起不来的实例（那会表现为播放按钮一直转圈）。
          howl.once('loaderror', () => {
            if (this._preload?.howl === howl) this._invalidatePreload();
          });

          this._preload = {
            trackID: targetID,
            track,
            source,
            howl,
            createdAt: Date.now(),
          };
          this._trimBlobRecords();
          return this._preload;
        });
      })
      .catch(error => {
        console.debug('[debug][Player.js] preload next track failed', error);
        return null;
      });
  }
  _setLoadingNext(isLoading) {
    if (this._loadingTimer !== null) {
      clearTimeout(this._loadingTimer);
      this._loadingTimer = null;
    }
    this._loadingNext = isLoading;
    if (!isLoading) return;
    // 兜底：网络挂死、序号被后续切歌顶掉等异常路径都不应该让按钮一直转圈
    this._loadingTimer = setTimeout(() => {
      this._loadingTimer = null;
      this._loadingNext = false;
    }, LOADING_NEXT_TIMEOUT);
  }
  /**
   * 用户主动 seek 之后对预载槽位的处理。
   *
   * 已经缓冲完成的预载仍然有效，没必要因为一次 seek 就丢掉；
   * 还在缓冲中的预载会和 seek 触发的 range 请求抢带宽，
   * 而且拖动进度条会连续触发 seek，所以这里丢掉它、松手后再重新预载。
   */
  _onUserSeek() {
    const slot = this._preload;
    if (slot && slot.howl?._state !== 'loaded') {
      this._invalidatePreload();
    }
    this._schedulePreload(SEEK_PRELOAD_DELAY);
  }
  _loadSelfFromLocalStorage() {
    const player = JSON.parse(localStorage.getItem('player'));
    if (!player) return;
    for (const [key, value] of Object.entries(player)) {
      this[key] = value;
    }
  }
  _initMediaSession() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => {
        this.play();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        this.pause();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        this.playPrevTrack();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        this._playNextTrack(this.isPersonalFM);
      });
      navigator.mediaSession.setActionHandler('stop', () => {
        this.pause();
      });
      navigator.mediaSession.setActionHandler('seekto', event => {
        this.seek(event.seekTime);
        this._updateMediaSessionPositionState();
      });
      navigator.mediaSession.setActionHandler('seekbackward', event => {
        this.seek(this.seek() - (event.seekOffset || 10));
        this._updateMediaSessionPositionState();
      });
      navigator.mediaSession.setActionHandler('seekforward', event => {
        this.seek(this.seek() + (event.seekOffset || 10));
        this._updateMediaSessionPositionState();
      });
    }
  }
  _updateMediaSessionMetaData(track) {
    if ('mediaSession' in navigator === false) {
      return;
    }
    let artists = track.ar.map(a => a.name);
    const metadata = {
      title: track.name,
      artist: artists.join(','),
      album: track.al.name,
      artwork: [
        {
          src: track.al.picUrl + '?param=224y224',
          type: 'image/jpg',
          sizes: '224x224',
        },
        {
          src: track.al.picUrl + '?param=512y512',
          type: 'image/jpg',
          sizes: '512x512',
        },
      ],
      length: this.currentTrackDuration,
      trackId: this.current,
      url: '/trackid/' + track.id,
    };

    navigator.mediaSession.metadata = new window.MediaMetadata(metadata);
    if (isCreateMpris) {
      this._updateMprisState(track, metadata);
    }
  }
  // OSDLyrics 会检测 Mpris 状态并寻找对应歌词文件，所以要在更新 Mpris 状态之前保证歌词下载完成
  async _updateMprisState(track, metadata) {
    if (!store.state.settings.enableOsdlyricsSupport) {
      return ipcRenderer?.send('metadata', metadata);
    }

    let lyricContent = null;
    try {
      lyricContent = await getLyric(track.id);
    } catch (e) {
      return ipcRenderer?.send('metadata', metadata);
    }

    if (!lyricContent?.lrc?.lyric) {
      return ipcRenderer?.send('metadata', metadata);
    }

    // 原实现每切一首歌就 ipcRenderer.on 一次且从不移除，
    // 长会话下监听器会累积到上千个，每次事件都要遍历全部回调。
    // 这里保证同一时刻最多只有一个待处理的监听器。
    if (this._mprisListener) {
      ipcRenderer.removeListener('saveLyricFinished', this._mprisListener);
    }
    this._mprisListener = () => {
      ipcRenderer.removeListener('saveLyricFinished', this._mprisListener);
      this._mprisListener = null;
      ipcRenderer?.send('metadata', metadata);
    };
    ipcRenderer.on('saveLyricFinished', this._mprisListener);

    ipcRenderer.send('sendLyrics', {
      track,
      lyrics: lyricContent.lrc.lyric,
    });
  }
  _updateMediaSessionPositionState() {
    if ('mediaSession' in navigator === false) {
      return;
    }
    if ('setPositionState' in navigator.mediaSession) {
      navigator.mediaSession.setPositionState({
        duration: ~~(this.currentTrack.dt / 1000),
        playbackRate: 1.0,
        position: this.seek(),
      });
    }
  }
  _nextTrackCallback() {
    this._scrobble(this._currentTrack, 0, true);
    if (!this.isPersonalFM && this.repeatMode === 'one') {
      this._replaceCurrentTrack(this.currentTrackID);
    } else {
      this._playNextTrack(this.isPersonalFM);
    }
  }
  _loadPersonalFMNextTrack() {
    if (this._personalFMNextLoading) {
      return [false, undefined];
    }
    this._personalFMNextLoading = true;
    return personalFM()
      .then(result => {
        if (!result || !result.data) {
          this._personalFMNextTrack = undefined;
        } else {
          this._personalFMNextTrack = result.data[0];
          this._cacheNextTrack(); // cache next track
        }
        this._personalFMNextLoading = false;
        return [true, this._personalFMNextTrack];
      })
      .catch(() => {
        this._personalFMNextTrack = undefined;
        this._personalFMNextLoading = false;
        return [false, this._personalFMNextTrack];
      });
  }
  _playDiscordPresence(track, seekTime = 0) {
    if (
      process.env.IS_ELECTRON !== true ||
      store.state.settings.enableDiscordRichPresence === false
    ) {
      return null;
    }
    let copyTrack = { ...track };
    copyTrack.dt -= seekTime * 1000;
    ipcRenderer?.send('playDiscordPresence', copyTrack);
  }
  _pauseDiscordPresence(track) {
    if (
      process.env.IS_ELECTRON !== true ||
      store.state.settings.enableDiscordRichPresence === false
    ) {
      return null;
    }
    ipcRenderer?.send('pauseDiscordPresence', track);
  }
  _playNextTrack(isPersonal) {
    if (isPersonal) {
      this.playNextFMTrack();
    } else {
      this.playNextTrack();
    }
  }

  appendTrack(trackID) {
    // Array 没有 append 方法，原实现在这里必然抛 TypeError
    const list = this.list;
    if (!Array.isArray(list)) return;
    list.push(trackID);
    // 列表变了，「下一首」可能跟着变，预载作废并重建
    this._refreshPreload();
    this.saveSelfToLocalStorage();
  }
  /**
   * 追加到播放列表末尾。
   *
   * search.vue 的搜索结果点击直接调用了 player.appendTrackToPlayerList(track, true)，
   * 但 Player 上没有这个方法、store 里也没有同名 mutation，
   * 点击即 TypeError。这里补上实现。
   *
   * @param {object} track 歌曲详情对象
   * @param {boolean} playNow 是否立即播放
   */
  appendTrackToPlayerList(track, playNow = false) {
    if (!track || track.id === undefined || track.id === null) return;
    if (!this._list.includes(track.id)) this._list.push(track.id);
    if (this._shuffle && !this._shuffledList.includes(track.id)) {
      this._shuffledList.push(track.id);
    }
    this._refreshPreload();
    this.saveSelfToLocalStorage();
    if (playNow) {
      this.current = this.list.indexOf(track.id);
      this._replaceCurrentTrack(track.id);
    }
  }
  playNextTrack() {
    const [trackID, index] = this._getNextTrack();
    if (trackID === undefined) {
      this._howler?.stop();
      this._setPlaying(false);
      this._setLoadingNext(false);
      return false;
    }
    let next = index;
    if (index === INDEX_IN_PLAY_NEXT) {
      this._playNextList.shift();
      next = this.current;
    }
    this.current = next;
    this._replaceCurrentTrack(trackID);
    return true;
  }
  async playNextFMTrack() {
    if (this._personalFMLoading) {
      return false;
    }

    this._isPersonalFM = true;
    if (!this._personalFMNextTrack) {
      this._personalFMLoading = true;
      let result = null;
      let retryCount = 5;
      for (; retryCount >= 0; retryCount--) {
        result = await personalFM().catch(() => null);
        if (!result) {
          this._personalFMLoading = false;
          store.dispatch('showToast', 'personal fm timeout');
          return false;
        }
        if (result.data?.length > 0) {
          break;
        } else if (retryCount > 0) {
          await delay(1000);
        }
      }
      this._personalFMLoading = false;

      if (retryCount < 0) {
        let content = '获取私人FM数据时重试次数过多，请手动切换下一首';
        store.dispatch('showToast', content);
        console.log(content);
        return false;
      }
      // 这里只能拿到一条数据
      this._personalFMTrack = result.data[0];
    } else {
      if (this._personalFMNextTrack.id === this._personalFMTrack.id) {
        return false;
      }
      this._personalFMTrack = this._personalFMNextTrack;
    }
    if (this._isPersonalFM) {
      this._replaceCurrentTrack(this._personalFMTrack.id);
    }
    this._loadPersonalFMNextTrack();
    return true;
  }
  playPrevTrack() {
    const [trackID, index] = this._getPrevTrack();
    if (trackID === undefined) return false;
    this.current = index;
    this._replaceCurrentTrack(
      trackID,
      true,
      UNPLAYABLE_CONDITION.PLAY_PREV_TRACK
    );
    return true;
  }
  /**
   * 标记播放器状态需要持久化。
   *
   * 原实现每次赋值都同步序列化整个实例（含上千个 trackID 的播放列表），
   * 播放进度每秒触发一次就是每秒一次大对象序列化 + 同步写盘。
   * 现在改为脏标记 + 合并写入，窗口内的多次变更只序列化一次。
   *
   * @param {boolean} immediate 是否跳过合并窗口立即落盘
   */
  saveSelfToLocalStorage(immediate = false) {
    this._persistDirty = true;
    if (immediate) {
      this._flushSelfToLocalStorage();
      return;
    }
    if (this._persistTimer !== null) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._flushSelfToLocalStorage();
    }, PERSIST_THROTTLE);
  }
  _flushSelfToLocalStorage() {
    if (this._persistTimer !== null) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    if (!this._persistDirty) return;
    this._persistDirty = false;

    const snapshot = {};
    for (const key of PERSISTED_KEYS) {
      if (this[key] !== undefined) snapshot[key] = this[key];
    }

    try {
      localStorage.setItem('player', JSON.stringify(snapshot));
    } catch (e) {
      console.warn('[Player] failed to persist state', e);
    }
  }

  pause() {
    // 记录用户意图：淡出期间如果又点了播放，这一次暂停要放弃，
    // 否则会出现「点了播放但 200ms 后被暂停」的竞态。
    this._desiredPlaying = false;
    // 暂停代数 +1：还在等音源的那次切歌不应该在音源就绪后把声音放出来
    this._pauseSeq += 1;
    const howl = this._howler;
    if (!howl) {
      this._setPlaying(false);
      return;
    }

    howl.fade(howl.volume(), 0, PLAY_PAUSE_FADE_DURATION);
    howl.once('fade', () => {
      if (this._howler !== howl) return;
      if (this._desiredPlaying) {
        // 用户在淡出过程中恢复了播放，把音量淡回去
        howl.fade(howl.volume(), this.volume, PLAY_PAUSE_FADE_DURATION);
        this._setPlaying(true);
        return;
      }
      howl.pause();
      this._setPlaying(false);
      setTitle(null);
      this._pauseDiscordPresence(this._currentTrack);
    });
  }
  play() {
    this._desiredPlaying = true;
    const howl = this._howler;
    if (!howl) return;

    // 已经处于播放中（可能正在淡出暂停）：只需把音量淡回来，不要重复 play
    if (howl.playing()) {
      howl.fade(howl.volume(), this.volume, PLAY_PAUSE_FADE_DURATION);
      this._setPlaying(true);
      this._setLoadingNext(false);
      if (this._currentTrack.name) {
        setTitle(this._currentTrack);
      }
      return;
    }

    howl.play();

    howl.once('play', () => {
      if (this._howler !== howl) return;
      // 音源已经就绪：加载态到此结束（无论接下来是否真的出声）
      this._setLoadingNext(false);
      this._clearPlayWatchdog();
      // 取源/解码期间用户可能已经点了暂停，此时不要再把音量淡回来，
      // 否则会出现「点了暂停，200ms 后声音又响了一下」
      if (!this._desiredPlaying) return;

      // 交叉淡化用设置里的时长，普通播放 / 恢复沿用 200ms
      const fadeIn = this._pendingFadeIn ?? PLAY_PAUSE_FADE_DURATION;
      this._pendingFadeIn = null;
      howl.fade(0, this.volume, fadeIn);

      // 播放时确保开启player.
      // 避免因"忘记设置"导致在播放时播放器不显示的Bug
      this._enabled = true;
      this._setPlaying(true);
      if (this._currentTrack.name) {
        setTitle(this._currentTrack);
      }
      this._playDiscordPresence(this._currentTrack, this.seek());
      if (store.state.lastfm.key !== undefined) {
        trackUpdateNowPlaying({
          artist: this.currentTrack.ar[0].name,
          track: this.currentTrack.name,
          album: this.currentTrack.al.name,
          trackNumber: this.currentTrack.no,
          duration: ~~(this.currentTrack.dt / 1000),
        });
      }
    });
  }
  playOrPause() {
    if (this._howler?.playing()) {
      this.pause();
    } else {
      this.play();
    }
  }
  seek(time = null, sendMpris = true) {
    if (isCreateMpris && sendMpris && time) {
      ipcRenderer?.send('seeked', time);
    }
    if (time !== null) {
      this._lastSeekAt = Date.now();
      // 立即回写进度，让进度条跟手；同时告诉采样定时器这段时间不要覆盖
      this._progress = time;
      this._howler?.seek(time);
      if (this._playing)
        this._playDiscordPresence(this._currentTrack, this.seek(null, false));
      this._onUserSeek();
    }
    return this._howler === null ? 0 : this._howler.seek();
  }
  mute() {
    if (this.volume === 0) {
      this.volume = this._volumeBeforeMuted;
    } else {
      this._volumeBeforeMuted = this.volume;
      this.volume = 0;
    }
  }
  /**
   * 把当前音频节点切到设置里选的输出设备。
   *
   * 原实现直接 `_node.setSinkId(store.state.settings.outputDevice)`：
   * 1. setSinkId 返回 Promise，设备被拔掉时会 reject，没有 catch 就是每次
   *    切歌都往控制台丢一个 unhandled rejection；
   * 2. 默认值 'default' 并不是合法的 sinkId（规范里只有 '' 表示系统默认），
   *    所以「默认设备」这个最常见的情况其实每次都在失败；
   * 3. 任何同步异常都会顺着 _playAudioSource 冒出去，直接打断切歌。
   * 现在：非法/默认值归一成 ''，已经是目标设备就跳过，失败回退一次系统默认，
   * 并且保证不抛。
   */
  setOutputDevice() {
    const node = this._howler?._sounds?.[0]?._node;
    // 非 Electron / 老版本 Chromium 没有 setSinkId，跳过
    if (!node || typeof node.setSinkId !== 'function') return;

    const configured = store.state.settings?.outputDevice;
    // 'default' / 空值都表示「系统默认设备」，Chromium 只认空字符串
    const sinkId = !configured || configured === 'default' ? '' : configured;
    // 新创建的 <audio> 本来就挂在系统默认设备上，没必要再切一次
    if (node.sinkId === sinkId) return;

    const applySinkId = id => {
      try {
        const result = node.setSinkId(id);
        return result && typeof result.catch === 'function'
          ? result
          : Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    };

    applySinkId(sinkId).catch(() => {
      // 回退到系统默认设备本身也失败时放弃，不要无限重试
      if (sinkId === '') return;
      console.debug(
        '[debug][Player.js] setSinkId failed, falling back to system default'
      );
      applySinkId('').catch(() => {});
    });
  }

  replacePlaylist(
    trackIDs,
    playlistSourceID,
    playlistSourceType,
    autoPlayTrackID = 'first'
  ) {
    this._isPersonalFM = false;
    // 整个播放列表换掉了，槽位里的「下一首」一定不属于新列表
    this._refreshPreload();
    this.list = trackIDs;
    this.current = 0;
    this._playlistSource = {
      type: playlistSourceType,
      id: playlistSourceID,
    };
    if (this.shuffle) this._shuffleTheList(autoPlayTrackID);
    if (autoPlayTrackID === 'first') {
      this._replaceCurrentTrack(this.list[0]);
    } else {
      this.current = this.list.indexOf(autoPlayTrackID);
      this._replaceCurrentTrack(autoPlayTrackID);
    }
  }
  playAlbumByID(id, trackID = 'first') {
    getAlbum(id).then(data => {
      let trackIDs = data.songs.map(t => t.id);
      this.replacePlaylist(trackIDs, id, 'album', trackID);
    });
  }
  playPlaylistByID(id, trackID = 'first', noCache = false) {
    console.debug(
      `[debug][Player.js] playPlaylistByID 👉 id:${id} trackID:${trackID} noCache:${noCache}`
    );
    getPlaylistDetail(id, noCache).then(data => {
      let trackIDs = data.playlist.trackIds.map(t => t.id);
      this.replacePlaylist(trackIDs, id, 'playlist', trackID);
    });
  }
  playArtistByID(id, trackID = 'first') {
    getArtist(id).then(data => {
      let trackIDs = data.hotSongs.map(t => t.id);
      this.replacePlaylist(trackIDs, id, 'artist', trackID);
    });
  }
  playTrackOnListByID(id, listName = 'default') {
    if (listName === 'default') {
      // 随机模式下 this.list 是打乱后的列表，索引必须写到 _shuffledCurrent，
      // 原实现直接写 _current，会导致「上一首 / 下一首」跳到错误的歌。
      const index = this.list.findIndex(t => t === id);
      this.current = index < 0 ? 0 : index;
    }
    this._replaceCurrentTrack(id);
  }
  playIntelligenceListById(id, trackID = 'first', noCache = false) {
    getPlaylistDetail(id, noCache).then(data => {
      const randomId = Math.floor(
        Math.random() * (data.playlist.trackIds.length + 1)
      );
      const songId = data.playlist.trackIds[randomId].id;
      intelligencePlaylist({ id: songId, pid: id }).then(result => {
        let trackIDs = result.data.map(t => t.id);
        this.replacePlaylist(trackIDs, id, 'playlist', trackID);
      });
    });
  }
  addTrackToPlayNext(trackID, playNow = false) {
    this._playNextList.push(trackID);
    // 「下一首」被插队了，之前的预载不再是要播的那一首
    this._refreshPreload();
    if (playNow) {
      this.playNextTrack();
    }
  }
  playPersonalFM() {
    this._isPersonalFM = true;
    if (this.currentTrackID !== this._personalFMTrack.id) {
      this._replaceCurrentTrack(this._personalFMTrack.id, true);
    } else {
      this.playOrPause();
    }
  }
  async moveToFMTrash() {
    this._isPersonalFM = true;
    let id = this._personalFMTrack.id;
    if (await this.playNextFMTrack()) {
      fmTrash(id);
    }
  }

  sendSelfToIpcMain() {
    if (process.env.IS_ELECTRON !== true) return false;
    let liked = store.state.liked.songs.includes(this.currentTrack.id);
    ipcRenderer?.send('player', {
      playing: this.playing,
      likedCurrentTrack: liked,
    });
    setTrayLikeState(liked);
  }

  switchRepeatMode() {
    if (this._repeatMode === 'on') {
      this.repeatMode = 'one';
    } else if (this._repeatMode === 'one') {
      this.repeatMode = 'off';
    } else {
      this.repeatMode = 'on';
    }
    if (isCreateMpris) {
      ipcRenderer?.send('switchRepeatMode', this.repeatMode);
    }
  }
  switchShuffle() {
    this.shuffle = !this.shuffle;
    if (isCreateMpris) {
      ipcRenderer?.send('switchShuffle', this.shuffle);
    }
  }
  switchReversed() {
    this.reversed = !this.reversed;
  }

  clearPlayNextList() {
    this._playNextList = [];
    // 「下一首」回到列表里的下一首，预载作废并重建
    this._refreshPreload();
  }
  removeTrackFromQueue(index) {
    this._playNextList.splice(index, 1);
    this._refreshPreload();
  }
}
