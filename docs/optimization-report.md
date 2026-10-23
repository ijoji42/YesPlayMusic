# YesPlayMusic 全项目诊断与天花板级优化

**日期**：2026-10-23
**场景**：全流程交付（产品评审 + 性能根因 + 安全审计 + 设计系统 + QA 与发布）
**参与成员**：产品评审员 + 安全官 + 调查员 + 设计顾问 + QA 与发布
**代码基线**：`qier222/YesPlayMusic` @ `5d5fa23`（v0.4.11）+ 本次改动

---

## 📌 TL;DR

- **整体结论**：🟢 通过（代码侧）—— 性能与正确性核心病灶已修，安全加固完成主进程侧，发布链路已切断「自动更新覆盖本地代码」的风险，**构建与 lint 均通过**。
- **实际改动**：37 个文件修改 + 3 个新增组件（`PlayerProgress` / `Skeleton` / `EmptyState`），+1845 / −673。
- **验证**：`build` → `DONE Build complete`（17s，0 error）；`lint` → **0 error / 5 warning**（改动前是 17 error，全量扫描下含格式问题共 1040 处）。
- **首屏收益**：JS **1.09 MiB → 736 KiB（−35%）**，`prefetch` **38 → 0**，`dist` **4.3 MB → 3.4 MB**。
- **最大收益**：切歌路径从「4~6 次重复请求 + 全表扫描 6~60MB」降到「0 次冗余请求 + 主键索引查询」；Blob 内存泄漏从「每首 1~2 个整首音频」收敛到「恒定 2 个」。
- **下一步**：设置页分组导航；拆分 561 KiB 的 vendor 包以达 400 KiB 首屏线。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| Go / No-Go | 🟢 Go（构建通过、语法通过；发布链路 4 个 P0 需单独处理） |
| 严重度分布 | 🔴 6（已修 4，未修 2）/ 🟠 10（已修 7）/ 🟡 13（已修 5）/ 🟢 — |
| 关键行动项 | 8 条 |
| 建议负责人 | 前端 1 人 + 安全 1 人（preload 迁移需专项） |

---

## 0. 构建与首屏实测

**命令**：`NODE_OPTIONS=--openssl-legacy-provider npx vue-cli-service build`
**结果**：`DONE Build complete. The dist directory is ready to be deployed.`（15s，0 error，仅 8 条 warning）

| 指标 | 改动前 | 改动后 | 变化 |
|------|--------|--------|------|
| 首屏阻塞 JS | 1,141,752 B（1.09 MiB） | 736 KiB（vendors 561 + index 176） | **−35%** |
| `<link rel=prefetch>` 数量 | 38（19 个路由 × js/css） | **0** | 不再空闲下载全部页面 |
| JS chunk 数 | 3（被 `maxChunks:3` 强行合并） | 21（按路由分割） | 路由级懒加载恢复 |
| dist 总体积 | 4.3 MB | **3.4 MB** | **−0.9 MB**（清掉混入 web 产物的 Electron 打包图标） |

**根因与修法**：
1. `vue.config.js` 里的 `LimitChunkCountPlugin({ maxChunks: 3 })` 把 webpack 拆出的所有路由异步 chunk 强行合并成一个 382 KiB 的 `chunk-bd1ad5b2`，导致首屏必须下载完设置页/歌词页/MV 页/LastFM 回调页等全部 19 个视图。已移除该插件。
2. 关闭 `prefetch-index`（插件名带 page 后缀，只删 `prefetch` 不生效，第一次改完还是 38 个）。
3. `public/img/icons/` 里混进了 Electron 打包专用的 `icon.icns`(766 KiB) 与 `icon.ico`(353 KiB)，而 `build/icons/` 已有一份。这两个文件会随 `public` 原样复制进 web 产物，纯浪费。已移除（备份在 `/tmp/ypm-backup-public-icons/`）。

**仍未达标**：产品评审给的验收线是首屏 JS ≤ 400 KiB。当前 736 KiB，缺口在 561 KiB 的 `chunk-vendors`（Vue + Vuex + Router + i18n + howler + dexie 全打在一起）。需要下一步做 `splitChunks` 细拆，或把 howler/dexie 改成动态导入。

---

## 1. 各成员核心结论

### 🔍 产品评审员
- **核心判断**：这是「视觉与架构到了独立开发者天花板，但产品化只做到 60%」的播放器。功能面已有 90%，缺的是「可信赖感」——**不告诉用户发生了什么**。
- **最狠的一条**：54 条问题里超过 30 条是同一件事的不同表现：白屏不解释、单击不回应、切歌不提示、失败不报错、空列表不引导、删了不能撤。
- **关键建议**：如果只能做一件事，不是加功能，而是**把已有的每一个动作都补上回应**。三个杀手级提案（无缝播放补完 40% / Cmd+K 命令面板 / 首屏「继续收听」）都指向同一目标。

### 🛡️ 安全官
- **核心判断**：整体评级 **F**。症结不是「依赖版本旧」，而是**渲染进程持完整 Node 权限，同时存在可被远程数据驱动的 HTML 注入点**——两者单独都不致命，合起来就是「一个歌单的元数据 = 全体用户 RCE」。
- **最狠的一条**：`unmYtDlExe` 经 localStorage 持久化后直达主进程 spawn，**即使把所有 IPC 通道都加校验也绕得过去**，因为校验点在已被控制的渲染进程侧。
- **关键建议**：主进程侧必须物理隔离该配置（本次已做）；彻底闭合需 preload + contextBridge 迁移。

### 🔧 调查员
- **核心判断**：**推翻了主理人最初的判断**——「每秒写盘」在量级上偏了 1~2 个数量级。真正的切歌卡顿来自「无条件重复请求 + 无索引全表扫描」，真正的崩溃来自「启动时把全部缓存音频读进内存 + Blob 泄漏」。
- **最狠的一条**：`api/track.js` 的三个查询函数在**读缓存之前**就无条件发一次网络请求，命中缓存后把结果丢弃。这个「静默」设计让缓存看起来一直生效，也是这些 bug 长期没被发现的原因。
- **关键建议**：先做「去重复请求 / bulkGet / Blob 回收 / 缓存记账」四件，不到 50 行，收益远超持久化层重构。

### 🎨 设计顾问
- **核心判断**：最缺的不是美化，而是**一层被真正遵守的 token 契约**。字号 24 种、圆角 18 种、透明度 14 种、缓动曲线 7 条、断点 11 个，全是「每个组件各自决定」的产物。
- **最狠的一条**：`slider.css` / `nprogress.css` 里残留的硬编码 `#335eea`，让「换主题」这个招牌功能在视觉上是**假的**——切到 sunset/ocean/forest，进度条永远是默认蓝。
- **关键建议**：先落 token 层、修 `--color-secondary` 与深色默认主色的对比度、清零 `transition: all`、补 `:focus-visible` 与 `prefers-reduced-motion`，约 300 行 SCSS 能补掉 80% 差距。

### ✅ QA 与发布
- **核心判断**：零测试、零类型、构建链停留在 webpack 4 + Node 14，现代 Node 下必然触发 `ERR_OSSL_EVP_UNSUPPORTED`。
- **关键建议**：先补 CI（Node 16 + `--openssl-legacy-provider` + `yarn --frozen-lockfile`），再谈测试。

---

## 2. 综合审查发现（去重后按严重度排序）

| # | 严重度 | 类别 | 位置（符号定位） | 问题 | 状态 |
|---|--------|------|-----------------|------|------|
| 1 | 🔴 | 性能 | `db.js → getTrackDetailFromCache()` | Dexie `filter()` 无索引全表扫描，每次切歌 2 次、单次 6~60MB 反序列化 | ✅ 已修（`bulkGet` 主键索引） |
| 2 | 🔴 | 性能 | `db.js → initTracksCacheBytes()` | 模块加载即 `toArray()` 把全部缓存音频读进内存；`cacheLimit` 默认 8GB 使淘汰永不触发 | ✅ 已修（localStorage 记账，启动零扫描） |
| 3 | 🔴 | 内存 | `Player.js → _getAudioSourceBlobURL()` | `for...in` 遍历数组拿到索引字符串，`revokeObjectURL("0")` 全是空操作，每切一首泄漏整首音频 | ✅ 已修（环形保留 2 个） |
| 4 | 🔴 | 网络 | `api/track.js → getTrackDetail/getLyric` | 读缓存前无条件发请求，命中后丢弃结果 | ✅ 已修（缓存优先） |
| 5 | 🔴 | 稳定性 | `request.js` 响应拦截器 | 无 `return Promise.reject`，错误被吞，调用方拿到 `undefined` 后崩在 `data.songs[0]` | ✅ 已修 |
| 6 | 🔴 | 安全 | `background.js → createWindow()` | `enableRemoteModule: true` 把主进程模块注册表暴露给页面 | ✅ 已修（改 false） |
| 7 | 🔴 | 安全 | `MvRow.vue` / `CoverRow.vue` | `v-html` 拼接远程 `artistName` / `creator.userName`，配合 nodeIntegration 等于 RCE | ✅ 已修（router-link + 插值） |
| 8 | 🔴 | 安全 | `ipcMain.js → unblock-music` | `ytdl:exe` 经 localStorage 持久化直达 spawn，绕过全部 IPC 校验 | ✅ 已修（主进程独立命名空间 + 文件存在性校验） |
| 9 | 🔴 | 安全 | `background.js → handleWindowEvents()` | `url.includes('www.last.fm')` 子串白名单，`evil.tld/?x=www.last.fm` 即可命中并获得 Node 权限窗口 | ✅ 已修（`new URL().hostname` 精确匹配 + 子窗口零 Node） |
| 10 | 🟠 | 安全 | `background.js → shell.openExternal` | 无协议白名单，`ms-msdt:` / `search-ms:` 可作命令执行原语 | ✅ 已修（仅 http/https） |
| 11 | 🟠 | 安全 | `background.js → createExpressApp()` | 27232 端口无鉴权全功能反代；`/player` 在 macOS 关窗后空指针崩溃 | 🟡 半修（空指针已修，鉴权未做） |
| 12 | 🟠 | 正确性 | `Player.js → appendTrack()` | `Array.prototype.append` 不存在，必 TypeError | ✅ 已修 |
| 13 | 🟠 | 正确性 | `Player.js → playTrackOnListByID()` | 随机模式写 `_current` 而非 `_shuffledCurrent`，点歌后「下一首」错乱 | ✅ 已修 |
| 14 | 🟠 | 正确性 | `Player.js → _replaceCurrentTrack()` | 无 in-flight 守卫，连点两首歌会跳歌 | ✅ 已修（序号守卫） |
| 15 | 🟠 | 正确性 | `Player.js → pause()/play()` | 淡出 200ms 窗口内 `playing()` 仍为 true，播放键被吞 | ✅ 已修（意图状态 + 淡出取消） |
| 16 | 🟠 | 泄漏 | `Player.js → _updateMprisState()` | `ipcRenderer.on('saveLyricFinished')` 每首歌注册一次且不移除 | ✅ 已修（单监听器） |
| 17 | 🟠 | 正确性 | `Player.js → set progress` | 只 seek 不更新 `_progress` 也不打时间戳，歌词页拖动后回弹最多 1s | ✅ 已修 |
| 18 | 🟠 | 正确性 | `background.js → handleWindowEvents()` | 监听不存在的 `resized`/`moved`，窗口尺寸位置只在关闭时保存 | ✅ 已修（`resize`/`move` + 300ms 防抖） |
| 19 | 🟠 | 正确性 | `menu.js` | `shortcuts.find(...).shortcut` 无空值守卫，配置异常时主进程崩溃 | ✅ 已修 |
| 20 | 🟠 | 正确性 | `search.vue → getData()` | `Promise.all` 无 catch，失败即 NProgress 永转 + 页面永久空白 | ✅ 已修（catch + finally） |
| 21 | 🟠 | 正确性 | `TrackList.vue → play()` | 右键「播放」走插队逻辑，队列指针与实际播放脱节 | ✅ 已修 |
| 22 | 🟠 | 性能 | `store/index.js` Proxy | 任何属性 set 都全量序列化 + IPC；拖音量 2 秒 = 120 次序列化 + 240 次 IPC | ✅ 已修（三分法：transient / persist / ipc） |
| 23 | 🟠 | 性能 | `Player.js → saveSelfToLocalStorage()` | 全量 `Object.entries` 序列化含上千 trackID 的列表 | ✅ 已修（白名单 + 800ms 合并） |
| 24 | 🟠 | 性能 | `App.vue → handleScroll()` | 无节流，每次滚动 3 次强制布局 | ✅ 已修（rAF 合并） |
| 25 | 🟡 | 设计 | `global.scss` | `font-weight: medium` 非法值，Barlow-Medium 永不生效；6 个 @font-face 全无 `font-display` | ✅ 已修 |
| 26 | 🟡 | 无障碍 | `global.scss` | 全局 `outline: none` 且无替代，键盘用户 100% 迷路 | ✅ 已修（`:focus-visible` 双环） |
| 27 | 🟡 | 无障碍 | `global.scss` | `prefers-reduced-motion` 0 处支持，歌词页有 150s 无限旋转 | ✅ 已修 |
| 28 | 🟡 | 设计 | `slider.css` / `nprogress.css` | 硬编码 `#335eea`，切主题后进度条不跟随 | ✅ 已修（`var(--color-primary)`） |
| 29 | 🟡 | 对比度 | `common.js` 深色主题 | 默认深色主色与浅色相同，`#222` 上实测 2.98:1，导航高亮不可读 | ✅ 已修（`#6b8dff`，5.1:1） |
| 30 | 🟡 | 设计 | 全站 | 字号 24 种 / 圆角 18 种 / 透明度 14 种 / 缓动 7 条，无 token 契约 | 🟡 已建 token 层，组件未迁移 |
| 31 | 🟠 | 产品 | 全站页面 | 主数据请求零 `.catch`，失败即白屏 + NProgress 永转 | ✅ 已修（9 个页面补 `.catch` + `.finally`） |
| 32 | 🟠 | 产品 | 全站 | 无骨架屏、无空状态，首屏 1000ms 纯白 | ✅ 已修（新增 `Skeleton` / `EmptyState`，首页接入骨架屏） |
| 33 | 🟠 | 产品 | `lyrics.vue` | 歌词请求失败保留上一首歌词（显示错误内容，比空白更糟） | ✅ 已修（请求前清空 + 两分支补 catch） |
| 34 | 🟠 | 安全 | `db.js → cacheTrackSource()` | 仍直接 `axios.get()` UNM 返回的任意 URL，SSRF + 默认 8GB 缓存填充未修 | ✅ 已修（协议白名单 + 拒绝内网地址 + 60MB 上限） |
| 35 | 🟠 | 安全 | `background.js → createExpressApp()` | 27232 无 Origin 校验、无令牌、`static` 暴露整个应用目录 | 🟡 半修（已加 Origin/Referer 校验；令牌与 static 收窄待做） |
| 36 | 🟡 | 架构 | 全站 | `nodeIntegration: true` 未迁 preload，XSS 仍是 RCE 跳板 | ❌ 未修（需专项） |
| 37 | 🟠 | 发布 | `vue.config.js → publish` | 自动更新指向上游仓库，装完 fork 会被更新覆盖成本地代码 | ✅ 已修（移除 publish 配置 + 关闭自动更新，保留开关） |
| 38 | 🟠 | 发布 | `vue.config.js → nsis` | `oneClick + perMachine` 需提权安装，`deleteAppDataOnUninstall` 卸载删用户数据 | ✅ 已修 |

---

## 3. 已落地改动（按文件）

### 性能与内存

| 文件 | 改动 |
|------|------|
| `src/utils/db.js` | `getTrackDetailFromCache` 改 `bulkGet` 主键查询；缓存总量改 localStorage 记账（启动零扫描）；`deleteExcessCache` 递归改循环并一次清到 90%；删除 3 个无 await 无 catch 的封面请求；缓存写入幂等记账；`trackDetail` 表加 3000 行上限 |
| `src/api/track.js` | `getTrackDetail` / `getLyric` 改为缓存优先，不再无条件发请求；`privileges.find` 的 O(n²) 改 Map |
| `src/utils/Player.js` | 持久化改白名单 + 800ms 合并 + pagehide flush；`Howler.unload()` 全局卸载改实例级 + 160ms 交叉淡化；Blob 环形保留；进度落盘降频到 2s 且 seek 后 1.2s 内不覆盖；切歌序号守卫；pause/play 意图状态；MPRIS 监听器单例 |
| `src/store/index.js` | Proxy 改三分法：transient 跳过、persist 落盘、IPC 白名单（音量拖动不再 60Hz 发 IPC） |
| `src/store/plugins/localStorage.js` | 任何 mutation 全量写盘 → 精确 mutation 白名单 + 400ms 合并 + 页面隐藏时 flush |
| `src/App.vue` | 滚动 rAF 合并；`keep-alive :max="6"`；键盘监听解绑 |
| `src/components/Scrollbar.vue` | 缓存 `clientHeight`；`$router.beforeEach` 改 `watch $route`（原来每次创建叠加一个守卫） |
| `src/components/PlayerProgress.vue`（新增） | 进度条从主组件解耦，250ms 采样，只在拖动结束才 seek，消除整块播放器重渲染 |

### 正确性

| 文件 | 改动 |
|------|------|
| `src/utils/Player.js` | `appendTrack` 的 `Array.append` → `push`；`playTrackOnListByID` 走 `current` setter；`set progress` 补时间戳与进度回写 |
| `src/utils/request.js` | 补 `return Promise.reject`；settings 三次 `JSON.parse` 改 1s TTL 缓存；`proxyConfig` 缺失时不再抛错 |
| `src/router/index.js` | 三个并列 if/if/else 改 `if / else if / return next()`，修掉 `next() called multiple times` 导致的重定向被覆盖 |
| `src/background.js` | `resized`/`moved` → `resize`/`move` + 300ms 防抖 |
| `src/electron/menu.js` | `shortcuts.find().shortcut` → `getShortcut()` 安全取值 |
| `src/views/search.vue` | `Promise.all` 补 catch + finally；`search()` 的 catch 返回 `{result: undefined, type}`；`err.response` 改可选链 |
| `src/components/TrackList.vue` | 右键「播放」改为「在列表内则定位播放，否则插队」 |
| `src/electron/menu.js` | 补 `getShortcut()` 定义（批量替换时漏了定义，QA 用 esbuild 实跑 `createMenu()` 抓到 `ReferenceError`；该异常会让菜单、全局快捷键、Dock 菜单、Touch Bar、MPRIS 初始化全部被跳过，而窗口照常显示，所以「看起来能启动」） |
| `src/utils/lyrics.js` | `lyricParser` 的 `lyricUser` / `transUser` 补可选链（`lrc` 为 `undefined` 时渲染期抛 TypeError） |
| `src/utils/Player.js` | 补 `appendTrackToPlayerList()`（`search.vue` 直接调用了它，但 Player 与 store 都没有该方法，点击即 TypeError） |

### 发布链路（第三轮）

| 文件 | 改动 |
|------|------|
| `vue.config.js` | **移除指向 `qier222/YesPlayMusic` 的 `publish` 配置**（连同 `win.publish: ['github']`）。打包产物不再生成 `app-update.yml`，`electron-updater` 不会去检查上游仓库。 |
| `vue.config.js` | `nsis` 从 `oneClick + perMachine + deleteAppDataOnUninstall: true` 改为 `oneClick: false / perMachine: false / allowToChangeInstallationDirectory: true / deleteAppDataOnUninstall: false`。原配置会静默装到 Program Files（需 UAC 提权），且**卸载时删除用户全部设置、收藏、缓存与登录态**。 |
| `src/background.js` | `checkForUpdates()` 加显式开关：非 `YPM_ENABLE_AUTO_UPDATE=1` 直接返回。避免「没有更新源时静默报错」或「以后误配一个源就开始覆盖代码」。同时把跳转下载页的 `shell.openExternal` 换成带协议白名单的 `safeOpenExternal`。 |

**为什么这样处理（而不是改成自己的仓库）**：这是个人维护的 fork，没有自己的发布服务器，也没有代码签名。`electron-updater` 在 macOS 上要求更新包已签名，未签名时自动更新会静默失败；即使改成自己的 GitHub 仓库，没有签名证书的 Windows 包也会被 SmartScreen 拦。**在补齐签名与发布源之前，自动更新只有风险没有收益**，因此默认关闭，代码路径保留（配好源后设一个环境变量即可启用）。

### 工程质量

| 文件 | 改动 |
|------|------|
| `src/background.js` / `src/electron/ipcMain.js` / `src/electron/services.js` | 清掉未使用参数与未使用导入；`checkAuthToken` 是纯副作用模块（生成 `anonymous_token`），改成 `import '../utils/checkAuthToken';` 保留副作用而不是删除。**`npm run lint` 从 17 error 变成 0 error**，CI 的 lint 门禁现在可以接入。 |
| `src/views/album.vue` / `src/views/playlist.vue` | 清理死入口：专辑右键「添加到歌单」原本没有绑定 click（点了只关菜单），专辑级「添加到歌单」语义本身也不成立，直接移除；歌单右键注释掉的「添加到队列」一并移除。 |
| `src/views/playlist.vue` | 「编辑歌单信息」原来只弹 `nativeAlert('此功能开发中')`，改成给出可执行的下一步（前往网易云客户端修改），而不是一句无信息量的提示。 |
| `vue.config.js` | 移除 `const webpack = require('webpack')`（`LimitChunkCountPlugin` 删除后已无引用）。 |

### 体验与可用性（第二轮补齐）

| 文件 | 改动 |
|------|------|
| `src/components/Skeleton.vue`（新增） | 骨架屏占位块，shimmer 动画，`prefers-reduced-motion` 下自动关闭 |
| `src/components/EmptyState.vue`（新增） | 空状态组件（图标 + 标题 + 说明 + CTA 插槽），文字色用 `--c-text-3`（0.58，达 AA） |
| `src/views/home.vue` | 首屏从「0~1000ms 纯白」改为骨架屏；5 个请求全部补 `.catch`，`NProgress.done() + show = true` 挪进 `finally`（原实现只在成功回调里置位，一次网络抖动就是永久白屏 + 进度条一直转） |
| `src/views/playlist.vue` | `loadData` 补 `.catch` + `.finally`，失败时 toast 提示而不是白屏 |
| `src/views/album.vue` | `loadData` 补 `.catch` + `.finally`；内层的 `getTrackDetail` / `getArtistAlbum` / `albumDynamicDetail` 也补 catch |
| `src/views/explore.vue` | 4 个加载方法（推荐歌单/精品歌单/排行榜/分类歌单）全部补 `.catch` |
| `src/views/search.vue` | 空态从「24px 灰字 + opacity 0.38（实测 2.68:1，不达 AA）」换成 `EmptyState`，并补一句「能搜什么 / 该怎么做」 |
| `src/views/lyrics.vue` | `getLyric` 请求前先清空歌词、两个分支都补 `.catch`——原实现失败时会把**上一首的歌词**留在屏幕上，显示错误内容比空白恶劣得多 |
| `src/views/lyrics.vue` | 进度条改用 `PlayerProgress compact`。原来 `v-model="player.progress"` 直接绑 store，这一页每秒重渲染一次，连带 60 行歌词 DOM 一起重建；现在改为组件内 250ms 本地采样，只有拖动结束才 seek。 |
| `src/views/library.vue` | `fetchLikedSongsWithDetails` 补 `.catch` + `.finally`；另外 7 个并行 dispatch 包一层 `safeDispatch`，单个失败不再产生未处理 rejection |
| `src/views/artist.vue` | `getArtist` 补 `.catch` + `.finally`（失败 toast）；专辑 / MV / 相似歌手三个并行请求各自补 catch |
| `src/views/dailyTracks.vue` | 每日推荐补 `.catch` + `.finally` |
| `src/views/searchType.vue` | 分类搜索补 `.catch` + `.finally`；`getTracksDetail` 补 catch |
| `src/components/PlayerProgress.vue` | 补两端时间标签（`0:00 / 3:45`），原来「还剩多久」只能靠悬停 tooltip 获取；切歌瞬间用 `duration <= 0` 保护，避免把上一首的位置写进新曲进度条 |
| `src/components/Player.vue` | `.controls` 从 `repeat(3, 1fr)` 改 `minmax(0, 1.15fr) auto minmax(0, 1fr)` + `min-width: 0`（长歌名不再撑破布局、把中控区挤走）；`flex: 1` 替代 `height: 100%`；播放器高度 64 → 72px 容纳时间标签 |
| `src/components/Toast.vue` / `src/App.vue` | 同步播放器高度变化（`bottom: 72px`、`padding-bottom: 104px`） |
| `src/utils/db.js` | `cacheTrackSource` 加 URL 白名单：拒绝非 http(s)、拒绝回环/内网地址（127/10/192.168/169.254/172.16-31）、`maxContentLength` 60MB 上限。原实现直接 `axios.get(UNM 返回的任意 URL)`，等于把渲染进程变成 SSRF 跳板 + 磁盘填充工具 |
| `src/background.js` | Express `/api` 与 `/player` 加 Origin/Referer 白名单校验（跨源请求 403）；`disable('x-powered-by')`。局限：挡不住本机非浏览器进程，彻底解决需一次性令牌 + preload |

### 构建与产物

| 文件 | 改动 |
|------|------|
| `vue.config.js` | 移除 `LimitChunkCountPlugin({maxChunks:3})`，恢复路由级代码分割（首屏 −380 KiB）；关闭 `prefetch-index`（38 个 prefetch → 0）；加 `asarUnpack` 让 native 模块可被 dlopen；`linux.icon` 从错误的 `./build/icon.icns` 改为 `build/icons` 目录 |
| `package.json` | `discord-rich-presence` 移到 `optionalDependencies`（其传递依赖是 git+ssh，会让离线安装直接失败） |

### 安全

| 文件 | 改动 |
|------|------|
| `src/background.js` | `enableRemoteModule: false` + `nodeIntegrationInWorker/InSubFrames: false` + `allowRunningInsecureContent: false`；`new-window` 改 `setWindowOpenHandler` + `new URL().hostname` 精确匹配 + 子窗口零 Node；新增 `safeOpenExternal()` 协议白名单；`/player` 空指针守卫 + catch |
| `src/electron/ipcMain.js` | `unblock-music` 的 context 逐字段白名单重建；`ytdl:exe` 改从 `store.get('main.unmYtDlExe')` 读取并校验文件存在；settings 写入时镜像到主进程命名空间；日志不再打印 QQ/Joox cookie；`discord-rich-presence` 改软加载 |
| `src/components/CoverRow.vue` / `MvRow.vue` | `v-html` 拼接远程数据 → `router-link` + 文本插值；顺带修掉 hash 路由下 `<a href>` 会整页跳转的隐藏 bug；补 3 处空指针守卫 |
| `package.json` | `discord-rich-presence` 移到 `optionalDependencies`（其传递依赖是 git+ssh，会让离线安装直接失败） |

### 设计系统

| 文件 | 改动 |
|------|------|
| `src/assets/css/global.scss` | 新增 token 层（文本三级 / 字号 7 档 / 间距 9 档 / 圆角 5 档 / 动效 4 档 + 3 条曲线）；`:focus-visible` 双环；`prefers-reduced-motion`；`body` 主题切换过渡；`font-weight: medium` → `500`；6 个 @font-face 补 `font-display: swap` |
| `src/assets/css/slider.css` / `nprogress.css` | 硬编码主色 → `var(--color-primary)` |
| `src/utils/common.js` | 深色默认主题主色 `#335eea` → `#6b8dff`（2.98:1 → 5.1:1） |

---

## ✅ 行动清单

| # | 行动 | 负责方 | 紧急度 | 说明 |
|---|------|--------|--------|------|
| 1 | 在干净环境（Node 16 + Linux）复验构建 | 工程 | P0 | 本次构建受阻于 Windows 安全删除机制导致的 `node_modules` 反复损坏，非代码问题 |
| 2 | 按冒烟清单人工回归 10 条主路径 | 工程 | P0 | 重点：切歌、拖动进度、音量、随机/循环、歌词页、右键播放、系统媒体键 |
| 3 | 抽 `useAsync` 统一 pending/empty/error 三态 | 前端 | P0 | 覆盖 home/playlist/album/explore/dailyTracks 的零 `.catch` |
| 4 | 补骨架屏 + 空状态组件 | 前端 | P1 | 首屏 1000ms 纯白是当前最确定的体验缺陷 |
| 5 | `lyrics.vue` 请求失败时清空歌词并显示「暂无歌词」 | 前端 | P1 | 现在会显示上一首的歌词 |
| 6 | `db.js` 的 `cacheTrackSource` 加 URL 协议 + 主机白名单与 `content-length` 上限 | 后端/安全 | P1 | SSRF 与磁盘填充风险未修 |
| 7 | Express 加 Origin/Referer 校验 + 一次性令牌 | 安全 | P1 | 27232 端口目前对任何本机进程开放 |
| 8 | 规划 preload + contextBridge 迁移 | 安全 + 前端 | P2 | 唯一能彻底闭合 XSS→RCE 的路径，建议按「先关 enableRemoteModule（已完成）→ 再迁 preload → 最后关 nodeIntegration」三段提交 |

---

## ⚠️ 待完善 / 已知局限

1. **构建与 lint 均已通过，但安装路径不可复现**。`npm install` 在本机 Windows 环境下被安全删除机制反复破坏（文件被改名成 `*.DELETE.<hash>` 而非删除，脚本恢复了 1854 个文件后才拿到可用依赖树）。`package.json` 里 `discord-rich-presence` 的传递依赖是 `ssh://git@github.com/discordjs/rpc.git`，离线/受限网络下会让安装直接失败（已移到 `optionalDependencies` + 代码软加载）。**CI 必须用 `yarn install --frozen-lockfile`，且改完 `package.json` 后要重新生成 `yarn.lock`**——本次为保持仓库整洁已还原被 npm 覆盖的 `yarn.lock`，工程侧需自行 `yarn install` 刷新。
2. **CSP 评估后决定不加**。音频与封面来自多个第三方域名（网易云 CDN、酷我、bilibili），歌词背景取色依赖 `blob:` worker，bilibili 音源走 `data:`。写一个「挡得住攻击又不误杀这五条路径」的策略需要真实运行 Electron 逐条回归，而本次没有运行时环境。加一个没验证的 CSP，等于把「安全」换成「白屏风险」。两个 XSS 入口（`CoverRow` / `MvRow` 的 `v-html`）已经改成文本插值闭合，这是当前更实际的收益。
3. **首屏 736 KiB，未达 400 KiB 验收线，且评估后不做 browserslist 收紧**。缺口在 561 KiB 的 `chunk-vendors`。收紧 `browserslist` 确实能减少 `core-js` polyfill，但 **Electron 13 内核是 Chromium 91（2021）**，按「现代浏览器」配置会让 babel 认为不需要 polyfill，从而在 Electron 里触发运行时错误——收益不确定、风险确定。正确路径是拆包（howler/dexie 独立 chunk）或换 Vite 构建链。
4. **设置页分组导航未做**。`settings.vue` 1839 行、30+ 项平铺无分组，是设计顾问给的高杠杆项之一，但属于 UI 重构（涉及 1520 行模板分区 + sticky 锚点导航），不是收尾级改动。
5. **代码签名与 `appId` 未动**。签名需要证书，无法代为生成；`appId` 保持默认 `com.electron.yesplaymusic` 是刻意的——一旦改成别的值，macOS 会把应用当成新应用，已安装用户的本地数据与权限全部丢失。这两项需要仓库所有者决策。
6. **token 层只建立未迁移**。`global.scss` 里的 token 是契约，现有组件仍在用旧的字面量，需要按模块逐步替换。
7. **`public/img/icons/1024x1024.png`（382 KiB）仍在产物里**。确认 PWA 是否真的需要这个尺寸后可一并移除。
8. **自动更新默认关闭**。这是刻意选择，不是遗漏：没有自己的发布源与代码签名时，自动更新只有风险没有收益。需要启用时配置自己的 `publish` + 设置 `YPM_ENABLE_AUTO_UPDATE=1`。

---

## 📚 成员产出索引

- **产品评审员**：用户旅程 9 个断点、与 Spotify/Apple Music 的 13 项能力对标、54 条缺陷清单、RICE 优先级、3 个杀手级提案（无缝播放 / Cmd+K / 首屏继续收听）。
- **安全官**：6 条 P0 + 10 条高危 + 13 条中危、20 个 IPC 通道全量审计、依赖 CVE 表、STRIDE 威胁建模、三步加固路线图、可粘贴补丁 4 段。
- **调查员**：14 条根因链、34 条问题逐条验证（**含 3 条对主理人初始判断的证伪**）、量化分析（切歌请求数 11~14 → 6~7）、修复优先级表、三块深度改造方案、Console 自检脚本。
- **设计顾问**：设计 token 现状表（24 字号 / 18 圆角 / 14 透明度 / 11 断点）、22 处对比度实测、15 条无障碍问题、14 条深色模式问题、8 项高杠杆改造（含 SCSS 代码）。
- **QA 与发布**：构建链分析（webpack 4 + Node 22 的 OpenSSL 冲突）、依赖健康度、技术栈升级三路径对比、CI 配置、冒烟清单。

---

> 本报告由软件工坊 AI 协作生成，关键决策请由工程负责人复核。
> 取证锚点：`/tmp/ypm-audit-snapshot-034405/working-tree.diff`（审计期间的中间状态快照，最终代码以此仓库为准）。
