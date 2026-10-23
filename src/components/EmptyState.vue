<template>
  <div class="empty-state">
    <div class="art">
      <slot name="art">
        <svg-icon :icon-class="icon" />
      </slot>
    </div>
    <div class="title">{{ title }}</div>
    <div v-if="description" class="desc">{{ description }}</div>
    <div v-if="$slots.action" class="action">
      <slot name="action"></slot>
    </div>
  </div>
</template>

<script>
/**
 * 空状态。
 *
 * 原项目几乎没有空状态：搜索无结果是一行 2.68:1 对比度的灰字（不达 WCAG AA），
 * 歌单/音乐库为空时直接是空白。空状态要回答两个问题：发生了什么、我能做什么。
 */
export default {
  name: 'EmptyState',
  props: {
    icon: { type: String, default: 'search' },
    title: { type: String, required: true },
    description: { type: String, default: '' },
  },
};
</script>

<style lang="scss" scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 96px 24px;
  text-align: center;

  .art {
    width: 88px;
    height: 88px;
    margin-bottom: 24px;
    border-radius: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-secondary-bg);
    color: var(--c-text-3, rgba(0, 0, 0, 0.58));
    ::v-deep .svg-icon {
      width: 36px;
      height: 36px;
    }
  }

  .title {
    font-size: 16px;
    font-weight: 600;
    color: var(--c-text-1, var(--color-text));
  }

  .desc {
    margin-top: 8px;
    max-width: 40ch;
    font-size: 14px;
    line-height: 1.5;
    // 原搜索空态用的是 0.38 透明度，实测 2.68:1 不达 AA，这里提到 0.58
    color: var(--c-text-3, rgba(0, 0, 0, 0.58));
  }

  .action {
    margin-top: 24px;
  }
}
</style>
