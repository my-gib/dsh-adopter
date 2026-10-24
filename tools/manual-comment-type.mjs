// 测试：Draft.js 评论框能不能被程序输入文字。
//
// 只输入 + 读回 + 清空，**绝不点发送**。发评论是公开发布，必须人工确认。
//
//   node tools/test-comment-type.mjs [作品ID]

import { BrowserController } from '../src/browser/controller.mjs';

const videoId = process.argv[2] || '7411803066837519652';
const sample = '测试输入：这条不会发出去';

const controller = new BrowserController({
  source: 'api-probe',
  homeUrl: `https://www.douyin.com/video/${videoId}`,
  readySelector: '',
  allowedOrigins: ['https://www.douyin.com'],
});

try {
  await controller.withPage(async (page) => {
    await page.waitForLoadState('load').catch(() => {});
    if (!page.url().includes(String(videoId))) {
      await page.goto(`https://www.douyin.com/video/${videoId}`, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForTimeout(5000);
    await page
      .evaluate(() => {
        for (const video of document.querySelectorAll('video')) {
          video.muted = true;
          video.pause();
        }
      })
      .catch(() => {});

    // 1. 点第一条评论的「回复」，让回复框出现
    const replyEntry = page.locator('[data-e2e="comment-item"]').first().getByText('回复', { exact: true }).first();
    console.log('「回复」入口数量：', await replyEntry.count());
    await replyEntry.click({ timeout: 8000 }).catch((error) => console.log('点回复失败：', error.message.split('\n')[0]));
    await page.waitForTimeout(2000);

    // 2. 编辑器可能有多个（主框 + 回复框），取最靠下的那个 = 回复框
    const editors = page.locator('.public-DraftEditor-content');
    const count = await editors.count();
    console.log('Draft 编辑器数量：', count);

    const boxes = [];
    for (let index = 0; index < count; index += 1) {
      const box = await editors.nth(index).boundingBox();
      boxes.push({ index, top: box ? Math.round(box.top) : null, height: box ? Math.round(box.height) : null });
    }
    console.log('各编辑器位置：', JSON.stringify(boxes));

    const replyIndex = boxes.filter((item) => item.top !== null).sort((a, b) => b.top - a.top)[0]?.index ?? 0;
    console.log('选中回复框 index =', replyIndex);
    const editor = editors.nth(replyIndex);

    // 3. 点进去，用键盘输入（Draft.js 监听 beforeinput，fill() 不靠谱）
    await editor.click({ timeout: 8000 }).catch((error) => console.log('点编辑器失败：', error.message.split('\n')[0]));
    await page.keyboard.type(sample, { delay: 30 });
    await page.waitForTimeout(800);

    const readBack = await page.evaluate(() => {
      const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
      return [...document.querySelectorAll('.public-DraftEditor-content')].map((element) => clean(element.innerText));
    });
    console.log('\n输入后各编辑器内容：', JSON.stringify(readBack));

    const typed = readBack.some((text) => text.includes('测试输入'));
    console.log(typed ? '\n✅ Draft.js 能吃 keyboard.type 打进去的字' : '\n❌ 打不进去，得换别的方式');

    // 4. 清空，别留草稿
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.waitForTimeout(600);
    const afterClear = await page.evaluate(() => {
      const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
      return [...document.querySelectorAll('.public-DraftEditor-content')].map((element) => clean(element.innerText));
    });
    console.log('清空后：', JSON.stringify(afterClear));

    await page.screenshot({ path: 'logs/comment-typed.png' }).catch(() => {});
    console.log('截图：logs/comment-typed.png');
    await page.keyboard.press('Escape').catch(() => {});
  });
} finally {
  await controller.close().catch(() => {});
}
