import { app, dialog, globalShortcut, ipcMain } from 'electron';
import UNM from '@unblockneteasemusic/rust-napi';
import { registerGlobalShortcut } from '@/electron/globalShortcut';
import cloneDeep from 'lodash/cloneDeep';
import shortcuts from '@/utils/shortcuts';
import { createMenu } from './menu';
import { isCreateTray, isMac } from '@/utils/platform';

const clc = require('cli-color');
const log = text => {
  console.log(`${clc.blueBright('[ipcMain.js]')} ${text}`);
};

const exitAsk = (e, win) => {
  e.preventDefault(); //阻止默认行为
  dialog
    .showMessageBox({
      type: 'info',
      title: 'Information',
      cancelId: 2,
      defaultId: 0,
      message: '确定要关闭吗？',
      buttons: ['最小化', '直接退出'],
    })
    .then(result => {
      if (result.response == 0) {
        e.preventDefault(); //阻止默认行为
        win.minimize(); //调用 最小化实例方法
      } else if (result.response == 1) {
        win = null;
        //app.quit();
        app.exit(); //exit()直接关闭客户端，不会执行quit();
      }
    })
    .catch(err => {
      log(err);
    });
};

const exitAskWithoutMac = (e, win) => {
  e.preventDefault(); //阻止默认行为
  dialog
    .showMessageBox({
      type: 'info',
      title: 'Information',
      cancelId: 2,
      defaultId: 0,
      message: '确定要关闭吗？',
      buttons: ['最小化到托盘', '直接退出'],
      checkboxLabel: '记住我的选择',
    })
    .then(result => {
      if (result.checkboxChecked && result.response !== 2) {
        win.webContents.send(
          'rememberCloseAppOption',
          result.response === 0 ? 'minimizeToTray' : 'exit'
        );
      }

      if (result.response === 0) {
        e.preventDefault(); //阻止默认行为
        win.hide(); //调用 最小化实例方法
      } else if (result.response === 1) {
        win = null;
        //app.quit();
        app.exit(); //exit()直接关闭客户端，不会执行quit();
      }
    })
    .catch(err => {
      log(err);
    });
};

// Discord Rich Presence 是可选能力，它的传递依赖指向一个 git 仓库
// （ssh://git@github.com/discordjs/rpc.git），在受限网络或 CI 环境里会让
// npm install 直接失败。这里改成软加载：依赖缺失时自动降级为「不显示状态」，
// 不影响播放等主流程。
let discordClient = null;
try {
  discordClient = require('discord-rich-presence')('818936529484906596');
} catch (e) {
  console.warn(
    '[ipcMain] discord-rich-presence is not available, Rich Presence disabled'
  );
}

/**
 * Make data a Buffer.
 *
 * @param {?} data The data to convert.
 * @returns {import("buffer").Buffer} The converted data.
 */
function toBuffer(data) {
  if (data instanceof Buffer) {
    return data;
  } else {
    return Buffer.from(data);
  }
}

/**
 * Get the file base64 data from bilivideo.
 *
 * @param {string} url The URL to fetch.
 * @returns {Promise<string>} The file base64 data.
 */
async function getBiliVideoFile(url) {
  const axios = await import('axios').then(m => m.default);
  const response = await axios.get(url, {
    headers: {
      Referer: 'https://www.bilibili.com/',
      'User-Agent': 'okhttp/3.4.1',
    },
    responseType: 'arraybuffer',
  });

  const buffer = toBuffer(response.data);
  const encodedData = buffer.toString('base64');

  return encodedData;
}

/**
 * Parse the source string (`a, b`) to source list `['a', 'b']`.
 *
 * @param {import("@unblockneteasemusic/rust-napi").Executor} executor
 * @param {string} sourceString The source string.
 * @returns {string[]} The source list.
 */
function parseSourceStringToList(executor, sourceString) {
  const availableSource = executor.list();

  return sourceString
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => {
      const isAvailable = availableSource.includes(s);

      if (!isAvailable) {
        log(`This source is not one of the supported source: ${s}`);
      }

      return isAvailable;
    });
}

export function initIpcMain(win, store, trayEventEmitter) {
  // WIP: Do not enable logging as it has some issues in non-blocking I/O environment.
  // UNM.enableLogging(UNM.LoggingType.ConsoleEnv);
  const unmExecutor = new UNM.Executor();

  /**
   * ytdl 的可执行文件路径只从主进程独立命名空间读取。
   *
   * 原实现把渲染进程 settings.unmYtDlExe 直接透传给 Rust executor，
   * 而 settings 又会被持久化到 localStorage —— 意味着只要能写 localStorage
   * （一次 XSS 就够），就能让主进程 spawn 任意可执行文件，
   * 即使所有 IPC 通道都加了参数校验也绕不过去。
   */
  const getValidatedYtdlPath = () => {
    const p = store.get('main.unmYtDlExe');
    if (typeof p !== 'string' || !p) return null;
    try {
      const fs = require('fs');
      return fs.statSync(p).isFile() ? p : null;
    } catch (e) {
      return null;
    }
  };

  /**
   * 逐字段重建 context，绝不把渲染进程传来的对象原样交给 Rust executor。
   * 其中 config['ytdl:exe'] 一律丢弃，改用主进程侧校验过的值。
   */
  const normalizeUnmContext = raw => {
    const src = raw && typeof raw === 'object' ? raw : {};
    const cfg = src.config && typeof src.config === 'object' ? src.config : {};
    return {
      enableFlac: src.enableFlac === true ? true : null,
      proxyUri: /^https?:\/\/[^\s"'<>]+$/i.test(String(src.proxyUri || ''))
        ? String(src.proxyUri)
        : null,
      searchMode: src.searchMode === 1 ? 1 : 0,
      config: {
        'ytdl:exe': getValidatedYtdlPath(),
        'joox:cookie':
          typeof cfg['joox:cookie'] === 'string' ? cfg['joox:cookie'] : null,
        'qq:cookie':
          typeof cfg['qq:cookie'] === 'string' ? cfg['qq:cookie'] : null,
      },
    };
  };

  ipcMain.handle(
    'unblock-music',
    /**
     *
     * @param {*} _
     * @param {string | null} sourceListString
     * @param {Record<string, any>} ncmTrack
     * @param {UNM.Context} context
     */
    async (_, sourceListString, ncmTrack, context) => {
      if (!ncmTrack || typeof ncmTrack !== 'object') return null;

      // Formt the track input
      // FIXME: Figure out the structure of Track
      const song = {
        id: ncmTrack.id != null ? ncmTrack.id.toString() : '',
        name: typeof ncmTrack.name === 'string' ? ncmTrack.name : '',
        duration: Number(ncmTrack.dt) || 0,
        album: ncmTrack.al && {
          id: ncmTrack.al.id != null ? ncmTrack.al.id.toString() : '',
          name: typeof ncmTrack.al.name === 'string' ? ncmTrack.al.name : '',
        },
        artists: Array.isArray(ncmTrack.ar)
          ? ncmTrack.ar.map(({ id, name }) => ({
              id: id != null ? id.toString() : '',
              name: typeof name === 'string' ? name : '',
            }))
          : [],
      };
      if (!song.id) return null;

      const sourceList =
        typeof sourceListString === 'string'
          ? parseSourceStringToList(unmExecutor, sourceListString)
          : ['ytdl', 'bilibili', 'pyncm', 'kugou'];
      log(`[UNM] using source: ${sourceList.join(', ')}`);

      const safeContext = normalizeUnmContext(context);
      // 原实现把整个 context 打进 stdout，其中包含 QQ / Joox 的登录 cookie
      log(
        `[UNM] using configuration: ${JSON.stringify({
          enableFlac: safeContext.enableFlac,
          proxyUri: safeContext.proxyUri,
          searchMode: safeContext.searchMode,
          ytdl: safeContext.config['ytdl:exe'] ? 'configured' : 'none',
        })}`
      );

      try {
        // TODO: tell users to install yt-dlp.
        const matchedAudio = await unmExecutor.search(
          sourceList,
          song,
          safeContext
        );
        const retrievedSong = await unmExecutor.retrieve(
          matchedAudio,
          safeContext
        );

        // bilibili's audio file needs some special treatment
        if (retrievedSong.url.includes('bilivideo.com')) {
          retrievedSong.url = await getBiliVideoFile(retrievedSong.url);
        }

        log(`respond with retrieve song…`);
        log(JSON.stringify(matchedAudio));
        return retrievedSong;
      } catch (err) {
        const errorMessage = err instanceof Error ? `${err.message}` : `${err}`;
        log(`UnblockNeteaseMusic failed: ${errorMessage}`);
        return null;
      }
    }
  );

  ipcMain.on('close', e => {
    if (isMac) {
      win.hide();
      exitAsk(e, win);
    } else {
      let closeOpt = store.get('settings.closeAppOption');
      if (closeOpt === 'exit') {
        win = null;
        //app.quit();
        app.exit(); //exit()直接关闭客户端，不会执行quit();
      } else if (closeOpt === 'minimizeToTray') {
        e.preventDefault();
        win.hide();
      } else {
        exitAskWithoutMac(e, win);
      }
    }
  });

  ipcMain.on('minimize', () => {
    win.minimize();
  });

  ipcMain.on('maximizeOrUnmaximize', () => {
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });

  ipcMain.on('settings', (event, options) => {
    store.set('settings', options);
    // 把 ytdl 路径镜像到主进程独立命名空间，供 getValidatedYtdlPath() 读取。
    // 渲染进程之后即使再改 settings.unmYtDlExe，也影响不到已镜像的值。
    if (options && typeof options.unmYtDlExe === 'string') {
      store.set('main.unmYtDlExe', options.unmYtDlExe);
    }
    if (options.enableGlobalShortcut) {
      registerGlobalShortcut(win, store);
    } else {
      log('unregister global shortcut');
      globalShortcut.unregisterAll();
    }
  });

  ipcMain.on('playDiscordPresence', (event, track) => {
    discordClient &&
      discordClient.updatePresence({
        details: track.name + ' - ' + track.ar.map(ar => ar.name).join(','),
        state: track.al.name,
        endTimestamp: Date.now() + track.dt,
        largeImageKey: track.al.picUrl,
        largeImageText: 'Listening ' + track.name,
        smallImageKey: 'play',
        smallImageText: 'Playing',
        instance: true,
      });
  });

  ipcMain.on('pauseDiscordPresence', (event, track) => {
    discordClient &&
      discordClient.updatePresence({
        details: track.name + ' - ' + track.ar.map(ar => ar.name).join(','),
        state: track.al.name,
        largeImageKey: track.al.picUrl,
        largeImageText: 'YesPlayMusic',
        smallImageKey: 'pause',
        smallImageText: 'Pause',
        instance: true,
      });
  });

  ipcMain.on('setProxy', (event, config) => {
    const proxyRules = `${config.protocol}://${config.server}:${config.port}`;
    store.set('proxy', proxyRules);
    win.webContents.session.setProxy(
      {
        proxyRules,
      },
      () => {
        log('finished setProxy');
      }
    );
  });

  ipcMain.on('removeProxy', () => {
    log('removeProxy');
    win.webContents.session.setProxy({});
    store.set('proxy', '');
  });

  ipcMain.on('switchGlobalShortcutStatusTemporary', (e, status) => {
    log('switchGlobalShortcutStatusTemporary');
    if (status === 'disable') {
      globalShortcut.unregisterAll();
    } else {
      registerGlobalShortcut(win, store);
    }
  });

  ipcMain.on('updateShortcut', (e, { id, type, shortcut }) => {
    log('updateShortcut');
    let shortcuts = store.get('settings.shortcuts');
    let newShortcut = shortcuts.find(s => s.id === id);
    newShortcut[type] = shortcut;
    store.set('settings.shortcuts', shortcuts);

    createMenu(win, store);
    globalShortcut.unregisterAll();
    registerGlobalShortcut(win, store);
  });

  ipcMain.on('restoreDefaultShortcuts', () => {
    log('restoreDefaultShortcuts');
    store.set('settings.shortcuts', cloneDeep(shortcuts));

    createMenu(win, store);
    globalShortcut.unregisterAll();
    registerGlobalShortcut(win, store);
  });

  if (isCreateTray) {
    ipcMain.on('updateTrayTooltip', (_, title) => {
      trayEventEmitter.emit('updateTooltip', title);
    });
    ipcMain.on('updateTrayPlayState', (_, isPlaying) => {
      trayEventEmitter.emit('updatePlayState', isPlaying);
    });
    ipcMain.on('updateTrayLikeState', (_, isLiked) => {
      trayEventEmitter.emit('updateLikeState', isLiked);
    });
    ipcMain.on('updateTrayIcon', () => {
      trayEventEmitter.emit('updateIcon');
    });
  }
}
