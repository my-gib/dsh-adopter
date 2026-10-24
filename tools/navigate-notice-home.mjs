// 把通知通道那张页面拨回首页 —— **一次性人工修复**，不是轮询路径。
//
// 什么时候需要：页面被带偏到 `user/self`（个人主页）或作品页时，顶部「通知」入口
// hover 也能打开浮层，但浮层里的列表是空的 → 通道一直读到 0 条通知，而且因为
// 「浮层能打开」它不会触发重载闸，自己永远回不来。
//
// 为什么不在轮询里做：每轮都导航回首页就是用户抱怨的「页时不时刷新」。
// 这种「页面被带偏」是外部事件（抖音自己的路由 JS 会把页面导到 user/self，
// 见 tools/probe-reload-initiator.mjs 的 initiator 栈），不是每轮都会发生的事，
// 所以交给人工/一次性工具处理更安全。
//
//   node tools/navigate-notice-home.mjs          # 只报告当前 URL
//   node tools/navigate-notice-home.mjs --go     # 真的拨回首页
//
// ⚠️ 不调 browser.close()：CDP 连接的 close() 会关掉整个 Edge。

import { chromium } from '../src/browser/playwright.mjs';

const HOME = 'https://www.douyin.com/?recommend=1&from_nav=1';
const go = process.argv.includes('--go');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9227', { timeout: 15_000 });
const context = browser.contexts()[0];

let target = null;
for (const page of context.pages()) {
  if (page.isClosed()) continue;
  const name = await page.evaluate(() => window.name).catch(() => '');
  if (name.includes('douyin-notice')) {
    target = page;
    console.log(`找到通知页面：${name}`);
    break;
  }
}

if (!target) {
  console.log('没找到通知页面（window.name 含 douyin-notice）。');
  process.exit(0);
}

const before = await target.evaluate(() => ({ url: location.href, origin: performance.timeOrigin }));
console.log(`当前 URL：${before.url}`);

if (!go) {
  console.log('\n（只报告，没有改动。要拨回首页请加 --go）');
  process.exit(0);
}

if (before.url === HOME || before.url.startsWith('https://www.douyin.com/?recommend=1')) {
  console.log('已经在首页，不用动。');
  process.exit(0);
}

console.log(`\n拨回首页：${HOME}`);
await target.goto(HOME, { waitUntil: 'domcontentloaded' });
await target.waitForTimeout(3500);
await target
  .evaluate(() => {
    for (const video of document.querySelectorAll('video')) {
      video.muted = true;
      video.pause();
    }
  })
  .catch(() => {});

const after = await target.evaluate(() => ({ url: location.href, origin: performance.timeOrigin }));
console.log(`现在 URL：${after.url}`);
console.log(`页面重载：${before.origin !== after.origin}（这是这一次人工修复，不是轮询行为）`);
// 不调 browser.close()：见文件头。
process.exit(0);
