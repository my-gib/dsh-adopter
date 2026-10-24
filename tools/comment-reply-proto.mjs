// 原型：定位某条评论 → 点「回复」→ 在回复框里输入 → 读回验证 → 清空。
//
// **绝不点发送**。发评论是公开发布，必须人工确认每一步。
//
// 用法：
//   node tools/comment-reply-proto.mjs <作品ID> [评论ID|关键词] ["要输入的文字"]
//
// 不给评论时用第一条评论。给纯数字当评论 ID，给其他当关键词匹配评论内容。

import { BrowserController } from '../src/browser/controller.mjs';

const videoId = process.argv[2] || '7411803066837519652';
const target = process.argv[3] || '';
const text = process.argv[4] || '原型验证：这句不会发出去';

const byCommentId = /^\d{10,}$/.test(target);
const keyword = byCommentId ? '' : target;

const controller = new BrowserController({
  source: 'api-probe',
  homeUrl: `https://www.douyin.com/video/${videoId}`,
  readySelector: '',
  allowedOrigins: ['https://www.douyin.com'],
});

const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();

/** 读当前所有 Draft 编辑器的位置与内容，用来区分「主评论框」和「回复框」 */
async function readEditors(page) {
  return page.evaluate(() => {
    const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('.public-DraftEditor-content')].map((element) => {
      const box = element.getBoundingClientRect();
      // 回复框通常在 comment-item 内部或紧邻；主框在页面底部
      const insideComment = Boolean(element.closest('[data-e2e="comment-item"]'));
      return {
        text: clean(element.innerText),
        top: Math.round(box.top),
        height: Math.round(box.height),
        visible: box.width > 0 && box.height > 0,
        insideComment,
      };
    });
  });
}

try {
  await controller.withPage(async (page) => {
    await page.waitForLoadState('load').catch(() => {});

    // 强制重新导航：复用旧标签页会带着上一轮的编辑器状态，定位必然错
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

    console.log('URL：', page.url());
    console.log('刷新后编辑器：', JSON.stringify(await readEditors(page)));

    // 1. 找目标评论
    const comments = page.locator('[data-e2e="comment-item"]');
    const total = await comments.count();
    console.log('\n可见评论数：', total);

    let targetIndex = -1;
    const list = [];
    for (let index = 0; index < Math.min(total, 12); index += 1) {
      const info = await comments.nth(index).evaluate((element) => ({
        text: (element.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
        commentId: element.getAttribute('data-comment-id') ?? null,
      }));
      list.push({ index, ...info });
      const hit = byCommentId ? info.commentId === target : keyword ? info.text.includes(keyword) : index === 0;
      if (hit && targetIndex < 0) targetIndex = index;
    }
    console.log('评论清单：');
    for (const item of list) console.log(`  #${item.index} id=${item.commentId} ${JSON.stringify(item.text.slice(0, 60))}`);

    if (targetIndex < 0) throw new Error(`没找到目标评论（${byCommentId ? `评论ID ${target}` : keyword ? `含「${keyword}」` : '第一条'}）`);
    console.log(`\n命中评论 #${targetIndex}`);

    const comment = comments.nth(targetIndex);
    const commentId = await comment.getAttribute('data-comment-id');

    // 2. 点这条评论的「回复」
    const replyEntry = comment.getByText('回复', { exact: true }).first();
    const replyCount = await replyEntry.count();
    console.log('该评论的「回复」入口数量：', replyCount);
    if (replyCount === 0) throw new Error('这条评论没有「回复」入口，可能它是自己发的或者结构不同。');

    const before = await readEditors(page);
    await replyEntry.click({ timeout: 8000 });
    await page.waitForTimeout(1800);

    const after = await readEditors(page);
    console.log('\n点回复前编辑器：', before.length, '个');
    console.log('点回复后编辑器：', JSON.stringify(after, null, 2));

    // 3. 找回复框：优先「在 comment-item 内」且可见的那个；没有就取新出现的
    let editorIndex = after.findIndex((item) => item.insideComment && item.visible);
    if (editorIndex < 0) editorIndex = after.findIndex((item) => item.visible && !before.some((b) => b.top === item.top));
    if (editorIndex < 0) editorIndex = after.length - 1;
    console.log(`\n选中编辑器 index=${editorIndex}（insideComment=${after[editorIndex]?.insideComment}）`);

    const editor = page.locator('.public-DraftEditor-content').nth(editorIndex);
    await editor.click({ timeout: 8000 });
    await page.keyboard.type(text, { delay: 25 });
    await page.waitForTimeout(800);

    const typedState = await readEditors(page);
    console.log('\n输入后：', JSON.stringify(typedState, null, 2));

    const typedOk = typedState.some((item) => item.text.includes(text.slice(0, 8)));
    console.log(typedOk ? '\n✅ 文字确实进了某个编辑器' : '\n❌ 没打进去');

    await page.screenshot({ path: 'logs/comment-reply-proto.png' }).catch(() => {});
    console.log('截图：logs/comment-reply-proto.png');

    // 4. 清空，绝不发
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.waitForTimeout(500);
    console.log('清空后：', JSON.stringify((await readEditors(page)).map((item) => item.text)));

    // 关掉回复框。实测残留会让评论项文本里多出「回复中 回复@xxx」，
    // 下一次定位时「回复」入口就出现两个，选择器会抓错。
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
    console.log('ESC 之后编辑器数量：', (await readEditors(page)).length);

    console.log(`\n目标评论 ${commentId}，回复框已就位、文字可写入 —— 但**没有点发送**。`);
  });
} finally {
  await controller.close().catch(() => {});
}
