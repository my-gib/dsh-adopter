// 清理某个会话输入框里的草稿 —— 发送失败留下的残留会把通道堵死。
//
// 为什么必须有这个：chat-browser.sendMessage 开头有一道闸
//   `if (existingDraft.rendered || ...) throw new Error('当前会话已有草稿，已停止发送以保留原内容。')`
// 而发送失败（比如点击没落地）恰恰会在输入框里留下可见的文字。
// 于是「一次失败」会变成「以后每一次都失败」，得手动清。
//
// 清理手段只用 STATUS.md 坑 3 实测有效的那一个：Ctrl+A → Delete。
// （textContent='' 只清 DOM、model 里留字，下次输入会复活；fill('') 一个字都删不掉。）
//
// 只清当前会话的输入框，不发送任何消息。
//
//   node tools/clear-draft.mjs            # 清列表第 0 个会话
//   node tools/clear-draft.mjs --index 1  # 清第 1 个
//   node tools/clear-draft.mjs --all      # 把所有会话都清一遍（会逐个点开）

import { BrowserController } from '../src/browser/controller.mjs';

const argv = process.argv.slice(2);
const indexAt = argv.indexOf('--index');
const onlyIndex = indexAt >= 0 ? Number(argv[indexAt + 1] ?? 0) : 0;
const all = argv.includes('--all');

const controller = new BrowserController({
  source: 'api-chat',
  homeUrl: 'https://www.douyin.com/?recommend=1&from_nav=1',
  readySelector: '[data-e2e="im-entry"]',
  allowedOrigins: ['https://www.douyin.com'],
  closePageOnExit: true,
});

try {
  await controller.withPage(async (page) => {
    await page.waitForLoadState('load').catch(() => {});
    if (!(await page.locator('[data-e2e="im-dialog"]').isVisible().catch(() => false))) {
      await page.locator('[data-e2e="im-entry"]').click({ timeout: 20000 });
      await page.locator('[data-e2e="im-dialog"]').waitFor({ state: 'visible', timeout: 10000 });
    }
    await page.waitForTimeout(1200);

    const names = await page.evaluate(() => [...document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="conversation-item"]')]
      .map((row, index) => ({
        index,
        name: (row.querySelector('.conversationConversationItemtitle')?.textContent ?? '').trim(),
      })));
    console.log('会话列表：', JSON.stringify(names));

    const targets = all ? names.map((item) => item.index) : [onlyIndex];

    for (const index of targets) {
      // 会话层是压在列表层上的，先退回去才能点列表项
      const back = page.locator('[data-stack-layer="chat"] .StackLayoutStackTitleBarbackBtn');
      if (await back.count() === 1) {
        await back.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(600);
      }
      const row = page.locator('[data-e2e="im-dialog"] [data-e2e="conversation-item"]').nth(index);
      const label = (await row.locator('.conversationConversationItemtitle').textContent().catch(() => '?'))?.trim();
      await row.click({ timeout: 10000 });
      await page.waitForTimeout(1500);

      const editor = page.locator('[data-e2e="msg-input"] [contenteditable="true"]').first();
      if (await editor.count() !== 1) {
        console.log(`[${index}] ${label}：找不到输入框，跳过`);
        continue;
      }

      // 注意：这是**正则字面量**，反斜杠只能写一个。原来写成 \\u200B 匹配的是
      // 字面上的「u200B」，于是明明清干净了（只剩零宽占位符）也会报「没清干净」。
      const zeroWidth = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
      const read = async () => (await editor.innerText().catch(() => '')).replace(zeroWidth, '').trim();
      const before = await read();
      if (!before) {
        console.log(`[${index}] ${label}：输入框是空的，不用清`);
        continue;
      }

      console.log(`[${index}] ${label}：清理前「${before.slice(0, 60)}」（${before.length} 字）`);
      await editor.click({ timeout: 8000 }).catch(() => {});
      // 只认 Ctrl+A + Delete：编辑器在 model 层全选后删除，DOM 只留一个空行占位
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(120);
      await page.keyboard.press('Delete');
      await page.waitForTimeout(400);

      const after = await read();
      if (after) {
        console.log(`[${index}] ${label}：⚠ 没清干净，还剩「${after.slice(0, 60)}」—— 可能需要再跑一次或人工清`);
      } else {
        console.log(`[${index}] ${label}：✓ 已清空`);
      }
    }

    await page.screenshot({ path: 'logs/clear-draft.png' }).catch(() => {});
  });
} finally {
  await controller.close().catch(() => {});
}
