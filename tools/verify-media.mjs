// 验证：媒体消息能不能真的变成「带画面路径的一行文字」。
//
// 走的是完整链路：DOM → publicMessages（含 resources）→ 下载落盘 → describeMessage。
// 和常驻进程 poll 用的是同一套代码，只是把结果打出来而不上报。
//
//   node tools/verify-media.mjs

import { readdirSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadChannel } from '../src/channels/registry.mjs';
import { describeMessage } from '../src/channels/douyin.mjs';
import { captureDir } from '../src/media/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const douyin = (config.channels ?? []).find((item) => item.id === 'douyin') ?? {};

const channel = await loadChannel('douyin', {
  recipientId: douyin.recipientId || config.recipientId,
  contactName: douyin.contactName || 'your-name',
});

try {
  const snapshot = await channel.poll({});
  console.log('会话：', snapshot.conversation?.displayName ?? '?');
  console.log('窗口构成：', JSON.stringify(snapshot.diagnostics));
  console.log('\n=== 每条消息 → 上报文本 ===');
  for (const [index, message] of (snapshot.messages ?? []).entries()) {
    const media = message.media
      ? ` media=${message.media.type ?? '?'}${message.media.files?.length ? ` files=${message.media.files.length}` : ''}`
      : '';
    console.log(`[${index}] ${String(message.direction).padEnd(8)} kind=${String(message.kind).padEnd(9)}${media}`);
    console.log(`     id=${message.id}`);
    console.log(`     → ${describeMessage(message)}`);
    if (message.share) console.log(`     share=${JSON.stringify(message.share)}`);
  }

  const dir = captureDir(ROOT);
  console.log(`\n=== 落盘目录 ${dir} ===`);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    console.log('（目录还不存在）');
  }
  for (const name of names.slice(0, 12)) {
    const file = join(dir, name);
    console.log(`  ${name}  ${statSync(file).size} 字节`);
  }
  if (!names.length) console.log('  （空）');
} finally {
  await channel.close().catch(() => {});
}
