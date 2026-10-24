// 看会话最近几条消息 —— 用来判断「发送到底有没有真的成功」。
//
//   node tools/peek.mjs [条数]
//
// 注意：adopter 常驻时也连着同一张页面，靠 tab-api-chat 锁互斥，可能要等几秒。

import { loadChannel } from '../src/channels/registry.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const limit = Number(process.argv[2] ?? 8);

// 从 config 取 recipientId：只传 contactName 会走「按名字匹配」，
// 而联系人列表在会话浮层里可能只有一个当前会话，名字对不上就白跑。
const HERE = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(HERE, '..', 'config.json'), 'utf8'));
const douyin = (config.channels ?? []).find((item) => item.id === 'douyin') ?? {};

const channel = await loadChannel('douyin', {
  recipientId: douyin.recipientId || config.recipientId,
  contactName: douyin.contactName || 'your-name',
});

try {
  const snapshot = await channel.poll({});
  const flags = snapshot.flags ?? {};
  if (flags.blocked || flags.loginRequired || flags.verificationRequired) {
    console.log('会话不可用：', JSON.stringify(flags));
    process.exitCode = 1;
  } else {
    console.log(`会话：${snapshot.conversation?.displayName ?? '?'}  共 ${snapshot.messages.length} 条`);
    for (const message of snapshot.messages.slice(-limit)) {
      const kind = message.media?.type ? ` (${message.media.type})` : '';
      console.log(`  [${String(message.direction).padEnd(8)}]${kind} ${JSON.stringify(message.text ?? '')}`);
    }
  }
} finally {
  await channel.close().catch(() => {});
}
