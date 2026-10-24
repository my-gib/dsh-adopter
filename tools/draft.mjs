// 读 / 清抖音私信输入框里的草稿。
//
// 为什么单独有个工具：发送失败时如果已经点了按钮，chat-browser 的清理逻辑不会跑
// （它的条件是「还没点过」），残留草稿会堵死下一次发送。这时候需要人工看一眼、清一下。
//
// 坑：不能把 readConversation 放进 withPage 回调里 —— 同一把 tab-api-chat 锁重入会死锁。
// 所以下面分两步：先 readConversation（自己拿锁并释放），再单独开一次 withPage 摸输入框。
//
//   node tools/draft.mjs            # 只看
//   node tools/draft.mjs --clear    # 看完再清

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatBrowser } from '../src/dom/chat-browser.mjs';
import { BrowserController } from '../src/browser/controller.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(HERE, '..', 'config.json'), 'utf8'));
const douyin = (config.channels ?? []).find((item) => item.id === 'douyin') ?? {};
const recipientId = douyin.recipientId || config.recipientId;

if (!recipientId) {
  console.error('config.json 里没有 douyin 的 recipientId，先跑 node adopter.mjs --dump-contacts。');
  process.exit(1);
}

const clear = process.argv.includes('--clear');
const readable = (value) => value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();

const controller = new BrowserController({ source: 'api-chat' });
const browser = new ChatBrowser({ source: 'api-chat', controller });

try {
  // 第一步：进到目标会话
  const snapshot = await browser.readConversation(recipientId, { allowed: true });
  console.log('会话：', snapshot?.conversation?.displayName ?? '?');
  if (snapshot?.loginRequired || snapshot?.verificationRequired || snapshot?.blocked) {
    console.log('会话不可用：', JSON.stringify({ loginRequired: snapshot.loginRequired, verificationRequired: snapshot.verificationRequired, blocked: snapshot.blocked }));
    process.exitCode = 1;
  }

  // 第二步：另起一次 withPage 摸输入框（此时第一把锁已经释放）
  await controller.withPage(async (page) => {
    const editors = page.locator('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]');
    const count = await editors.count();
    console.log('输入框数量：', count);
    if (count !== 1) {
      console.log('输入框不唯一，不做任何处理。');
      return;
    }

    const text = readable(await editors.innerText());
    const attachments = await editors.locator('img,video,audio,[data-slate-void="true"]').count();
    console.log('草稿长度：', text.length);
    console.log('草稿内容：', JSON.stringify(text.slice(0, 300)));
    console.log('非文本附件：', attachments);

    if (!clear) return;
    if (!text && attachments === 0) {
      console.log('本来就没有草稿，无需清理。');
      return;
    }

    await editors.evaluate((element) => {
      element.textContent = '';
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    });
    const after = readable(await editors.innerText());
    console.log(after === '' ? '✔ 已清空' : `✖ 没清干净：${JSON.stringify(after.slice(0, 80))}`);
  });
} finally {
  await browser.close().catch(() => {});
}
