// 看 B 站私信通道现在读到什么。只读，不发任何东西。
//
//   node tools/peek-bili.mjs            # 自检 + 读一轮
//   node tools/peek-bili.mjs --status   # 只看自检（不读消息）
//   node tools/peek-bili.mjs --raw      # 额外打印原始接口返回（调试用）
//
// 对应抖音那边的 tools/peek.mjs。2026-10-25

import { loadChannel } from '../src/channels/registry.mjs';

const argv = process.argv.slice(2);
const onlyStatus = argv.includes('--status');
const showRaw = argv.includes('--raw');

const channel = await loadChannel('bilibili', {});

console.log('=== status() ===');
const status = await channel.status();
console.log(JSON.stringify(status, null, 2));

if (onlyStatus) process.exit(0);

console.log('\n=== poll() ===');
const started = Date.now();
const snapshot = await channel.poll({});
const cost = Date.now() - started;

if (snapshot?.reason) console.log('reason:', snapshot.reason);
if (snapshot?.flags && Object.keys(snapshot.flags).length) console.log('flags:', JSON.stringify(snapshot.flags));
console.log('diagnostics:', JSON.stringify(snapshot?.diagnostics ?? null));
console.log(`耗时 ${cost}ms`);

const conversations = Array.isArray(snapshot?.conversations) ? snapshot.conversations : [];
console.log(`\n会话数：${conversations.length}`);
for (const bundle of conversations) {
  const conversation = bundle.conversation ?? {};
  console.log(`\n── ${conversation.displayName ?? '?'}（${conversation.id}，未读 ${conversation.unread ?? 0}）──`);
  console.log(`   消息 ${bundle.messages.length} 条：`);
  for (const message of bundle.messages) {
    const arrow = message.direction === 'incoming' ? '←' : '→';
    const low = message.important === false ? ' [低优先级]' : '';
    console.log(`   ${arrow} ${message.id}  ${message.kind}${low}  ${channel.describe(message).slice(0, 70)}`);
    if (showRaw && message.share) console.log(`       share: ${JSON.stringify(message.share)}`);
  }
}

// 原始接口返回（--raw）：给「为什么读成这样」留证据
if (showRaw && conversations.length) {
  console.log('\n=== read()（原始快照，第一个会话）===');
  try {
    const raw = await channel.read({ conversationId: conversations[0].conversation.id });
    console.log(JSON.stringify({ displayName: raw.displayName, selfUid: raw.selfUid, rawMessageCount: raw.rawMessages.length, firstRaw: raw.rawMessages[0] }, null, 2));
  } catch (error) {
    console.log('read 失败：', error?.message ?? error);
  }
}
