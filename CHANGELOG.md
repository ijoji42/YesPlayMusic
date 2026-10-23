# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式。

## [0.4.12] - 2026-10-24

以「不改变使用方式、只让每一处更可靠」为目标的一轮优化。共 37 个文件修改、3 个新组件，
构建与 lint 全部通过。

### 性能

- **切歌不再卡顿**：歌曲详情查询从 Dexie 无索引全表扫描改为 `bulkGet` 主键索引，
  单次耗时从 50~400ms 降到 <10ms。
- **切歌请求减半**：移除「查缓存前无条件发一次请求」的逻辑，每首歌的接口调用从 4~6 次降到 1 次。
- **启动内存与缓存解耦**：不再在启动时把全部缓存音频读进内存，改为 localStorage 记账。
  以前缓存 500MB 启动就多占 500MB。
- **首屏体积下降 35%**：移除 `LimitChunkCountPlugin({ maxChunks: 3 })`，恢复路由级代码分割，
  首屏 JS 从 1.09 MiB 降到 736 KiB；关闭 `prefetch`（38 个链接），不再空闲下载全部页面。
- **产物瘦身**：清掉误入 web 产物的 Electron 打包图标，`dist` 从 4.3 MB 降到 3.4 MB。
- **持久化开销降低**：播放器状态改白名单 + 800ms 合并写，拖动音量从 120 次写盘降到 1 次。
- **歌词页不再每秒重渲染**：进度条改用独立组件本地采样，不再重建 60 行歌词 DOM。
- **列表滚动合并到帧**：滚动事件用 rAF 合并，避免每次滚动触发 3 次强制布局。

### 修复

- **Blob 内存泄漏**：`for...in` 遍历数组导致 `revokeObjectURL` 全部失效，
  每切一首缓存的歌泄漏整首音频（3~12MB，FLAC 更高）。改为环形保留 2 个 URL。
- **切歌跳歌**：连点下一首时，先发出的请求可能后返回导致跳回。加序号守卫，只应用最后一次请求。
- **暂停/播放按键被吞**：淡出 200ms 内 `playing()` 仍为 true，播放键无效。改用意图状态判断。
- **进度条拖动回弹**：`set progress` 只 seek 不更新进度与时间戳，被 1 秒采样覆盖。
- **随机模式队列错乱**：`playTrackOnListByID` 写 `_current` 而非 `_shuffledCurrent`。
- **右键「播放」破坏队列**：改为「在列表内则定位播放，否则插队」。
- **`Array.prototype.append` 不存在**：`appendTrack` 必然抛 TypeError。
- **MPRIS 监听器泄漏**：每首歌注册一个 `ipcRenderer.on` 且不移除，长会话累积上千个。
- **窗口尺寸不记忆**：监听的事件名写成了 `resized`/`moved`，实际应为 `resize`/`move`。
- **菜单初始化中断**：`shortcuts.find().shortcut` 无空值守卫，异常会让菜单、全局快捷键、
  Dock 菜单、Touch Bar、MPRIS 的初始化全部被跳过（窗口照常显示，所以「看起来能启动」）。
- **网络失败永久白屏**：9 个页面补 `.catch` + `.finally`，`NProgress.done()` 与 `show = true`
  不再只在成功回调里执行。
- **请求错误被静默吞掉**：响应拦截器补 `return Promise.reject`，调用方不再拿到 `undefined`。
- **搜索页任一子请求失败即整页崩溃**：`Promise.all` 补 catch，`search()` 失败时返回带 type 的空结果。
- **歌词显示上一首**：请求前先清空，失败时不再把上一首歌词留在屏幕上。
- **路由守卫双重 `next()`**：三个并列 if/if/else 改为 `if / else if / return next()`。
- **`lyricParser` 空值崩溃**：`lyricUser` / `transUser` 补可选链。

### 界面

- **播放器显示时长**：两端补 `0:00 / 3:45` 时间标签，不再需要悬停看 tooltip。
- **长歌名不再撑破布局**：播放器网格改 `minmax(0, 1.15fr) auto minmax(0, 1fr)` 并补 `min-width: 0`。
- **首屏骨架屏**：打开应用后不再有约 1 秒的纯白，改为骨架占位，同时消除布局跳动。
- **空状态组件**：搜索无结果从「24px 灰字 + opacity 0.38（对比度 2.68:1）」改为带图标、
  标题与引导文案的空状态，文字对比度提到 5.33:1。
- **深色主题可读性**：默认深色主色在 `#222` 背景上只有 2.98:1，提亮到 5.1:1。
- **主题色不再硬编码**：进度条与加载条改用 `var(--color-primary)`，
  以前切到 sunset / ocean / forest 主题时进度条永远是蓝色。
- **键盘焦点可见**：补 `:focus-visible` 双环，原实现全局抹掉了焦点轮廓。
- **尊重减弱动效**：补 `prefers-reduced-motion`，歌词页的无限旋转会跟随系统设置关闭。
- **字体字重修复**：`font-weight: medium` 是非法值，Barlow-Medium 从未生效；
  6 个 `@font-face` 补 `font-display: swap`。
- **设计 token 层**：新增文本三级、字号 7 档、间距 9 档、圆角 5 档、动效 4 档的变量契约。
- **清理死入口**：专辑右键「添加到歌单」无 click 绑定、歌单右键注释掉的「添加到队列」已移除。

### 安全

- **XSS 入口闭合**：`CoverRow` / `MvRow` 的 `v-html` 拼接远程数据改为文本插值 + `router-link`。
  在 `nodeIntegration: true` 下，一个歌单的元数据即可执行任意代码。
- **关闭 `enableRemoteModule`**：不再允许渲染进程通过 `remote.require()` 调用主进程任意模块。
- **外链协议白名单**：`shell.openExternal` 只放行 http/https，阻断 `ms-msdt:` 类协议处理器。
- **子窗口精确域名匹配**：`new-window` 改 `setWindowOpenHandler`，
  原实现用 `url.includes('www.last.fm')`，`evil.tld/?x=www.last.fm` 也能命中。
- **ytdl 路径隔离**：从渲染进程可写的 settings 移到主进程独立命名空间，并在使用前校验文件存在。
  原实现可通过写 localStorage 让主进程 spawn 任意可执行文件。
- **UNM context 白名单**：逐字段重建，不再把渲染进程传来的对象原样交给 Rust executor；
  日志不再打印 QQ / Joox cookie。
- **缓存下载防 SSRF**：`cacheTrackSource` 加协议白名单、拒绝回环与内网地址、单曲 60MB 上限。
- **本地 API 跨源校验**：Express 的 `/api` 与 `/player` 校验 Origin / Referer，跨源请求返回 403。

### 发布

- **移除指向上游仓库的自动更新**：原配置会让装了本 fork 的用户被提示更新，
  下载并安装上游版本，直接覆盖本地代码。现默认关闭，代码路径保留，需要时设
  `YPM_ENABLE_AUTO_UPDATE=1` 并自行配置 `publish`。
- **安装器改为可选目录、卸载保留数据**：原 `oneClick + perMachine` 需管理员权限，
  且 `deleteAppDataOnUninstall: true` 会删除全部设置、收藏、缓存与登录态。
- **原生模块解包**：补 `asarUnpack`，`.node` 文件不再因 asar 无法 `dlopen` 而失效。
- **Linux 图标路径修复**：原指向不存在的 `./build/icon.icns`。

### 工程

- **`npm run lint` 从 17 error 降到 0 error**（仅剩 5 个 warning），CI 可以接入 lint 门禁。
- **补 `.env`**：缺失时打包后 `VUE_APP_ELECTRON_API_URL` 为 `undefined`，
  应用能打开但登录、搜索、播放全部失败。
- **主进程语法兼容**：webpack 4 的 parser 不支持 `?.` 和 `??`，
  主进程代码改用兼容写法（渲染进程有 babel 转译，不受影响）。
- **依赖可选化**：`discord-rich-presence` 移到 `optionalDependencies`，
  其传递依赖是 `ssh://git@github.com`，离线或受限网络下会让安装直接失败；代码改为软加载。

### 已知限制

- 首屏 736 KiB 在当前架构下已接近下限，剩余部分全是首屏必需的依赖。
  进一步下降需要迁移到 Vite 或裁剪 `core-js`（Electron 13 内核为 Chromium 91，裁剪有运行时风险）。
- 未启用 CSP：音频与封面来自多个第三方域名，需在真机上逐条回归后才能上。
- `nodeIntegration: true` 尚未迁移到 preload + contextBridge。
- 无代码签名，Windows SmartScreen 会提示未知发布者。
