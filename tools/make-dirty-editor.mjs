// 故意把输入框弄成「DOM 空、model 脏」——就是日志里「填写前 0 字／回读 91 字」那个现场。
//
// 用法（两步要连着跑，中间别让人碰页面）：
//   node tools/make-dirty-editor.mjs
//   node tools/try-endpoint.mjs
//
// 修好之后，/send 应该会把这段隐形残留扫掉，发出干净的原文；
// 修之前，它会读回「这段残留 + 新文本」然后拒绝发送。

import { BrowserController } from '../src/browser/controller.mjs';

const EDITOR = '[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]';
const readable = (value) => String(value ?? '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
const DIRTY = '这是探针故意塞进去的残留（不该被发出去）';

const controller = new BrowserController({ source: 'api-chat', closePageOnExit: false });

try {
  await controller.withPage(async (page) => {
    const editor = page.locator(EDITOR);
    if ((await editor.count()) !== 1) throw new Error(`输入框不唯一：${await editor.count()}`);

    await editor.click({ timeout: 3000 });
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(150);

    await editor.fill(DIRTY);
    await page.waitForTimeout(200);
    const filled = await editor.innerText();
    console.log(`填进去之后读回：${JSON.stringify(readable(filled))}`);

    await editor.evaluate((element) => {
      element.textContent = '';
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    });
    await page.waitForTimeout(200);

    const state = await editor.evaluate((element) => ({
      innerText: element.innerText ?? '',
      textContent: element.textContent ?? '',
      children: element.childElementCount,
    }));
    console.log(`清 DOM 之后：innerText=${JSON.stringify(readable(state.innerText))} textContent=${JSON.stringify(readable(state.textContent))} children=${state.children}`);
    console.log('现在编辑器看起来是空的，但 model 里还压着上面那句话 —— 跑 tools/try-endpoint.mjs 看 /send 怎么处理。');
  });
} finally {
  await controller.close().catch(() => {});
}
