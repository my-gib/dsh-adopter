// 媒体落盘的纯逻辑测试：不碰浏览器、不连网。
//   node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isAllowedUrl, downloadResource, pruneCapture, captureDir, captureSubdir, safeName } from '../src/media/store.mjs';

// ── URL 白名单：页面内容不能把下载器变成任意请求原语 ─────────────────

test('抖音自家 CDN 的 https 链接放行', () => {
  assert.equal(isAllowedUrl('https://p26-sign.douyinpic.com/obj/artist-material/abc?x-expires=1'), true);
  assert.equal(isAllowedUrl('https://p3-pc-sign.douyinpic.com/a.png'), true);
  assert.equal(isAllowedUrl('https://p1.byteimg.com/a.webp'), true);
});

test('非抖音域、非 https、本地地址一律拒绝', () => {
  assert.equal(isAllowedUrl('http://p26-sign.douyinpic.com/a.png'), false, 'http 不放行');
  assert.equal(isAllowedUrl('http://127.0.0.1:9320/status'), false, '不许打本机端点');
  assert.equal(isAllowedUrl('http://localhost/a.png'), false);
  assert.equal(isAllowedUrl('https://evil.example.com/a.png'), false);
  assert.equal(isAllowedUrl('file:///C:/a.png'), false);
  assert.equal(isAllowedUrl(''), false);
  // 后缀伪装：douyinpic.com.evil.com 不能因为包含 douyinpic.com 就放行
  assert.equal(isAllowedUrl('https://douyinpic.com.evil.com/a.png'), false);
});

// ── 下载：失败要如实返回，不能抛 ──────────────────────────────────

test('被拒绝的主机直接返回 ok:false，不发请求', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adopter-media-'));
  const result = await downloadResource({ url: 'https://evil.example.com/a.png', messageId: 'msg:abc', type: 'emoji', dir });
  assert.equal(result.ok, false);
  assert.match(result.error, /不允许下载/);
  assert.equal(readdirSync(dir).length, 0, '被拒绝的请求不该留下文件');
});

test('不可达的 CDN 返回 ok:false 而不是抛错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adopter-media-'));
  // 域名在白名单里但连不上：走真实 fetch，必然失败
  const result = await downloadResource({
    url: 'https://no-such-host-0417.douyinpic.com/a.png',
    messageId: 'msg:dead',
    type: 'image',
    dir,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /下载失败/);
});

// ── 清理：只保留最新 N 个 ────────────────────────────────────────

test('pruneCapture 按修改时间保留最新，超出的删掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adopter-media-'));
  for (let index = 0; index < 5; index += 1) {
    const file = join(dir, `f${index}.png`);
    writeFileSync(file, 'x');
    const seconds = 1_700_000_000 + index;
    utimesSync(file, seconds, seconds);
  }
  const result = pruneCapture(dir, 2);
  assert.equal(result.removed, 3);
  assert.deepEqual(readdirSync(dir).sort(), ['f3.png', 'f4.png']);
});

test('目录不存在时清理不报错', () => {
  const result = pruneCapture(join(tmpdir(), 'adopter-media-does-not-exist-9876'), 10);
  assert.equal(result.removed, 0);
});

// ── 落盘目录约定 ──────────────────────────────────────────────────

test('落盘目录在项目根下的 capture/，和 archive/ 分开', () => {
  assert.equal(captureDir('<repo>'), join('<repo>', 'capture'));
});

test('按通道分子目录：capture/bilibili/，根目录还是那个 capture/', () => {
  // 抖音那批文件是平铺在 capture/ 下的（历史形状，不改），所以子目录必须
  // 挂在同一个根下面 —— 两套各自 prune，混在一个平铺目录里会互相踩
  assert.equal(captureSubdir('<repo>', 'bilibili'), join('<repo>', 'capture', 'bilibili'));
});

// ── 文件名：<msg_key>-<序号>.<ext> ────────────────────────────────

test('B站图床（biliimg / hdslb）放行，仿冒域不放行', () => {
  assert.equal(isAllowedUrl('https://message.biliimg.com/bfs/im_new/78cf7e.png'), true);
  assert.equal(isAllowedUrl('https://i0.hdslb.com/bfs/archive/a.jpg'), true);
  assert.equal(isAllowedUrl('https://biliimg.com.evil.com/a.png'), false);
  assert.equal(isAllowedUrl('https://evil-biliimg.com/a.png'), false);
});

test('safeName 把消息 ID 变成能当文件名的前缀', () => {
  // msg_key 是纯数字，原样用；带前缀的 ID 里冒号换成 -（不丢尾巴）
  assert.equal(safeName('7700219232671842682'), '7700219232671842682');
  assert.equal(safeName('bili:7700219232671842682'), 'bili-7700219232671842682');
  // 路径穿越和非法字符一律不许进文件名
  assert.equal(safeName('../../etc/passwd'), 'etc-passwd');
  assert.equal(safeName('a\\b/c:d*e'), 'a-b-c-d-e');
  assert.equal(safeName(''), 'unknown');
  assert.ok(safeName('x'.repeat(200)).length <= 48);
});

test('给了 name 就落成 <name>-<序号>.<ext>，第二次命中缓存不重复下载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adopter-media-'));
  // 1x1 PNG（不走网络：data: URI 分支）
  const dataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

  const first = await downloadResource({ url: dataUrl, messageId: 'bili:7700219232671842682', name: '7700219232671842682', index: 0, type: 'image', dir });
  assert.equal(first.ok, true, first.error);
  assert.equal(basenameOf(first.path), '7700219232671842682-0.png', '文件名要能直接回查是哪条私信');
  assert.deepEqual(readdirSync(dir), ['7700219232671842682-0.png']);

  const second = await downloadResource({ url: dataUrl, messageId: 'bili:7700219232671842682', name: '7700219232671842682', index: 0, type: 'image', dir });
  assert.equal(second.ok, true);
  assert.equal(second.cached, true, '同一张图重复轮询不许重下');
  assert.equal(readdirSync(dir).length, 1);

  // 同一条消息的第二张图（多图容错）
  const third = await downloadResource({ url: dataUrl, messageId: 'bili:1', name: '7700219232671842682', index: 1, type: 'image', dir });
  assert.equal(basenameOf(third.path), '7700219232671842682-1.png');
});

test('pruneCapture 只清文件，不动子目录（那是各通道自己的落盘区）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adopter-media-'));
  const sub = join(dir, 'bilibili');
  mkdirSync(sub);
  writeFileSync(join(sub, 'keep.png'), 'x');
  for (let index = 0; index < 3; index += 1) {
    const file = join(dir, `f${index}.png`);
    writeFileSync(file, 'x');
    utimesSync(file, 1_700_000_000 + index, 1_700_000_000 + index);
  }
  // maxFiles=1 时只留最新那个文件，子目录必须还在（按 mtime 它是最老的，会被误删）
  utimesSync(sub, 1_600_000_000, 1_600_000_000);
  const result = pruneCapture(dir, 1);
  assert.equal(result.removed, 2);
  assert.deepEqual(readdirSync(dir).sort(), ['bilibili', 'f2.png']);
  assert.equal(existsSync(join(sub, 'keep.png')), true, '子目录里的文件一个都不许被清掉');
});

/** 只要文件名（跨平台都取最后一段，不依赖 path.basename 的平台差异）。 */
function basenameOf(file) {
  return String(file).split(/[\\/]/).pop();
}
