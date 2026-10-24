// 回复某条评论：定位 → 点回复 → 输入 → （可选）发送。
//
// 默认是 **dry-run**：只走到「找到发送按钮」，然后清空退出，不发。
// 加 --send 才真的发出去。
//
//   node tools/reply-comment.mjs <作品ID> <评论ID|关键词> "回复内容"
//   node tools/reply-comment.mjs <作品ID> <评论ID|关键词> "回复内容" --send
//
// 注意：Draft.js 编辑器只吃 keyboard.type，fill() 不生效。

import { BrowserController } from '../src/browser/controller.mjs';

const args = process.argv.slice(2);
const doSend = args.includes('--send');
const positional = args.filter((item) => !item.startsWith('--'));

const videoId = positional[0];
const target = positional[1] ?? '';
const text = positional[2] ?? '';

if (!videoId || !text) {
  console.error('用法：node tools/reply-comment.mjs <作品ID> [评论ID|关键词] "回复内容" [--send]');
  process.exit(1);
}

const byCommentId = /^\d{10,}$/.test(target);
const keyword = byCommentId ? '' : target;

const controller = new BrowserController({
  source: 'api-probe',
  homeUrl: `https://www.douyin.com/video/${videoId}`,
  readySelector: '',
  allowedOrigins: ['https://www.douyin.com'],
});

const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();

async function readEditors(page) {
  return page.evaluate(() => {
    const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('.public-DraftEditor-content')].map((element) => {
      const box = element.getBoundingClientRect();
      return {
        text: clean(element.innerText),
        top: Math.round(box.top),
        visible: box.width > 0 && box.height > 0,
        insideComment: Boolean(element.closest('[data-e2e="comment-item"]')),
      };
    });
  });
}

try {
  await controller.withPage(async (page) => {
    await page.waitForLoadState('load').catch(() => {});

    // 强制重新导航：复用旧页会带着上一轮的回复框状态，定位必错
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

    // 1. 找目标评论
    const comments = page.locator('[data-e2e="comment-item"]');
    const total = await comments.count();
    let targetIndex = -1;
    for (let index = 0; index < Math.min(total, 15); index += 1) {
      const info = await comments.nth(index).evaluate((element) => ({
        text: (element.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
        commentId: element.getAttribute('data-comment-id') ?? null,
      }));
      const hit = byCommentId ? info.commentId === target : keyword ? info.text.includes(keyword) : index === 0;
      if (hit && targetIndex < 0) {
        targetIndex = index;
        console.log(`命中评论 #${index}：${JSON.stringify(info.text.slice(0, 80))}`);
      }
    }
    if (targetIndex < 0) throw new Error(`没找到目标评论（${byCommentId ? `ID ${target}` : `含「${keyword}」`}）`);

    const comment = comments.nth(targetIndex);

    // 2. 点「回复」
    const replyEntry = comment.getByText('回复', { exact: true }).first();
    if ((await replyEntry.count()) === 0) throw new Error('这条评论没有「回复」入口。');
    await replyEntry.click({ timeout: 8000 });
    await page.waitForTimeout(1800);

    // 3. 找回复框并输入
    const editors = await readEditors(page);
    const editorIndex = editors.findIndex((item) => item.insideComment && item.visible);
    if (editorIndex < 0) throw new Error('没找到评论内部的回复框（insideComment 全为 false）。');
    console.log('回复框 index =', editorIndex, JSON.stringify(editors[editorIndex]));

    const editor = page.locator('.public-DraftEditor-content').nth(editorIndex);
    await editor.click({ timeout: 8000 });
    await page.keyboard.type(text, { delay: 25 });
    await page.waitForTimeout(800);

    const typed = await readEditors(page);
    console.log('输入后：', JSON.stringify(typed.map((item) => item.text)));
    if (!typed.some((item) => item.text.includes(text.slice(0, 6)))) throw new Error('文字没进回复框。');

    // 4. 找发送按钮。它是**红色圆底 + 白色箭头**，但实测那个红色在 svg 内部，
    //    backgroundColor 是透明的 —— 按颜色找永远找不到（踩过）。
    //
    //    可靠判据是位置：编辑器右边同一行有一排 36x36 的图标（@ / 表情 / 发送），
    //    **发送永远是最右边那个**。所以取「编辑器右侧、同一行、带 svg、尺寸相近」里 left 最大的。
    const sendInfo = await page.evaluate(() => {
      const editorNode = [...document.querySelectorAll('.public-DraftEditor-content')].find((element) =>
        element.closest('[data-e2e="comment-item"]'),
      );
      if (!editorNode) return { found: false, reason: '没定位到评论内的编辑器' };

      const editorBox = editorNode.getBoundingClientRect();
      const editorMidY = editorBox.top + editorBox.height / 2;
      const icons = [];

      for (const element of document.querySelectorAll('div,span,button')) {
        const box = element.getBoundingClientRect();
        if (box.width < 24 || box.width > 52 || box.height < 24 || box.height > 52) continue;
        if (box.left < editorBox.right - 20) continue; // 必须在编辑器右边（同一行那一排）
        if (Math.abs(box.top + box.height / 2 - editorMidY) > 40) continue;
        if (!element.querySelector('svg')) continue;

        icons.push({
          el: element,
          tag: element.tagName,
          cls: typeof element.className === 'string' ? element.className.slice(0, 50) : null,
          size: `${Math.round(box.width)}x${Math.round(box.height)}`,
          left: Math.round(box.left),
          top: Math.round(box.top),
        });
      }

      // 去掉同一位置的内外层重复（外层 span 和它包着的元素）
      const unique = [];
      for (const icon of icons.sort((a, b) => a.left - b.left)) {
        if (unique.some((kept) => Math.abs(kept.left - icon.left) < 4)) continue;
        unique.push(icon);
      }

      const best = unique[unique.length - 1] ?? null; // 最右 = 发送
      if (best) best.el.setAttribute('data-adopter-send', '1');

      return {
        found: Boolean(best),
        picked: best ? { cls: best.cls, size: best.size, left: best.left } : null,
        iconCount: unique.length,
        icons: unique.slice(0, 5).map(({ el, ...rest }) => rest),
        reason: best ? undefined : '编辑器右侧那排图标里没找到候选',
      };
    });
    console.log('\n=== 发送按钮侦察 ===');
    console.log(JSON.stringify(sendInfo, null, 2));

    if (!doSend) {
      await page.screenshot({ path: 'logs/reply-ready.png' }).catch(() => {});
      console.log('\n[dry-run] 文字已填入、发送按钮已定位，但没有点。截图：logs/reply-ready.png');
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      console.log('已清空并关闭回复框。');
      return;
    }

    if (!sendInfo.found) throw new Error(`找不到发送按钮：${sendInfo.reason ?? '候选里没有偏红的圆形图标'}`);

    // 5. 真发（用标记好的元素，让 playwright 自己滚到位置再点）
    const sendButton = page.locator('[data-adopter-send="1"]');
    if ((await sendButton.count()) !== 1) {
      throw new Error(`发送按钮标记不唯一（${await sendButton.count()} 个），不敢点。`);
    }
    console.log('\n点击发送…');
    await sendButton.click({ timeout: 8000 });
    await page.waitForTimeout(3500);

    // 【风控闸】点发送可能触发抖音的「接收短信验证码」拦路。
    // 撞到就立刻停：不点取消、不点获取验证码、不填任何东西，把弹窗留给人工处理。
    const blocked = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return {
        verifyShown: /接收短信验证码|请输入验证码|使用原设备扫码/.test(text),
        bodySample: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
      };
    });

    if (blocked.verifyShown) {
      await page.screenshot({ path: 'logs/verify-blocked.png' }).catch(() => {});

      // 关键：弹验证 ≠ 没发出去。实测第一次撞风控时评论其实已经提交了，
      // 只是被验证框挡住看不见。所以这里必须先核实评论区，别一口咬定失败。
      const maybePosted = await page.evaluate((needle) => {
        const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
        const textOf = (element) => {
          const clone = element.cloneNode(true);
          for (const editor of clone.querySelectorAll('.public-DraftEditor-content')) editor.remove();
          return clean(clone.innerText);
        };
        const items = [...document.querySelectorAll('[data-e2e="comment-item"]')];
        return {
          commentCount: items.length,
          found: items.some((element) => textOf(element).includes(needle)),
        };
      }, text.slice(0, 6));

      console.log('\n⛔ 触发风控：抖音要求短信验证。已停下，没有做任何验证动作。');
      console.log('   截图：logs/verify-blocked.png');
      console.log('   弹窗留在专用 Edge 窗口里，需要人工处理。');
      console.log(`   顺便核实评论区：共 ${maybePosted.commentCount} 条，${maybePosted.found ? '回复文字**已经在评论区里了**（说明其实发出去了）' : '暂时没看到回复文字'}`);
      if (!maybePosted.found) {
        console.log('   → 需要你在 Edge 窗口里手动过验证；通过后评论区可能才会出现，也可能要重发。');
      }
      // 故意不关闭、不清空 —— 让人能看到现场
      return;
    }

    // 6. 验证：评论区里应该出现我的回复
    //    注意排除编辑器节点 —— 回复框就嵌在 comment-item 内部，
    //    直接读 innerText 会把「输入框里还没发出去的字」当成已发布的评论（踩过，误报成功）。
    const verify = await page.evaluate((needle) => {
      const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
      const textOf = (element) => {
        const clone = element.cloneNode(true);
        for (const editor of clone.querySelectorAll('.public-DraftEditor-content')) editor.remove();
        return clean(clone.innerText);
      };
      const items = [...document.querySelectorAll('[data-e2e="comment-item"]')];
      return {
        commentCount: items.length,
        found: items.some((element) => textOf(element).includes(needle)),
        editorStillFilled: [...document.querySelectorAll('.public-DraftEditor-content')]
          .map((element) => clean(element.innerText))
          .filter(Boolean),
        tail: items.slice(-2).map((element) => textOf(element).slice(0, 110)),
      };
    }, text.slice(0, 6));

    console.log('\n=== 发送后验证 ===');
    console.log(JSON.stringify(verify, null, 2));
    await page.screenshot({ path: 'logs/reply-sent.png' }).catch(() => {});
    console.log('截图：logs/reply-sent.png');
    console.log(verify.found ? '\n✅ 评论区里能看到这条回复了' : '\n⚠️ 评论区里没找到回复文字，需要人工确认');
  });
} finally {
  await controller.close().catch(() => {});
}
