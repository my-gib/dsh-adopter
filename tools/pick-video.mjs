// 从精选页捡一条作品出来（优先真视频），用于后续分享。
//
//   node tools/pick-video.mjs            # 只列出候选，不发任何东西
//
// 精选页是卡片网格，链接都在 <a href> 里，跟推荐流那种全屏滑动结构不一样。

import { BrowserController } from '../src/browser/controller.mjs';

const controller = new BrowserController({
  source: 'api-pick',
  homeUrl: 'https://www.douyin.com/jingxuan',
  readySelector: '',
  allowedOrigins: ['https://www.douyin.com'],
});

try {
  await controller.withPage(async (page) => {
    await page.waitForLoadState('load').catch(() => {});
    await page.waitForTimeout(4500);

    // 往下滚一点，让更多卡片进 DOM
    await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {});
    await page.waitForTimeout(1500);

    await page
      .evaluate(() => {
        for (const video of document.querySelectorAll('video')) {
          video.muted = true;
          video.pause();
        }
      })
      .catch(() => {});

    const info = await page.evaluate(() => {
      const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
      const works = new Map();
      for (const link of document.querySelectorAll('a[href]')) {
        const match = /\/(video|note)\/(\d+)/.exec(link.getAttribute('href') ?? '');
        if (!match) continue;
        const [, type, id] = match;
        if (works.has(id)) continue;
        works.set(id, {
          id,
          type,
          // 卡片上一般带标题/作者文字
          text: clean(link.innerText).slice(0, 60),
          hasVideoTag: Boolean(link.querySelector('video')),
        });
      }
      return {
        url: location.href,
        title: document.title,
        total: works.size,
        works: [...works.values()].slice(0, 15),
      };
    });

    console.log('页面：', info.title);
    console.log('URL ：', info.url);
    console.log('候选作品数：', info.total);

    const videos = info.works.filter((work) => work.type === 'video');
    const notes = info.works.filter((work) => work.type === 'note');
    console.log(`其中 /video/ ${videos.length} 条，/note/ ${notes.length} 条\n`);

    console.log('=== 优先候选（/video/）===');
    for (const work of videos.slice(0, 8)) {
      console.log(`  ${work.id}  ${work.hasVideoTag ? '[卡片内有 video]' : ''}  ${work.text}`);
    }
    if (!videos.length) {
      console.log('  （没有 /video/ 类型的，看 /note/）');
      for (const work of notes.slice(0, 8)) {
        console.log(`  ${work.id}  ${work.hasVideoTag ? '[卡片内有 video]' : ''}  ${work.text}`);
      }
    }

    await page.screenshot({ path: 'logs/jingxuan.png' }).catch(() => {});
    console.log('\n截图：logs/jingxuan.png');
  });
} finally {
  await controller.close().catch(() => {});
}
