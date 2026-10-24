// 清理专用 Edge 里堆积的测试标签页。
//
// 背景：BrowserController.close() 只断开 CDP 连接，不关闭标签页；每个工具脚本开一个
// source 就会留下一个窗口。这个脚本按 window.name 认出「本工具开的页」，关掉不要的。
//
// 归属规则（靠 window.name 认）：
//   deepseek-douyin-api-chat   adopter 的私信通道，常驻进程正连着它 —— 保留
//   deepseek-douyin-api-*      本工具临时开的探针页 —— 清理
//   deepseek-douyin-dsh*       dsh 插件的页面 —— 不归我们管，不动
//   其它                       用户自己开的 —— 不动
//
//   node tools/cleanup-pages.mjs            # 只看，不关
//   node tools/cleanup-pages.mjs --close    # 真的关

import { chromium } from '../src/browser/playwright.mjs';

const doClose = process.argv.includes('--close');
const KEEP = new Set(['deepseek-douyin-api-chat']);
// 插件的页面，绝不动
const PLUGIN = /^deepseek-douyin-dsh/;

const browser = await chromium.connectOverCDP('http://127.0.0.1:9227', { timeout: 15_000 });
try {
  const rows = [];
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      const name = await page.evaluate(() => window.name).catch(() => '');
      rows.push({
        page,
        name: typeof name === 'string' ? name : '',
        title: (await page.title().catch(() => '')).slice(0, 30),
        url: page.url().slice(0, 80),
      });
    }
  }

  const classify = (name) => {
    if (!name.startsWith('deepseek-douyin-')) return { tag: '（用户自己的页面，不动）', cleanable: false };
    if (PLUGIN.test(name)) return { tag: '（插件的页面，不动）', cleanable: false };
    if (KEEP.has(name)) return { tag: '（保留：私信通道）', cleanable: false };
    return { tag: '（本工具开的探针页，清理）', cleanable: true };
  };

  console.log(`共 ${rows.length} 个页面：\n`);
  for (const row of rows) {
    const { tag } = classify(row.name);
    console.log(`  ${row.name || '(无 window.name)'} ${tag}`);
    console.log(`     ${row.title} | ${row.url}`);
  }

  const targets = rows.filter((row) => classify(row.name).cleanable);
  console.log(`\n可清理：${targets.length} 个`);

  if (!doClose) {
    console.log('（没有关。加 --close 才真的关。）');
  } else {
    let closed = 0;
    for (const target of targets) {
      await target.page.close().catch(() => {});
      closed += 1;
    }
    console.log(`已关闭 ${closed} 个；剩余 ${rows.length - closed} 个。`);
  }
} finally {
  await browser.close().catch(() => {});
}
