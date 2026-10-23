// 音频分析层：把 AnalyserNode 挂到 Howler 的主增益节点上，读取频段能量，
// 并做节拍检测。供歌词页背景（lyrics.vue）和设置页预览（ReactivePreview.vue）共用。
//
// 四个必须守住的点：
// 1. **音源必须是 Web Audio 模式**。Howler 的 html5 模式把播放交给 <audio> 元素
//    直接输出到硬件，信号根本不经过 Howler.masterGain；而 analyser 是挂在
//    masterGain 上的旁路监听，所以在 html5 模式下 getByteFrequencyData() 永远是
//    全 0。Player.syncAudioMode() 负责在律动被选中时把当前实例单向升级成
//    Web Audio 模式。
//    Web Audio 模式下的输出设备由 Player 的输出桥负责（masterGain →
//    MediaStreamDestination → 隐藏 <audio>.setSinkId），所以「选了非默认设备」
//    不再是降级理由。改接路由会调用本文件的 rewireAnalyser() 重新挂上 analyser。
// 2. analyser 只从 masterGain 取信号，**绝不**再接 destination，否则声音会放两遍。
// 3. 读不到频谱时（跨域音源 / 解码失败 / 上下文被挂起）这一帧的能量就是 0，
//    视觉层自然表现为静止，不需要额外的降级状态，也不需要「假装在动」的兜底。
// 4. 整个模块不进 Vuex、不进组件 data。每帧只写 CSS 自定义属性，避免整页重渲染。

import { Howler } from 'howler';

const FFT_SIZE = 256;
// fftSize 256 → frequencyBinCount 128。采样率 44.1kHz 时每 bin ≈ 172Hz。
const BAND_BASS = [0, 4]; // 0 ~ 690Hz  鼓点与贝斯
const BAND_MID = [4, 24]; // 690Hz ~ 4kHz 人声与主旋律
const BAND_TREBLE = [24, 80]; // 4kHz 以上  镲片与空气感

const TARGET_FPS = 30; // 人眼对背景模糊的变化不敏感，30fps 足够
const FRAME_INTERVAL = 1000 / TARGET_FPS;
const BEAT_WINDOW_SECONDS = 0.7;
const BEAT_FRAMES = Math.max(4, Math.round(BEAT_WINDOW_SECONDS * TARGET_FPS)); // 21
const MIN_BEAT_LEVEL = 70; // 绝对门限，防止安静段落里的噪声被当成鼓点
const PULSE_DECAY = 0.86; // 每帧衰减，半衰期约 0.15s
const BASE_BLUR = 50; // 与 lyrics.vue 里 .lyrics-background 的 blur(50px) 对齐
// 非对称包络的一阶系数：起音快、释放慢。
// 对称的平滑会跟着每个鼓点一起抽搐；起音用 0.62 让「一下」立刻到位，
// 释放用 0.13 让背景缓慢回落，观感上才像「呼吸」而不是「抖动」。
const ATTACK = 0.62;
const RELEASE = 0.13;

export const REACTIVE_PRESETS = {
  soft: {
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
  punchy: {
    intensity: 62,
    sensitivity: 70,
    smoothing: 48,
    band: 'all',
    dimensions: {
      scale: true,
      blur: true,
      brightness: true,
      saturate: true,
      drift: true,
    },
  },
  beatOnly: {
    intensity: 52,
    sensitivity: 82,
    smoothing: 32,
    band: 'bass',
    dimensions: {
      scale: true,
      blur: false,
      brightness: false,
      saturate: false,
      drift: false,
    },
  },
  breathe: {
    intensity: 26,
    sensitivity: 34,
    smoothing: 92,
    band: 'mid',
    dimensions: {
      scale: false,
      blur: true,
      brightness: true,
      saturate: false,
      drift: true,
    },
  },
};

export const DEFAULT_REACTIVE_CONFIG = Object.assign(
  { preset: 'soft' },
  REACTIVE_PRESETS.soft
);

const DIMENSION_KEYS = ['scale', 'blur', 'brightness', 'saturate', 'drift'];
const BANDS = ['bass', 'mid', 'treble', 'all'];

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

// 去掉 toFixed 留下的尾随 0：1.0000 → "1"，1.0600 → "1.06"。
// 让 CSS 变量在「无变化」时保持字符串稳定，避免无意义的重绘。
function num(value, digits) {
  const fixed = value.toFixed(digits);
  if (fixed.indexOf('.') === -1) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/** 把任意来源的配置补齐成完整、合法的配置。 */
export function normalizeReactiveConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const dims =
    src.dimensions && typeof src.dimensions === 'object' ? src.dimensions : {};
  // 老版本用 dimensions.hue 控制 hue-rotate，这个维度已经整链路删除。
  // 直接丢掉会让老用户「关掉色相」的偏好变成默认开启视差，所以用它来补 drift：
  // 老配置 hue:false 迁移后就是「不视差」，观感与它原来「不换色」的克制程度一致。
  const driftSource =
    dims.drift === undefined && dims.hue !== undefined ? dims.hue : dims.drift;
  const dimensions = {};
  DIMENSION_KEYS.forEach(key => {
    const value = key === 'drift' ? driftSource : dims[key];
    dimensions[key] =
      value === undefined
        ? DEFAULT_REACTIVE_CONFIG.dimensions[key]
        : Boolean(value);
  });
  return {
    preset: typeof src.preset === 'string' ? src.preset : 'custom',
    intensity: clamp(Number(src.intensity), 0, 100),
    sensitivity: clamp(Number(src.sensitivity), 0, 100),
    smoothing: clamp(Number(src.smoothing), 0, 100),
    band: BANDS.indexOf(src.band) >= 0 ? src.band : 'bass',
    dimensions,
  };
}

/** 用户手改任意一项后，预设名自动降级为 custom。 */
export function configsEqual(a, b) {
  if (!a || !b) return false;
  if (
    a.intensity !== b.intensity ||
    a.sensitivity !== b.sensitivity ||
    a.smoothing !== b.smoothing ||
    a.band !== b.band
  ) {
    return false;
  }
  return DIMENSION_KEYS.every(key => a.dimensions[key] === b.dimensions[key]);
}

/** 从当前配置反查匹配的预设名，匹配不上返回 'custom'。 */
export function detectPreset(config) {
  const normalized = normalizeReactiveConfig(config);
  const names = Object.keys(REACTIVE_PRESETS);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (
      configsEqual(normalized, normalizeReactiveConfig(REACTIVE_PRESETS[name]))
    ) {
      return name;
    }
  }
  return 'custom';
}

function smoothingToConstant(smoothing) {
  return 0.5 + (clamp(smoothing, 0, 100) / 100) * 0.45; // 0.5 ~ 0.95
}

function avgBins(data, from, to) {
  const end = Math.min(to, data.length);
  if (end <= from) return 0;
  let sum = 0;
  for (let i = from; i < end; i++) sum += data[i];
  return sum / (end - from);
}

/** 当前环境有没有 Web Audio。 */
export function supportsReactive() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.AudioContext || window.webkitAudioContext);
}

// ---------------------------------------------------------------------------
// Analyser 生命周期
// ---------------------------------------------------------------------------

let analyser = null;
let freqData = null;
let config = normalizeReactiveConfig(DEFAULT_REACTIVE_CONFIG);
let beatDetector = null;
let pulse = 0;
// 非对称包络后的归一化能量（0~1）。放在模块级而不是每帧局部变量，
// 否则「释放慢」就没有跨帧记忆可言了。
let smoothLevel = 0;
let lastFrame = {
  bass: 0,
  mid: 0,
  treble: 0,
  energy: 0,
  level: 0,
  smooth: 0,
  beat: false,
  pulse: 0,
};
const subscribers = new Set();
let rafId = null;
let lastSampleAt = 0;

/**
 * 确保 analyser 已接入。Howler 的 AudioContext 是懒创建的，首次播歌之前
 * `Howler.ctx` 可能是 undefined，此时返回 null，调用方下帧再试即可。
 */
export function ensureAnalyser() {
  if (analyser) return analyser;
  if (!supportsReactive()) return null;

  const ctx = Howler.ctx;
  const masterGain = Howler.masterGain;
  if (!ctx || !masterGain) return null;

  try {
    const node = ctx.createAnalyser();
    node.fftSize = FFT_SIZE;
    node.smoothingTimeConstant = smoothingToConstant(config.smoothing);
    // 只做「旁路监听」：masterGain 已经连到 destination，这里再连一个 analyser
    // 不会产生第二路声音（AnalyserNode 不输出到硬件）。反过来如果 analyser
    // 自己连 destination，就会听到两遍。
    masterGain.connect(node);
    analyser = node;
    freqData = new Uint8Array(node.frequencyBinCount);
    beatDetector = createBeatDetector(BEAT_FRAMES);
    return analyser;
  } catch (e) {
    // 某些环境下 createAnalyser 会抛（上下文已关闭等），降级即可。
    analyser = null;
    freqData = null;
    return null;
  }
}

/**
 * 把 analyser 重新挂回 Howler.masterGain。
 *
 * `masterGain.disconnect()` 会一次性断掉它的**所有**出边（destination 和
 * analyser 这一路都在内），所以每次改接输出路由之后都必须调一次这里。
 * 同一对节点重复 connect 在 Web Audio 规范里是幂等的，不会叠出第二条支路。
 */
export function rewireAnalyser() {
  if (!analyser) return;
  const masterGain = Howler.masterGain;
  if (!masterGain) return;
  try {
    masterGain.connect(analyser);
  } catch (e) {
    /* 已断开或上下文已关闭，忽略 */
  }
}

/** 断开并释放 analyser。rAF 循环全部退出后调用。 */
export function releaseAnalyser() {
  if (analyser) {
    try {
      analyser.disconnect();
    } catch (e) {
      /* 已断开，忽略 */
    }
  }
  analyser = null;
  freqData = null;
  beatDetector = null;
  pulse = 0;
  smoothLevel = 0;
}

/** 读取一次频段能量。读不到返回 null。 */
export function readBands() {
  if (!analyser || !freqData) return null;
  analyser.getByteFrequencyData(freqData);
  const bass = avgBins(freqData, BAND_BASS[0], BAND_BASS[1]);
  const mid = avgBins(freqData, BAND_MID[0], BAND_MID[1]);
  const treble = avgBins(freqData, BAND_TREBLE[0], BAND_TREBLE[1]);
  return {
    bass,
    mid,
    treble,
    energy: (bass * 1.4 + mid + treble * 0.6) / 3,
  };
}

/**
 * 节拍检测器。
 * 当前值超过最近 BEAT_FRAMES 帧移动平均的 (1 + (100-灵敏度)/200) 倍时算一拍。
 * 灵敏度 0 → 阈值 1.5（迟钝），灵敏度 100 → 阈值 1.0（灵敏）。
 */
export function createBeatDetector(windowFrames) {
  const size = Math.max(2, windowFrames || BEAT_FRAMES);
  const history = [];
  return {
    push(value, sensitivity) {
      history.push(value);
      if (history.length > size) history.shift();
      if (history.length < 4) return false;
      let sum = 0;
      for (let i = 0; i < history.length; i++) sum += history[i];
      const mean = sum / history.length;
      if (mean <= 0) return false;
      const threshold = 1 + (100 - clamp(sensitivity, 0, 100)) / 200;
      return value > mean * threshold && value > MIN_BEAT_LEVEL;
    },
    reset() {
      history.length = 0;
    },
    size() {
      return history.length;
    },
  };
}

function pickLevel(bands, band) {
  if (band === 'mid') return bands.mid;
  if (band === 'treble') return bands.treble;
  if (band === 'all') return bands.energy;
  return bands.bass;
}

/**
 * 纯函数：把一帧分析结果映射成 CSS 自定义属性。
 * 单独抽出来是为了可测（tests/ 里有对应用例），也方便设置页预览复用。
 *
 * 变量契约（视觉层照此消费，名字和单位都不要改）：
 *   --react-scale       1 ~ 1.052     无单位
 *   --react-blur        50px ~ 30px   能量越高越清晰（聚焦感），不是越大越糊
 *   --react-brightness  1 ~ 1.06      无单位
 *   --react-saturate    1 ~ 1.10      无单位
 *   --react-drift       0px ~ 26px    位移幅度，方向由 CSS 按层决定
 *   --react-glow        0.06 ~ 0.32   辉光层 opacity。**地板是 0.06 而不是 0**：
 *                                     律动开着时中心永远有一层极淡的白，CSS 侧
 *                                     不能假设它能淡到全透明（深色主题下那层白
 *                                     本身的 alpha 要压住，否则会像蒙雾）
 *   --react-pulse       0 ~ 1         节拍脉冲
 *
 * 只输出会被 transform / filter / opacity 消费的属性，不碰 width / margin / top
 * 这类会触发重排的键。
 */
export function mapFrameToVars(frame, cfg) {
  const c = normalizeReactiveConfig(cfg);
  const dims = c.dimensions;
  // 优先用非对称包络后的 smooth；没有时（外部只传了 level 的调用方、测试）
  // 回退到瞬时能量，保证这个函数单独使用时行为仍然可预测。
  const hasSmooth = frame && typeof frame.smooth === 'number';
  const rawAmp = hasSmooth ? frame.smooth : ((frame && frame.level) || 0) / 255;
  const amp = clamp(rawAmp, 0, 1);
  const power = c.intensity / 100;
  const pulseValue = clamp((frame && frame.pulse) || 0, 0, 1);
  const vars = {};

  vars['--react-scale'] = dims.scale
    ? num(1 + amp * power * 0.04 + pulseValue * power * 0.012, 4)
    : '1';
  // 反向：能量越高 blur 越小。满功率时 50px → 30px。
  // 这 20px 不只是「清晰度」，它同时是视差能被看见的前提：blur 降到 46px 以下
  // 边缘才重新出现，drift 才有可追踪的对象；blur 不动时再怎么加大位移，
  // 看到的也只是「一片糊移动得更大」。
  // 真实音乐里非对称包络的 amp 典型值只有 0.6~0.8，所以 K 必须按「典型值也有
  // 7~9px 变化」来定；K=12 时典型值只有 4~5px，等于只把「完全不可见」改成
  // 「几乎不可见」。
  vars['--react-blur'] = dims.blur
    ? num(BASE_BLUR - amp * power * 20, 1) + 'px'
    : BASE_BLUR + 'px';
  vars['--react-brightness'] = dims.brightness
    ? num(1 + amp * power * 0.06, 3)
    : '1';
  vars['--react-saturate'] = dims.saturate
    ? num(1 + amp * power * 0.1, 3)
    : '1';
  // 26px 而不是 10px：两层反向视差的相对位移只有 1.7 倍差，绝对值太小的话
  // 在 50px 模糊底图上完全读不出来（默认档曾是 3.4px，用户反馈「几乎没用」）。
  vars['--react-drift'] = dims.drift ? num(amp * power * 26, 1) + 'px' : '0px';
  // 辉光不受 dimensions 控制：它只是一层极淡的白光，永远保持很轻，
  // 不参与「关掉某个维度」的取舍，否则关掉 blur 后画面会完全没有生命感。
  vars['--react-glow'] = num(
    clamp(0.06 + pulseValue * 0.2 + amp * 0.06, 0, 0.32),
    3
  );
  vars['--react-pulse'] = num(pulseValue, 3);

  return vars;
}

/** 更新配置。平滑度会立刻作用到 analyser 上。 */
export function setReactiveConfig(next) {
  config = normalizeReactiveConfig(next);
  if (analyser) {
    analyser.smoothingTimeConstant = smoothingToConstant(config.smoothing);
  }
}

export function getReactiveConfig() {
  return config;
}

export function getLastFrame() {
  return lastFrame;
}

function sampleFrame() {
  if (!ensureAnalyser()) return null;
  const bands = readBands();
  if (!bands) return null;

  const level = pickLevel(bands, config.band);
  const beat = beatDetector
    ? beatDetector.push(level, config.sensitivity)
    : false;
  pulse = beat ? 1 : pulse * PULSE_DECAY;

  // 非对称包络：起音跟得快、回落得慢。
  const target = clamp(level / 255, 0, 1);
  const k = target > smoothLevel ? ATTACK : RELEASE;
  smoothLevel += (target - smoothLevel) * k;

  lastFrame = {
    bass: bands.bass,
    mid: bands.mid,
    treble: bands.treble,
    energy: bands.energy,
    level,
    smooth: smoothLevel,
    beat,
    pulse,
  };
  return lastFrame;
}

function tick(now) {
  rafId = window.requestAnimationFrame(tick);
  if (now - lastSampleAt < FRAME_INTERVAL) return;
  lastSampleAt = now;

  const frame = sampleFrame();
  if (!frame) return;

  // 复制一份再遍历：订阅者回调里可能会退订，直接遍历 Set 会跳项。
  Array.from(subscribers).forEach(fn => {
    try {
      fn(frame);
    } catch (e) {
      // 单个订阅者出错不能拖垮整个循环
      console.warn('[audioAnalyser] subscriber error', e);
    }
  });
}

function startLoop() {
  if (rafId !== null) return;
  if (typeof window === 'undefined') return;
  lastSampleAt = 0;
  rafId = window.requestAnimationFrame(tick);
}

function stopLoop() {
  if (rafId === null) return;
  window.cancelAnimationFrame(rafId);
  rafId = null;
}

/**
 * 订阅每一帧的分析结果。返回退订函数。
 * 有订阅者时启动 rAF 循环，最后一个订阅者退订时立刻停掉并释放 analyser——
 * 这样「关掉律动后 rAF 完全停止」是可以被 Performance 面板验证的。
 */
export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  subscribers.add(fn);
  startLoop();
  return function unsubscribe() {
    subscribers.delete(fn);
    if (subscribers.size === 0) {
      stopLoop();
      releaseAnalyser();
    }
  };
}

export function subscriberCount() {
  return subscribers.size;
}

/** 测试用：把内部状态清干净。 */
export function __resetForTests() {
  subscribers.clear();
  stopLoop();
  releaseAnalyser();
  config = normalizeReactiveConfig(DEFAULT_REACTIVE_CONFIG);
  smoothLevel = 0;
  lastFrame = {
    bass: 0,
    mid: 0,
    treble: 0,
    energy: 0,
    level: 0,
    smooth: 0,
    beat: false,
    pulse: 0,
  };
}
