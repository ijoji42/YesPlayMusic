import { playlistCategories } from '@/utils/staticData';
import shortcuts from '@/utils/shortcuts';

console.debug('[debug][initLocalStorage.js]');
const enabledPlaylistCategories = playlistCategories
  .filter(c => c.enable)
  .map(c => c.name);

let localStorage = {
  player: {},
  settings: {
    lang: null,
    musicLanguage: 'all',
    appearance: 'auto',
    themeColor: 'default',
    musicQuality: 320000,
    lyricFontSize: 28,
    outputDevice: 'default',
    showPlaylistsByAppleMusic: true,
    enableUnblockNeteaseMusic: true,
    automaticallyCacheSongs: true,
    cacheLimit: 8192,
    enableReversedMode: false,
    nyancatStyle: false,
    showLyricsTranslation: true,
    // 歌词背景默认用「动态」：和封面色同源的缓慢流动，比静态渐变更有质感，
    // 也不会像「律动」那样依赖音频分析。
    lyricsBackground: 'dynamic',
    // 歌词背景「律动」参数。preset 为预设名，用户手改任意一项后自动变为 custom
    lyricsReactive: {
      preset: 'soft',
      intensity: 55,
      sensitivity: 55,
      smoothing: 78,
      band: 'bass',
      dimensions: {
        scale: true,
        blur: true,
        brightness: true,
        saturate: false,
        drift: true,
      },
    },
    // 系统开启「减弱动态效果」时，律动默认不跑；用户显式点过「仍然开启」后置为 true
    lyricsReactiveOverride: false,
    // 切歌交叉淡入淡出时长（毫秒）。0 = 关闭（瞬时切换）
    crossfadeDuration: 0,
    enableOsdlyricsSupport: false,
    closeAppOption: 'ask',
    enableDiscordRichPresence: false,
    enableGlobalShortcut: true,
    showLibraryDefault: false,
    subTitleDefault: false,
    linuxEnableCustomTitlebar: false,
    trayIconTheme: 'auto',
    enabledPlaylistCategories,
    proxyConfig: {
      protocol: 'noProxy',
      server: '',
      port: null,
    },
    enableRealIP: false,
    realIP: null,
    shortcuts: shortcuts,
  },
  data: {
    user: {},
    likedSongPlaylistID: 0,
    lastRefreshCookieDate: 0,
    loginMode: null,
  },
};

if (process.env.IS_ELECTRON === true) {
  localStorage.settings.automaticallyCacheSongs = true;
}

export default localStorage;
