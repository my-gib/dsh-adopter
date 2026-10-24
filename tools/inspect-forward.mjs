// 挖分享面板里「好友行」的真实结构 —— 面板没有 data-e2e，只能靠 class / 文本定位。
//
//   node tools/inspect-forward.mjs [作品ID] [好友名]
//
// 做法：点开分享面板 → 找到文本等于好友名的叶子节点 → 向上打出 5 层 class 链
//       → 在同一行里找「分享」按钮。不发任何消息。

import { BrowserController } from '../src/browser/controller.mjs';

const videoId = process.argv[2] || '7000000000000000000';
const friendName = process.argv[3] || 'your-name';
const url = `https://www.douyin.com/video/${videoId}`;

const controller = new BrowserController({
  source: 'api-explore',
  homeUrl: url,
  readySelector: '',
  allowedOrigins: ['https://www.douyin.com'],
});

try {
  await controller.withPage(async (page) => {
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForTimeout(3500);
    await page
      .evaluate(() => {
        for (const video of document.querySelectorAll('video')) {
          video.muted = true;
          video.pause();
        }
      })
      .catch(() => {});

    const share = page.locator('[data-e2e="video-player-share"]').filter({ visible: true });
    if ((await share.count()) === 0) {
      console.log('没有分享按钮');
      return;
    }
    await share.first().click({ timeout: 8000 }).catch((error) => console.log('点击分享失败：', error.message.split('\n')[0]));
    await page.waitForTimeout(1800);

    const result = await page.evaluate((fname) => {
      const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
      const all = [...document.querySelectorAll('*')];

      // 1) 名字所在的叶子节点
      const nameNodes = all.filter((element) => element.childElementCount === 0 && clean(element.textContent) === fname);
      if (!nameNodes.length) {
        // 退一步：包含该名字的最深元素
        const loose = all.filter((element) => clean(element.textContent).includes(fname));
        return {
          foundExact: false,
          looseCount: loose.length,
          panelTextSample: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
          hint: '没找到完全等于该名字的叶子节点，看 panelTextSample 里的实际写法',
        };
      }

      const node = nameNodes[0];
      const chain = [];
      let cursor = node;
      for (let depth = 0; depth < 6 && cursor; depth += 1) {
        chain.push({
          tag: cursor.tagName,
          cls: typeof cursor.className === 'string' ? cursor.className : null,
          childCount: cursor.childElementCount,
          text: clean(cursor.innerText).slice(0, 60),
        });
        cursor = cursor.parentElement;
      }

      // 2) 在同一行里找「分享」按钮
      const row = node.parentElement?.parentElement ?? node.parentElement;
      const buttons = row
        ? [...row.querySelectorAll('*')]
            .filter((element) => element.childElementCount === 0 && /^(分享|发送|Send)$/.test(clean(element.innerText)))
            .map((element) => {
              const clickable = element.closest('button,[role="button"],div') ?? element;
              return {
                text: clean(element.innerText),
                tag: element.tagName,
                cls: typeof element.className === 'string' ? element.className : null,
                clickableTag: clickable.tagName,
                clickableCls: typeof clickable.className === 'string' ? clickable.className : null,
              };
            })
        : [];

      // 3) 面板容器：名字节点的祖先里，尺寸最大的那个
      let panelChain = [];
      let panel = node.parentElement;
      for (let depth = 0; depth < 6 && panel; depth += 1) {
        const box = panel.getBoundingClientRect();
        panelChain.push({ tag: panel.tagName, cls: typeof panel.className === 'string' ? panel.className : null, size: `${Math.round(box.width)}x${Math.round(box.height)}` });
        panel = panel.parentElement;
      }

      return { foundExact: true, nameNodeTag: node.tagName, nameNodeClass: typeof node.className === 'string' ? node.className : null, chain, buttons, panelChain };
    }, friendName);

    console.log('=== 好友行结构 ===');
    console.log(JSON.stringify(result, null, 2));

    // 顺便把两个好友名字都取出来，确认还能认出其他联系人
    const allNames = await page.evaluate(() => {
      const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
      // 分享面板里「分享」按钮的兄弟节点通常是名字
      return [...document.querySelectorAll('*')]
        .filter((element) => element.childElementCount === 0 && /^分享$/.test(clean(element.innerText)))
        .map((button) => {
          const row = button.parentElement?.parentElement ?? button.parentElement;
          return { rowText: clean(row?.innerText).slice(0, 60), btnClass: typeof button.className === 'string' ? button.className : null };
        });
    });
    console.log('\n=== 面板里所有「分享」按钮所在的整行 ===');
    console.log(JSON.stringify(allNames, null, 2));

    await page.screenshot({ path: 'logs/forward-panel.png' }).catch(() => {});
    console.log('\n截图：logs/forward-panel.png');
  });
} finally {
  await controller.close().catch(() => {});
}
