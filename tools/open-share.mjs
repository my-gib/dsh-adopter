// 测试：点开私信里的分享卡片，看能不能从真实打开的页面里拿到作品 ID。
//
// 这是「好友分享的内容」变成「可刷的作品」的唯一路径——卡片本身没有链接。
// 点开会短暂弹出作品页，脚本拿到 URL 后立刻关掉并把视频暂停。
//
//   node tools/open-share.mjs

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
  const snapshot = await browser.readConversation(recipientId, { allowed: true });
  const shared = (snapshot.messages ?? []).filter((message) => message.media?.type === 'shared-work').at(-1);
  if (!shared) {
    console.log('会话里没有分享卡片，先让人发一个。');
    process.exit(1);
  }

  console.log('目标卡片：', shared.id);
  console.log('解析到的元数据：', JSON.stringify({ author: shared.media?.author ?? null, isPhotoGallery: shared.media?.isPhotoGallery ?? null }));

  console.log('\n正在点开卡片…（会短暂弹出作品页，拿到地址就关掉）');
  const result = await browser.openSharedVideo(recipientId, shared.id, { allowed: true });
  console.log('\n结果：');
  console.log(JSON.stringify(result, null, 2));

  if (result?.videoId) {
    console.log('\n✅ 拿到了作品 ID：', result.videoId);
    console.log('   https://www.douyin.com/video/' + result.videoId);
  } else {
    console.log('\n❌ 没拿到作品 ID，看上面的 reason。');
  }
} finally {
  await browser.close().catch(() => {});
}
