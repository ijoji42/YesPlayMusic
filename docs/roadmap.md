# YesPlayMusic 后续版本路线图

**日期**：2026-10-24
**当前版本**：v0.4.11（已完成一轮优化，构建与 lint 通过）
**定位**：个人维护的 fork，业余时间推进，因此每个版本都按「一个周末能收尾」为粒度切分

---

## 当前基线

| 指标 | 现状 |
|---|---|
| 首屏阻塞 JS | 736 KiB（vendors 561 + index 176） |
| `dist` 总体积 | 3.4 MB |
| JS chunk 数 | 21（按路由分割） |
| 构建 | `DONE Build complete`（约 15s） |
| Lint | 0 error / 5 warning |
| 自动化测试 | **0** |

**一个必须说清的事实**：首屏 736 KiB 在当前架构下已接近下限。剩下的 561 KiB 是 Vue + Vuex + Router + i18n + howler + dexie + axios + core-js，**这些全都是首屏需要的**，拆成多个 chunk 只会改善二次访问的缓存命中，不会减少首次下载量。要真正降到 400 KiB，只有两条路：换 Vite（tree-shaking 更好）或裁掉 `core-js` 的 polyfill（但 Electron 13 内核是 Chromium 91，裁了有运行时风险）。所以这条不放在近期。

---

## v0.4.12 · 稳定性收尾

**主题**：让后续每一次改动都有回归网
**周期**：1 个周末
**目标**：从「改完靠手点」变成「改完能自动验证」

| # | 内容 | 为什么值得做 |
|---|------|-------------|
| 1 | **12 条 Vitest 用例**（播放器状态机 / 歌词解析 / 路由守卫 / 持久化节流） | 这次改动最危险的地方全在 `Player.js` 的状态机（切歌竞态、pause/play 淡出、随机索引）。这些 bug 手测很难覆盖，但写成测试就是几十行 |
| 2 | **CI 接入**（lint + build + test） | lint 已经能过了，现在缺的是自动化。三平台完整打包太慢，先做「lint + build」的快速检查 |
| 3 | **冒烟清单固化**到仓库（`docs/smoke-test.md`） | 现在的冒烟步骤散落在对话里，下次改动没人知道该测什么 |
| 4 | 移除 `public/img/icons/1024x1024.png`（382 KiB） | 确认 PWA 不需要这个尺寸后，产物再小 0.4 MB |
| 5 | 清理 `settings.vue` 的死代码 | 有若干注释掉的配置项，容易误导后续维护 |

**验收**：`yarn test:unit` 有输出、CI 变绿、`docs/smoke-test.md` 存在且能照着跑完。

---

## v0.5.0 · 体验跃迁

**主题**：让每一次操作都有回应
**周期**：2-3 个周末
**目标**：从「功能齐全」变成「敢推荐给朋友」

这是产品评审给出的核心判断：54 条问题里有 30+ 条是同一件事——**它不告诉用户发生了什么**。这一版集中解决这个。

| # | 内容 | 预期效果 | 工作量 |
|---|------|---------|--------|
| 1 | **无缝播放补完**：预载下一首到独立实例 + 切歌加载态 | 点下一首到出声从 300ms~2s 降到 **<150ms**；静音段消失 | 2-3 天 |
| 2 | **首屏「继续收听」**：从 localStorage 同步渲染最近 8 个播放会话 | 冷启动第一块内容 **0 网络等待**；顺带解决「回访从零开始」 | 2 天 |
| 3 | **Cmd/Ctrl+K 命令面板** | 搜歌、跳页面、续播不用离开键盘；键盘用户效率翻倍 | 3-4 天 |
| 4 | **设置页分组导航**（30+ 项分 8 组 + sticky 锚点） | 1839 行的设置页从「平铺列表」变成「可扫描」 | 2 天 |
| 5 | **列表虚拟滚动**（万首歌单） | 大歌单滚动不掉帧；现在 500 行就有 25 万次 `includes` 比较 | 3 天 |
| 6 | **歌词背景律动**（见下节，视觉优化主项） | 背景真正跟着音乐动；可调、可预览、有预设 | 4-5 天 |

**建议顺序**：2 → 1 → 6 → 3 → 4 → 5。

「继续收听」排第一，因为它是唯一一个**同时解决回访留存和首屏等待**的改动，且不依赖任何新依赖。

「歌词背景律动」排第三：它是这一版里唯一「用户会主动截图分享」的功能，但依赖音频分析层，需要单独调试。

---

## 视觉优化专项：歌词背景律动（Reactive Background）

### 现状

`settings.lyricsBackground` 现有四个值：

| 值 | 效果 |
|---|---|
| `false` | 关闭 |
| `true` | 封面取色渐变（`gradient-background`） |
| `'blur'` | 两张 140vw 封面图，一张 `mix-blend-mode: luminosity`，静态 |
| `'dynamic'` | 在 `blur` 基础上加 `animation: rotate 150s linear infinite` |

**关键事实**：所谓「动态」只是**封面图以 150 秒一圈缓慢旋转**，与音乐完全无关。用户听快歌和慢歌，背景转速一模一样。

### 目标

新增第五种模式 `'reactive'`：背景随音频能量实时变化，并允许用户自定义映射方式、实时预览。

### 一、音频分析层

新建 `src/utils/audioAnalyser.js`。核心是把 `AnalyserNode` 接到 Howler 的主增益节点上：

```js
import { Howler } from 'howler';

let analyser = null;
let freqData = null;

export function ensureAnalyser() {
  if (analyser) return analyser;
  const ctx = Howler.ctx;
  if (!ctx || !Howler.masterGain) return null;

  analyser = ctx.createAnalyser();
  analyser.fftSize = 256;                 // 128 个频段
  analyser.smoothingTimeConstant = 0.75;  // 与用户「平滑度」联动
  Howler.masterGain.connect(analyser);    // 注意：不接 destination，否则声音会重复
  freqData = new Uint8Array(analyser.frequencyBinCount);
  return analyser;
}

export function readBands() {
  if (!analyser) return null;
  analyser.getByteFrequencyData(freqData);
  // 采样率 44.1kHz + fftSize 256 → 每 bin ≈ 172Hz
  const bass = avg(freqData, 0, 4);      // 0~690Hz，鼓点与贝斯
  const mid = avg(freqData, 4, 24);      // 690Hz~4kHz，人声与主旋律
  const treble = avg(freqData, 24, 80);  // 4kHz 以上，镲片与空气感
  return { bass, mid, treble, energy: (bass * 1.4 + mid + treble * 0.6) / 3 };
}
```

**必须注意的三个坑**：

1. **跨域音频会让频谱全为 0**（tainted canvas 规则）。本项目音频已通过 `_getAudioSourceBlobURL()` 转成同源 blob，所以没问题；但如果将来直接播远端 URL，分析会静默失效——需要在 `readBands()` 返回全 0 时降级到静态效果，而不是显示一个不动的背景。
2. **`setSinkId` 切换输出设备后 analyser 仍然有效**，但要在切歌时确认没有重建 AudioContext。
3. **不能让 analyser 接 destination**，否则音频会被播放两次。

### 二、律动检测与视觉映射

两种驱动方式叠加，避免「只会跟着音量忽大忽小」：

- **能量映射**（连续）：低频能量线性映射到缩放、模糊、亮度。
- **节拍脉冲**（离散）：当前能量超过最近 43 帧（约 0.7 秒）移动平均的 1.35 倍时触发一次脉冲，用 CSS 过渡自然衰减。

```js
const history = [];
function detectBeat(bass, sensitivity) {
  history.push(bass);
  if (history.length > 43) history.shift();
  const avg = history.reduce((a, b) => a + b, 0) / history.length;
  const threshold = 1 + (100 - sensitivity) / 200;  // 灵敏度 0~100 → 阈值 1.5~1.0
  return bass > avg * threshold && bass > 70;
}
```

**视觉输出必须只用 `transform` 和 `filter`**，不能碰 `width`/`margin`/`top` 这类会触发重排的属性。用 CSS 变量驱动，每帧只改变量：

```js
el.style.setProperty('--react-scale', String(1 + bass / 255 * intensity));
el.style.setProperty('--react-blur', `${baseBlur + bass / 255 * 18}px`);
```

```scss
.reactive-background > div {
  transform: scale(var(--react-scale, 1)) rotate(var(--react-rotate, 0deg));
  filter: blur(var(--react-blur, 0px)) brightness(var(--react-brightness, 1))
          saturate(var(--react-saturate, 1));
  transition: transform 80ms linear, filter 80ms linear;
  will-change: transform, filter;
}
```

### 三、可自定义（人性化操作）

设置项结构：

```js
settings.lyricsBackground = 'reactive';
settings.lyricsReactive = {
  preset: 'soft',          // soft / punchy / beatOnly / breathe / custom
  intensity: 55,           // 幅度 0~100
  sensitivity: 50,         // 触发灵敏度 0~100
  smoothing: 70,           // 平滑度 0~100（映射到 smoothingTimeConstant 0.5~0.95）
  band: 'bass',            // bass / mid / treble / all —— 听什么动什么
  dimensions: {            // 映射维度，多选
    scale: true,
    blur: true,
    brightness: false,
    hue: false,
    saturate: false,
  },
};
```

**预设是「人性化」的关键**。大部分人不想调 5 个滑块，只想选一个感觉：

| 预设 | 参数组合 | 适合 |
|---|---|---|
| 柔和（默认） | 强度 40 / 低频 / 仅缩放+模糊 | 日常听歌，不抢歌词 |
| 强烈 | 强度 85 / 全频段 / 缩放+模糊+亮度+饱和 | 电子、摇滚 |
| 仅鼓点 | 强度 70 / 低频 / 仅缩放，平滑度低 | 追求「一击一震」 |
| 呼吸感 | 强度 30 / 中频 / 仅模糊+亮度，平滑度高 | 民谣、纯音乐 |

选预设后仍可微调，微调后 `preset` 自动变成 `custom`。

### 四、可预览

设置页内嵌一个 **240×140 的预览块**，与歌词页共用同一个 analyser：

- 有音乐在播 → 实时响应当前音频，所见即所得
- 没有音乐 → 显示提示「播放任意歌曲后可预览」，同时用一段内置的合成波形（`OscillatorNode`，静音）驱动，让用户至少能看到效果
- 调任何滑块，预览立刻变化，不需要进歌词页

这样用户不用「改一下 → 退出去听一下 → 再回来改」。

### 五、性能预算

- rAF 循环**只在歌词页可见或预览块在视口内时运行**，离开时 `cancelAnimationFrame`。
- 采样降到 **30fps**（每两帧读一次频谱），人眼对背景模糊的变化不敏感，30fps 足够。
- 每帧只写 2~5 个 CSS 变量，不触发 Vue 响应式更新（**不进 Vuex，不进 data**），避免整页重渲染。
- 目标是歌词页 CPU 增量 < 2%，在集显机器上不掉帧。

### 六、验收标准

1. 播放电子乐时，背景随鼓点有肉眼可见的脉冲；播放纯人声时，背景几乎静止（说明 `band` 过滤生效）。
2. 调整「强度」滑块，预览块实时变化，延迟 < 100ms。
3. 切换四个预设，效果差异明显可辨。
4. 歌词页连续播放 30 分钟，CPU 占用增量 < 2%，内存无增长。
5. 关闭该功能后，`requestAnimationFrame` 循环完全停止（DevTools Performance 面板验证）。
6. 音频频谱读不到（跨域/解码失败）时，自动降级为静态模糊背景，不显示一个不动的「假律动」。

### 七、涉及文件

| 文件 | 改动 |
|---|---|
| `src/utils/audioAnalyser.js` | 新建：AnalyserNode 接入、频段读取、节拍检测 |
| `src/views/lyrics.vue` | 新增 `'reactive'` 模式的模板分支与样式；rAF 生命周期 |
| `src/views/settings.vue` | 新增「律动效果」分组：预设选择、5 个滑块、映射维度多选、预览块 |
| `src/components/ReactivePreview.vue` | 新建：设置页内嵌预览 |
| `src/store/state.js` | 新增 `settings.lyricsReactive` 默认值 |
| `src/locale/*.js` | 新增文案（中/英） |

### 八、风险

| 风险 | 应对 |
|---|---|
| 部分音频源跨域导致频谱全 0 | 检测到连续 60 帧全 0 时降级为静态，并在设置页提示 |
| 低端机掉帧 | 默认 30fps + 只改 transform/filter；提供「关闭律动」开关 |
| 与 `prefers-reduced-motion` 冲突 | 系统开启减弱动效时默认关闭律动，需用户显式开启 |
| 频谱数据让「动态」模式的旋转看起来更乱 | 两种模式独立，互不叠加 |

---

## v0.6.0 · 架构升级（可选）

**主题**：把安全与构建债还掉
**周期**：1-2 个月（业余时间）
**前提**：v0.5.0 稳定运行一段时间、没有回归

| # | 内容 | 预期效果 | 风险 |
|---|------|---------|------|
| 1 | **preload + contextBridge 迁移**，之后关闭 `nodeIntegration` | 彻底闭合「XSS → 任意代码执行」。现在两个 XSS 入口已堵，但只要 `nodeIntegration: true` 还在，任何新的注入点都会重新变成 RCE | 中：8 处 `window.require` 调用要逐个改写 |
| 2 | **Vue 2.7 + Vite** 替换 vue-cli 4 / webpack 4 | 首屏预计 **300-400 KiB**；dev server 冷启动从 ~15s 到 <1s；构建从 13s 到 ~4s | 中高：主进程构建链要换成 `electron-vite`，native 模块的 externals 要重配 |
| 3 | **代码签名 + 发布流水线** | 不再弹 SmartScreen；自动更新可以真正启用 | 需要证书（个人开发者可用开源签名或自签 + 手动确认） |

**注意**：这一版是「技术债」，做完用户感知不明显。只有在打算长期维护时才值得投入。

---

## 不建议做

| 项 | 原因 |
|---|------|
| **Vue 3 全量重写** | 6-8 人周。`vue-slider-component@3` 没有 Vue 3 版、`vue-clipboard2` 停更、`plyr` 封装要重写，回归面覆盖全部 19 个视图。收益（Composition API、官方支持到 2027）与个人维护的成本不匹配 |
| **移动端适配** | 桌面播放器的交互模型和移动端差异大，不是加断点能解决的 |
| **补全歌单编辑功能** | 涉及名称/简介/封面/标签多个接口和表单，属于独立功能开发。当前已改为提示「前往客户端修改」，比留一个「开发中」的死入口好 |

---

## 如果时间很紧，只做这三件

1. **v0.4.12 的 1 + 2**（测试 + CI）—— 没有回归网，后面每改一次都是在赌
2. **v0.5.0 的 2**（继续收听）—— 单点改动，同时解决首屏和回访
3. **v0.5.0 的 1**（无缝播放补完）—— 切歌是最频繁的操作，收益最直接

---

## 版本号建议

当前 `package.json` 是 `0.4.11`，沿用上游版本号。建议：

- v0.4.12 —— 本轮优化的正式发布（当前工作区状态）
- v0.5.0 —— 体验跃迁（有新增功能，走 minor）
- v0.6.0 —— 架构升级（可能有不兼容的内部变化）

**发布前必须确认**：`package.json` 的 `version` 与 git tag 一致。目前没有任何步骤校验这一点，可能发出 `v0.4.12` 的 tag 却打出 0.4.11 的包。
