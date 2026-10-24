// 把私信里那张「分享作品」卡片的真实 DOM 结构 dump 出来。
//
// 用途：chat-browser 解析分享卡片靠的是 .MessageItemShareAweme* 那组 class，
// 抖音一改版就拿不到 videoId / 标题 / 作者。这个工具用来现场看清结构。
//
//   node tools/inspect-share.mjs

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
  // 先确保私信浮层开着
  await browser.readConversation(recipientId, { allowed: true });

  const info = await controller.withPage((page) =>
    page.evaluate(() => {
      const cards = [...document.querySelectorAll('.MessageItemShareAwemecontainer')];
      const share = cards.at(-1);
      if (!share) return { found: false, note: '页面里没有 .MessageItemShareAwemecontainer' };

      const descendants = [...share.querySelectorAll('*')];
      const classes = [...new Set(descendants.map((element) => element.className).filter((value) => typeof value === 'string' && value.trim()))];
      const attrs = [...new Set(descendants.map((element) => element.getAttribute('data-e2e')).filter(Boolean))];

      return {
        found: true,
        cardCount: cards.length,
        outerHTML: share.outerHTML.slice(0, 4000),
        innerText: (share.innerText || '').slice(0, 500),
        classes,
        dataE2e: attrs,
        links: [...share.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
        images: [...share.querySelectorAll('img')].map((image) => ({
          src: (image.currentSrc || image.getAttribute('src') || '').slice(0, 140),
          alt: image.getAttribute('alt'),
        })),
        parentClasses: (() => {
          const chain = [];
          let node = share;
          for (let depth = 0; depth < 4 && node; depth += 1) {
            chain.push(typeof node.className === 'string' ? node.className : String(node.className));
            node = node.parentElement;
          }
          return chain;
        })(),
      };
    }),
  );

  console.log(JSON.stringify(info, null, 2));
} finally {
  await browser.close().catch(() => {});
}
