<template>
  <div class="skeleton" :style="style"></div>
</template>

<script>
/**
 * 骨架屏占位块。
 *
 * 首屏原来是「0~1000ms 纯白 → 出现一根 2px 进度条 → 内容整体跳出」，
 * 用户在这 1 秒里无法判断应用是活着还是死了。骨架屏让等待可见，
 * 同时消除内容突然出现时的布局跳动。
 */
export default {
  name: 'Skeleton',
  props: {
    width: { type: String, default: '100%' },
    height: { type: String, default: '16px' },
    radius: { type: String, default: 'var(--r-md, 8px)' },
  },
  computed: {
    style() {
      return {
        width: this.width,
        height: this.height,
        borderRadius: this.radius,
      };
    },
  },
};
</script>

<style lang="scss" scoped>
.skeleton {
  background-color: var(--color-secondary-bg);
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.55) 50%,
    transparent 100%
  );
  background-size: 200% 100%;
  background-repeat: no-repeat;
  animation: skeleton-shimmer 1200ms linear infinite;
}

[data-theme='dark'] .skeleton {
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.06) 50%,
    transparent 100%
  );
}

@keyframes skeleton-shimmer {
  from {
    background-position: 150% 0;
  }
  to {
    background-position: -50% 0;
  }
}

// 系统开启「减弱动态效果」时不做循环动画（global.scss 里已全局关掉，
// 这里再兜一层，避免 keyframes 被单独覆盖时失效）
@media (prefers-reduced-motion: reduce) {
  .skeleton {
    animation: none;
  }
}
</style>
