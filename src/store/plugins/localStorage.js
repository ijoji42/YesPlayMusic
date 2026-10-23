/**
 * 持久化插件（性能版）
 *
 * 原实现：任何 mutation 都同步 JSON.stringify(settings) + JSON.stringify(data)
 * 并写入 localStorage。播放器进度、loading、toast 这类高频 mutation 会让主线程
 * 每秒执行多次「全量序列化 + 同步磁盘写」，是切歌卡顿与界面掉帧的主要来源之一。
 *
 * 现实现：
 * 1. 只持久化真正需要跨会话保留的两个顶层 key（settings / data），且用精确的
 *    mutation 映射，避免把运行时状态也写盘
 * 2. 写入合并到一个批次（默认 400ms），同一批次内多次变更只序列化一次
 * 3. 页面隐藏 / 卸载时强制 flush，保证不丢数据
 */

const FLUSH_DELAY = 400;

// 只有这些 mutation 会改动需要持久化的状态。
// 新增修改 settings / data 的 mutation 时，必须在这里登记，否则不会落盘。
const MUTATION_TO_KEY = {
  changeLang: 'settings',
  changeMusicQuality: 'settings',
  changeLyricFontSize: 'settings',
  changeOutputDevice: 'settings',
  updateSettings: 'settings',
  togglePlaylistCategory: 'settings',
  updateShortcut: 'settings',
  restoreDefaultShortcuts: 'settings',
  updateData: 'data',
};

export default store => {
  const pending = new Set();
  let timer = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;

    for (const key of pending) {
      try {
        localStorage.setItem(key, JSON.stringify(store.state[key]));
      } catch (e) {
        // 配额超限或序列化失败不应该让整个应用崩溃
        console.warn(`[persist] failed to save "${key}"`, e);
      }
    }
    pending.clear();
  };

  const schedule = key => {
    pending.add(key);
    if (timer !== null) return;
    timer = setTimeout(flush, FLUSH_DELAY);
  };

  store.subscribe(mutation => {
    const key = MUTATION_TO_KEY[mutation.type];
    if (key) schedule(key);
  });

  if (typeof window !== 'undefined') {
    // 页面即将隐藏 / 关闭时立即落盘，避免防抖窗口内丢数据
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
  }
};
