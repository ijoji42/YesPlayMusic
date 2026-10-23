'use strict';
import {
  app,
  protocol,
  BrowserWindow,
  shell,
  dialog,
  globalShortcut,
  nativeTheme,
  screen,
} from 'electron';
import {
  isWindows,
  isMac,
  isLinux,
  isDevelopment,
  isCreateTray,
  isCreateMpris,
} from '@/utils/platform';
import { createProtocol } from 'vue-cli-plugin-electron-builder/lib';
import { startNeteaseMusicApi } from './electron/services';
import { initIpcMain } from './electron/ipcMain.js';
import { createMenu } from './electron/menu';
import { createTray } from '@/electron/tray';
import { createTouchBar } from './electron/touchBar';
import { createDockMenu } from './electron/dockMenu';
import { registerGlobalShortcut } from './electron/globalShortcut';
import { autoUpdater } from 'electron-updater';
import installExtension, { VUEJS_DEVTOOLS } from 'electron-devtools-installer';
import { EventEmitter } from 'events';
import express from 'express';
import expressProxy from 'express-http-proxy';
import Store from 'electron-store';
import { createMpris, createDbus } from '@/electron/mpris';
import { spawn } from 'child_process';
const clc = require('cli-color');
const log = text => {
  console.log(`${clc.blueBright('[background.js]')} ${text}`);
};

const SAFE_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:']);

/**
 * 唯一允许调用 shell.openExternal 的入口。
 *
 * 原实现把渲染进程传来的任意 URL 直接交给 shell.openExternal，
 * 而 Windows 上的 ms-msdt: / search-ms: / file: / smb: 等协议处理器
 * 可以被当作命令执行原语使用。这里只放行 http/https。
 *
 * @param {string} rawUrl
 * @returns {boolean} 是否已放行
 */
function safeOpenExternal(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch (e) {
    log(`[safeOpenExternal] blocked malformed url`);
    return false;
  }

  if (!SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    log(`[safeOpenExternal] blocked protocol: ${parsed.protocol}`);
    return false;
  }

  shell
    .openExternal(parsed.href)
    .catch(err => log(`[safeOpenExternal] failed: ${err.message}`));
  return true;
}

const closeOnLinux = (e, win, store) => {
  let closeOpt = store.get('settings.closeAppOption');
  if (closeOpt !== 'exit') {
    e.preventDefault();
  }

  if (closeOpt === 'ask') {
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
          win.hide(); //调用 最小化实例方法
        } else if (result.response === 1) {
          win = null;
          app.exit(); //exit()直接关闭客户端，不会执行quit();
        }
      })
      .catch(err => {
        log(err);
      });
  } else if (closeOpt === 'exit') {
    win = null;
    app.quit();
  } else {
    win.hide();
  }
};

class Background {
  constructor() {
    this.window = null;
    this.ypmTrayImpl = null;
    this.store = new Store({
      windowWidth: {
        width: { type: 'number', default: 1440 },
        height: { type: 'number', default: 840 },
      },
    });
    this.neteaseMusicAPI = null;
    this.expressApp = null;
    this.willQuitApp = !isMac;

    this.init();
  }

  init() {
    log('initializing');

    // Make sure the app is singleton.
    if (!app.requestSingleInstanceLock()) return app.quit();

    // start netease music api
    this.neteaseMusicAPI = startNeteaseMusicApi();

    // create Express app
    this.createExpressApp();

    // Scheme must be registered before the app is ready
    protocol.registerSchemesAsPrivileged([
      { scheme: 'app', privileges: { secure: true, standard: true } },
    ]);

    // handle app events
    this.handleAppEvents();

    // disable chromium mpris
    if (isCreateMpris) {
      app.commandLine.appendSwitch(
        'disable-features',
        'HardwareMediaKeyHandling,MediaSessionService'
      );
    }
  }

  async initDevtools() {
    // Install Vue Devtools extension
    try {
      await installExtension(VUEJS_DEVTOOLS);
    } catch (e) {
      console.error('Vue Devtools failed to install:', e.toString());
    }

    // Exit cleanly on request from parent process in development mode.
    if (isWindows) {
      process.on('message', data => {
        if (data === 'graceful-exit') {
          app.quit();
        }
      });
    } else {
      process.on('SIGTERM', () => {
        app.quit();
      });
    }
  }

  createExpressApp() {
    log('creating express app');

    const expressApp = express();
    expressApp.disable('x-powered-by');

    // 27232 端口对本机所有进程开放，而 /api 是一条全功能反代
    // （能删歌单、换绑手机号、发短信、删云盘文件）。
    // 这里加一层来源校验：浏览器发起的跨源请求一定带 Origin，
    // 带了就必须在白名单里，否则拒绝。
    //
    // 注意局限：这挡不住本机非浏览器进程（curl / 恶意软件），
    // 彻底解决需要一次性令牌 + preload，属于后续专项。
    const ALLOWED_ORIGINS = new Set([
      'http://localhost:27232',
      'http://127.0.0.1:27232',
    ]);
    const guard = (req, res, next) => {
      const origin = req.get('Origin');
      const referer = req.get('Referer');

      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        log(`[express] blocked cross-origin request from ${origin}`);
        return res.status(403).end();
      }
      if (
        !origin &&
        referer &&
        ![...ALLOWED_ORIGINS].some(o => referer.startsWith(o))
      ) {
        log(`[express] blocked cross-origin referer ${referer}`);
        return res.status(403).end();
      }
      next();
    };

    expressApp.use('/', express.static(__dirname + '/'));
    expressApp.use('/api', guard, expressProxy('http://127.0.0.1:10754'));
    expressApp.use('/player', guard, (req, res) => {
      // macOS 关闭窗口后 this.window 会被置为 null，
      // 此时本机任意进程请求 /player 都会让主进程抛 TypeError（未捕获异常）。
      if (!this.window || this.window.isDestroyed()) {
        return res.status(503).json({ error: 'window not available' });
      }
      this.window.webContents
        .executeJavaScript('window.yesplaymusic.player')
        .then(result => {
          res.send({
            currentTrack: result._isPersonalFM
              ? result._personalFMTrack
              : result._currentTrack,
            progress: result._progress,
          });
        })
        .catch(err => {
          res.status(500).json({ error: err.message });
        });
    });
    this.expressApp = expressApp.listen(27232, '127.0.0.1');
  }

  createWindow() {
    log('creating app window');

    const appearance = this.store.get('settings.appearance');
    const showLibraryDefault = this.store.get('settings.showLibraryDefault');

    const options = {
      width: this.store.get('window.width') || 1440,
      height: this.store.get('window.height') || 840,
      minWidth: 1080,
      minHeight: 720,
      titleBarStyle: 'hiddenInset',
      frame: !(
        isWindows ||
        (isLinux && this.store.get('settings.linuxEnableCustomTitlebar'))
      ),
      title: 'YesPlayMusic',
      show: false,
      webPreferences: {
        // —— 保留项 ——
        // 项目有 8 处直接使用 window.require('electron' / 'os')，
        // 在迁移到 preload + contextBridge 之前关闭会直接白屏。
        nodeIntegration: true,
        contextIsolation: false,
        // UI 由 http://localhost:27232 提供，需要跨源加载封面与音频。
        // 彻底开启需要先把 UI 切到 app:// 协议（已注册但未使用）。
        webSecurity: false,
        // nodeIntegration: true 要求 sandbox 必须为 false，显式声明避免误改
        sandbox: false,

        // —— 已关闭 ——
        // Electron 12+ 默认即 false，这里曾被主动打开：
        // 等于把主进程模块注册表暴露给渲染进程，
        // require('electron').remote.require('child_process') 可直接执行命令。
        enableRemoteModule: false,

        // —— 顺手收紧，零兼容风险 ——
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
      },
      backgroundColor:
        ((appearance === undefined || appearance === 'auto') &&
          nativeTheme.shouldUseDarkColors) ||
        appearance === 'dark'
          ? '#222'
          : '#fff',
    };

    if (this.store.get('window.x') && this.store.get('window.y')) {
      let x = this.store.get('window.x');
      let y = this.store.get('window.y');

      let displays = screen.getAllDisplays();
      let isResetWindiw = false;
      if (displays.length === 1) {
        let { bounds } = displays[0];
        if (
          x < bounds.x ||
          x > bounds.x + bounds.width - 50 ||
          y < bounds.y ||
          y > bounds.y + bounds.height - 50
        ) {
          isResetWindiw = true;
        }
      } else {
        isResetWindiw = true;
        for (let i = 0; i < displays.length; i++) {
          let { bounds } = displays[i];
          if (
            x > bounds.x &&
            x < bounds.x + bounds.width &&
            y > bounds.y &&
            y < bounds.y - bounds.height
          ) {
            // 检测到APP窗口当前处于一个可用的屏幕里，break
            isResetWindiw = false;
            break;
          }
        }
      }

      if (!isResetWindiw) {
        options.x = x;
        options.y = y;
      }
    }

    this.window = new BrowserWindow(options);

    // hide menu bar on Microsoft Windows and Linux
    this.window.setMenuBarVisibility(false);

    if (process.env.WEBPACK_DEV_SERVER_URL) {
      // Load the url of the dev server if in development mode
      this.window.loadURL(
        showLibraryDefault
          ? `${process.env.WEBPACK_DEV_SERVER_URL}/#/library`
          : process.env.WEBPACK_DEV_SERVER_URL
      );
      if (!process.env.IS_TEST) this.window.webContents.openDevTools();
    } else {
      createProtocol('app');
      this.window.loadURL(
        showLibraryDefault
          ? 'http://localhost:27232/#/library'
          : 'http://localhost:27232'
      );
    }
  }

  checkForUpdates() {
    if (isDevelopment) return;

    // 默认关闭自动更新。
    //
    // 原因：electron-updater 依赖打包时生成的 app-update.yml，而本项目原先的
    // publish 配置指向上游作者仓库（qier222/YesPlayMusic）。这条链路一旦生效，
    // 用户装的是本地这份 fork，却会被提示「发现新版本」并下载安装上游版本，
    // 等于用一次更新把本地改动全部覆盖掉。
    //
    // 现在 vue.config.js 里已不再生成 publish 配置，没有 app-update.yml，
    // updater 本来也会失败。这里再加一道显式开关，避免出现「静默报错」或
    // 「以后误配一个源就开始覆盖代码」的情况。
    // 需要启用时：配置自己的 publish + 设置 YPM_ENABLE_AUTO_UPDATE=1。
    if (process.env.YPM_ENABLE_AUTO_UPDATE !== '1') {
      log('auto update disabled: no publish source configured');
      return;
    }

    log('checkForUpdates');
    autoUpdater.checkForUpdatesAndNotify();

    const showNewVersionMessage = info => {
      dialog
        .showMessageBox({
          title: '发现新版本 v' + info.version,
          message: '发现新版本 v' + info.version,
          detail: '是否前往发布页下载新版本安装包？',
          buttons: ['下载', '取消'],
          type: 'question',
          noLink: true,
        })
        .then(result => {
          if (result.response === 0) {
            // 走统一的协议白名单，避免 shell.openExternal 被当作命令执行原语
            safeOpenExternal(info.downloadUrl || 'https://github.com');
          }
        });
    };

    autoUpdater.on('update-available', info => {
      showNewVersionMessage(info);
    });
  }

  handleWindowEvents() {
    this.window.once('ready-to-show', () => {
      log('window ready-to-show event');
      this.window.show();
      this.store.set('window', this.window.getBounds());
    });

    this.window.on('close', e => {
      log('window close event');

      if (isLinux) {
        closeOnLinux(e, this.window, this.store);
      } else if (isMac) {
        if (this.willQuitApp) {
          this.window = null;
          app.quit();
        } else {
          e.preventDefault();
          this.window.hide();
        }
      } else {
        let closeOpt = this.store.get('settings.closeAppOption');
        if (this.willQuitApp && (closeOpt === 'exit' || closeOpt === 'ask')) {
          this.window = null;
          app.quit();
        } else {
          e.preventDefault();
          this.window.hide();
        }
      }
    });

    // Electron 的窗口事件名是 resize / move，原实现写成了 resized / moved，
    // 这两个监听从来没有触发过，窗口尺寸与位置实际上只在关闭时保存一次。
    // 顺便加 300ms 防抖，拖拽窗口时不要每一帧都写磁盘。
    let boundsTimer = null;
    const saveWindowBounds = () => {
      if (boundsTimer) clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        boundsTimer = null;
        if (!this.window || this.window.isDestroyed()) return;
        this.store.set('window', this.window.getBounds());
      }, 300);
    };
    this.window.on('resize', saveWindowBounds);
    this.window.on('move', saveWindowBounds);

    this.window.on('maximize', () => {
      this.window.webContents.send('isMaximized', true);
    });

    this.window.on('unmaximize', () => {
      this.window.webContents.send('isMaximized', false);
    });

    // 用 setWindowOpenHandler 替换已废弃的 new-window 事件。
    // 关键修复：原实现用 url.includes('www.last.fm') 做子串判断，
    // https://evil.tld/?ref=www.last.fm 同样会命中，并被塞进一个
    // nodeIntegration:true 的窗口 —— 等于把 Node 权限交给任意远程页面。
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (e) {
        return { action: 'deny' };
      }

      if (parsed.protocol !== 'https:') {
        safeOpenExternal(url);
        return { action: 'deny' };
      }

      const LASTFM_HOSTS = new Set(['www.last.fm', 'last.fm']);
      if (LASTFM_HOSTS.has(parsed.hostname)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 800,
            height: 600,
            titleBarStyle: 'default',
            title: 'YesPlayMusic',
            parent: this.window,
            webPreferences: {
              // 子窗口承载的是远程页面，必须与主窗口完全隔离
              webSecurity: true,
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              enableRemoteModule: false,
            },
          },
        };
      }

      safeOpenExternal(url);
      return { action: 'deny' };
    });
  }

  handleAppEvents() {
    app.on('ready', async () => {
      // This method will be called when Electron has finished
      // initialization and is ready to create browser windows.
      // Some APIs can only be used after this event occurs.
      log('app ready event');

      // for development
      if (isDevelopment) {
        this.initDevtools();
      }

      // create window
      this.createWindow();
      this.window.once('ready-to-show', () => {
        this.window.show();
      });
      this.handleWindowEvents();

      // create tray
      if (isCreateTray) {
        this.trayEventEmitter = new EventEmitter();
        this.ypmTrayImpl = createTray(
          this.window,
          this.trayEventEmitter,
          this.store
        );
      }

      // init ipcMain
      initIpcMain(this.window, this.store, this.trayEventEmitter);

      // set proxy
      const proxyRules = this.store.get('proxy');
      if (proxyRules) {
        this.window.webContents.session.setProxy({ proxyRules }, result => {
          log('finished setProxy', result);
        });
      }

      // check for updates
      this.checkForUpdates();

      // create menu
      createMenu(this.window, this.store);

      // create dock menu for macOS
      const createdDockMenu = createDockMenu(this.window);
      if (createDockMenu && app.dock) app.dock.setMenu(createdDockMenu);

      // create touch bar
      const createdTouchBar = createTouchBar(this.window);
      if (createdTouchBar) this.window.setTouchBar(createdTouchBar);

      // register global shortcuts
      if (this.store.get('settings.enableGlobalShortcut') !== false) {
        registerGlobalShortcut(this.window, this.store);
      }

      // try to start osdlyrics process on start
      if (this.store.get('settings.enableOsdlyricsSupport')) {
        await createDbus(this.window);
        log('try to start osdlyrics process');
        const osdlyricsProcess = spawn('osdlyrics');

        osdlyricsProcess.on('error', err => {
          log(`failed to start osdlyrics: ${err.message}`);
        });

        osdlyricsProcess.on('exit', (code, signal) => {
          log(`osdlyrics process exited with code ${code}, signal ${signal}`);
        });
      }

      // create mpris
      if (isCreateMpris) {
        createMpris(this.window);
      }
    });

    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      log('app activate event');
      if (this.window === null) {
        this.createWindow();
      } else {
        this.window.show();
      }
    });

    app.on('window-all-closed', () => {
      if (!isMac) {
        app.quit();
      }
    });

    app.on('before-quit', () => {
      this.willQuitApp = true;
    });

    app.on('quit', () => {
      this.expressApp.close();
    });

    app.on('will-quit', () => {
      // unregister all global shortcuts
      globalShortcut.unregisterAll();
    });

    if (!isMac) {
      app.on('second-instance', () => {
        if (this.window) {
          this.window.show();
          if (this.window.isMinimized()) {
            this.window.restore();
          }
          this.window.focus();
        }
      });
    }
  }
}

new Background();
