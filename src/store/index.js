import Vue from 'vue';
import Vuex from 'vuex';
import state from './state';
import mutations from './mutations';
import actions from './actions';
import { changeAppearance, changeThemeColor } from '@/utils/common';
import Player from '@/utils/Player';
// vuex 自定义插件
import saveToLocalStorage from './plugins/localStorage';
import { getSendSettingsPlugin } from './plugins/sendSettings';

Vue.use(Vuex);

let plugins = [saveToLocalStorage];
if (process.env.IS_ELECTRON === true) {
  let sendSettings = getSendSettingsPlugin();
  plugins.push(sendSettings);
}
const options = {
  state,
  mutations,
  actions,
  plugins,
};

const store = new Vuex.Store(options);

if ([undefined, null].includes(store.state.settings.lang)) {
  const defaultLang = 'en';
  const langMapper = new Map()
    .set('zh', 'zh-CN')
    .set('zh-TW', 'zh-TW')
    .set('en', 'en')
    .set('tr', 'tr');
  store.state.settings.lang =
    langMapper.get(
      langMapper.has(navigator.language)
        ? navigator.language
        : navigator.language.slice(0, 2)
    ) || defaultLang;
  localStorage.setItem('settings', JSON.stringify(store.state.settings));
}

changeAppearance(store.state.settings.appearance);
changeThemeColor(store.state.settings.themeColor);

window
  .matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', () => {
    if (store.state.settings.appearance === 'auto') {
      changeAppearance(store.state.settings.appearance);
      changeThemeColor(store.state.settings.themeColor);
    }
  });

/**
 * 高频变化的运行时字段：不参与持久化，也不触发跨进程同步。
 * 播放进度每秒都会变，如果每次都走「全量序列化 + IPC」，主线程会被持续占用，
 * 表现为切歌卡顿、滚动掉帧、进度条拖动不跟手。
 */
const TRANSIENT_PROPS = new Set([
  '_progress',
  '_howler',
  '_fadingHowler',
  '_personalFMLoading',
  '_personalFMNextLoading',
  '_lastSeekAt',
  '_lastProgressSave',
  '_desiredPlaying',
  '_persistDirty',
  '_persistTimer',
  '_progressTimer',
  '_replaceSeq',
  '_mprisListener',
  'createdBlobRecords',
  // 下一首预载槽位与相关调度句柄：只描述「运行时正在发生什么」，
  // 既不该落盘（里面是 Howl 实例和 Blob URL，序列化出来就是垃圾），
  // 也不该触发 IPC 同步。
  '_preload',
  '_preloadSeq',
  '_preloadTimer',
  '_playWatchdog',
  // 切歌加载态与淡入淡出调度：
  // _loadingNext 变化只驱动播放按钮上的加载环，不需要落盘，
  // 更不需要把托盘 / MPRIS 唤醒一次。
  '_loadingNext',
  '_loadingTimer',
  '_pendingFadeIn',
  '_pauseSeq',
]);

/**
 * 只有这些字段变化才需要同步给主进程（托盘 / MPRIS / Touch Bar / Discord）。
 * 音量、播放模式这类字段只需要落盘，不需要每次变更都发一次 IPC ——
 * 拖动音量滑杆时每帧都会写一次 _volume，原实现等于 60 次/秒的跨进程通信。
 *
 * 注意：_playing 不放进 TRANSIENT_PROPS，因为 MPRIS 与 Touch Bar 依赖
 * `player` 通道拿到播放/暂停状态；如果它被当作纯运行时字段跳过，
 * 系统媒体面板会永远显示「正在播放」。
 */
const IPC_TRIGGER_PROPS = new Set([
  '_playing',
  '_currentTrack',
  '_enabled',
  '_isPersonalFM',
]);

let player = new Player();
player = new Proxy(player, {
  set(target, prop, val) {
    target[prop] = val;
    if (TRANSIENT_PROPS.has(prop)) return true;
    target.saveSelfToLocalStorage();
    if (IPC_TRIGGER_PROPS.has(prop)) target.sendSelfToIpcMain();
    return true;
  },
});
store.state.player = player;

export default store;
