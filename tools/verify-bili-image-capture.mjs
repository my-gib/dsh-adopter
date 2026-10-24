// 真跑一次 B站 poll()，把图片消息解析结果打出来（URL 打码、本地路径、大小、文件头）。
//   node tools/verify-bili-image-capture.mjs
//
// 只读：不发送、不改任何东西，最多往 capture/bilibili/ 落一张图。

import { readFileSync, statSync } from 'node:fs';

import { loadChannel } from '../src/channels/registry.mjs';

const channel = await loadChannel('bilibili', {});

function mask(url) {
  try {
    const u = new URL(String(url));
    for (const key of [...u.searchParams.keys()]) if (/sign|token|key|auth|expire|ts=/i.test(key)) u.searchParams.set(key, '<masked>');
    return u.toString();
  } catch {
    return String(url);
  }
}

/** PNG 的 IHDR 宽高（顺便证明文件头真的是 PNG，而不是 HTML 错误页）。 */
function pngSize(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function report(label, snapshot, cost) {
  console.log(`\n═══ ${label}：${cost}ms ═══`);
  console.log('diagnostics:', JSON.stringify(snapshot.diagnostics));
  const conversations = snapshot.conversations ?? [];
  for (const bundle of conversations) {
    console.log(`\n── ${bundle.conversation.displayName}（${bundle.conversation.id}）${bundle.messages.length} 条`);
    for (const message of bundle.messages) {
      if (message.media?.type !== 'image') continue;
      console.log('   describe() :', channel.describe(message));
      console.log('   id         :', message.id);
      console.log('   direction  :', message.direction);
      console.log('   urls       :', (message.media.urls ?? []).map(mask));
      console.log('   files      :', message.media.files ?? []);
      console.log('   requiresVisual/captureError/captureSkipped:',
        message.media.requiresVisual, '|', message.media.captureError ?? '(无)', '|', message.media.captureSkipped ?? '(无)');
      for (const file of message.media.files ?? []) {
        const buffer = readFileSync(file);
        const size = pngSize(buffer);
        console.log(`   ── 文件 ${file}`);
        console.log(`      大小 ${statSync(file).size} 字节；头 8 字节 ${buffer.subarray(0, 8).toString('hex')}`);
        console.log(`      PNG IHDR: ${size ? `${size.width}x${size.height}` : '(不是 PNG)'}`);
      }
    }
  }
}

// 第一轮（冷：这条图应该真下载下来）
const t1 = Date.now();
const first = await channel.poll({});
report('第一轮 poll（冷）', first, Date.now() - t1);

// 第二轮（暖：应当命中缓存，不重复下载）
const t2 = Date.now();
const second = await channel.poll({});
report('第二轮 poll（暖：同一张图）', second, Date.now() - t2);

const t3 = Date.now();
await channel.poll({});
console.log(`\n第三轮（暖）耗时 ${Date.now() - t3}ms`);

console.log('\nstatus():', JSON.stringify(await channel.status(), null, 2));

/**
 * 失败演练（`--fail-drill`）：把落盘目录指到一个**根本不是目录**的路径上，
 * 让真实的下载链路失败，看它会不会静默退回 `[图片]`。
 *
 * 这不是造假数据：消息还是那条真消息、URL 还是那个真 URL，只是写不进去。
 * 目的是验证「出错要出声」那条接缝（saveImage → media.captureError → describe），
 * 这是单元测试里只能两头分别断言、中间那条线最容易断的地方。
 */
if (process.argv.includes('--fail-drill')) {
  console.log('\n===== 失败演练：落盘目录不可写 =====');
  const broken = await loadChannel('bilibili', { captureDir: '<repo>\\package.json' });
  const t = Date.now();
  const snapshot = await broken.poll({});
  console.log(`耗时 ${Date.now() - t}ms`);
  console.log('diagnostics:', JSON.stringify(snapshot.diagnostics));
  for (const bundle of snapshot.conversations ?? []) {
    for (const message of bundle.messages) {
      if (message.media?.type !== 'image') continue;
      console.log('   describe()  :', broken.describe(message));
      console.log('   captureError:', message.media.captureError ?? '(无)');
      console.log('   files       :', message.media.files ?? []);
    }
  }
}
