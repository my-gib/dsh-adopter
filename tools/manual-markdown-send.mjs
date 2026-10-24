// 验证 P2/P3：直接调 ChatBrowser.sendMessage 发一条**带 Markdown 标记**的文本。
//
// 为什么要绕过 adopter 的 /send：那条路径上有 toPlainText 会把 `**` 剥掉，
// 就测不到「编辑器改写后回读不相等」这个原始问题了。
//
//   node tools/test-markdown-send.mjs
//
// 期望：confirmed: true（归一化比对照样通过）。
// 如果失败，看 reason，并顺便检查输入框有没有留下草稿（P3 该把它清干净）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatBrowser } from '../src/dom/chat-browser.mjs';
import { BrowserController } from '../src/browser/controller.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(HERE, '..', 'config.json'), 'utf8'));
const douyin = (config.channels ?? []).find((item) => item.id === 'douyin') ?? {};
const recipientId = douyin.recipientId || config.recipientId;

// 故意带三种 Slate 最爱改写的标记
const text = '测试：这条带 **加粗** 和 `代码` 还有 # 井号';

const controller = new BrowserController({ source: 'api-chat' });
const browser = new ChatBrowser({ source: 'api-chat', controller });

const readable = (value) => value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();

try {
  console.log('要发的原文：', JSON.stringify(text));
  const result = await browser.sendMessage(recipientId, text, { allowed: true });
  console.log('\n发送结果：');
  console.log(JSON.stringify(result, null, 2));

  // P3 验证：失败之后输入框应该是干净的
  await controller.withPage(async (page) => {
    const editors = page.locator('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]');
    if ((await editors.count()) !== 1) {
      console.log('输入框不唯一，跳过草稿检查。');
      return;
    }
    const draft = readable(await editors.innerText());
    console.log('\n残留草稿：', draft === '' ? '（空，干净）' : JSON.stringify(draft));
  });

  console.log(
    result?.confirmed === true
      ? '\n✅ P2 通过：带 Markdown 的文本能发出去（归一化比对生效）'
      : `\n⚠️ 没发出去，reason 见上。若残留草稿为空说明 P3 生效（没留垃圾）。`,
  );
} finally {
  await browser.close().catch(() => {});
}
