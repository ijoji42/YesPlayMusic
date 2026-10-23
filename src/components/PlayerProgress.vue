<template>
  <div
    class="player-progress"
    :class="{
      compact,
      nyancat: settings.nyancatStyle,
      'nyancat-stop': settings.nyancatStyle && !player.playing,
    }"
    @click.stop
  >
    <span class="time time-start">{{ formatTime(progress) }}</span>
    <vue-slider
      v-model="progress"
      :min="0"
      :max="duration"
      :interval="0.1"
      :drag-on-click="true"
      :duration="0"
      :dot-size="12"
      :height="2"
      :tooltip-formatter="formatTime"
      :lazy="false"
      :silent="false"
      @drag-start="handleDragStart"
      @drag-end="handleDragEnd"
    ></vue-slider>
    <span class="time time-end">{{ formatTime(duration) }}</span>
  </div>
</template>

<script>
import VueSlider from 'vue-slider-component';
import '@/assets/css/slider.css';
import { mapState } from 'vuex';

/**
 * 播放进度条。
 *
 * 原先进度条直接 v-model 到 player.progress，导致：
 * 1. 播放器实例每秒被写入一次，整块播放器 UI 跟着重渲染；
 * 2. 拖动过程中每一次指针移动都会写回播放器实例。
 *
 * 现在进度由组件自己以 250ms 采样维护，只有「拖动结束」才真正 seek，
 * 主播放器不再因为进度变化而重渲染，进度条也比原来（1s 采样）更跟手。
 *
 * 同时补上两端的时间标签：原来「还剩多久」只能靠悬停 tooltip 获取，
 * 而这个控件每天被看几百次，核心信息不该藏在 hover 里。
 */
export default {
  name: 'PlayerProgress',
  components: { VueSlider },
  props: {
    /**
     * 紧凑模式：去掉左右留白、放大时间字号。
     * 供全屏歌词页复用 —— 那边是独立的一栏布局，不需要跟随主界面的 10vw 边距。
     */
    compact: { type: Boolean, default: false },
  },
  data() {
    return {
      progress: 0,
      isDragging: false,
    };
  },
  computed: {
    ...mapState(['player', 'settings']),
    duration() {
      return this.player.currentTrackDuration || 0;
    },
  },
  watch: {
    'player.currentTrack.id'() {
      this.isDragging = false;
      this.progress = 0;
      // 等 duration 跟着新曲目更新后再采样，避免用旧的最大值夹取
      this.$nextTick(this.tick);
    },
  },
  mounted() {
    this.tick();
    this.timer = setInterval(this.tick, 250);
  },
  beforeDestroy() {
    if (this.timer) clearInterval(this.timer);
  },
  methods: {
    tick() {
      if (this.isDragging) return;
      // 切歌瞬间 _howler 可能还是上一首的实例，此时读到的位置会把
      // 进度条瞬间推到满格。新曲还没装载好就先保持 0。
      if (this.duration <= 0) {
        this.progress = 0;
        return;
      }
      const value = this.player.seek(null, false);
      if (typeof value === 'number' && !Number.isNaN(value)) {
        this.progress = Math.min(value, this.duration);
      }
    },
    handleDragStart() {
      this.isDragging = true;
    },
    handleDragEnd() {
      this.isDragging = false;
      this.player.seek(this.progress);
    },
    /**
     * 与 common.js 的 formatTrackTime 不同：0 秒要显示 "0:00" 而不是空字符串，
     * 否则暂停在开头时两端时间标签会缺一个。
     */
    formatTime(value) {
      if (!Number.isFinite(value) || value < 0) return '0:00';
      const min = Math.floor(value / 60);
      const sec = Math.floor(value % 60)
        .toString()
        .padStart(2, '0');
      return `${min}:${sec}`;
    },
  },
};
</script>

<style lang="scss" scoped>
.player-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 0 10vw;
  box-sizing: border-box;
  // 进度条本体占满剩余空间；min-width: 0 防止被两端时间标签挤爆
  ::v-deep .vue-slider {
    flex: 1;
    min-width: 0;
  }
  .time {
    flex: 0 0 auto;
    min-width: 34px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--c-text-3, rgba(0, 0, 0, 0.58));
    user-select: none;
  }
  .time-end {
    text-align: right;
  }

  // 歌词页复用：跟随父容器留白，时间字号与该页原有排版一致
  &.compact {
    padding: 0;
    gap: 10px;
    .time {
      font-size: 15px;
      min-width: 28px;
      opacity: 0.58;
      color: inherit;
    }
  }
}

@media (max-width: 1336px) {
  .player-progress {
    padding: 0 5vw;
  }
}
</style>
