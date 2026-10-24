// 通道层测试：只测纯逻辑，不连浏览器。
//   node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeMessage, toShare } from '../src/channels/douyin.mjs';
import {
  parseBiliJson,
  toContractMessage,
  createZeroSessionWatchdog,
  ZERO_CONVERSATION_ROUNDS,
  extractImageUrls,
  describeBiliMessage,
} from '../src/channels/bilibili.mjs';
import {
  RELOAD_AFTER_FAILURES,
  RELOAD_MIN_GAP_MS,
  appendReloadLog,
  readLastReloadAt,
  reloadGate,
} from '../src/channels/douyin-notice.mjs';
import { validateChannel, loadChannel, listChannelNames } from '../src/channels/registry.mjs';

// ── 分享卡片 → 契约里的 message.share ──────────────────────────────

test('分享的视频卡片能解析成可打开的入口', () => {
  const share = toShare({
    type: 'shared-work',
    videoId: '7312345678901234567',
    url: 'https://www.douyin.com/video/7312345678901234567',
    title: '一条测试视频',
    author: '某某',
    isPhotoGallery: false,
  });
  assert.equal(share.kind, 'video');
  assert.equal(share.videoId, '7312345678901234567');
  assert.equal(share.url, 'https://www.douyin.com/video/7312345678901234567');
  assert.equal(share.title, '一条测试视频');
  assert.equal(share.author, '某某');
});

test('图文作品标成 note，不冒充视频', () => {
  const share = toShare({ type: 'shared-work', videoId: '123', title: '图文', isPhotoGallery: true });
  assert.equal(share.kind, 'note');
});

test('类型未知时标成 work —— 不把「不知道」硬说成视频', () => {
  // 卡片 DOM 里没有可靠的视频/图文判据，解析阶段一律是 null
  const share = toShare({ type: 'shared-work', videoId: '123', isPhotoGallery: null });
  assert.equal(share.kind, 'work');
  assert.equal(toShare({ type: 'shared-work', videoId: '123' }).kind, 'work');
});

test('DOM 没给出链接时，用 videoId 兜一个', () => {
  const share = toShare({ type: 'shared-work', videoId: '999', url: null });
  assert.equal(share.url, 'https://www.douyin.com/video/999');
});

test('没有任何标识时 url 是 null，不编造', () => {
  const share = toShare({ type: 'shared-work', videoId: null, url: null });
  assert.equal(share.videoId, null);
  assert.equal(share.url, null);
});

test('非分享类型的消息不产出 share', () => {
  assert.equal(toShare(undefined), undefined);
  assert.equal(toShare({ type: 'emoji', label: '笑' }), undefined);
  assert.equal(toShare({ type: 'text' }), undefined);
});

// ── 消息文字化 ────────────────────────────────────────────────────

test('文本原样返回，去掉首尾空白', () => {
  assert.equal(describeMessage({ text: '  在吗  ' }), '在吗');
});

test('分享卡片要带上标题和作者，不能退化成 [非文本消息]', () => {
  const line = describeMessage({
    media: { type: 'shared-work', title: '好看的视频', author: 'UP主' },
  });
  assert.match(line, /分享作品/);
  assert.match(line, /好看的视频/);
  assert.match(line, /UP主/);
});

test('表情和图片各有说法', () => {
  assert.equal(describeMessage({ media: { type: 'emoji', label: '感动' } }), '[表情包：感动]');
  assert.equal(describeMessage({ media: { type: 'image' } }), '[图片]');
});

test('表情包标签与 QQ 那条入站对齐（[表情包] / [图片]）', () => {
  // dsh-notifier 的 onebot-in.mjs 对 QQ 的 mface 用 [表情包]、image 用 [图片]，
  // 抖音这边用同一套词，会话侧不用记两套。
  assert.match(describeMessage({ media: { type: 'emoji' } }), /^\[表情包\]/);
  assert.match(describeMessage({ media: { type: 'image' } }), /^\[图片\]/);
});

test('画面落盘后，路径跟着消息一起上报', () => {
  const line = describeMessage({
    id: 'msg:abc',
    media: { type: 'emoji', requiresVisual: true, files: ['<repo>\\capture\\abc-emoji-0.png'] },
  });
  assert.equal(line, '[表情包]（画面：<repo>\\capture\\abc-emoji-0.png）');
});

test('画面没取到要明说，并给出 messageId 供重取', () => {
  // 「只有标签」和「有画面但取不到」是两件事，不能让会话混为一谈
  const line = describeMessage({ id: 'msg:deadbeef', media: { type: 'image', requiresVisual: true } });
  assert.equal(line, '[图片]（画面未取到，messageId=msg:deadbeef）');
});

test('分享卡片的封面路径进 message.share.cover', () => {
  const cover = 'H:\\capture\\cover.png';
  const share = toShare({ type: 'shared-work', author: '某某', isPhotoGallery: null }, cover);
  assert.equal(share.cover, cover);
  assert.equal(toShare({ type: 'shared-work', author: '某某' }).cover, null);
});

test('什么都没有时给一个明确的占位', () => {
  assert.equal(describeMessage({}), '[非文本消息]');
});

// ── 契约校验 ──────────────────────────────────────────────────────

const noopChannel = {
  id: 'demo',
  label: '示例',
  poll: async () => ({}),
  send: async () => ({}),
  status: async () => ({}),
};

test('合规的通道能过校验', () => {
  assert.equal(validateChannel(noopChannel), null);
});

test('缺少必需方法要被拦下', () => {
  assert.match(validateChannel({ ...noopChannel, send: undefined }), /send/);
});

test('id 不合法要被拦下', () => {
  assert.match(validateChannel({ ...noopChannel, id: 'Demo!' }), /id/);
});

test('label 为空要被拦下', () => {
  assert.match(validateChannel({ ...noopChannel, label: '  ' }), /label/);
});

test('可选方法写了但不是函数要被拦下', () => {
  assert.match(validateChannel({ ...noopChannel, openShare: 'x' }), /openShare/);
});

// ── 通道发现与加载 ────────────────────────────────────────────────

test('能列出 douyin 和 bilibili', async () => {
  const names = await listChannelNames();
  assert.ok(names.includes('douyin'));
  assert.ok(names.includes('bilibili'));
  assert.ok(!names.includes('registry'), 'registry 不该被自己列成通道');
});

test('抖音通道实现了契约要求的全部能力', async () => {
  const channel = await loadChannel('douyin', { contactName: 'your-name' });
  assert.equal(channel.id, 'douyin');
  for (const method of ['poll', 'send', 'status', 'contacts', 'read', 'openShare', 'close']) {
    assert.equal(typeof channel[method], 'function', `${method} 应该是函数`);
  }
});

test('B站通道是只读的：能读、能自检，send 明确拒绝', async () => {
  const channel = await loadChannel('bilibili', {});
  assert.equal(channel.id, 'bilibili');
  for (const method of ['poll', 'send', 'status', 'contacts', 'read', 'close']) {
    assert.equal(typeof channel[method], 'function', `${method} 应该是函数`);
  }

  // status 无论登录与否都必须自报「只读」——这是加「回」之前的闸
  const status = await channel.status();
  assert.equal(status.implemented, true);
  assert.equal(status.readOnly, true);
  assert.ok(['on', 'off', 'unknown'].includes(status.pluginDmWatch), '必须报出插件的私信监听状态');

  // 发送是刻意不做的，理由里必须出现「只读」和「dmWatch」
  await assert.rejects(() => channel.send({ text: 'x' }), /只读/);
  await assert.rejects(() => channel.send({ text: 'x' }), /dmWatch/);
});

test('B站凭证缺失时 poll 报 loginRequired，不假装成功', async () => {
  // 注入一个不存在的凭证路径，避免测试依赖本机登录态
  const channel = await loadChannel('bilibili', { credentialPath: join(tmpdir(), 'no-such-bili-credential.json') });
  const snapshot = await channel.poll({});
  assert.equal(snapshot.flags.loginRequired, true);
  assert.equal(snapshot.messages.length, 0);
  assert.match(snapshot.reason, /凭证/);
});

// ── B站：msg_key 精度（这行的存在是为了一次实测事故）─────────────
// 2026-10-25 实测：同一条消息在 DOM 里是 7699152546950374864，
// JSON.parse 之后变成 7699152546950374000 —— 最后三位被 double 抹平。
// 水位拿它当键会把不同消息判成同一条，而且错得极其隐蔽。

test('19 位 msg_key 不能被 JSON.parse 抹平尾巴', () => {
  const body = '{"code":0,"data":{"messages":[{"msg_key":7699152546950374864,"msg_type":10}]}}';
  const parsed = parseBiliJson(body);
  assert.equal(parsed.data.messages[0].msg_key, '7699152546950374864');
  // 反证：普通 JSON.parse 会坏掉（写成断言，是为了让「改回去」立刻被发现）
  assert.notEqual(String(JSON.parse(body).data.messages[0].msg_key), '7699152546950374864');
});

test('msg_key 精度保护不影响 content 里那段被转义的 JSON', () => {
  // content 是一段 JSON 字符串，里面也可能有数字，不能被误伤成字符串
  const body = '{"msg_key":7699152546950374864,"content":"{\\"item\\":\\"123\\",\\"count\\":42}"}';
  const parsed = parseBiliJson(body);
  assert.equal(parsed.msg_key, '7699152546950374864');
  assert.equal(parsed.content, '{"item":"123","count":42}');
});

test('B站消息：msg_key 当水位，方向按 sender_uid 判', () => {
  const selfUid = '1234567890';
  const ours = toContractMessage('844424930131964', { msg_key: '7699152546950374864', msg_type: 1, sender_uid: 1234567890, timestamp: 1792841249, content: '{"content":"我发的"}' }, selfUid);
  const theirs = toContractMessage('844424930131964', { msg_key: '7699152546950374865', msg_type: 1, sender_uid: 844424930131964, timestamp: 1792841250, content: '{"content":"对方发的"}' }, selfUid);
  assert.equal(ours.id, 'bili:7699152546950374864');
  assert.equal(ours.direction, 'outgoing');
  assert.equal(ours.text, '我发的');
  assert.equal(theirs.direction, 'incoming');
  assert.equal(theirs.text, '对方发的');
});

test('B站系统通知（msg_type=10）不上报，但照样有稳定 ID', () => {
  const message = toContractMessage('844424930131964', {
    msg_key: '7700194532385659122',
    msg_type: 10,
    sender_uid: 844424930131964,
    timestamp: 1792841249,
    content: '{"title":"登录操作通知","text":"你的账号在新设备或平台登录成功"}',
  }, '1234567890');
  assert.equal(message.important, false, '系统通知不该叫醒会话');
  assert.equal(message.kind, 'system');
  assert.match(message.text, /登录操作通知/);
  assert.equal(message.id, 'bili:7700194532385659122');
});

test('B站分享卡片能认出 BV 号并挂成 message.share', () => {
  const message = toContractMessage('1', {
    msg_key: '123',
    msg_type: 7,
    sender_uid: 2,
    timestamp: 1792841249,
    content: '{"title":"一条视频","author":"UP主","jump_url":"https://www.bilibili.com/video/BV1c8nK6zEGV"}',
  }, '1');
  assert.equal(message.share.videoId, 'BV1c8nK6zEGV');
  assert.equal(message.share.kind, 'video');
  assert.equal(message.media.type, 'share');
});

test('B站消息没有 msg_key 时给合成 ID，仍然是稳定字符串', () => {
  const row = { msg_type: 1, sender_uid: 2, timestamp: 1792841249, content: '{"content":"没有 key"}' };
  const first = toContractMessage('999', row, '1');
  const second = toContractMessage('999', row, '1');
  assert.equal(first.id, second.id, '合成 ID 必须稳定（不含窗口位置）');
  assert.match(first.id, /^bili:synth:999:/);
});

test('不存在的通道报清楚的错', async () => {
  await assert.rejects(() => loadChannel('weibo', {}), /没有名为「weibo」的通道/);
});

// ── B站：图片消息落盘 ─────────────────────────────────────────────
//
// 背景（2026-10-26 实测）：msg_type=2 的私信，content 是
//   {"url":"https://message.biliimg.com/bfs/im_new/<md5>.png","height":305,"width":305,"size":"90"}
// 改之前只把它当「[图片]」三个字上报，会话里看不到图。
//
// 下面这些断言盯的是「解析 + 措辞」这两件纯逻辑；
// 「真下载 + 落盘路径 + 文件头」由 tools/verify-bili-image-capture.mjs 拿真凭证跑。

/** 实测的那条消息（msg_key=7700219232671842682，脱敏无关：图床 URL 本身无签名）。 */
const REAL_IMAGE_CONTENT =
  '{"url":"https://message.biliimg.com/bfs/im_new/78cf7e6d81f2e046f5f7adbd69177763695300301.png","height":305,"width":305,"size":"90"}';

test('B站图片消息：URL 在 content.url，能抠出来', () => {
  assert.deepEqual(extractImageUrls(JSON.parse(REAL_IMAGE_CONTENT)), [
    'https://message.biliimg.com/bfs/im_new/78cf7e6d81f2e046f5f7adbd69177763695300301.png',
  ]);
});

test('B站图片消息：content 解析后就挂上 media.urls，不是只留一句 [图片]', () => {
  const message = toContractMessage('695300301', {
    msg_key: '7700219232671842682',
    msg_type: 2,
    sender_uid: 695300301,
    timestamp: 1792847000,
    content: REAL_IMAGE_CONTENT,
  }, '1234567890');
  assert.equal(message.kind, 'image');
  assert.equal(message.media.type, 'image');
  assert.equal(message.media.urls.length, 1);
  assert.match(message.media.urls[0], /^https:\/\/message\.biliimg\.com\/bfs\/im_new\//);
  assert.equal(message.media.requiresVisual, true, '有地址但还没落盘 → 需要画面');
});

test('多图也认：数组 / image_urls 之类的形状不许写死成一张', () => {
  // B站私信实测是一条一张，但接口形状变了不该直接瞎掉
  const two = extractImageUrls({
    image_urls: ['https://message.biliimg.com/a.png', 'https://i0.hdslb.com/b.jpg'],
  });
  assert.equal(two.length, 2);
  assert.deepEqual(extractImageUrls(['https://message.biliimg.com/c.webp']), ['https://message.biliimg.com/c.webp']);
  // 同一个地址重复出现只留一份
  assert.equal(extractImageUrls({ url: 'https://i0.hdslb.com/x.png', dup: 'https://i0.hdslb.com/x.png' }).length, 1);
});

test('非图片的链接不许当成图去下载（jump_uri 那种）', () => {
  // 系统通知里的详情链接不能被当成图片（它同样在 content 里）
  assert.deepEqual(extractImageUrls({ jump_uri: 'https://account.bilibili.com/h5/account-h5/notice/notice-login?mid=1' }), []);
  assert.deepEqual(extractImageUrls({ url: 'http://i0.hdslb.com/a.png' }), ['http://i0.hdslb.com/a.png'], 'http 也算地址（是否放行由 store 的白名单决定）');
  assert.deepEqual(extractImageUrls({ url: 'not a url' }), []);
  assert.deepEqual(extractImageUrls(null), []);
});

test('B站图片落盘后，describe() 给出本地路径（和抖音同一套措辞）', () => {
  const file = '<repo>\\capture\\bilibili\\7700219232671842682-0.png';
  const biliLine = describeBiliMessage({ media: { type: 'image', files: [file] } });
  assert.equal(biliLine, `[图片]（画面：${file}）`);

  // 措辞必须和抖音那边**一个字都不差** —— 会话侧只认一套规则
  const douyinLine = describeMessage({ media: { type: 'image', files: [file] } });
  assert.equal(biliLine, douyinLine);
});

test('B站图片没落盘时：「没有 URL」和「下载失败」要分开说', () => {
  const noUrl = describeBiliMessage({
    id: 'bili:7700219232671842682',
    media: { type: 'image', requiresVisual: true, captureError: '没有 URL（content 里没找到图床地址）' },
  });
  assert.match(noUrl, /^\[图片\]（画面未取到：没有 URL/);
  assert.match(noUrl, /messageId=bili:7700219232671842682/);

  const forbidden = describeBiliMessage({
    id: 'bili:42',
    media: { type: 'image', requiresVisual: true, captureError: '下载失败：HTTP 403' },
  });
  assert.match(forbidden, /HTTP 403/);
  assert.match(forbidden, /messageId=bili:42/);

  // 只有标签、没有任何原因的旧形状也别崩（退回抖音那句「画面未取到」）
  assert.equal(
    describeBiliMessage({ id: 'bili:7', media: { type: 'image', requiresVisual: true } }),
    '[图片]（画面未取到，messageId=bili:7）',
  );
});

test('按策略没取（自己发出去的图）不算失败，不加「未取到」', () => {
  assert.equal(
    describeBiliMessage({ id: 'bili:9', media: { type: 'image', requiresVisual: false, captureSkipped: 'outgoing' } }),
    '[图片]',
  );
});

test('多张图落盘时路径都带上（用「、」连起来）', () => {
  const line = describeBiliMessage({ media: { type: 'image', files: ['C:\\a.png', 'C:\\b.png'] } });
  assert.equal(line, '[图片]（画面：C:\\a.png、C:\\b.png）');
});

test('B站通道的 describe() 用导出那份规则（别在通道里另写一遍）', async () => {
  const channel = await loadChannel('bilibili', {});
  const message = { id: 'bili:1', media: { type: 'image', files: ['C:\\x.png'] } };
  assert.equal(channel.describe(message), describeBiliMessage(message));
});

// ── 通知通道的整页重载闸 ──────────────────────────────────────────
// 用户 2026-10-23 的要求：打不开浮层不许立刻刷新页面（那等于每轮轮询刷一次），
// 只有「连续失败够多」且「距上次重载够久」才许重载一次。

test('连续失败没到阈值时，不许重载页面', () => {
  for (let failures = 0; failures < RELOAD_AFTER_FAILURES; failures += 1) {
    const gate = reloadGate({ consecutiveFailures: failures, lastReloadAt: 0, now: 1_000_000 });
    assert.equal(gate.allowed, false, `失败 ${failures} 轮不该放行`);
    assert.match(gate.reason, /没到重载阈值/);
  }
});

test('从没重载过 + 连续失败到阈值 → 允许重载一次', () => {
  const gate = reloadGate({ consecutiveFailures: RELOAD_AFTER_FAILURES, lastReloadAt: 0, now: 1_000_000 });
  assert.equal(gate.allowed, true);
  assert.match(gate.reason, /连续失败 5 轮/);
});

test('10 分钟内刚刷过 → 连续失败再多也不许再刷', () => {
  const now = 1_000_000_000;
  const gate = reloadGate({
    consecutiveFailures: RELOAD_AFTER_FAILURES + 3,
    lastReloadAt: now - 5 * 60_000,
    now,
  });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /还要再等 5 分钟/);
});

test('距上次重载超过 10 分钟 → 重新放行', () => {
  const now = 1_000_000_000;
  const gate = reloadGate({
    consecutiveFailures: RELOAD_AFTER_FAILURES,
    lastReloadAt: now - RELOAD_MIN_GAP_MS - 1000,
    now,
  });
  assert.equal(gate.allowed, true);
});

test('重载记录能写能读：文件不存在当作「从没重载过」，有多行时取最后一条', () => {
  const file = join(tmpdir(), `notice-reloads-${process.pid}-${Date.now()}.log`);
  assert.equal(readLastReloadAt(file), 0);

  const at = Date.now();
  const line = appendReloadLog({ at, attempt: 1, failures: 5, reason: '测试', file });
  assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\t第 1 次\t连续 5 轮打不开\t测试$/);

  appendReloadLog({ at: at + 60_000, attempt: 2, failures: 6, reason: '测试2', file });
  assert.equal(readLastReloadAt(file), at + 60_000, '应当取最后一条，而不是第一条');

  rmSync(file, { force: true });
});

// ── B站：连续 0 会话的看门狗（静默失效）────────────────────────────
//
// 背景（2026-10-25 实测）：cookie 过期时 B站的会话列表接口**仍可能回 code 0 +
// 空列表**，于是 poll() 不报错、flags 是空的 —— 通道安安静静地「读到 0 条」，
// 没人知道它已经瞎了。看门狗负责在连续 0 会话到阈值时验一次 status()，
// 并**只写一行日志**（不阻断轮询、不改 poll() 的返回值）。
//
// 下面那个「假通道」就是给它喂 status() 用的：看门狗只需要这一个能力。

/** 一个只有 status() 的假通道 —— 看门狗的全部外部依赖就这一样。 */
function fakeChannel(status) {
  return { status: async () => status };
}

test('B站看门狗：阈值之前一次 status() 都不调（那是网络请求）', async () => {
  const rounds = 3;
  const lines = [];
  let calls = 0;
  const watch = createZeroSessionWatchdog({
    rounds,
    verify: async () => {
      calls += 1;
      return fakeChannel({ ok: false, loggedIn: false, navCode: -101 }).status();
    },
    logger: (line) => lines.push(line),
  });

  assert.equal(await watch.observe(0), false, '第 1 轮 0 会话不该验');
  assert.equal(await watch.observe(0), false, '第 2 轮 0 会话不该验');
  assert.equal(calls, 0, '阈值之前不许调 status()');
  assert.equal(lines.length, 0, '阈值之前不许报警');
});

test('B站看门狗：连续 N 轮 0 会话 → 恰好验一次、报一次，文案给出要跑的命令', async () => {
  const rounds = 3;
  const lines = [];
  let calls = 0;
  const watch = createZeroSessionWatchdog({
    rounds,
    verify: async () => {
      calls += 1;
      return fakeChannel({ ok: false, loggedIn: false, navCode: -101, reason: 'nav 挂了' }).status();
    },
    logger: (line) => lines.push(line),
  });

  await watch.observe(0);
  await watch.observe(0);
  assert.equal(await watch.observe(0), true, '第 N 轮该验了');
  assert.equal(calls, 1);
  assert.equal(lines.length, 1);

  // 强告警：说清「几轮 / nav 码 / 跑哪条命令」—— 少一样使用者都得自己猜
  assert.match(lines[0], new RegExp(`连续 ${rounds} 轮读到 0 个会话`));
  assert.match(lines[0], /nav code=-101/);
  assert.match(lines[0], /node tools\/bili-login\.mjs/);
  assert.match(lines[0], /cookie 过期/);

  // 还没恢复：继续 0 会话，不许再验、不许再报（别刷屏）
  for (let index = 0; index < rounds * 3; index += 1) {
    assert.equal(await watch.observe(0), false, '一次故障只验一次');
  }
  assert.equal(calls, 1, 'status() 只许调一次');
  assert.equal(lines.length, 1, '告警只许出一条');
});

test('B站看门狗：恢复出会话后计数清零，下次再坏再报一次', async () => {
  const rounds = 3;
  const lines = [];
  let calls = 0;
  const watch = createZeroSessionWatchdog({
    rounds,
    verify: async () => {
      calls += 1;
      return fakeChannel({ ok: false, loggedIn: false, navCode: -101 }).status();
    },
    logger: (line) => lines.push(line),
  });

  await watch.observe(0);
  await watch.observe(0);
  await watch.observe(0); // 第一次报
  assert.equal(lines.length, 1);

  // 会话回来了（正常两三个会话）
  assert.equal(await watch.observe(2), false);
  assert.equal(watch.zeroRounds, 0, '恢复后计数必须清零');
  assert.equal(watch.alerted, false, '恢复后「已报过」必须复位');

  // 再坏一次：应该重新计数、再验一次、再报一次
  await watch.observe(0);
  await watch.observe(0);
  assert.equal(await watch.observe(0), true);
  assert.equal(calls, 2, '第二次故障要重新验');
  assert.equal(lines.length, 2, '第二次故障要重新报（但只一条）');
});

test('B站看门狗：登录正常时只给弱提示，不喊「cookie 过期」', async () => {
  const rounds = 2;
  const lines = [];
  const watch = createZeroSessionWatchdog({
    rounds,
    verify: async () => fakeChannel({ ok: true, loggedIn: true, uname: 'bili_1234567890' }).status(),
    logger: (line) => lines.push(line),
  });

  await watch.observe(0);
  await watch.observe(0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /连续 2 轮读到 0 个会话/, '两种情况的共同部分照旧');
  assert.match(lines[0], /登录正常/);
  assert.match(lines[0], /bili_1234567890/);
  assert.doesNotMatch(lines[0], /cookie 过期/, '登录正常时不许断言 cookie 过期');
  assert.doesNotMatch(lines[0], /bili-login/, '登录正常时不用叫人去扫码');
  assert.match(lines[0], /先别当坏了/, '措辞要留余地，别断言坏了');
});

test('B站看门狗：登录态问不出来（nav 超时）也只报一次，且留余地', async () => {
  const rounds = 2;
  const lines = [];
  let calls = 0;
  const watch = createZeroSessionWatchdog({
    rounds,
    verify: async () => {
      calls += 1;
      throw new Error('nav 请求超时');
    },
    logger: (line) => lines.push(line),
  });

  await watch.observe(0);
  assert.equal(await watch.observe(0), true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /也没问成/);
  assert.match(lines[0], /nav 请求超时/);

  // verify 抛错也不许每 N 轮重试一次（那是白烧网络）
  for (let index = 0; index < rounds * 4; index += 1) await watch.observe(0);
  assert.equal(calls, 1, '抛过错之后这一轮故障期就不再验了');
  assert.equal(lines.length, 1);
});

test('B站看门狗：默认阈值是 8 轮（默认 15 秒一轮 ≈ 2 分钟），不是随手写死的数', () => {
  assert.equal(ZERO_CONVERSATION_ROUNDS, 8);
  assert.ok(ZERO_CONVERSATION_ROUNDS >= 4, '阈值太小会被单次抖动骗到');
  assert.ok(ZERO_CONVERSATION_ROUNDS <= 20, '阈值太大，通道瞎了要等五分钟以上才发现');
});

