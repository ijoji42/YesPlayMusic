<template>
  <div>
    <transition name="fade">
      <div
        v-show="show"
        id="scrollbar"
        :class="{ 'on-drag': isOnDrag }"
        @click="handleClick"
      >
        <div
          id="thumbContainer"
          :class="{ active }"
          :style="thumbStyle"
          @mouseenter="handleMouseenter"
          @mouseleave="handleMouseleave"
          @mousedown="handleDragStart"
          @click.stop
        >
          <div></div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
export default {
  name: 'Scrollbar',
  data() {
    return {
      top: 0,
      thumbHeight: 0,
      clientHeight: 0,
      active: false,
      show: false,
      hideTimer: null,
      isOnDrag: false,
      onDragClientY: 0,
      positions: {
        home: { scrollTop: 0, params: {} },
      },
    };
  },
  computed: {
    thumbStyle() {
      return {
        transform: `translateY(${this.top}px)`,
        height: `${this.thumbHeight}px`,
      };
    },
    main() {
      return this.$parent.$refs.main;
    },
  },

  watch: {
    // 原先在 created 里用 $router.beforeEach 注册守卫，组件销毁时不会解绑，
    // 每创建一次就叠加一个守卫。改用路由变化监听。
    $route() {
      this.show = false;
    },
  },

  mounted() {
    this.updateClientHeight();
    window.addEventListener('resize', this.updateClientHeight);
  },

  beforeDestroy() {
    window.removeEventListener('resize', this.updateClientHeight);
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
  },

  methods: {
    updateClientHeight() {
      const el = this.main;
      if (!el) return;
      // 视口高度只在窗口尺寸变化时改变，缓存下来避免每次滚动都强制 reflow
      this.clientHeight = el.clientHeight - 128;
    },
    handleScroll() {
      const el = this.main;
      if (!el) return;
      const clintHeight = this.clientHeight || el.clientHeight - 128;
      const scrollHeight = el.scrollHeight - 128;
      if (clintHeight <= 0 || scrollHeight <= 0) return;

      const scrollTop = el.scrollTop;
      let top = ~~((scrollTop / scrollHeight) * clintHeight);
      let thumbHeight = ~~((clintHeight / scrollHeight) * clintHeight);

      if (thumbHeight < 24) thumbHeight = 24;
      if (top > clintHeight - thumbHeight) {
        top = clintHeight - thumbHeight;
      }
      this.top = top;
      this.thumbHeight = thumbHeight;

      if (!this.show && clintHeight !== thumbHeight) this.show = true;
      this.setScrollbarHideTimeout();

      const route = this.$route;
      if (route.meta.savePosition) {
        this.positions[route.name] = { scrollTop, params: route.params };
      }
    },
    handleMouseenter() {
      this.active = true;
    },
    handleMouseleave() {
      this.active = false;
      this.setScrollbarHideTimeout();
    },
    handleDragStart(e) {
      this.onDragClientY = e.clientY;
      this.isOnDrag = true;
      this.$parent.userSelectNone = true;
      document.addEventListener('mousemove', this.handleDragMove);
      document.addEventListener('mouseup', this.handleDragEnd);
    },
    handleDragMove(e) {
      if (!this.isOnDrag) return;
      const clintHeight = this.main.clientHeight - 128;
      const scrollHeight = this.main.scrollHeight - 128;
      const clientY = e.clientY;
      const scrollTop = this.main.scrollTop;
      const offset = ~~(
        ((clientY - this.onDragClientY) / clintHeight) *
        scrollHeight
      );
      this.top = ~~((scrollTop / scrollHeight) * clintHeight);
      this.main.scrollBy(0, offset);
      this.onDragClientY = clientY;
    },
    handleDragEnd() {
      this.isOnDrag = false;
      this.$parent.userSelectNone = false;
      document.removeEventListener('mousemove', this.handleDragMove);
      document.removeEventListener('mouseup', this.handleDragEnd);
    },
    handleClick(e) {
      let scrollTop;
      if (e.clientY < this.top + 84) {
        scrollTop = -256;
      } else {
        scrollTop = 256;
      }
      this.main.scrollBy({
        top: scrollTop,
        behavior: 'smooth',
      });
    },
    setScrollbarHideTimeout() {
      if (this.hideTimer !== null) clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => {
        if (!this.active) this.show = false;
        this.hideTimer = null;
      }, 4000);
    },
    restorePosition() {
      const route = this.$route;
      if (
        !route.meta.savePosition ||
        this.positions[route.name] === undefined ||
        this.main === undefined
      ) {
        return;
      }
      this.main.scrollTo({ top: this.positions[route.name].scrollTop });
    },
  },
};
</script>

<style lang="scss" scoped>
#scrollbar {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: 16px;
  z-index: 1000;

  #thumbContainer {
    margin-top: 64px;
    div {
      transition: background 0.4s;
      position: absolute;
      right: 2px;
      width: 8px;
      height: 100%;
      border-radius: 4px;
      background: rgba(128, 128, 128, 0.38);
    }
  }
  #thumbContainer.active div {
    background: rgba(128, 128, 128, 0.58);
  }
}

[data-theme='dark'] {
  #thumbContainer div {
    background: var(--color-secondary-bg);
  }
}

#scrollbar.on-drag {
  left: 0;
  width: auto;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter,
.fade-leave-to {
  opacity: 0;
}
</style>
