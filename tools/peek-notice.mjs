// 读一次抖音通知通道的内容（@我的 / 评论 / 赞 / 粉丝）。
//
//   node tools/peek-notice.mjs
//   node tools/peek-notice.mjs --resolve <noticeId>   # 顺带解析某条通知对应的作品 ID

import { loadChannel } from '../src/channels/registry.mjs';

const resolveIndex = process.argv.indexOf('--resolve');
const toResolve = resolveIndex >= 0 ? process.argv[resolveIndex + 1] : null;

const channel = await loadChannel('douyin-notice', {});

try {
  const snapshot = await channel.poll({});
  console.log(`通知数：${snapshot.messages.length}\n`);

  for (const message of snapshot.messages) {
    console.log(`  [${message.kind}] ${message.text}`);
    console.log(`        通知 ID：${message.id}`);
    if (message.notice?.cover) console.log(`        封面：${message.notice.cover.slice(0, 90)}`);
  }

  if (toResolve) {
    console.log(`\n=== 解析通知对应的作品 ===`);
    try {
      const result = await channel.resolveVideo(toResolve, {});
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.log('解析失败：', error instanceof Error ? error.message : String(error));
    }
  }

  const status = await channel.status();
  console.log('\n=== 状态 ===');
  console.log(JSON.stringify(status, null, 2));
} finally {
  await channel.close().catch(() => {});
}
