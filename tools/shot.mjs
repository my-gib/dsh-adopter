// 截一张当前专用标签页的图，用来肉眼确认界面真实状态。
//
//   node tools/shot.mjs [输出文件名]
//
// 输出到 logs/ 下，默认 page.png。

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatBrowser } from '../src/dom/chat-browser.mjs';
import { BrowserController } from '../src/browser/controller.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(HERE, '..', 'config.json'), 'utf8'));
const douyin = (config.channels ?? []).find((item) => item.id === 'douyin') ?? {};
const recipientId = douyin.recipientId || config.recipientId;

const name = process.argv[2] || 'page.png';
const logs = join(HERE, '..', 'logs');
mkdirSync(logs, { recursive: true });
const out = join(logs, name);

const controller = new BrowserController({ source: 'api-chat' });
const browser = new ChatBrowser({ source: 'api-chat', controller });

try {
  // 先确保私信浮层是开着的
  await browser.readConversation(recipientId, { allowed: true });
  await controller.withPage(async (page) => {
    await page.screenshot({ path: out });
    console.log('已保存：', out);
    console.log('URL：', page.url());
  });
} finally {
  await browser.close().catch(() => {});
}
