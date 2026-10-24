// 无损自检：验证「连接 → 选中会话 → 读 DOM → 水位核对」整条发送前链路是通的，
// 但保证不真的发出消息。
//
// 原理：sendMessage 在填写输入框之前会拿 expectedMessageIds 对一遍水位。
// 故意给一个对不上的集合，它就会在「还没碰输入框」的时候返回 confirmed:false。
// 拿到那条 reason，就说明前面整条路都走通了。
//
//   node tools/verify-send-guard.mjs
//
// 预期输出：confirmed:false，reason 是「私信水位或内容已变化，未填写或发送回复。」

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatBrowser } from '../src/dom/chat-browser.mjs';
import { BrowserController } from '../src/browser/controller.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(HERE, '..', 'config.json'), 'utf8'));
const douyin = (config.channels ?? []).find((item) => item.id === 'douyin') ?? {};

const recipientId = douyin.recipientId || config.recipientId;
if (!recipientId) {
  console.error('config.json 里没有 douyin 的 recipientId，先跑 node adopter.mjs --dump-contacts。');
  process.exit(1);
}

const controller = new BrowserController({ source: 'api-chat' });
const browser = new ChatBrowser({ source: 'api-chat', controller });

try {
  const result = await browser.sendMessage(recipientId, '【这只是通道自检，不应该真的发出去】', {
    allowed: true,
    // 故意对不上的水位：一个不可能存在的消息 ID
    expectedMessageIds: ['msg:0000000000000000000000000000000000000000000000000000000000000000'],
  });

  console.log('返回：', JSON.stringify(result, null, 2));

  if (result?.reason?.includes('水位') || result?.reason?.includes('内容已变化')) {
    console.log('\n✅ 发送前链路正常：会话选中、DOM 读取、水位核对都走通了，消息没有发出。');
    process.exitCode = 0;
  } else if (result?.confirmed === true) {
    console.error('\n❌ 意外真的发出了消息（水位没拦住），请立刻人工检查会话。');
    process.exitCode = 2;
  } else {
    console.error('\n⚠️ 没有走到预期分支，看上面的 reason 判断。');
    process.exitCode = 1;
  }
} finally {
  await browser.close().catch(() => {});
}
