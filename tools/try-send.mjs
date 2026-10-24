// 试验性发送：不经过 ChatBrowser.sendMessage 的那一大坨校验，自己一步步来，
// 把每一步的真实结果打出来。目的有两个：
//   1. 搞清楚「点击发送」到底是哪里失败（怀疑 sendMessage 里 timeout:350 太短）
//   2. 确认这条链路现在还能不能真的把字发出去
//
//   node tools/try-send.mjs "要发的话"
//
// 注意：这是真的发送，会发到对方那里。想只在本地试就别跑这个。
//
// 守坑：不在 withPage 回调里调 readConversation（同锁重入死锁）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatBrowser, readConversationDom } from '../src/dom/chat-browser.mjs';
import { BrowserController } from '../src/browser/controller.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(HERE, '..', 'config.json'), 'utf8'));
const douyin = (config.channels ?? []).find((item) => item.id === 'douyin') ?? {};
const recipientId = douyin.recipientId || config.recipientId;

const text = (process.argv[2] ?? '').trim();
if (!text) {
  console.error('用法：node tools/try-send.mjs "要发的话"');
  process.exit(1);
}

const readable = (value) => value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
const step = (label, value) => console.log(`  ${label}: ${value}`);

const controller = new BrowserController({ source: 'api-chat' });
const browser = new ChatBrowser({ source: 'api-chat', controller });

try {
  // 第一步：进会话，记下现有消息数（一会儿对比）
  const before = await browser.readConversation(recipientId, { allowed: true });
  console.log('进入会话：', before?.conversation?.displayName, '现有', before?.messages?.length, '条');
  if (before?.loginRequired || before?.verificationRequired || before?.blocked) {
    console.log('会话不可用，停。', JSON.stringify({ loginRequired: before.loginRequired, verificationRequired: before.verificationRequired, blocked: before.blocked }));
    process.exit(1);
  }
  const beforeCount = before.messages.length;

  // 第二步：自己操作输入框和按钮
  let sent = false;
  await controller.withPage(async (page) => {
    const editor = page.locator('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]');
    step('输入框数量', await editor.count());
    if ((await editor.count()) !== 1) throw new Error('输入框不唯一，中止');

    step('填写前草稿', JSON.stringify(readable(await editor.innerText())));
    if (readable(await editor.innerText())) throw new Error('已有草稿，中止（先跑 tools/draft.mjs --clear）');

    await editor.fill(text);
    step('fill 后立刻读回', JSON.stringify(readable(await editor.innerText())));
    await page.waitForTimeout(400);
    step('等 400ms 后读回', JSON.stringify(readable(await editor.innerText())));

    const button = page.locator('.e2e-send-msg-btn,[data-e2e="send-msg-btn"]').first();
    step('按钮数量', await page.locator('.e2e-send-msg-btn,[data-e2e="send-msg-btn"]').count());
    step('按钮可见', await button.isVisible().catch((error) => `读取失败 ${error.message.split('\n')[0]}`));
    step('按钮 disabled', await button.isDisabled().catch((error) => `读取失败 ${error.message.split('\n')[0]}`));
    step('按钮 box', JSON.stringify(await button.boundingBox().catch(() => null)));

    // 真点，给足 8 秒而不是 350ms
    const started = Date.now();
    try {
      await button.click({ timeout: 8000 });
      step('点击耗时', `${Date.now() - started}ms（成功）`);
    } catch (error) {
      step('点击耗时', `${Date.now() - started}ms（失败）`);
      step('点击错误', error.message.split('\n')[0]);
    }

    await page.waitForTimeout(2000);
    step('点击后草稿', JSON.stringify(readable(await editor.innerText())));

    const after = await page.evaluate(readConversationDom);
    step('点击后消息数', (after.messages ?? []).length);
    const last = (after.messages ?? []).at(-1);
    if (last) {
      step('最后一条', `sender=${last.sender} kind=${last.kind} ${JSON.stringify((last.text ?? '').slice(0, 50))}`);
    }
    sent = (after.messages ?? []).length > beforeCount;

    // 没发出去就别留草稿堵路。
    // 注意用 Ctrl+A + Delete，不要用 element.textContent = '' —— 那只能清掉 DOM，
    // 编辑器的 model 里字还在，下一次填字会把旧文本一起渲染出来（见 HANDOFF 二十二）。
    if (!sent && readable(await editor.innerText())) {
      await editor.click({ timeout: 3000 });
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
      await page.waitForTimeout(150);
      step('已清理草稿', JSON.stringify(readable(await editor.innerText())));
    }
  });

  console.log(sent ? '\n✅ 消息数增加了，发出去了一条' : '\n❌ 消息数没变，还是没发出去');
  process.exitCode = sent ? 0 : 1;
} finally {
  await browser.close().catch(() => {});
}
