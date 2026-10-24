// 一次性快照：专用 Edge 里每张页面叫什么、停在哪、导航类型、能不能找到「通知」入口。
//
// 排查「每 15 秒整页刷新一次」用。只读，不导航，不关浏览器。
//
//   node tools/dump-pages.mjs

import { chromium } from '../src/browser/playwright.mjs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9227', { timeout: 15_000 });
const context = browser.contexts()[0];
const rows = [];

for (const page of context.pages()) {
  if (page.isClosed()) continue;
  let info = null;
  try {
    info = await page.evaluate(() => {
      const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
      const entries = [...document.querySelectorAll('div,span,a,button')].filter((element) => clean(element.innerText) === '通知');
      const nav = performance.getEntriesByType('navigation')?.[0] ?? null;
      return {
        name: window.name,
        url: location.href,
        title: document.title,
        timeOrigin: performance.timeOrigin,
        ageMs: Math.round(performance.now()),
        navType: nav?.type ?? null,
        noticeEntries: entries.length,
        noticeRects: entries.slice(0, 3).map((element) => {
          const box = element.getBoundingClientRect();
          return `${Math.round(box.width)}x${Math.round(box.height)}@${Math.round(box.left)},${Math.round(box.top)}`;
        }),
        cards: document.querySelectorAll('[data-e2e="user-name-card"]').length,
        hasPanelTitle: document.body.innerText.includes('互动消息'),
      };
    });
  } catch (error) {
    info = { error: String(error?.message ?? error).slice(0, 160) };
  }
  rows.push(info);
}

console.log(JSON.stringify(rows, null, 2));
// 不调 browser.close()：CDP 连接的 close() 会关掉整个 Edge。
process.exit(0);
