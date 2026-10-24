// 自检：B 站私信能不能以「B站」的身份进会话。
//
// 干三件事（都只读，除了最后一步会往会话里投一条自检消息）：
//   1. 查 8107 在不在听（notifier 的 bilibili inbound）
//   2. 查 state.json 里的绑定 bilibili:<userId>
//   3. 模拟 adopter 的上报，POST 一条自检消息 —— **这一步会在会话里冒出一条假消息**
//
//   node tools/verify-bili-inbound.mjs          # 只查 1、2（不发）
//   node tools/verify-bili-inbound.mjs --post   # 额外做第 3 步（会真的投一条进会话）
//
// 2026-10-24

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const doPost = process.argv.includes('--post');
const STATE = path.join(homedir(), '.dsh', 'dsh-notifier', 'state.json');
const ENDPOINT = 'http://127.0.0.1:8107/bilibili';

// ── 1) 端口 ────────────────────────────────────────────────────────
console.log('=== 1. 8107 在不在听 ===');
let listening = false;
try {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}', // 空 payload：bilibili-in.mjs 的 handlePayload 会直接 return，不投递
    signal: AbortSignal.timeout(3000),
  });
  listening = true;
  console.log(`  ✅ 通了（HTTP ${response.status}）—— inbound 已启动`);
} catch (error) {
  console.log(`  ❌ 连不上：${error?.cause?.code ?? error?.message ?? error}`);
  console.log('     → 说明 notifier 还没重启（或 cordis.patch.yml 的 inbound.bilibili 没被读到）');
}

// ── 2) 绑定 ────────────────────────────────────────────────────────
console.log('\n=== 2. state.json 里的绑定 ===');
try {
  const state = JSON.parse(readFileSync(STATE, 'utf8'));
  const bindings = state['inbound:bindings'] ?? {};
  for (const [key, value] of Object.entries(bindings)) {
    const marker = key.startsWith('bilibili:') ? ' ←' : '';
    console.log(`  ${key.padEnd(22)} label=${JSON.stringify(value?.label ?? '')} role=${value?.role ?? '?'}${marker}`);
  }
  const bili = Object.keys(bindings).filter((key) => key.startsWith('bilibili:'));
  console.log(bili.length ? `  ✅ 有 ${bili.length} 条 B站绑定` : '  ❌ 没有 bilibili 绑定');
} catch (error) {
  console.log(`  ❌ 读不到 state.json：${error?.message ?? error}`);
}

// ── 3) 模拟上报（可选）─────────────────────────────────────────────
if (!doPost) {
  console.log('\n（加 --post 会往会话里真投一条自检消息；不加就到此为止）');
  process.exit(listening ? 0 : 1);
}

if (!listening) {
  console.log('\n8107 没起来，跳过投递。');
  process.exit(1);
}

console.log('\n=== 3. 模拟 adopter 的上报 ===');
const payload = {
  userId: 'your-name',
  chatId: 'uid:695300301',
  text: '[自检] notifier 的 B站 inbound 通了（这条是 verify-bili-inbound.mjs 发的，不是真人消息）',
  messageId: `bilibili:verify:${Date.now()}`,
  displayName: 'B站',
};
console.log('  payload:', JSON.stringify(payload));
try {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  console.log(`  HTTP ${response.status} | 返回：${text.slice(0, 300) || '(空)'}`);
  if (response.ok) {
    console.log('\n  ✅ 投递成功。去会话里看：前缀应该是 [B站 your-name]，不是 [抖音 your-name]。');
  }
} catch (error) {
  console.log(`  ❌ 投递失败：${error?.message ?? error}`);
}
