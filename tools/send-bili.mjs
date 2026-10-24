// 给 B 站发一条私信。**默认 dry-run，加 --send 才真发。**
//
//   node tools/send-bili.mjs <uid> "内容"            # 只校验参数，不发
//   node tools/send-bili.mjs <uid> "内容" --send     # 真发（会先自检、再回读确认）
//
// 形状照抖音那边的 `tools/reply-comment.mjs`：dry-run 是默认，真发要显式给。
//
// ⚠️ 发之前它会先看一眼插件的私信监听（`status().pluginDmWatch`）：
//    开着也**不拦**，但会大声警告 —— 因为那意味着「回别人」的时候会被两边各回一条。
//    要不要继续，调用的人自己决定。
//
// 2026-10-25

import { loadChannel } from '../src/channels/registry.mjs';

const argv = process.argv.slice(2);
const doSend = argv.includes('--send');
const positional = argv.filter((item) => !item.startsWith('--'));
const rawUid = positional[0] ?? '';
const text = positional[1] ?? '';

if (!rawUid || !text) {
  console.error('用法：node tools/send-bili.mjs <对方uid> "内容" [--send]');
  process.exit(1);
}

const conversationId = /^uid:\d+$/.test(rawUid) ? rawUid : `uid:${rawUid}`;
if (!/^uid:\d+$/.test(conversationId)) {
  console.error(`uid 不合法：${rawUid}（要数字，或 uid:数字）`);
  process.exit(1);
}

// allowSend 只在这次调用里开，常驻的 adopter 仍然按 config 来（默认 false）
const channel = await loadChannel('bilibili', { allowSend: true });

const status = await channel.status();
console.log('=== 自检 ===');
console.log(
  JSON.stringify(
    {
      loggedIn: status.loggedIn,
      uname: status.uname,
      sendEnabled: status.sendEnabled,
      pluginDmWatch: status.pluginDmWatch,
      conversationCount: status.conversationCount,
    },
    null,
    2,
  ),
);

if (status.pluginDmWatch === 'on') {
  console.warn(
    '\n⚠️ 插件的私信监听是「已开」。\n' +
      '   发一条测试消息不会撞车（插件只回「主人本人发来的私信」，不回我们自己发出去的），\n' +
      '   但**将来做「自动回复」之前必须先关掉它**，否则对方会收到两条。\n',
  );
}
if (!status.loggedIn) {
  console.error('登录态不可用，停。');
  process.exit(1);
}

console.log(`\n=== 目标 ===\n  ${conversationId}\n  内容（${[...text].length} 字）：${text}\n`);

if (!doSend) {
  console.log('[dry-run] 参数已校验，没有发。要真发加 --send。');
  process.exit(0);
}

console.log('发送中…');
const started = Date.now();
const result = await channel.send({ conversationId, text });
console.log(`\n=== 结果（${Date.now() - started}ms）===`);
console.log(JSON.stringify(result, null, 2));

if (result?.confirmed === true) {
  console.log('\n✅ 接口回成功 + 回读确认：这条已经出现在会话里了');
} else {
  console.log('\n⚠️ 没拿到确认，去 B 站私信页看一眼实际有没有发出去');
}
