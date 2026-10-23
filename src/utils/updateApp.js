import initLocalStorage from '@/store/initLocalStorage.js';
import pkg from '../../package.json';

const updateSetting = () => {
  const parsedSettings = JSON.parse(localStorage.getItem('settings'));
  const settings = {
    ...initLocalStorage.settings,
    ...parsedSettings,
  };

  if (
    settings.shortcuts.length !== initLocalStorage.settings.shortcuts.length
  ) {
    // 当新增 shortcuts 时
    const oldShortcutsId = settings.shortcuts.map(s => s.id);
    const newShortcutsId = initLocalStorage.settings.shortcuts.filter(
      s => oldShortcutsId.includes(s.id) === false
    );
    newShortcutsId.map(id => {
      settings.shortcuts.push(
        initLocalStorage.settings.shortcuts.find(s => s.id === id)
      );
    });
  }

  if (localStorage.getItem('appVersion') === '"0.3.9"') {
    settings.lyricsBackground = true;
  }

  // 一次性迁移：歌词背景的默认效果从「静态渐变」改为「动态」。
  // 用独立标记而不是版本号判断，避免用户升级路径不同导致迁移跑两次。
  if (localStorage.getItem('ypm-lyrics-bg-dynamic') !== '1') {
    if (settings.lyricsBackground === true) {
      settings.lyricsBackground = 'dynamic';
    }
    localStorage.setItem('ypm-lyrics-bg-dynamic', '1');
  }

  localStorage.setItem('settings', JSON.stringify(settings));
};

const updateData = () => {
  const parsedData = JSON.parse(localStorage.getItem('data'));
  const data = {
    ...parsedData,
  };
  localStorage.setItem('data', JSON.stringify(data));
};

const updatePlayer = () => {
  let parsedData = JSON.parse(localStorage.getItem('player'));
  let appVersion = localStorage.getItem('appVersion');
  if (appVersion === `"0.2.5"`) parsedData = {}; // 0.2.6版本重构了player
  const data = {
    ...parsedData,
  };
  localStorage.setItem('player', JSON.stringify(data));
};

const removeOldStuff = () => {
  // remove old indexedDB databases created by localforage
  indexedDB.deleteDatabase('tracks');
};

export default function () {
  updateSetting();
  updateData();
  updatePlayer();
  removeOldStuff();
  localStorage.setItem('appVersion', JSON.stringify(pkg.version));
}
