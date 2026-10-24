<template>
  <div class="reactive-preview" :class="{ 'is-idle': !isLive }">
    <div
      ref="stage"
      class="stage"
      :style="{ backgroundImage: previewImage }"
    ></div>
    <!-- 和歌词页同构的两层可见信号：暗幕 + 三团光斑。
         必须是 .stage 的兄弟节点 —— 放进 .stage 里会被它的 filter 建出一个
         新的层叠上下文，光斑的 mix-blend-mode 混不到背景上，而且实测断层
         会恶化 3 倍。 -->
    <div class="react-veil" aria-hidden="true"></div>
    <div class="react-orbs" :style="accentStyle" aria-hidden="true">
      <div class="react-orb a"></div>
      <div class="react-orb b"></div>
      <div class="react-orb c"></div>
    </div>
    <!-- 抖动层：光斑的 alpha 斜坡在 8-bit 下必然出同心环，必须和歌词页用
         同一份噪声去打散。少了这一层，240×140 的预览块 flatRatio 会到 51%。 -->
    <div class="react-grain" aria-hidden="true"></div>
    <div class="badge" :class="badgeClass">
      <span class="dot"></span>
      <span>{{ badgeText }}</span>
    </div>
  </div>
</template>

<script>
import { mapState } from 'vuex';
import * as Vibrant from 'node-vibrant/dist/vibrant.worker.min.js';
import Color from 'color';
import {
  subscribe,
  setReactiveConfig,
  mapFrameToVars,
  supportsReactive,
  DEFAULT_REACTIVE_CONFIG,
  normalizeReactiveConfig,
} from '@/utils/audioAnalyser';

const SYNTHETIC_INTERVAL = 1000 / 30;
// 预览块只有 240×140，歌词页背景是 100vw。模糊半径在 CSS 里乘 0.2 等比缩放
// （50px / 1400px ≈ 0.036，240px × 0.036 ≈ 8.6px；取 0.2 偏保守，保证还能看出结构）。

export default {
  name: 'ReactivePreview',
  props: {
    // 用户当前正在调的配置。不传则读 settings.lyricsReactive。
    config: {
      type: Object,
      default: null,
    },
    // 封面图，用于让预览看起来像歌词页
    coverUrl: {
      type: String,
      default: '',
    },
  },
  data() {
    return {
      isLive: false, // true = 真实音频驱动
      visible: false,
      syntheticPulse: 0,
      // 从封面取到的主色 / 互补色，"r, g, b" 形式。取不到时由 CSS 里的
      // var() 回退值接管，保证预览块不会因为取色失败而空掉。
      accent: '',
      accentAlt: '',
    };
  },
  computed: {
    ...mapState(['player', 'settings']),
    accentStyle() {
      const style = {};
      if (this.accent) style['--react-accent'] = this.accent;
      if (this.accentAlt) style['--react-accent-alt'] = this.accentAlt;
      return style;
    },
    activeConfig() {
      return normalizeReactiveConfig(
        this.config || this.settings.lyricsReactive || DEFAULT_REACTIVE_CONFIG
      );
    },
    previewImage() {
      if (this.coverUrl) return `url("${this.coverUrl}?param=400y400")`;
      // 没有封面时用一段固定渐变，保证「缩放/模糊/色相」的变化肉眼可见
      return (
        'radial-gradient(circle at 30% 30%, #7b5cff 0%, #2b1a6b 45%, #0b0a1a 100%),' +
        ' radial-gradient(circle at 75% 70%, #ff5c8a 0%, transparent 55%)'
      );
    },
    badgeText() {
      if (this.isLive) return this.$t('settings.lyricsReactive.preview');
      return this.$t('settings.lyricsReactive.previewSynthetic');
    },
    badgeClass() {
      return this.isLive ? 'live' : 'demo';
    },
    canUseRealAudio() {
      return Boolean(this.player.playing) && supportsReactive();
    },
  },
  watch: {
    activeConfig: {
      deep: true,
      immediate: true,
      handler(value) {
        // 只更新分析层配置，不触发重渲染
        setReactiveConfig(value);
        this.applyVars(
          mapFrameToVars(
            { level: 0, pulse: this.syntheticPulse },
            this.effectiveConfig(value)
          )
        );
      },
    },
    canUseRealAudio(value) {
      if (value) this.startReal();
      else this.startSynthetic();
    },
    // 预览块的光斑要和播放页同色，否则「设置里看到的」和「实际播放页」还是
    // 两套观感 —— 那正是这次要修的不对称。
    coverUrl: {
      immediate: true,
      handler() {
        this.loadAccent();
      },
    },
  },
  mounted() {
    this.observeVisibility();
    this.startSynthetic();
  },
  beforeDestroy() {
    this.stopAll();
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  },
  methods: {
    effectiveConfig(config) {
      const cfg = config || this.activeConfig;
      return Object.assign({}, cfg, {
        dimensions: Object.assign({}, cfg.dimensions),
      });
    },
    observeVisibility() {
      if (typeof IntersectionObserver === 'undefined') {
        this.visible = true;
        return;
      }
      this.observer = new IntersectionObserver(
        entries => {
          const entry = entries[0];
          const wasVisible = this.visible;
          this.visible = Boolean(entry && entry.isIntersecting);
          if (this.visible && !wasVisible) {
            if (this.canUseRealAudio) this.startReal();
            else this.startSynthetic();
          } else if (!this.visible && wasVisible) {
            this.stopAll();
          }
        },
        { threshold: 0.15 }
      );
      this.observer.observe(this.$el);
    },
    stopAll() {
      if (this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
      }
      if (this.syntheticTimer) {
        clearInterval(this.syntheticTimer);
        this.syntheticTimer = null;
      }
    },
    applyVars(vars) {
      // 写到 .reactive-preview 根节点上，让 .stage / .react-veil / .react-orbs
      // 三个兄弟节点都靠继承拿到同一份值（和歌词页的做法一致）。
      const root = this.$el;
      if (!root || !root.style) return;
      Object.keys(vars).forEach(key => {
        root.style.setProperty(key, vars[key]);
      });
    },
    loadAccent() {
      if (!this.coverUrl) return;
      Vibrant.from(`${this.coverUrl}?param=256y256`, { colorCount: 1 })
        .getPalette()
        .then(palette => {
          const swatch = palette.DarkMuted || palette.Muted || palette.Vibrant;
          if (!swatch || !swatch._rgb) return;
          const originColor = Color.rgb(swatch._rgb);
          const rgbString = c =>
            c
              .rgb()
              .array()
              .slice(0, 3)
              .map(v => Math.round(v))
              .join(', ');
          this.accent = rgbString(originColor);
          this.accentAlt = rgbString(originColor.rotate(40).lighten(0.18));
        })
        .catch(() => {
          // 取色失败就用 CSS 的主题回退色，预览本身照常跑
        });
    },
    startReal() {
      this.stopAll();
      if (!this.visible) return;
      this.isLive = true;
      this.unsubscribe = subscribe(frame => {
        this.applyVars(mapFrameToVars(frame, this.activeConfig));
      });
    },
    startSynthetic() {
      if (this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
      }
      if (this.syntheticTimer) clearInterval(this.syntheticTimer);
      this.syntheticTimer = null;
      this.isLive = false;
      if (!this.visible) return;

      const cfg = this.effectiveConfig();
      cfg.dimensions = Object.assign({}, cfg.dimensions);
      const startedAt = Date.now();
      // 120bpm 的模拟节拍：500ms 一拍，指数包络衰减
      this.syntheticTimer = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        const beatPhase = (elapsed % 500) / 500;
        const envelope = Math.exp(-beatPhase * 4.2);
        const swell = (Math.sin(elapsed / 900) + 1) / 2;
        const level = Math.min(255, 70 + envelope * 130 + swell * 35);
        this.syntheticPulse = envelope;
        this.applyVars(
          mapFrameToVars({ level, pulse: envelope }, this.activeConfig)
        );
      }, SYNTHETIC_INTERVAL);
    },
  },
};
</script>

<style lang="scss" scoped>
.reactive-preview {
  position: relative;
  width: 240px;
  height: 140px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--color-secondary-bg);
  flex-shrink: 0;
  // 让光斑的 mix-blend-mode 只混预览块自己的内容（.stage + 自身背景），
  // 不去混设置页后面的东西。歌词页靠 z-index 天然隔离，这里要显式声明。
  isolation: isolate;

  .stage {
    position: absolute;
    // 往外扩一圈，缩放时不会露出边缘
    top: -25%;
    right: -25%;
    bottom: -25%;
    left: -25%;
    background-size: cover;
    background-position: center;
    // 基础亮度和歌词页同源（浅色 1.12 / 深色 0.72）。--react-brightness 的
    // 语义已经改成「乘数」，漏掉基础值预览就会比实际页面暗一档。
    --react-base-brightness: 1.12;
    // 模糊半径由 --react-blur 提供，这里只做等比缩小。
    // 亮度**不乘** --react-brightness，和歌词页保持同一套解耦：滤镜给质感，
    // 暗幕给亮度呼吸。两层叠乘会把画面压到深色文字读不清的亮度。
    filter: blur(calc(var(--react-blur, 50px) * 0.2))
      brightness(var(--react-base-brightness))
      saturate(var(--react-saturate, 1));
    // 叠加视差：方向与歌词页近层一致（左上），幅度减半。
    // 位移必须和 blur 一样乘 0.2 做等比缩放：drift 是绝对像素值，直接用在
    // 240px 的块上会变成 9% 的位移，而歌词页 1400px 视口下只有 1.6%，
    // 预览会把动感夸大约 6 倍，用户就会照着失真的预览去选预设。
    transform: translate3d(
        calc(var(--react-drift, 0px) * 0.2),
        calc(var(--react-drift, 0px) * -0.1),
        0
      )
      scale(var(--react-scale, 1));
    transition: transform 140ms cubic-bezier(0.2, 0, 0, 1),
      filter 160ms cubic-bezier(0.2, 0, 0, 1);
    will-change: transform, filter;
  }

  [data-theme='dark'] & .stage {
    --react-base-brightness: 0.72;
  }

  // 暗幕：和歌词页同一条公式，整块预览随能量明暗呼吸
  .react-veil {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background: #000;
    // 浅色档压到 0.66，理由同歌词页：全屏压暗会和深色文字抢对比度。
    opacity: calc((1.12 - var(--react-brightness, 1.12)) * 0.66);
    transition: opacity 120ms linear;
  }

  [data-theme='dark'] & .react-veil {
    opacity: calc((1.12 - var(--react-brightness, 1.12)) * 1.9);
  }

  .react-orbs {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .react-orb {
    --orb-accent: var(--react-accent, 60, 70, 90);
    position: absolute;
    border-radius: 50%;
    pointer-events: none;
    mix-blend-mode: multiply;
    will-change: transform, opacity;
    transition: transform 120ms cubic-bezier(0.2, 0, 0, 1), opacity 160ms linear;
    background: radial-gradient(
      ellipse closest-side at 50% 50%,
      #{'rgba(var(--orb-accent), 0.95)'} 0%,
      #{'rgba(var(--orb-accent), 0.88)'} 14%,
      #{'rgba(var(--orb-accent), 0.62)'} 30%,
      #{'rgba(var(--orb-accent), 0.34)'} 46%,
      #{'rgba(var(--orb-accent), 0.14)'} 60%,
      #{'rgba(var(--orb-accent), 0.04)'} 70%,
      #{'rgba(var(--orb-accent), 0)'} 78%
    );

    &.b {
      --orb-accent: var(--react-accent-alt, 70, 110, 190);
    }

    &.a {
      width: 130%;
      height: 130%;
      left: -45%;
      top: -52%;
      transform: translate3d(
          calc(var(--react-bass, 0) * var(--react-power, 1) * 26%),
          calc(var(--react-bass, 0) * var(--react-power, 1) * 18%),
          0
        )
        scale(calc(1 + var(--react-bass, 0) * var(--react-power, 1) * 0.3));
      opacity: calc(
        (0.1 + var(--react-bass, 0) * 0.55) * var(--react-power, 1)
      );
    }

    &.b {
      width: 95%;
      height: 95%;
      right: -28%;
      bottom: -34%;
      transform: translate3d(
          calc(var(--react-mid, 0) * var(--react-power, 1) * -22%),
          calc(var(--react-mid, 0) * var(--react-power, 1) * -15%),
          0
        )
        scale(calc(1 + var(--react-mid, 0) * var(--react-power, 1) * 0.28));
      opacity: calc(
        (0.08 + var(--react-mid, 0) * 0.42) * var(--react-power, 1)
      );
    }

    &.c {
      width: 60%;
      height: 60%;
      left: 66%;
      top: 10%;
      transform: translate3d(
          calc(var(--react-treble, 0) * var(--react-power, 1) * 12%),
          calc(var(--react-treble, 0) * var(--react-power, 1) * -9%),
          0
        )
        scale(calc(1 + var(--react-pulse, 0) * var(--react-power, 1) * 0.3));
      opacity: calc(
        (0.04 + var(--react-treble, 0) * 0.22 + var(--react-pulse, 0) * 0.16) *
          var(--react-power, 1)
      );
    }
  }

  [data-theme='dark'] & .react-orb {
    --orb-accent: var(--react-accent, 255, 255, 255);
    mix-blend-mode: screen;

    &.b {
      --orb-accent: var(--react-accent-alt, 120, 170, 255);
    }
  }

  // 和歌词页 .lyrics-grain 完全同源：opacity 0.08 / normal / sRGB 湍流。
  // 抖动是唯一能把光斑 alpha 台阶压到肉眼不可见的办法。
  .react-grain {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    opacity: 0.08;
    mix-blend-mode: normal;
    background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n' color-interpolation-filters='sRGB'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.86' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    background-repeat: repeat;
    background-size: 160px 160px;
  }

  [data-theme='dark'] & .react-grain {
    opacity: 0.06;
  }

  .badge {
    position: absolute;
    left: 8px;
    bottom: 8px;
    right: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 11px;
    line-height: 16px;
    color: rgba(255, 255, 255, 0.92);
    background: rgba(0, 0, 0, 0.42);
    backdrop-filter: blur(6px);

    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      flex-shrink: 0;
    }

    &.live .dot {
      background: #4ade80;
      animation: preview-pulse 1.1s ease-in-out infinite;
    }

    &.demo .dot {
      background: #fbbf24;
    }
  }
}

@keyframes preview-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

@media (prefers-reduced-motion: reduce) {
  .reactive-preview .stage,
  .reactive-preview .react-veil,
  .reactive-preview .react-orb {
    transition: none;
  }

  .reactive-preview .badge.live .dot {
    animation: none;
  }
}
</style>
