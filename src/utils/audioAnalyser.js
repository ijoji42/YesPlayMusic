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
// 5. **绝对电平不能直接当幅度用**。真实音乐（尤其是流行乐）的 bass bin 均值
//    常年 228~240，`level / 255` 归一化出来就是 0.9 以上，所有维度被钉在
//    映射上限，肉眼看就是「律动完全没作用」。所以这里先过一层自适应增益
//    （AGC）：用缓慢跟随的 min/max 把当前曲目自己的动态范围拉满，再送进
//    包络和映射。三个分频段各有一条独立 AGC，因为 treble 的绝对电平比
//    bass 低一个数量级。
// 6. **节拍必须从原始频谱的「上升沿」里找，不能从 AGC 之后的能量里找**。
//    能量类信号是慢变量：AGC 的回落系数只有 0.0008~0.15，非对称包络的
//    释放系数 0.13，两者叠加之后，一个鼓点在数据上就是一段几十毫秒的
//    缓坡。在缓坡上做阈值比较，检出来的「拍」自然没有鼓点的位置感，
//    观感就是缓慢呼吸而不是跟着节奏跳。现在改成频谱通量（spectral flux）
//    onset 检测：直接拿 analyser 的原始 byte 频谱，逐 bin 累加**正向**差分，
//    用 ~1s 滑动窗口的 mean + k·std 做自适应阈值，配 refractory 窗口和
//    快攻慢放包络。详见 createOnsetDetector() 的注释。

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
const BASE_BLUR = 50; // 与 lyrics.vue 里 .lyrics-background 的 blur(50px) 对齐

// ---------------------------------------------------------------------------
// 频谱通量（spectral flux）onset 检测的参数
//
// 为什么是这五个数：
//
// bins = 80：fftSize 256 → 128 个 bin，每 bin ≈ 172Hz（44.1kHz）。前 80 个
//   bin 覆盖到 ~13.8kHz，鼓点（60~250Hz 的底鼓、2~5kHz 的军鼓/拍手）的能量
//   全部落在里面，而最上面的 bin 基本只有噪声。取全部 128 个 bin 会把高频
//   噪声也计入通量，信噪比反而下降。**不做 A 计权/对数压缩**：byte 频谱本身
//   已经是 dB 刻度线性映射过的值，再压缩一次会把弱拍的上升沿压没。
//
// windowMs = 1000：自适应阈值的 mean/std 用 1s 滑动窗口。窗口太短（<0.3s）
//   会把上一拍当成「常态」，下一拍就检不出来；太长（>3s）跟不上段落切换
//   （主歌进副歌、鼓组整体抬升）。1s 大约覆盖 2 拍（120BPM），恰好是
//   「这一拍的背景」这个语义。
//
// k = 1.4（默认 sensitivity 55 时）：阈值 = mean + 1.4·std。这是 onset
//   检测里最常用的经验值（Bello 等人的经典做法是 mean + δ，δ 取 1~2 倍
//   标准差）。1.0 会开始把军鼓的余震当新 onset，2.0 会漏掉弱拍。
//   sensitivity 滑杆映射到 k：2.0（最迟钝）~ 0.8（最灵敏），见 onsetK()。
//
// refractoryMs = 110：不定期窗口。一个底鼓的能量包络在频谱上会持续 3~5 帧
//   （30fps 下 100~160ms）都保持「比前一帧高」，没有 refractory 的话一次
//   鼓点会连触发 3~4 次，pulse 被反复拉回 1，看上去就是「一直亮着」。
//   110ms 同时保证 8 分音符（120BPM 下 250ms）不会被吞掉。
//
// releaseMs = 125：包络每帧乘 exp(-dt/release)。125ms 是「一拍一闪」的
//   量级：100ms 后剩 0.45，300ms 后剩 0.08，视觉上是一次干净的闪烁而不是
//   拖尾。原本打算用 170ms（听感更柔），但 170ms 在 300ms 处还剩 0.17，
//   律动看起来仍然偏「呼吸」，且通不过「300ms 时 env < 0.1」这条验收线。
// ---------------------------------------------------------------------------
const ONSET_BINS = 80;
const ONSET_WINDOW_MS = 1000;
const ONSET_REFRACTORY_MS = 110;
const ONSET_RELEASE_MS = 125;
// 绝对门限：全静音时 mean=std=0，阈值退化成 0，任何 1 个 LSB 的抖动都会被
// 当成鼓点。80 个 bin 上平均每 bin 差 0.5，正好挡掉量化噪声。
const ONSET_MIN_FLUX = 40;
// 窗口还没填满时 mean/std 没有统计意义（3 个样本的 std 可以任意大或任意小），
// 先攒 8 帧（30fps 下 ~270ms）再开始判定。起播时最多晚 0.27s 出第一拍。
const ONSET_MIN_HISTORY = 8;
// 通量至少要达到「最近 1s 平均通量」的 1.6 倍才算 onset。这一项专门用来
// 压掉白噪/嘶声/弦乐群这类**持续**高波动的信号：它们的 std 很大，
// 光靠 mean + k·std 会有一成左右的帧越过阈值。鼓点是稀疏尖峰，mean 远低于
// 峰值（120BPM、每秒 2 击时 mean ≈ 峰值的 1/15），所以对鼓点几乎无影响。
const ONSET_JUMP = 1.6;
// ---------------------------------------------------------------------------
// 自适应增益（AGC）
//
// 直接用 level/255 会把真实音乐压死：流行乐的 bass bin 均值常年 228~240，
// 归一化后 amp 稳定在 0.9 以上，被钉在映射上限，视觉上就是「纹丝不动」。
// 这里用一条缓慢跟随的 min/max 把**当前曲目自己的动态范围**拉满。
//
// 四个系数是刻意不对称的：
//   max 快速上跟（0.35）——1~2 帧贴上新峰值，鼓点不会被吃掉；
//   max 极慢回落（0.0008）——安静段不会把基准拉低，下一拍不会「爆」；
//   min 快速下跟（0.15）——咬住谷底，但**不能太快**（见下）；
//   min 慢速上移（0.03）——约 1.5s 恢复，既能跟上段落变化，又不会把基准整体抬起来。
//
// min 的两个系数是拿真实曲目逐帧数据标定出来的，不是拍脑袋：
// 《起风了》的 bass 逐帧值 95% 落在 200~250（均值 222），偶尔有 177 的谷和
// 起播瞬间的 0。如果 min 用 0.5 下跟、0.0005 上移（初版取值），单个异常帧就会
// 把 min 钉在 0 附近且再也回不来 —— 实测 min≈169、span≈55，于是 222 的常态帧
// 归一化出 0.9，整首歌仍然是一条直线（blur 只有 2.5px 变化，pulse 10 秒只跳 1 次）。
// 改成 0.15/0.03 之后 min 稳定在 222、span 落到 24 的 floor 上，常态帧回到 0~0.8，
// 同一段音频的 blur 动态范围从 2.5px 变成 9.8px（逐帧实测）。max 的两个系数实测无影响，保持不动。
// ---------------------------------------------------------------------------
const AGC_FLOOR_SPAN = 24; // 最小跨度：恒定信号不会被放大成满幅噪声闪烁
const AGC_MAX_RISE = 0.35;
const AGC_MAX_FALL = 0.0008;
const AGC_MIN_FALL = 0.15;
const AGC_MIN_RISE = 0.03;
const AGC_SILENCE = 12; // 绝对静音门限：低于它的帧不参与基准，也不输出能量
const AGC_GAMMA = 0.75; // 提升中间段，避免只在峰值附近才有变化
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

/**
 * 用户设置的「平滑度」→ AnalyserNode.smoothingTimeConstant。
 *
 * 旧映射是 0.5 ~ 0.95，对应时间常数 2~20 帧。0.8（默认预设落在这里）意味着
 * 每帧频谱 = 0.8·上一帧 + 0.2·当前帧，一个 1 帧宽的鼓点上升沿会被摊成
 * 5 帧的缓坡 —— 那正是「律动不跟节奏」的直接来源。
 *
 * 现在整条映射压到 0.12 ~ 0.45：
 *   - 上限 0.45 是硬上限（调用点还有一次 Math.min 兜底）。再高就会把
 *     频谱通量里最有信息量的那一段上升沿抹平，onset 检测只能看到斜坡，
 *     每帧都有一点正向差，既检不准位置也更容易误触发。
 *   - 下限保留 0.12，不直接给 0：完全不平滑的 byte 频谱逐 bin 抖动很大，
 *     flux 会带上明显的噪声底，弱拍反而更难和噪声区分。
 * 滑杆依然有效（0.12~0.45 是能看出差别的一段），只是不再允许它把瞬态抹掉。
 */
function smoothingToConstant(smoothing) {
  return 0.12 + (clamp(smoothing, 0, 100) / 100) * 0.33; // 0.12 ~ 0.45
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
// 实时链路只用 onsetDetector。旧的 createBeatDetector 仍作为公开 API 保留
// （测试和外部调用方在用），但不再参与每一帧的判定 —— 见它的注释。
let onsetDetector = null;
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
  amp: 0,
  agc: { min: 0, max: 0, span: 0 },
  smooth: 0,
  beat: false,
  pulse: 0,
  flux: 0,
  onsetThreshold: 0,
  bassAmp: 0,
  midAmp: 0,
  trebleAmp: 0,
};
// 四条独立的 AGC：level（被选中那条频段的能量，决定 amp/pulse）加三个分频段。
// 分频段必须各用一条：treble 的绝对电平（13~59）比 bass（208~246）低一个数量级，
// 共用一条 AGC 会把 treble 归一化成 0。
const agcLevel = createAgcTracker();
const agcBands = {
  bass: createAgcTracker(),
  mid: createAgcTracker(),
  treble: createAgcTracker(),
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
    node.smoothingTimeConstant = Math.min(
      0.45,
      smoothingToConstant(config.smoothing)
    );
    // 只做「旁路监听」：masterGain 已经连到 destination，这里再连一个 analyser
    // 不会产生第二路声音（AnalyserNode 不输出到硬件）。反过来如果 analyser
    // 自己连 destination，就会听到两遍。
    masterGain.connect(node);
    analyser = node;
    freqData = new Uint8Array(node.frequencyBinCount);
    onsetDetector = createOnsetDetector();
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
  onsetDetector = null;
  pulse = 0;
  smoothLevel = 0;
  resetAgc();
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
 * 旧的「电平阈值」节拍检测器。
 *
 * **已经不在实时链路上了** —— sampleFrame() 现在走 createOnsetDetector()。
 * 保留它是因为它仍是公开导出（测试和外部调用方在用），而且它的返回值语义
 * （true 表示这一帧算一拍）本身没变。之所以被替换：它比较的是 AGC 归一化
 * 之后的能量，而那条信号经过 AGC 和非对称包络两级低通，鼓点的上升沿早已
 * 被摊成缓坡，检出来的拍位置偏后、边界模糊。
 *
 * 当前值超过最近 BEAT_FRAMES 帧移动平均 **加上一个与 AGC 跨度成比例的增量**
 * 时算一拍。
 *
 * 这里刻意不用乘性阈值（`value > mean * 1.22`）：真实音乐里 mean 能到 232，
 * 乘性阈值就是 284，而 level 上限只有 255 —— 永远不可能触发，pulse 会一直是 0，
 * --react-glow 也就丢掉它最主要的那一项动态。改成加性阈值之后，阈值随信号
 * 自身的动态范围（span）缩放，高电平段落同样能检测到鼓点。
 *
 * 灵敏度语义不变：sensitivity 越高 → need 越小 → 越容易触发。
 * 原 MIN_BEAT_LEVEL（绝对门限）的防误触发作用由 need >= 4 承担 ——
 * 绝对刻度在 AGC 之后已经没有意义。
 */
export function createBeatDetector(windowFrames) {
  const size = Math.max(2, windowFrames || BEAT_FRAMES);
  const history = [];
  return {
    push(value, sensitivity, span) {
      history.push(value);
      if (history.length > size) history.shift();
      if (history.length < 4) return false;
      let sum = 0;
      for (let i = 0; i < history.length; i++) sum += history[i];
      const mean = sum / history.length;
      if (mean <= 0) return false;
      const s = clamp(sensitivity, 0, 100);
      const scale = Math.max(AGC_FLOOR_SPAN, span || AGC_FLOOR_SPAN);
      const need = Math.max(4, scale * (0.16 + ((100 - s) / 100) * 0.26));
      return value > mean + need;
    },
    reset() {
      history.length = 0;
    },
    size() {
      return history.length;
    },
  };
}

/**
 * 频谱通量（spectral flux）onset 检测器 —— 律动现在的节拍来源。
 *
 * 输入是 analyser 的**原始 byte 频谱**（`getByteFrequencyData` 的 Uint8Array），
 * 输出是「这一帧是不是一个鼓点」加一条快攻慢放的包络。
 *
 * 算法（业界标准做法，刻意没有自创变体）：
 *   1. flux = Σ max(0, cur[i] - prev[i])，只累加**正向**差分。
 *      音量下降（cur < prev）不计入，所以「一整段变小声」不会产生通量，
 *      只有「能量突然变多」才会 —— 这正是打击乐器的物理特征。
 *   2. 阈值 = mean + k·std，mean/std 取自过去 1s 的通量滑动窗口
 *      （**不含当前帧**，否则当前帧会把阈值抬高，越强的拍越检不出来）。
 *      自适应阈值的意义：安静段落的弱拍和副歌的强拍用同一套参数就能都检到，
 *      不需要为每首歌调增益。
 *   3. refractory：距上一次 onset 不足 110ms 一律忽略。一个鼓点的频谱
 *      上升沿会持续好几帧，没有这个窗口的话一次鼓点会连触发 3~4 次。
 *   4. 包络：onset 时 env = 1，之后每帧 env *= exp(-dt/release)。
 *      用 exp(-dt/τ) 而不是固定系数，是因为 rAF 的 dt 不是恒定的
 *      （掉帧、切后台），按真实时间衰减才能保证 125ms 的释放时长不变。
 *
 * 为什么不用 AGC 之后的能量：那条信号经过 AGC（max 回落 0.0008、min 上移
 * 0.03）和非对称包络（release 0.13）两级低通，时间常数在几十到几百毫秒，
 * 鼓点早就被摊成缓坡了。通量检测必须跑在平滑链路之前。
 *
 * 全部状态都在闭包内，`push()` 的返回值也是纯数据，测试可以直接喂合成频谱
 * 驱动它（见 tests/audio-analyser.test.js），不需要 AudioContext。
 *
 * @param {object} [options]
 * @param {number} [options.bins=80]          参与通量计算的 bin 数量（从头开始）
 * @param {number} [options.windowMs=1000]    自适应阈值的滑动窗口
 * @param {number} [options.refractoryMs=110] 不定期窗口
 * @param {number} [options.releaseMs=125]    包络释放时间常数
 * @param {number} [options.minFlux=40]       通量绝对门限
 */
export function createOnsetDetector(options) {
  const opts = options || {};
  const bins = Math.max(1, Math.round(opts.bins || ONSET_BINS));
  const windowMs = Math.max(1, opts.windowMs || ONSET_WINDOW_MS);
  const refractoryMs = Math.max(
    0,
    opts.refractoryMs === undefined ? ONSET_REFRACTORY_MS : opts.refractoryMs
  );
  const releaseMs = Math.max(1, opts.releaseMs || ONSET_RELEASE_MS);
  const minFlux = opts.minFlux === undefined ? ONSET_MIN_FLUX : opts.minFlux;

  let prev = null;
  let env = 0;
  let clock = 0; // 内部时钟（ms），按每帧 dt 累加
  let lastOnsetAt = -Infinity;
  // 通量滑动窗口。存 {t, flux} 而不是定长数组，是因为 dt 会变，
  // 「最近 1s」只能按时间筛，不能按帧数筛。
  const history = [];

  function trimHistory() {
    const floor = clock - windowMs;
    while (history.length > 0 && history[0].t <= floor) history.shift();
  }

  function meanAndStd() {
    const n = history.length;
    if (n === 0) return { mean: 0, std: 0 };
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += history[i].flux;
    const mean = sum / n;
    let variance = 0;
    for (let i = 0; i < n; i += 1) {
      const d = history[i].flux - mean;
      variance += d * d;
    }
    return { mean, std: Math.sqrt(variance / n) };
  }

  return {
    /**
     * 推进一帧。
     * @param {Uint8Array|number[]|null} spectrum 当前帧的 byte 频谱
     * @param {object} [frameOptions]
     * @param {number} [frameOptions.sensitivity=55] 0~100，越高越容易触发
     * @param {number} [frameOptions.dt] 距上一帧的毫秒数，默认 1/30s
     */
    push(spectrum, frameOptions) {
      const fo = frameOptions || {};
      const dt = clamp(Number(fo.dt) || FRAME_INTERVAL, 1, 500);
      const sensitivity =
        fo.sensitivity === undefined
          ? 55
          : clamp(Number(fo.sensitivity), 0, 100);
      clock += dt;
      // 先衰减再判定：onset 那一帧的 env 必须是干净的 1，不能被本帧的
      // 衰减先啃掉一口；反过来没有 onset 的帧必须照常衰减。
      env *= Math.exp(-dt / releaseMs);

      if (!spectrum || spectrum.length === 0) {
        // 读不到频谱（静音、跨域、上下文挂起）：丢掉上一帧频谱，
        // 否则恢复播放的第一帧会和一个「很久以前的频谱」做差分，
        // 凭空产生一个巨大的假 onset。
        prev = null;
        return { onset: false, flux: 0, threshold: 0, env, mean: 0, std: 0 };
      }

      const n = Math.min(bins, spectrum.length);
      if (!prev || prev.length !== n) {
        // 第一帧没有参照物，只能记下来，不能判定。
        prev = new Float32Array(n);
        for (let i = 0; i < n; i += 1) prev[i] = spectrum[i];
        return { onset: false, flux: 0, threshold: 0, env, mean: 0, std: 0 };
      }

      let flux = 0;
      for (let i = 0; i < n; i += 1) {
        const diff = spectrum[i] - prev[i];
        if (diff > 0) flux += diff;
        prev[i] = spectrum[i];
      }

      trimHistory();
      const { mean, std } = meanAndStd();
      const k = onsetK(sensitivity);
      // 三条并列取最大，缺一条都会出问题：
      //   minFlux            —— 挡住量化噪声（全静音时 mean=std=0，阈值为 0）
      //   mean + k·std       —— 统计意义：比「最近 1s 的常态波动」高出一截
      //   mean · 1.6         —— 相对跳变：白噪/嘶声这类**连续**高波动信号
      //                         的 std 很大，单靠 k·std 会有一成左右的帧
      //                         越过阈值（实测：σ=6 的噪声 22 帧里误触发 2 次）。
      //                         真实鼓点的通量是稀疏尖峰，mean 远低于峰值，
      //                         所以这一项对鼓点几乎没有影响。
      const threshold = Math.max(minFlux, mean + k * std, mean * ONSET_JUMP);

      // 四个条件缺一不可：窗口攒够样本、通量过绝对门限、超过自适应阈值、
      // 不在 refractory 窗口内。
      const onset =
        history.length >= ONSET_MIN_HISTORY &&
        flux >= minFlux &&
        flux > threshold &&
        clock - lastOnsetAt >= refractoryMs;

      if (onset) {
        lastOnsetAt = clock;
        env = 1;
      }
      // 无论是否触发都要入窗：否则阈值永远学不到「这里平时有多少通量」。
      history.push({ t: clock, flux });

      return { onset, flux, threshold, env, mean, std };
    },
    reset() {
      prev = null;
      env = 0;
      clock = 0;
      lastOnsetAt = -Infinity;
      history.length = 0;
    },
    state() {
      return { env, fluxHistory: history.length, lastOnsetAt, clock };
    },
  };
}

/**
 * sensitivity（0~100）→ 自适应阈值的 k。
 * 2.0（最迟钝，只认明显的鼓点）~ 0.8（最灵敏，细碎的拍子也认）。
 * 默认预设 sensitivity 55 落在 1.34，也就是业界常用的 1~1.5 区间。
 */
function onsetK(sensitivity) {
  return 2 - (clamp(sensitivity, 0, 100) / 100) * 1.2;
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
 *   --react-scale       1 ~ 1.13      无单位
 *   --react-blur        50px ~ 20px   能量越高越清晰（聚焦感），不是越大越糊
 *   --react-brightness  0.82 ~ 1.12   乘数，不是增量
 *   --react-saturate    1 ~ 1.45      无单位
 *   --react-drift       0px ~ 72px    位移幅度，方向由 CSS 按层决定
 *   --react-glow        0.05 ~ 0.75   辉光层 opacity。**地板是 0.05 而不是 0**：
 *                                     律动开着时中心永远有一层极淡的白，CSS 侧
 *                                     不能假设它能淡到全透明（深色主题下那层白
 *                                     本身的 alpha 要压住，否则会像蒙雾）
 *   --react-pulse       0 ~ 1         节拍脉冲
 *   --react-bass        0 ~ 1         AGC 后的低频能量（**纯能量，未乘 intensity**）
 *   --react-mid         0 ~ 1         AGC 后的中频能量（同上）
 *   --react-treble      0 ~ 1         AGC 后的高频能量（同上）
 *   --react-power       0 ~ 1         intensity/100，供视觉层对不随 intensity
 *                                     变化的原始能量做统一缩放，例如
 *                                     calc(var(--react-bass) * var(--react-power))
 *
 * 区间按「AGC 之后 amp 真的能跑满 0~1」重新定过：旧的 20px/26px 区间是在
 * amp 被钉死在 0.9 的前提下调的，现在 amp 会真的摆动，同样的系数会显得过冲，
 * 但按旧值又完全看不出来 —— 所以整体放大，并新增三个分频段变量给视觉层用。
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
  // 分频段变量没传时回退到 amp：单独调用本函数的场景（测试、预览）
  // 只有一路能量，退化成同一个值比退化成 0 更可预测。
  const bandAmp = key => {
    const v = frame && frame[key];
    return typeof v === 'number' ? clamp(v, 0, 1) : amp;
  };
  const vars = {};

  // 权重重新分配：pulse（鼓点包络）现在是**主导项**，amp（慢能量）退成底噪。
  //
  // 旧配比是 amp 0.10 / pulse 0.03 —— 鼓点只贡献了 3% 的缩放，肉眼几乎看不见，
  // 用户看到的是 amp 驱动的缓慢起伏，于是有「没有跟着节奏走」的反馈。
  // 现在反过来：pulse 0.07 比 amp 0.06 还大一点，一次鼓点能在两帧内把背景
  // 「弹」一下，而 amp 只负责让整体基线随段落厚度缓慢变化。
  // 两者之和仍是 0.13，--react-scale 的 1~1.13 契约不变。
  vars['--react-scale'] = dims.scale
    ? num(1 + amp * power * 0.06 + pulseValue * power * 0.07, 4)
    : '1';
  // 反向：能量越高 blur 越小。满功率时 50px → 20px。
  // 这 30px 不只是「清晰度」，它同时是视差能被看见的前提：blur 降到 46px 以下
  // 边缘才重新出现，drift 才有可追踪的对象；blur 不动时再怎么加大位移，
  // 看到的也只是「一片糊移动得更大」。
  // amp 22 / pulse 8（合计仍是 30）：模糊是「聚焦感」，属于慢变量，鼓点只
  // 贡献很小的一点（8px）—— 给多了会在每次底鼓时闪一下，看起来像画面抖动。
  // 22 也刚好让默认预设（intensity 55，power=0.55）保住 12.1px 的行程下限。
  // 预设默认值不动 —— 改 soft.intensity 会让存量用户的 lyricsReactive 被判成
  // custom、设置页四个预设全灰。
  vars['--react-blur'] = dims.blur
    ? num(BASE_BLUR - (amp * 0.22 + pulseValue * 0.08) * power * 100, 1) + 'px'
    : BASE_BLUR + 'px';
  // 0.82 起步而不是 1：能量低时先压暗，给「亮起来」留出上行空间。
  // 亮度是「跳」最容易被感知的通道（人眼对亮度变化比对尺寸变化敏感得多），
  // 所以 pulse 在这里的权重（0.13）几乎追平 amp（0.17）。
  vars['--react-brightness'] = dims.brightness
    ? num(0.82 + (amp * 0.17 + pulseValue * 0.13) * power, 3)
    : '1';
  vars['--react-saturate'] = dims.saturate
    ? num(1 + (amp * 0.28 + pulseValue * 0.17) * power, 3)
    : '1';
  // 位移保持纯 amp 驱动：drift 是空间上的缓慢漂移，让它跟着每一拍抖会像
  // 画面在震，反而不像音乐。72px：在 50px 模糊底图上，位移小于 ~30px 基本读不出来。
  vars['--react-drift'] = dims.drift ? num(amp * power * 72, 1) + 'px' : '0px';
  // 辉光不受 dimensions 控制：它只是一层极淡的白光，永远保持很轻，
  // 不参与「关掉某个维度」的取舍，否则关掉 blur 后画面会完全没有生命感。
  // pulse 0.40 是这里最大的一项 —— 辉光是「这一拍打过来」最直接的表达，
  // amp 的 0.30 只负责段落之间的底噪差异。
  vars['--react-glow'] = num(
    clamp(0.05 + amp * 0.3 + pulseValue * 0.4, 0, 0.75),
    3
  );
  vars['--react-pulse'] = num(pulseValue, 3);
  vars['--react-bass'] = num(bandAmp('bassAmp'), 3);
  vars['--react-mid'] = num(bandAmp('midAmp'), 3);
  vars['--react-treble'] = num(bandAmp('trebleAmp'), 3);
  // 分频段变量是**纯能量**，不乘 intensity；视觉层用它统一缩放，
  // 否则用户在设置里拖「强度」滑杆时光斑 opacity 完全不响应。
  vars['--react-power'] = num(power, 2);

  return vars;
}

/** 更新配置。平滑度会立刻作用到 analyser 上。 */
export function setReactiveConfig(next) {
  config = normalizeReactiveConfig(next);
  if (analyser) {
    analyser.smoothingTimeConstant = Math.min(
      0.45,
      smoothingToConstant(config.smoothing)
    );
  }
}

export function getReactiveConfig() {
  return config;
}

export function getLastFrame() {
  return lastFrame;
}

/**
 * 推进一条 AGC 的 min/max，返回当前跨度。
 *
 * 首次采样直接用当前值当谷底、并给一个 floor 跨度的峰顶：这样恒定信号
 * 归一化出来是 0（不会被放大成噪声闪烁），而真实音乐往上走时 max 会
 * 在 1~2 帧内贴上新峰值。
 */
function updateAgc(agc, value) {
  const v = clamp(value, 0, 255);
  if (!agc.ready) {
    agc.min = v;
    agc.max = v + AGC_FLOOR_SPAN;
    agc.ready = true;
    return AGC_FLOOR_SPAN;
  }

  if (v > agc.max) agc.max += (v - agc.max) * AGC_MAX_RISE;
  else agc.max -= (agc.max - v) * AGC_MAX_FALL;

  if (v < agc.min) agc.min += (v - agc.min) * AGC_MIN_FALL;
  else agc.min += (v - agc.min) * AGC_MIN_RISE;

  agc.min = clamp(agc.min, 0, 255 - AGC_FLOOR_SPAN);
  const span = Math.max(AGC_FLOOR_SPAN, agc.max - agc.min);
  agc.max = Math.min(255, agc.min + span);
  return agc.max - agc.min;
}

/**
 * AGC 的单步推进，**状态作为参数传入**，不依赖任何模块级变量。
 *
 * `state` 是普通对象 `{ min, max, ready, span }`，会被就地更新；
 * 返回 `{ amp, span, min, max }`：
 *   amp  —— 归一化后的 0~1（已做 gamma 提升）
 *   span —— 当前跨度，节拍检测用它来缩放阈值
 *
 * 低于 AGC_SILENCE 的帧直接返回 amp=0，且**不推进基准** —— 静音不该改变增益。
 * 抽成纯函数是为了让测试能直接驱动这条状态机（见 __updateAgcForTests），
 * 不必造一个 AudioContext，也不必绕 sampleFrame() 间接测。
 */
export function stepAgc(state, value) {
  if (!Number.isFinite(value) || value < AGC_SILENCE) {
    return { amp: 0, span: state.span, min: state.min, max: state.max };
  }
  const span = updateAgc(state, value);
  state.span = span;
  const raw = clamp((value - state.min) / span, 0, 1);
  return {
    amp: Math.pow(raw, AGC_GAMMA),
    span,
    min: state.min,
    max: state.max,
  };
}

/** 测试入口：把 AGC 状态机的单步推进暴露成可直接调用的函数。 */
export function __updateAgcForTests(state, value) {
  return stepAgc(state, value);
}

/** 新建一份 AGC 状态。字段和 stepAgc 就地更新的对象完全一致。 */
export function createAgcState() {
  return { min: 0, max: 0, ready: false, span: AGC_FLOOR_SPAN };
}

/**
 * 一条 AGC 通道。`push(绝对电平)` 返回 `{ amp, span }`，
 * `state()` 返回收敛后的 `{ min, max, span }`（会写进 lastFrame 供运行时排查）。
 */
export function createAgcTracker() {
  const agc = createAgcState();
  return {
    push(value) {
      return stepAgc(agc, value);
    },
    reset() {
      agc.min = 0;
      agc.max = 0;
      agc.ready = false;
      agc.span = AGC_FLOOR_SPAN;
    },
    state() {
      return { min: agc.min, max: agc.max, span: agc.span };
    },
  };
}

/** 换歌 / 重新开启律动时丢掉上一首的增益基准。 */
export function resetAgc() {
  [agcLevel, agcBands.bass, agcBands.mid, agcBands.treble].forEach(tracker => {
    tracker.reset();
  });
}

function sampleFrame(dt) {
  if (!ensureAnalyser()) return null;
  const bands = readBands();
  if (!bands) return null;

  const level = pickLevel(bands, config.band);

  // 三个分频段各自归一化（mid/treble 的绝对电平比 bass 低一个数量级）
  const bassAmp = agcBands.bass.push(bands.bass).amp;
  const midAmp = agcBands.mid.push(bands.mid).amp;
  const trebleAmp = agcBands.treble.push(bands.treble).amp;

  // level 的 AGC 单独一条：它可能来自 'all'（energy），和上面三条不是同一个量。
  const levelAgc = agcLevel.push(level);
  const span = levelAgc.span;
  const target = levelAgc.amp;

  // 节拍走频谱通量：喂的是 readBands() 刚填好的**原始** byte 频谱（freqData），
  // 不是上面那条过了 AGC 的 level。这是「律动跟不上鼓点」的核心修正 ——
  // 在 AGC 之后的慢信号上做阈值比较，检出来的拍永远是软的。
  const onset = onsetDetector
    ? onsetDetector.push(freqData, { sensitivity: config.sensitivity, dt })
    : { onset: false, flux: 0, threshold: 0, env: 0 };
  const beat = onset.onset;
  // pulse 直接就是 onset 包络（快攻 1、慢放 exp(-dt/125ms)），不再自己乘衰减系数。
  pulse = onset.env;

  // 非对称包络：起音跟得快、回落得慢。
  const k = target > smoothLevel ? ATTACK : RELEASE;
  smoothLevel += (target - smoothLevel) * k;

  lastFrame = {
    bass: bands.bass,
    mid: bands.mid,
    treble: bands.treble,
    energy: bands.energy,
    level,
    // amp 是 AGC 之后的归一化能量（还没过非对称包络），smooth 是包络后的值。
    // 两个都留，排查「为什么不动」时能一眼分清是 AGC 没拉开还是包络太黏。
    amp: target,
    agc: { min: levelAgc.min, max: levelAgc.max, span },
    smooth: smoothLevel,
    beat,
    pulse,
    // flux / onsetThreshold 是 onset 检测的中间量：排查「为什么这一拍没跳」时
    // 直接看这两个数就知道是通量没起来还是被自适应阈值挡住了。
    flux: onset.flux,
    onsetThreshold: onset.threshold,
    bassAmp,
    midAmp,
    trebleAmp,
  };
  return lastFrame;
}

function tick(now) {
  rafId = window.requestAnimationFrame(tick);
  if (now - lastSampleAt < FRAME_INTERVAL) return;
  // dt 要按**真实时间**算：掉帧或切后台回来时帧间隔可能是几百毫秒，
  // 包络衰减和 refractory 都按毫秒定义，用固定的 1/30s 会让它们失真。
  // 上限 200ms 防止长时间挂起后一帧把包络直接清零（视觉上会「断一下」）。
  const dt = lastSampleAt ? clamp(now - lastSampleAt, 1, 200) : FRAME_INTERVAL;
  lastSampleAt = now;

  const frame = sampleFrame(dt);
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
  // 只有「从停到跑」这一条路径会走到这里（rafId 非空时提前返回），
  // 也就是订阅者从 0 变 1 的那一刻：换歌 / 重新开启律动都不能沿用
  // 上一首的增益基准，否则前几帧会拿旧曲目的 min/max 去归一化。
  resetAgc();
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
    amp: 0,
    agc: { min: 0, max: 0, span: 0 },
    smooth: 0,
    beat: false,
    pulse: 0,
    flux: 0,
    onsetThreshold: 0,
    bassAmp: 0,
    midAmp: 0,
    trebleAmp: 0,
  };
}
