// 数「某个 adopter 页面」到底被整页重载了几次。
//
// 判据：`performance.timeOrigin` 只在**整页加载**时变化。SPA 路由跳转（pushState）、
// DOM 更新、面板开关都不会改它。所以它数出来的就是「真刷新」。
//
//   node tools/watch-page-reloads.mjs [分钟=10] [页面名片段=douyin-notice]
//
// 用法场景：改完 douyin-notice.mjs 的重载闸之后，挂这个观察一段时间，
// `重载次数 = 0` 就是「不再整页刷新」的实证。
//
// ⚠️ 只连不关：这个脚本**不会**调用 browser.close()。
//    Playwright 对 connectOverCDP 的连接调 close() 会把整个 Edge 关掉，
//    那样 adopter 就失明了（杀 Edge 是本项目的硬禁忌）。

import { chromium } from '../src/browser/playwright.mjs';

const minutes = Number(process.argv[2] ?? 10);
const nameHint = process.argv[3] ?? 'douyin-notice';
const SAMPLE_MS = 2000;

const browser = await chromium.connectOverCDP('http://127.0.0.1:9227', { timeout: 15_000 });
const context = browser.contexts()[0];
if (!context) {
  console.log('没有可用窗口。');
  process.exit(0);
}

async function findPage() {
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    const name = await page.evaluate(() => window.name).catch(() => '');
    if (name.includes(nameHint)) return { page, name };
  }
  return null;
}

const found = await findPage();
if (!found) {
  const names = [];
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    names.push(await page.evaluate(() => `${window.name} | ${location.href}`).catch(() => '(closed)'));
  }
  console.log(`没找到窗口名含「${nameHint}」的页面。现有页面：`);
  for (const line of names) console.log(`  ${line}`);
  process.exit(0);
}

const { page, name } = found;
console.log(`观察页面：${name}`);
console.log(`采样间隔：${SAMPLE_MS}ms，观察 ${minutes} 分钟（${new Date().toISOString()} 起）`);

const startedAt = Date.now();
let lastOrigin = null;
let lastUrl = null;
let reloads = 0;
const events = [];
let samples = 0;
let evalErrors = 0;

while (Date.now() - startedAt < minutes * 60_000) {
  let state = null;
  try {
    state = await page.evaluate(() => ({
      origin: performance.timeOrigin,
      url: location.href,
      nav: performance.getEntriesByType('navigation')?.[0]?.type ?? null,
      panel: Boolean(document.querySelector('[data-e2e="user-name-card"]')) && document.body.innerText.includes('互动消息'),
    }));
  } catch (error) {
    // 导航中执行上下文会销毁 —— 不直接算重载，等下一轮用 timeOrigin 判定
    evalErrors += 1;
  }

  if (state) {
    samples += 1;
    if (lastOrigin !== null && state.origin !== lastOrigin) {
      reloads += 1;
      /**
       * 分清「谁刷的」——这是这个工具最关键的一列。
       *   goto        adopter 调了 page.goto()：**URL 会变**（回到 HOME）
       *   self-reload URL 没变、nav=reload：页面自己的脚本刷的（抖音断网重试 / 路由打转）
       *   same-url    URL 没变但 nav=navigate：同址重新导航
       * 只有 goto 该算 adopter 的账。
       */
      const kind = state.url === lastUrl ? (state.nav === 'reload' ? 'self-reload' : 'same-url') : 'goto';
      const event = {
        at: new Date().toISOString(),
        elapsedMin: Math.round(((Date.now() - startedAt) / 60000) * 10) / 10,
        kind,
        nav: state.nav,
        from: lastUrl,
        to: state.url,
      };
      events.push(event);
      console.log(`[重载 #${reloads}] +${event.elapsedMin}min kind=${kind} nav=${event.nav}`);
      console.log(`    ${event.from}\n    → ${event.to}`);
    }
    lastOrigin = state.origin;
    lastUrl = state.url;
  }
  await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
}

console.log('\n=== 汇总 ===');
console.log(
  JSON.stringify(
    {
      page: name,
      windowMinutes: minutes,
      from: new Date(startedAt).toISOString(),
      to: new Date().toISOString(),
      samples,
      evalErrors,
      reloads,
      byKind: events.reduce((acc, event) => {
        acc[event.kind] = (acc[event.kind] ?? 0) + 1;
        return acc;
      }, {}),
      events,
    },
    null,
    2,
  ),
);
// 刻意不调 browser.close()：见文件头。
process.exit(0);
