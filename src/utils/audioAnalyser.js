// 音频分析层：把 AnalyserNode 挂到 Howler 的主增益节点上，读取频段能量，
// 并做节拍检测。供歌词页背景（lyrics.vue）和设置页预览（ReactivePreview.vue）共用。
//
// 三个必须守住的点：
// 1. analyser 只从 masterGain 取信号，**绝不**再接 destination，否则声音会放两遍。
// 2. 频谱读不到时（跨域音源 / 解码失败 / 上下文被挂起）必须能被上层识别出来，
//    降级成静态背景，而不是显示一个「假装在动」的背景。
// 3. 整个模块不进 Vuex、不进组件 data。每帧只写 CSS 自定义属性，避免整页重渲染。

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
const SILENT_FRAME_LIMIT = 60; // 连续 2 秒全 0 才认定「读不到频谱」
const MIN_BEAT_LEVEL = 70; // 绝对门限，防止安静段落里的噪声被当成鼓点
const PULSE_DECAY = 0.86; // 每帧衰减，半衰期约 0.15s
const BASE_BLUR = 50; // 与 lyrics.vue 里 .lyrics-background 的 blur(50px) 对齐

export const REACTIVE_PRESETS = {
  soft: {
    intensity: 40,
    sensitivity: 50,
    smoothing: 70,
    band: 'bass',
    dimensions: {
      scale: true,
      blur: true,
      brightness: false,
      hue: false,
      saturate: false,
    },
  },
  punchy: {
    intensity: 85,
    sensitivity: 65,
    smoothing: 55,
    band: 'all',
    dimensions: {
      scale: true,
      blur: true,
      brightness: true,
      hue: true,
      saturate: true,
    },
  },
  beatOnly: {
    intensity: 70,
    sensitivity: 80,
    smoothing: 30,
    band: 'bass',
    dimensions: {
      scale: true,
      blur: false,
      brightness: false,
      hue: false,
      saturate: false,
    },
  },
  breathe: {
    intensity: 30,
    sensitivity: 35,
    smoothing: 90,
    band: 'mid',
    dimensions: {
      scale: false,
      blur: true,
      brightness: true,
      hue: false,
      saturate: false,
    },
  },
};

export const DEFAULT_REACTIVE_CONFIG = Object.assign(
  { preset: 'soft' },
  REACTIVE_PRESETS.soft
);

const DIMENSION_KEYS = ['scale', 'blur', 'brightness', 'hue', 'saturate'];
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
  const dimensions = {};
  DIMENSION_KEYS.forEach(key => {
    dimensions[key] =
      dims[key] === undefined
        ? DEFAULT_REACTIVE_CONFIG.dimensions[key]
        : Boolean(dims[key]);
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
let silentFrames = 0;
let degraded = false;
let pulse = 0;
let lastFrame = {
  bass: 0,
  mid: 0,
  treble: 0,
  energy: 0,
  level: 0,
  beat: false,
  pulse: 0,
  degraded: false,
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
    silentFrames = 0;
    return analyser;
  } catch (e) {
    // 某些环境下 createAnalyser 会抛（上下文已关闭等），降级即可。
    analyser = null;
    freqData = null;
    return null;
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
  silentFrames = 0;
  degraded = false;
  pulse = 0;
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
 * 只输出会被 transform / filter 消费的属性，不碰 width / margin / top
 * 这类会触发重排的键。
 */
export function mapFrameToVars(frame, cfg) {
  const c = normalizeReactiveConfig(cfg);
  const dims = c.dimensions;
  const amp = clamp((frame && frame.level) / 255, 0, 1);
  const power = c.intensity / 100;
  const pulseValue = clamp((frame && frame.pulse) || 0, 0, 1);
  const vars = {};

  if (dims.scale) {
    const scale = 1 + amp * power * 0.14 + pulseValue * power * 0.06;
    vars['--react-scale'] = num(scale, 4);
  } else {
    vars['--react-scale'] = '1';
  }

  if (dims.blur) {
    vars['--react-blur'] = num(BASE_BLUR + amp * power * 10, 1) + 'px';
  } else {
    vars['--react-blur'] = BASE_BLUR + 'px';
  }

  vars['--react-brightness'] = dims.brightness
    ? num(1 + amp * power * 0.35, 3)
    : '1';
  vars['--react-saturate'] = dims.saturate
    ? num(1 + amp * power * 0.6, 3)
    : '1';
  vars['--react-hue'] = dims.hue ? num(amp * power * 18, 2) + 'deg' : '0deg';
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

/** 频谱是否已经确认读不到（连续 2 秒全 0）。 */
export function isDegraded() {
  return degraded;
}

function sampleFrame() {
  if (!ensureAnalyser()) return null;
  const bands = readBands();
  if (!bands) return null;

  const level = pickLevel(bands, config.band);
  const silent = bands.bass === 0 && bands.mid === 0 && bands.treble === 0;
  if (silent) {
    silentFrames++;
    if (silentFrames > SILENT_FRAME_LIMIT) degraded = true;
  } else {
    silentFrames = 0;
    degraded = false;
  }

  const beat = beatDetector
    ? beatDetector.push(level, config.sensitivity)
    : false;
  pulse = beat ? 1 : pulse * PULSE_DECAY;

  lastFrame = {
    bass: bands.bass,
    mid: bands.mid,
    treble: bands.treble,
    energy: bands.energy,
    level,
    beat,
    pulse,
    degraded,
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
  lastFrame = {
    bass: 0,
    mid: 0,
    treble: 0,
    energy: 0,
    level: 0,
    beat: false,
    pulse: 0,
    degraded: false,
  };
}
