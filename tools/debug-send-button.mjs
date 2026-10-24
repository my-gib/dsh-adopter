// 调试：把评论回复框右侧那片区域的所有小元素连样式一起 dump，
// 目地是看清「发送键」到底是什么标签、颜色写在哪（backgroundColor? backgroundImage?）。
//
//   node tools/debug-send-button.mjs [作品ID] [关键词]

import { BrowserController } from '../src/browser/controller.mjs';

const videoId = process.argv[2] || '7411803066837519652';
const keyword = process.argv[3] || '示例号';

const controller = new BrowserController({
  source: 'api-probe',
  homeUrl: `https://www.douyin.com/video/${videoId}`,
  readySelector: '',
  allowedOrigins: ['https://www.douyin.com'],
});

try {
  await controller.withPage(async (page) => {
    await page.waitForLoadState('load').catch(() => {});
    await page.goto(`https://www.douyin.com/video/${videoId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5200);
    await page
      .evaluate(() => {
        for (const video of document.querySelectorAll('video')) {
          video.muted = true;
          video.pause();
        }
      })
      .catch(() => {});

    // 找到目标评论并点开回复
    const comments = page.locator('[data-e2e="comment-item"]');
    const total = await comments.count();
    let index = -1;
    for (let i = 0; i < Math.min(total, 15); i += 1) {
      const text = await comments.nth(i).innerText().catch(() => '');
      if (text.includes(keyword)) {
        index = i;
        break;
      }
    }
    if (index < 0) throw new Error(`没找到含「${keyword}」的评论`);
    console.log('命中评论 #', index);

    await comments.nth(index).getByText('回复', { exact: true }).first().click({ timeout: 8000 });
    await page.waitForTimeout(1800);

    // 输入一点字，让发送键变成可用状态（空输入时它常常是隐藏/禁用的）
    const editors = page.locator('.public-DraftEditor-content');
    const count = await editors.count();
    let editorIndex = 0;
    for (let i = 0; i < count; i += 1) {
      const inside = await editors.nth(i).evaluate((element) => Boolean(element.closest('[data-e2e="comment-item"]')));
      if (inside) {
        editorIndex = i;
        break;
      }
    }
    await editors.nth(editorIndex).click({ timeout: 8000 });
    await page.keyboard.type('调试', { delay: 20 });
    await page.waitForTimeout(700);

    const dump = await page.evaluate(() => {
      const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
      const editorNode = [...document.querySelectorAll('.public-DraftEditor-content')].find((element) =>
        element.closest('[data-e2e="comment-item"]'),
      );
      if (!editorNode) return { found: false };
      const editorBox = editorNode.getBoundingClientRect();

      const near = [];
      for (const element of document.querySelectorAll('div,span,button,svg,i')) {
        const box = element.getBoundingClientRect();
        if (box.width < 10 || box.width > 90 || box.height < 10 || box.height > 90) continue;
        // 编辑器右侧 400px 内，垂直 ±120
        if (box.left < editorBox.right - 60) continue;
        if (box.left > editorBox.right + 400) continue;
        if (Math.abs(box.top - editorBox.top) > 120) continue;

        const style = getComputedStyle(element);
        near.push({
          tag: element.tagName,
          cls: typeof element.className === 'string' ? element.className.slice(0, 50) : null,
          size: `${Math.round(box.width)}x${Math.round(box.height)}`,
          left: Math.round(box.left),
          top: Math.round(box.top),
          bg: style.backgroundColor,
          bgImage: style.backgroundImage === 'none' ? null : style.backgroundImage.slice(0, 70),
          fill: style.fill === 'none' ? null : style.fill,
          text: clean(element.innerText).slice(0, 12) || null,
          hasSvg: Boolean(element.querySelector('svg')),
        });
      }

      return {
        found: true,
        editorBox: { left: Math.round(editorBox.left), top: Math.round(editorBox.top), right: Math.round(editorBox.right), width: Math.round(editorBox.width) },
        viewport: `${innerWidth}x${innerHeight}`,
        near,
      };
    });

    console.log('\n=== 编辑器 ===');
    console.log(JSON.stringify(dump.editorBox));
    console.log('viewport：', dump.viewport);
    console.log(`\n=== 右侧附近元素（${dump.near.length} 个）===`);
    for (const item of dump.near) {
      console.log(
        `  ${item.tag.padEnd(4)} ${String(item.size).padEnd(9)} left=${String(item.left).padEnd(5)} top=${String(item.top).padEnd(5)}` +
          ` bg=${String(item.bg).padEnd(22)} ${item.hasSvg ? '[svg]' : '     '} ${item.bgImage ? `bgImage=${item.bgImage}` : ''} ${item.text ? `text=${item.text}` : ''}`,
      );
    }

    await page.screenshot({ path: 'logs/debug-send-button.png' }).catch(() => {});
    console.log('\n截图：logs/debug-send-button.png');

    // 清场
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  });
} finally {
  await controller.close().catch(() => {});
}
