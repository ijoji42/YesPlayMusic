<template>
  <div v-if="sessions.length > 0" class="continue-listening">
    <div class="title">
      <span>{{ $t('continueListening.title') }}</span>
      <button class="clear" type="button" @click="clearAll">
        {{ $t('continueListening.clear') }}
      </button>
    </div>
    <div class="cards">
      <div
        v-for="session in visibleSessions"
        :key="session.id"
        class="card"
        role="button"
        tabindex="0"
        :aria-label="session.trackMeta.name"
        @click="restore(session)"
        @keydown.enter.prevent="restore(session)"
        @keydown.space.prevent="restore(session)"
      >
        <img
          class="cover"
          :src="coverOf(session)"
          alt=""
          loading="lazy"
          @error="onCoverError"
        />
        <div class="meta">
          <div class="name">{{ session.trackMeta.name }}</div>
          <div class="artist">{{ session.trackMeta.artistNames }}</div>
          <div class="progress" aria-hidden="true">
            <div
              class="progress-inner"
              :style="{ width: percentOf(session) }"
            ></div>
          </div>
          <div class="time">{{ relativeOf(session) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { mapActions } from 'vuex';
import {
  clearSessions,
  formatRelativeTime,
  initSessionTracking,
  loadSessions,
} from '@/utils/listenHistory';

// 一行最多放几张卡片。再多就挤了，历史长度本身仍保留 8 条。
const MAX_CARDS = 4;
// 封面加载失败（离线 / 图片被删）时的兜底图
const FALLBACK_COVER =
  'https://p2.music.126.net/0-Ybpa8FrDfRgKYCTJD8Xg==/109951164796696795.jpg';
// 恢复会话后等待音频就绪再 seek 的轮询参数
const SEEK_POLL_INTERVAL = 250;
const SEEK_POLL_MAX_TRIES = 40;

export default {
  name: 'ContinueListening',
  data() {
    return {
      sessions: [],
      // 相对时间标签的基准时间，每分钟推进一次，避免「刚刚」永远不变
      now: Date.now(),
      clock: null,
      pendingSeek: null,
    };
  },
  computed: {
    visibleSessions() {
      return this.sessions.slice(0, MAX_CARDS);
    },
  },
  created() {
    // 追踪器随首页一起启动（首页是默认落地路由）
    initSessionTracking(this.$store);
    this.refresh();
  },
  activated() {
    this.startClock();
  },
  deactivated() {
    this.stopClock();
  },
  beforeDestroy() {
    this.stopClock();
    this.cancelPendingSeek();
  },
  methods: {
    ...mapActions(['showToast']),
    /**
     * 重新从本地读取会话列表。首页 keep-alive，返回时需要刷新。
     */
    refresh() {
      this.sessions = loadSessions();
      this.now = Date.now();
    },
    startClock() {
      this.stopClock();
      this.clock = setInterval(() => {
        this.now = Date.now();
      }, 60 * 1000);
    },
    stopClock() {
      if (this.clock !== null) {
        clearInterval(this.clock);
        this.clock = null;
      }
    },
    coverOf(session) {
      const url = session.trackMeta.coverUrl || FALLBACK_COVER;
      return `${url.replace('http://', 'https://')}?param=200y200`;
    },
    onCoverError(event) {
      const img = event.target;
      const fallback = `${FALLBACK_COVER}?param=200y200`;
      if (!img || img.src === fallback) return;
      img.src = fallback;
    },
    percentOf(session) {
      const duration = session.trackMeta.durationMs;
      if (!duration || duration <= 0) return '0%';
      const ratio = Math.min(1, Math.max(0, session.progressMs / duration));
      return `${(ratio * 100).toFixed(2)}%`;
    },
    relativeOf(session) {
      return formatRelativeTime(session.playedAt, this.now);
    },
    clearAll() {
      clearSessions();
      this.sessions = [];
    },
    /**
     * 恢复一条会话：换掉播放列表、定位到那首歌、然后跳到上次的位置。
     */
    restore(session) {
      const player = this.$store.state.player;
      if (!player || !session.trackIDs || session.trackIDs.length === 0) {
        return;
      }
      const trackID = session.trackMeta.id;
      try {
        player.replacePlaylist(
          session.trackIDs.slice(),
          session.sourceID,
          session.sourceType,
          trackID
        );
      } catch (error) {
        console.warn('[ContinueListening] failed to restore session', error);
        this.showToast('无法恢复播放');
        return;
      }
      this.showToast(
        `${this.$t('continueListening.title')} · ${session.trackMeta.name}`
      );
      this.seekWhenReady(trackID, session.progressMs);
    },
    /**
     * replacePlaylist 是异步的（要拉详情 + 取音源），音频就绪前
     * player.seek 会被 howler 丢掉。这里轮询到「目标歌曲真的在播」
     * 再 seek，保证续播点准确。
     */
    seekWhenReady(trackID, progressMs) {
      this.cancelPendingSeek();
      const seconds = Math.max(0, progressMs) / 1000;
      if (seconds < 1) return;

      const task = { trackID, seconds, tries: 0, timer: null };
      this.pendingSeek = task;

      const attempt = () => {
        if (this.pendingSeek !== task) return;
        const player = this.$store.state.player;
        if (!player) {
          this.pendingSeek = null;
          return;
        }
        if (player.playing && player.currentTrackID === trackID) {
          player.seek(seconds);
          this.pendingSeek = null;
          return;
        }
        task.tries += 1;
        if (task.tries >= SEEK_POLL_MAX_TRIES) {
          this.pendingSeek = null;
          return;
        }
        task.timer = setTimeout(attempt, SEEK_POLL_INTERVAL);
      };

      task.timer = setTimeout(attempt, SEEK_POLL_INTERVAL);
    },
    cancelPendingSeek() {
      if (this.pendingSeek && this.pendingSeek.timer !== null) {
        clearTimeout(this.pendingSeek.timer);
      }
      this.pendingSeek = null;
    },
  },
};
</script>

<style lang="scss" scoped>
.continue-listening {
  margin-top: 32px;
}

.title {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 20px;
  font-size: 28px;
  font-weight: 700;
  color: var(--color-text);
}

.clear {
  padding: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  opacity: 0.68;
  transition: opacity 200ms ease;
  &:hover {
    opacity: 1;
  }
}

.cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 24px;
  /* 固定高度：下面的骨架屏 / 真实内容加载完成时，这个块不能跟着跳。
     96px = 24px 上下内边距 + 72px 内容（封面 64px 定高，文字行高显式固定） */
  height: 96px;
}

.card {
  display: flex;
  align-items: center;
  box-sizing: border-box;
  height: 96px;
  min-width: 0;
  padding: 12px;
  border-radius: 12px;
  background: var(--color-secondary-bg);
  cursor: pointer;
  transition: background-color 200ms ease, transform 200ms ease;
  &:hover {
    background: var(--color-primary-bg-for-transparent);
  }
  &:active {
    transform: scale(0.99);
  }
}

.cover {
  flex: none;
  width: 64px;
  height: 64px;
  margin-right: 12px;
  border-radius: 8px;
  object-fit: cover;
  background: var(--color-secondary-bg-for-transparent);
}

.meta {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
}

.name {
  margin-bottom: 4px;
  font-size: 14px;
  line-height: 1.35;
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.artist {
  margin-bottom: 6px;
  font-size: 12px;
  line-height: 1.35;
  color: var(--color-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.progress {
  height: 3px;
  margin-bottom: 4px;
  border-radius: 2px;
  background: var(--color-primary-bg-for-transparent);
  overflow: hidden;
}

.progress-inner {
  height: 100%;
  border-radius: 2px;
  background: var(--color-primary);
}

.time {
  font-size: 11px;
  line-height: 1.3;
  color: var(--color-secondary);
  opacity: 0.8;
}

@media (prefers-reduced-motion: reduce) {
  .clear,
  .card {
    transition: none;
  }
  .card:active {
    transform: none;
  }
}
</style>
