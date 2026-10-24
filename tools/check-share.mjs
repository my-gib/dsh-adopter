// 对照检查：分享卡片「现在的解析结果」vs「手工逐字段提取的结果」。
//
// 前者走 ChatBrowser 的完整链路（media → share），后者直接在页面里照抄那几行选择器。
// 两边一对比，就知道是选择器写错了，还是时序问题（卡片还没渲染完就读了）。
//
//   node tools/check-share.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatBrowser } from '../src/dom/chat-browser.mjs';
import { BrowserController } from '../src/browser/controller.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(HERE, '..', 'config.json'), 'utf8'));
const douyin = (config.channels ?? []).find((item) => item.id === 'douyin') ?? {};
const recipientId = douyin.recipientId || config.recipientId;

const controller = new BrowserController({ source: 'api-chat' });
const browser = new ChatBrowser({ source: 'api-chat', controller });

try {
  // 1) 走完整链路：这是 adopter 真正上报时会拿到的数据
  const snapshot = await browser.readConversation(recipientId, { allowed: true });
  const shared = (snapshot.messages ?? []).filter((message) => message.media?.type === 'shared-work');
  console.log('=== 完整链路解析到的分享卡片 ===');
  console.log('数量：', shared.length);
  for (const message of shared) {
    console.log(' ', JSON.stringify({
      id: message.id?.slice(0, 20),
      direction: message.direction,
      mediaType: message.media?.type,
      videoId: message.media?.videoId ?? null,
      url: message.media?.url ?? null,
      title: message.media?.title ?? null,
      author: message.media?.author ?? null,
      isPhotoGallery: message.media?.isPhotoGallery ?? null,
      images: (message.media?.images ?? []).length,
      publicUrlSource: message.media?.publicUrlSource ?? null,
    }));
  }

  // 2) 手工照抄选择器，逐字段看
  console.log('\n=== 手工逐字段提取（照抄 chat-browser 那几行）===');
  const manual = await controller.withPage((page) =>
    page.evaluate(() => {
      const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
      const cards = [...document.querySelectorAll('.MessageItemShareAwemecontainer')];
      const share = cards.at(-1);
      if (!share) return { found: false };

      const titleNode = share.querySelector('.MessageItemShareAwemetitle,.MessageItemShareAwemedesc,[data-e2e="shared-video-title"]');
      const authorNode = share.querySelector('.MessageItemShareAwemeauthorName,[data-e2e="shared-video-author"]');
      const links = [...share.querySelectorAll('a[href]')];

      return {
        found: true,
        titleNodeFound: Boolean(titleNode),
        titleRaw: titleNode?.textContent ?? null,
        titleClean: clean(titleNode?.textContent) || null,
        authorNodeFound: Boolean(authorNode),
        authorRaw: authorNode?.textContent ?? null,
        authorClean: clean(authorNode?.textContent) || null,
        linkCount: links.length,
        hrefs: links.map((link) => link.getAttribute('href')),
        isPhotoGallery: Boolean(share.querySelector('.MessageItemShareAwemephotosTag')),
        // 补充：卡片上有没有别的地方藏着作品 id（属性 / 外层容器）
        nearbyDataAttrs: (() => {
          const found = [];
          let node = share;
          for (let depth = 0; depth < 6 && node; depth += 1) {
            for (const attribute of node.attributes ?? []) {
              if (/id|aweme|video|item|data-/i.test(attribute.name)) found.push(`${attribute.name}=${String(attribute.value).slice(0, 80)}`);
            }
            node = node.parentElement;
          }
          return found;
        })(),
      };
    }),
  );
  console.log(JSON.stringify(manual, null, 2));
} finally {
  await browser.close().catch(() => {});
}
