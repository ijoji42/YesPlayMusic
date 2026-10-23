<template>
  <div class="reactive-preview" :class="{ 'is-idle': !isLive }">
    <div
      ref="stage"
      class="stage"
      :style="{ backgroundImage: previewImage }"
    ></div>
    <div class="badge" :class="badgeClass">
      <span class="dot"></span>
      <span>{{ badgeText }}</span>
    </div>
  </div>
</template>

<script>
import { mapState } from 'vuex';
import {
  subscribe,
  setReactiveConfig,
  mapFrameToVars,
  supportsReactive,
  isDegraded,
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
      isDegraded: false,
      visible: false,
      syntheticPulse: 0,
    };
  },
  computed: {
    ...mapState(['player', 'settings']),
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
      if (this.isDegraded) return this.$t('settings.lyricsReactive.degraded');
      if (this.isLive) return this.$t('settings.lyricsReactive.preview');
      return this.$t('settings.lyricsReactive.previewSynthetic');
    },
    badgeClass() {
      if (this.isDegraded) return 'warn';
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
      const stage = this.$refs.stage;
      if (!stage) return;
      Object.keys(vars).forEach(key => {
        stage.style.setProperty(key, vars[key]);
      });
    },
    startReal() {
      this.stopAll();
      if (!this.visible) return;
      this.isLive = true;
      this.isDegraded = false;
      this.unsubscribe = subscribe(frame => {
        // 连续读不到频谱 → 停止真实驱动，退回模拟演示并提示用户
        if (isDegraded()) {
          this.isDegraded = true;
          this.isLive = false;
          this.stopAll();
          this.startSynthetic();
          return;
        }
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

  .stage {
    position: absolute;
    // 往外扩一圈，缩放时不会露出边缘
    top: -25%;
    right: -25%;
    bottom: -25%;
    left: -25%;
    background-size: cover;
    background-position: center;
    // 模糊半径由 --react-blur 提供，这里只做等比缩小
    filter: blur(calc(var(--react-blur, 50px) * 0.2))
      brightness(var(--react-brightness, 1)) saturate(var(--react-saturate, 1))
      hue-rotate(var(--react-hue, 0deg));
    transform: scale(var(--react-scale, 1));
    transition: transform 80ms linear, filter 80ms linear;
    will-change: transform, filter;
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

    &.warn .dot {
      background: #f87171;
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
  .reactive-preview .stage {
    transition: none;
  }

  .reactive-preview .badge.live .dot {
    animation: none;
  }
}
</style>
