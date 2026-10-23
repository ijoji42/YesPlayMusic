import Vue from 'vue';
import VueClipboard from 'vue-clipboard2';
import VueI18n from 'vue-i18n';
import store from '@/store';

import en from './lang/en.js';
import zhCN from './lang/zh-CN.js';
import zhTW from './lang/zh-TW.js';
import tr from './lang/tr.js';
import ext from './lang/ext.js';

Vue.use(VueClipboard);
Vue.use(VueI18n);

// 把增量文案（lang/ext.js）深合并进基础语言包。
// 数组按整体替换处理；这里没有数组文案，但写全了避免以后踩坑。
function deepMerge(base, extra) {
  const out = Object.assign({}, base);
  Object.keys(extra).forEach(key => {
    const a = out[key];
    const b = extra[key];
    if (
      a &&
      b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      out[key] = deepMerge(a, b);
    } else {
      out[key] = b;
    }
  });
  return out;
}

const i18n = new VueI18n({
  locale: store.state.settings.lang,
  messages: {
    en: deepMerge(en, ext.en),
    'zh-CN': deepMerge(zhCN, ext['zh-CN']),
    'zh-TW': deepMerge(zhTW, ext['zh-TW']),
    tr: deepMerge(tr, ext.tr),
  },
  silentTranslationWarn: true,
});

export default i18n;
