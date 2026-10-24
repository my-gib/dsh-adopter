// B站通道 —— **只读版**。读私信，不发。
//
// ════════════════════════════════════════════════════════════════════
// 为什么只读（封条，别拆）
//
//   本机同时跑着 dsh-bili-scroll 插件，它的「私信监听」是**默认开**的
//   （duty.log 2026-10-24 11:42：`私信监听：已开（每 1 分钟查一次）`），
//   会拿主人本人的私信去回复。
//
//   所以两个进程在这里的分工是：
//     · 读 —— **没有副作用**，两边同时读不冲突，随便并存 ✓
//     · 回 —— **会撞车**：插件回一条、adopter 再回一条，对方收到两条同样的回复 ✗
//
//   ⇒ 读的部分现在就能跑（默认就是只读）。**发送要两个条件同时满足**才动：
//     ① `createChannel({ allowSend: true })` —— 默认 false，不传就 throw
//     ② 插件的 dmWatch 已经关掉（设置页关「私信监听」，或 config 里 dmWatch 设 false）
//     ② 的理由就是上面那条撞车。`status()` 会把两个状态都报出来
//     （`sendEnabled` / `pluginDmWatch`），动手前先看它。
//
//   为什么不能两边都留着：那个插件回复时用的是它自己的人格和节奏，adopter 回复时用的是
//   会话里的模型 —— 两者对同一个人的同一句话各回一条，看起来像精神分裂，而且都是拿使用者
//   的号发的。
//
//   ⚠️ 补充（2026-10-25 实测）：插件现在 `dmOwnerUid=0` + `dmReplyPerDay=0` + `dmMode=off`，
//   实际只监听不回复，撞车的概率很低。但**别拿这个当放开的理由** —— 那是使用者的配置，
//   他哪天打开就会撞。闸门留着，要开就显式开。
// ════════════════════════════════════════════════════════════════════
//
// 走 HTTP API，不走 DOM。理由（都实测过，详见 `B站接入-可行性报告.md`）：
//   · 只要 3 个 cookie（SESSDATA / bili_jct / buvid3），**不需要 wbi 签名**
//   · 不用浏览器、不用扫码窗口、不用 tab 锁、不用等动画
//   · 私信有原生稳定消息 ID（`msg_key`），DOM 那边得从 `data-msg-key` 里抠
//
// 三个实测踩过的坑，改这个文件前先读完：
//   ① **`msg_key` 是 19 位整数，`JSON.parse` 会丢精度。**
//      实测同一条消息：DOM 里是 7699152546950374864，JSON.parse 之后变成
//      7699152546950374000 —— 最后三位被抹平。去重水位拿它当键会把不同消息判成
//      同一条，而且错得非常隐蔽。所以下面统一走 `parseBiliJson`，先把这几个字段
//      当字符串保护起来再 parse。**绝不能用 Number 当去重键。**
//   ② `content` 是**一段 JSON 字符串**，要二次 parse 才拿到正文。
//   ③ `msg_type` 要分开看：10 = 系统通知（社区中心那种），7/8 = 分享卡片，
//      其余大概率是 1（文本）。真人文本消息**还没验到**（这个号没有真人会话）。
//
// 凭证：读 `~/.dsh/bili-duty/bili_credential.json`。
//   **这个文件只由 `node tools/bili-login.mjs` 写**，通道这边仍然只读、不写 ——
//   不要在这里再搞一套扫码，也不要自动弹二维码（那是打扰，得显式触发）。
//   原先由 dsh-bili-scroll 插件扫码续期，插件被禁用（2026-10-24）后就没人续了，
//   所以那件事搬到了 `tools/bili-login.mjs`：自己生成 B站二维码 → 经 NapCat
//   发到 QQ → 扫码成功写回这个 json。cookie 一过期就这么续。
//
// 静默失效的兜底：cookie 过期时 `poll()` **未必报错** —— 会话列表接口对无效
//   cookie 仍可能回 code 0 + 空列表（2026-10-25 实测），于是通道安安静静地
//   「读到 0 条」，flags 也是空的。`createZeroSessionWatchdog` 专门盯这个：
//   连续 8 轮 0 会话才去问一次 `status()`，然后**只写一行日志**告诉你跑哪条命令。
//   不阻断轮询、不改 `poll()` 的返回值、不往 notifier 推东西。
//
// 图片消息（2026-10-26 加）：`msg_type=2`，content 里就是图床地址。落盘之后
//   `describe()` 输出 `[图片]（画面：<本地路径>）` —— 措辞和抖音那边**一模一样**，
//   会话侧拿到路径直接 read_image，不用为两个平台记两条规则。
//   实测形状、要不要 Referer、为什么只下「对方发的」，都写在
//   `extractImageUrls` / `saveImage` 的注释里。表情（`[热词系列_干杯]`）是
//   **msg_type=1 的文本**，不经过这条路径，也没有为它做任何特殊逻辑。
// ────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureDir, captureSubdir, downloadResource, pruneCapture } from '../media/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

const HOME = homedir();
const CREDENTIAL_PATH = path.join(HOME, '.dsh', 'bili-duty', 'bili_credential.json');
const DUTY_LOG_PATH = path.join(HOME, '.dsh', 'bili-duty', 'duty.log');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0';

/**
 * 单轮最多读几个会话、每个会话读几条。
 *
 * 为什么要有上限：每个会话要单独发一次请求，adopter 默认 15 秒一轮，
 * 会话一多就会追不上（抖音那边群聊实测过：8 个群就 16.5s > 15s）。
 * 第一版设 10，超出的显式警告，别让它悄悄变慢。
 */
const MAX_CONVERSATIONS = 10;
const MESSAGES_PER_CONVERSATION = 20;

/**
 * 连续读到多少轮「0 个会话」，才值得花一次 nav 请求去问 `status()`。
 *
 * 为什么是 8 轮：adopter 默认 `pollMs=15000`（config.json），8 轮 ≈ **2 分钟**。
 *   会话列表不会「忽然全空」—— B站的私信会话不会自己消失，真读到 0 个，说明
 *   列表接口本身不对劲了（cookie 过期最常见，见下面 watchBili 的注释）。
 *   2 分钟足够排除单次抖动（接口偶发抽风 / 网络reset），又不至于让人对着一条
 *   悄悄断掉的通道等十分钟。
 *
 * ⚠️ 这是**轮数**不是秒：有人把 pollMs 调大会让实际等待时间跟着变长，
 *    改这个数之前先看 config.json 里的 pollMs。
 */
export const ZERO_CONVERSATION_ROUNDS = 8;
/**
 * 通道的统一日志出口。
 *
 * 主进程**没有**给通道传 logger（`adopter.mjs` 里是 `loadChannel(id, options)`，
 * options 只来自 config.json），所以照 `douyin.mjs` 的先例直接用 console.warn。
 * 这不是「随便打个 console」了事：launcher（`start-adopter.cmd`）把 stdout 和
 * stderr **一起重定向**进 `logs\adopter.log`（`>> logs\adopter.log 2>&1`），
 * 实测 `[douyin] …` 那类通道层警告就躺在那个文件里。也就是说这条路是有人看得见的。
 *
 * 想换出口（比如以后主进程给了 logger）就传 `createChannel({ logger })`，
 * 不用改这里。
 */
function warnBili(line) {
  console.warn(line);
}

/** msg_type 的已知取值。没验到的别写死成「一定是文本」。 */
const MSG_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  SHARE: 7,
  SHARE_ALT: 8,
  SYSTEM: 10,
};

/**
 * 发私信接口的 `msg[dev_id]`。
 *
 * 这个 UUID 是从本机 `bilibili-api-python` 的 `session.py` 里读出来的 ——
 * 它那边就是**硬编码常量**，说明 B 站服务端只校验格式、不校验真实性。
 * 别自己编一个，编了可能被拒。
 */
const DEV_ID = 'A6716E9A-7CE3-47AF-994B-F0B34178D28D';

/** B站私信的单条上限（私信页输入框里写着 0/500，实测看到的）。 */
const MAX_MESSAGE_LENGTH = 500;

/**
 * 图片消息（msg_type=2）落盘的三个上限。
 *
 * 为什么要上限：`poll()` 默认 15 秒一轮，而图片是**真下载**。实测同一张 90KB 的
 * PNG（message.biliimg.com）冷启动 58ms~1267ms、热连接 ~60ms ——
 * **抖动一个数量级**，所以不能赌它总是快。一个刚打开的会话窗口里有 20 条消息，
 * 要是每条图都排着队下，一轮轮询会被拖长 —— 抖音那边群聊已经踩过这个坑
 * （8 个群 16.5s > 15s，见 MAX_GROUPS 注释）。
 *
 * 真正兜住「别拖慢轮询」的是**时间预算**，不是张数：
 *   每张图自带 6 秒超时，图床挂死时 3 张就能把一轮吃到 18 秒。所以
 *   每轮最多花 5 秒在图片上 —— 一开下载就超时就停手，最坏一轮 ≈ 6.5 秒，仍在 15 秒间隔内。
 * 张数上限设 8（不是 1、2、3）的理由：一整个窗口（默认 20 条）里的图通常个位数，
 * 把上限压到 3 会让第 4 张以后的图永远只能拿到「预算用完」——
 * 而一条消息**只上报一次**（adopter 按 messageId 记水位），下一轮补下好的文件
 * 也就没有第二次上报的机会了。所以张数上限定在「覆盖得住一整个窗口」的量级，
 * 让它只在异常时（窗口里 9 张以上图）才生效；异常时说的那句话必须给出
 * 「文件会落在哪个目录」，别让人对着「未取到」干瞪眼。
 *
 * 失败之后 10 分钟内不再重试（`IMAGE_RETRY_AFTER_MS`）—— 图床 403 的时候
 * 每 15 秒撞一次是纯浪费，而临时抽风过期后会自动再试一次。
 */
const MAX_IMAGE_DOWNLOADS_PER_ROUND = 8;
const IMAGE_BUDGET_MS = 5_000;
const IMAGE_TIMEOUT_MS = 6_000;
const IMAGE_RETRY_AFTER_MS = 10 * 60_000;

/** 一条消息里最多认几张图（B站私信实测是一条一张，多图只是容错，别无限收）。 */
const MAX_IMAGES_PER_MESSAGE = 9;

// ── 基础工具 ────────────────────────────────────────────────────────

/**
 * 保住大整数 ID 的 JSON.parse。
 *
 * 只保护这几个字段（都是 B 站的消息/评论 ID），不做通用 BigInt 处理 ——
 * 通用处理会误伤 content 那段被转义的 JSON 字符串里的数字。
 *
 * 导出是给测试用的：这是本文件最容易被「优化掉」的一处，
 * 有人把它改回 JSON.parse(text) 时 test/channels.test.mjs 会立刻挂。
 */
export function parseBiliJson(text) {
  const guarded = String(text).replace(
    /"(msg_key|msg_seqno|rpid|root)":(\d+)/g,
    (_match, key, value) => `"${key}":"${value}"`,
  );
  return JSON.parse(guarded);
}

function headersOf(cred) {
  return {
    'User-Agent': UA,
    Referer: 'https://message.bilibili.com/',
    Origin: 'https://message.bilibili.com',
    Cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
  };
}

/** 统一发一个 GET，把「网络错」和「接口回了错误码」分开报。 */
async function biliGet(url, cred, signal) {
  const timeout = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, { headers: headersOf(cred), signal: combined });
  const text = await response.text();
  let json = null;
  try {
    json = parseBiliJson(text);
  } catch {
    throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 120)}`);
  }
  return { status: response.status, json };
}

/** content 是「一段 JSON 字符串」，二次 parse。解析不了就当空对象，别抛。 */
function parseContent(raw) {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * 判断一个字符串像不像「图片地址」。
 *
 * 为什么不干脆「所有 http(s) 都收」：图片消息的 content 以后可能多挂别的链接
 * （卡片、跳转），全收会把非图片的东西当图去下载。这里只认两种：
 *   ① 带图片扩展名的（B站实测就是 `.png`）
 *   ② 落在两家图床域下的（B站 biliimg / hdslb，抖音 douyinpic / byteimg）
 * `jump_uri` 那种 `account.bilibili.com/h5/...` 两条都不满足，不会被误收。
 */
function looksLikeImageUrl(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return false;
  if (/\.(png|jpe?g|gif|webp|avif|heic|bmp)(\?|#|$)/i.test(text)) return true;
  return /^https?:\/\/([^/]*\.)?(biliimg\.com|hdslb\.com|douyinpic\.com|byteimg\.com)\//i.test(text);
}

/**
 * 从图片消息的 `content` 里抠出图床地址（可能多张）。
 *
 * 实测形状（2026-10-26，msg_key=7700219232671842682，就是用本机真实凭证 dump 的）：
 *   content = '{"url":"https://message.biliimg.com/bfs/im_new/<md5>.png",
 *               "height":305,"width":305,"size":"90"}'
 * 关键结论：
 *   · 地址就在 **`content.url`**，没有 `image_url` / `origin_image` / 缩略图字段 ——
 *     `height`/`width`/`size` 只是显示用的元数据（注意 `size` 是字符串 "90"，
 *     不是字节数；真实文件是 90549 字节）；
 *   · 下载下来的就是**原图**（305x305 PNG，90KB），B站没有再给一份「更小的缩略图」，
 *     所以不需要在缩略图/原图之间挑；
 *   · **B站私信的多张图是分条发的**（每条一个 msg_type=2），不会挤在一条里。
 *     下面之所以还支持数组 / `image_urls` 之类的形状，是容错而不是现状 ——
 *     别把这里改回「只读 content.url」，那等于把「以后可能变」写死成「一定不会变」。
 *
 * 导出给测试用：这条解析错了，落盘就是空的，而描述会悄悄退回 `[图片]`。
 */
export function extractImageUrls(content) {
  const urls = [];
  const push = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!looksLikeImageUrl(text)) return;
    if (!urls.includes(text)) urls.push(text);
  };

  const visit = (node, depth = 0) => {
    if (node == null || depth > 4) return;
    if (typeof node === 'string') {
      push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      // 明确是图片字段的先收，保证顺序稳定（url 在 img_url 前面）
      if (/^(url|image_url|img_url|origin_image|origin_url|pic|src|image|img)$/i.test(key)) {
        push(value);
        // 字段名对但值不是字符串（比如 {url:{...}}）：继续往下挖，别漏
        if (typeof value !== 'string') visit(value, depth + 1);
      } else {
        visit(value, depth + 1);
      }
    }
  };

  visit(content);
  return urls.slice(0, MAX_IMAGES_PER_MESSAGE);
}

/**
 * 从消息里抠出分享卡片。
 *
 * 只看 content，不看类型 —— 实测系统通知（type 10）和大卡片都会带 jump_uri，
 * 单看类型会漏。能抓到 BV 号才算分享。
 */
function shareOf(content, type) {
  const typeKnown = type === MSG_TYPE.SHARE || type === MSG_TYPE.SHARE_ALT;
  const jump = String(content?.jump_uri ?? content?.jump_url ?? '');
  const bvidFromJump = /BV[0-9A-Za-z]{10}/.exec(jump)?.[0] ?? null;
  const bvid = String(content?.bvid ?? '').match(/BV[0-9A-Za-z]{10}/)?.[0] ?? bvidFromJump;
  const looksLikeCard = typeKnown || bvid || content?.title || content?.author;
  // 系统通知也带 title/jump_uri，但那不是「好友分享的作品」，别混进来
  if (type === MSG_TYPE.SYSTEM) return null;
  if (!looksLikeCard || (!bvid && !typeKnown)) return null;
  return {
    kind: 'video',
    videoId: bvid,
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : jump || null,
    title: content?.title ? String(content.title).slice(0, 120) : null,
    author: content?.author ? String(content.author).slice(0, 80) : null,
    cover: content?.thumb ? String(content.thumb) : null,
  };
}

/**
 * 把 B 站的一条消息翻译成契约形状。
 *
 * 水位用的是返回的 id（框架按 message.id 去重），所以这里必须给出稳定且唯一的字符串。
 * 有 msg_key 就用它；没有才退到「会话+类型+时间+正文首段」的合成键 —— 合成键在
 * 同一条消息被读第二次时也稳定，因为它不含窗口位置。
 *
 * 导出给测试用（方向判定、系统通知不上报这两条容易被改坏）。
 */
export function toContractMessage(talkerId, row, selfUid) {
  const type = Number(row?.msg_type) || 0;
  const content = parseContent(row?.content);
  const senderUid = Number(row?.sender_uid) || 0;
  const outgoing = senderUid === Number(selfUid);
  const timestamp = Number(row?.timestamp) || 0;

  const text = (() => {
    if (type === MSG_TYPE.SYSTEM) {
      const title = String(content?.title ?? '').trim();
      const body = String(content?.text ?? '').trim();
      return [title, body].filter(Boolean).join('：').slice(0, 500);
    }
    const raw = content?.content ?? content?.text ?? '';
    return typeof raw === 'string' ? raw.trim().slice(0, 1000) : '';
  })();

  const share = shareOf(content, type);
  const media = (() => {
    if (share) return { type: 'share', title: share.title, author: share.author };
    if (type === MSG_TYPE.SYSTEM) return { type: 'system' };
    if (type === MSG_TYPE.IMAGE) {
      /**
       * 图片消息只负责**把地址带出来**，不在这里下载 ——
       * 这个函数是纯的（测试直接调它），落盘/超时/失败重试都在 poll 里的 saveImage。
       *
       * `urls` 为空也是一个要如实报告的事实（「没有 URL」和「下载失败」是两回事），
       * 所以 `requiresVisual` 一律先挂上，由 saveImage 决定最后怎么说。
       */
      const urls = extractImageUrls(content);
      return { type: 'image', urls, requiresVisual: true };
    }
    // B 站的表情消息也是 type 1，靠 content 里有没有 emoji 字段区分 —— 没验到，先不猜
    return null;
  })();

  const id =
    typeof row?.msg_key === 'string' && row.msg_key
      ? `bili:${row.msg_key}`
      : `bili:synth:${talkerId}:${type}:${timestamp}:${text.slice(0, 24)}`;

  const message = {
    id,
    direction: outgoing ? 'outgoing' : 'incoming',
    text,
    sentAt: timestamp ? new Date(timestamp * 1000).toISOString() : null,
    kind: type === MSG_TYPE.SYSTEM ? 'system' : share ? 'share' : type === MSG_TYPE.IMAGE ? 'image' : 'text',
  };
  if (media) message.media = media;
  if (share) message.share = share;
  /**
   * 系统通知（登录提示、社区公告那类）**不进会话**。
   * 理由：这类消息每轮都在、没有回复价值，上报等于每次登录都叫醒一次模型。
   * 框架看到 important:false 仍然记账（水位照走），只写日志不发总线。
   */
  if (type === MSG_TYPE.SYSTEM) message.important = false;
  return message;
}

/**
 * 图片消息的「画面在哪」提示。
 *
 * 措辞**故意和抖音那边（douyin.mjs 的 pictureHint）一模一样** —— 会话侧只认一套：
 *   · 落盘成功：`（画面：<绝对路径>）`，多张用「、」连起来
 *   · 没落盘  ：`（画面未取到：<原因>，messageId=<id>）`
 * 原因必须说清是「没有 URL」还是「下载失败：HTTP 403」——
 * 「只有 [图片] 三个字」和「有图但取不到」是两件事，不能让会话混为一谈。
 *
 * `captureSkipped` 是按策略主动不取（默认只下对方发的图，见 captureIncomingOnly），
 * 那不是失败，所以一个字的提示都不加。
 */
export function pictureHint(media, messageId) {
  const files = Array.isArray(media?.files) ? media.files.filter((file) => typeof file === 'string' && file) : [];
  if (files.length) return `（画面：${files.join('、')}）`;
  if (media?.captureSkipped) return '';
  const why = media?.captureError ? `：${media.captureError}` : '';
  const id = messageId ? `，messageId=${messageId}` : '';
  return `（画面未取到${why}${id}）`;
}

/** 一条消息压成一行文字。分享卡片/图片/系统通知各有说法，别退化成一个 [非文本消息] 就没了。 */
export function describeBiliMessage(message) {
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (text) return text;
  const media = message?.media;
  if (media?.type === 'share') {
    const title = media.title ? `：${media.title}` : '';
    const author = media.author ? ` @${media.author}` : '';
    /**
     * 2026-10-25：把 BV 链接一起带出去。
     *
     * `shareOf()` 早就从 content.bvid / jump_uri 里抠出了 BV 号并存进 media.videoId / url，
     * 但压成一行文本时只留了标题和作者 —— 会话那边拿到「某某分享了一个视频」，
     * 却没有可以点开的东西，等于把最有用的字段丢了。
     */
    const link = media.url ? ` ${media.url}` : media.videoId ? ` https://www.bilibili.com/video/${media.videoId}` : '';
    return `[分享视频${title}${author}${link}]`;
  }
  if (media?.type === 'image') return `[图片]${pictureHint(media, message?.id)}`;
  if (media?.type === 'system') return '[系统通知]';
  return `[非文本消息]${pictureHint(media, message?.id)}`;
}

/** 会话展示名：B 站 session_list 里不一定带名字，拿不到就如实退到 uid。 */
function displayNameOf(session) {
  const candidates = [
    session?.talker_name,
    session?.name,
    session?.account_info?.name,
    session?.show_name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return `uid:${session?.talker_id ?? '?'}`;
}

/** 插件的私信监听开着没 —— status() 要报出来，加「回」之前必须看它。 */
function readPluginDmWatch() {
  try {
    const text = readFileSync(DUTY_LOG_PATH, 'utf8');
    const matches = [...text.matchAll(/私信监听：(已开|已关)/g)];
    if (!matches.length) return { state: 'unknown', reason: 'duty.log 里没有私信监听的记录' };
    const last = matches[matches.length - 1][1];
    return { state: last === '已开' ? 'on' : 'off' };
  } catch (error) {
    return { state: 'unknown', reason: `读不到 duty.log（${error?.code ?? '未知'}）` };
  }
}

/**
 * 把接口错误码翻译成人话。B站的登录态失效是 -101 / -352。
 *
 * 认证失效这条**必须带上「跑哪条命令」** —— 这条 reason 就是 poll 报 loginRequired 时
 * 使用者唯一看得到的话。插件被禁用之后 cookie 不会自己续，不说清楚就是干瞪眼。
 */
function describeApiError(json) {
  const code = json?.code;
  if (code === -101 || code === -352) {
    return {
      loginRequired: true,
      reason:
        'B站登录态失效（cookie 过期了）。跑 `node tools/bili-login.mjs` 续一次：' +
        '它生成二维码、经 NapCat 发到 QQ，扫完自动把凭证写回 bili_credential.json。',
    };
  }
  if (code === -412) return { blocked: true, reason: 'B站风控（-412），先停一会儿。' };
  return { reason: `B站接口返回 code=${code}：${json?.message ?? ''}` };
}

// ── 「连续 0 会话」看门狗 ───────────────────────────────────────────

/**
 * 盯「连续读到 0 个会话」的看门狗。
 *
 * 为什么要有它：cookie 过期时 `poll()` **未必报错**。2026-10-25 实测，拿一份
 * 无效 cookie 去读会话列表，B站仍然回 `code 0` + 空列表 —— 于是通道安安静静地
 * 「读到 0 条」，flags 是空的，没人知道它已经瞎了。报错还好办，这种**静默失效**
 * 才是真的坑（使用者原话：对着 loginRequired 干瞪眼；实际上连 loginRequired 都
 * 不一定有）。
 *
 * 三条纪律（改之前先读完）：
 *   ① **只在连续 0 会话到阈值时才去问一次 `status()`** —— 它要打网络请求（nav），
 *      绝不能每 15 秒一轮地白烧；
 *   ② **一次故障只报一次** —— 报完把计数清零并置 `alerted`，恢复出会话后才复位，
 *      下次再坏再报一次，不刷屏；
 *   ③ **只写日志**：不阻断轮询、不改 `poll()` 的返回值、不往 notifier 推东西。
 *
 * 判据用的是**列表接口给的会话数**（`sessions.length`），不是过滤之后的
 * `conversations.length` —— 后者会被 recipients 白名单影响，配了个不存在的 uid
 * 就会一直是 0，那是配置问题，不该报成「cookie 过期」。
 *
 * 导出是给测试用的：上面 ② 那条是最容易被顺手改坏的地方。
 *
 * @param {object} options
 * @param {number} [options.rounds] 连续多少轮 0 会话才验一次（默认 ZERO_CONVERSATION_ROUNDS）
 * @param {() => Promise<object>} options.verify 验登录态，返回 `status()` 那个对象
 * @param {(line: string) => void} [options.logger] 日志出口，默认 console.warn
 */
export function createZeroSessionWatchdog({ rounds = ZERO_CONVERSATION_ROUNDS, verify, logger = warnBili } = {}) {
  let zeroRounds = 0;
  let alerted = false;

  /**
   * 每轮结束喂一次「这轮列表接口给了几个会话」。
   * 返回 `true` 表示这轮真的去问了 status()（测试靠它断言「只验一次」）。
   */
  async function observe(sessionCount) {
    if (Number(sessionCount) > 0) {
      // 会话回来了就算恢复：计数和「已报过」一起复位，下次坏了还能再报一次
      zeroRounds = 0;
      alerted = false;
      return false;
    }

    zeroRounds += 1;
    if (alerted || zeroRounds < rounds) return false;

    // 到阈值了。先记账再验：万一 verify 自己抛错，也别每 8 轮去撞一次网络
    zeroRounds = 0;
    alerted = true;

    let selfStatus = null;
    try {
      selfStatus = await verify();
    } catch (error) {
      logger(
        `[bilibili] 连续 ${rounds} 轮读到 0 个会话，想去问 status() 也没问成（${error?.message ?? error}）` +
          '—— 先看日志，别急着当坏了',
      );
      return true;
    }

    if (!selfStatus || selfStatus.loggedIn === false) {
      // 强告警：登录态没了，只有人能救。文案必须给出**要跑哪条命令**
      const navCode = selfStatus?.navCode ?? '?';
      logger(
        `[bilibili] 连续 ${rounds} 轮读到 0 个会话，且 status() 报登录失效（nav code=${navCode}）` +
          '⇒ 大概率是 cookie 过期，跑 `node tools/bili-login.mjs` 续一次' +
          '（二维码会发到 QQ，扫完凭证自动写回）',
      );
      return true;
    }

    if (selfStatus.loggedIn === true) {
      // 弱提示：登录是好的，就是列表空着。别断言「坏了」—— 也可能真的没人给你发私信
      const who = selfStatus.uname ? `（${selfStatus.uname}）` : '';
      logger(
        `[bilibili] 连续 ${rounds} 轮读到 0 个会话，但 status() 说登录正常${who}` +
          '—— 可能确实没人给你发私信，也可能会话列表接口变了；先别当坏了',
      );
      return true;
    }

    // 登录态都没问出来（nav 超时之类）：也留余地，把它的 reason 带上让人自己判断
    logger(
      `[bilibili] 连续 ${rounds} 轮读到 0 个会话，status() 也没能确认登录态` +
        `（${selfStatus?.reason ?? '没有给出原因'}）—— 先看日志，别急着当坏了`,
    );
    return true;
  }

  return {
    observe,
    /** 当前连续 0 会话的轮数（测试用）。 */
    get zeroRounds() {
      return zeroRounds;
    },
    /** 这一轮「故障期」是否已经报过（测试用）。 */
    get alerted() {
      return alerted;
    },
  };
}

// ── 通道 ────────────────────────────────────────────────────────────

/**
 * @param {object} options
 * @param {string[]} [options.recipients] 只读这些 uid（字符串或数字）。空 = 读所有会话（最多 maxConversations 个）。
 * @param {number} [options.maxConversations] 覆盖默认上限
 * @param {number} [options.messagesPerConversation] 每个会话读几条
 * @param {string} [options.credentialPath] 覆盖凭证路径（测试用）
 * @param {boolean} [options.allowSend=false] **发消息的显式开关，默认关。**
 *   开之前先看一眼 `status().pluginDmWatch`：只要插件的私信监听还开着，
 *   就别在这里开 send —— 两个进程各回一条，对方会收到两条。详见文件顶部。
 *   也可以只给某一次调用开：`loadChannel('bilibili', { allowSend: true })`，
 *   常驻的 adopter 用的是 config 里的参数（默认 false）。
 * @param {(line: string) => void} [options.logger] 警告出口，默认 console.warn
 *   （主进程目前不传；launcher 会把 console 一起重定向进 logs\adopter.log）。
 * @param {number} [options.zeroSessionRounds] 覆盖「连续几轮 0 会话才验一次」，测试用。
 * @param {string} [options.captureDir] 落盘根目录，默认项目根下 `capture/`。
 *   B站的图统一放它的子目录 `capture/bilibili/`（和抖音那批平铺的文件分开），
 *   文件名是 `<msg_key>-<序号>.<ext>`，从文件能直接找回是哪条私信。
 * @param {boolean} [options.captureImages=true] 图片消息要不要落盘（关掉就退回「只显示 [图片]」）
 * @param {boolean} [options.captureIncomingOnly=true] 只下「对方发的」图（省流量；
 *   自己发出去的图看一眼没必要，而且要下下来也没人看回来）
 * @param {number} [options.maxImagesPerRound] 每轮最多下几张（默认 8，见 MAX_IMAGE_DOWNLOADS_PER_ROUND）
 */
export async function createChannel({
  recipients = [],
  maxConversations = MAX_CONVERSATIONS,
  messagesPerConversation = MESSAGES_PER_CONVERSATION,
  credentialPath = CREDENTIAL_PATH,
  allowSend = false,
  logger = warnBili,
  zeroSessionRounds = ZERO_CONVERSATION_ROUNDS,
  captureDir: captureDirOption,
  captureImages = true,
  captureIncomingOnly = true,
  maxImagesPerRound = MAX_IMAGE_DOWNLOADS_PER_ROUND,
} = {}) {
  /** 日志出口统一收口：传进来不是函数就退回默认，别让一条日志把轮询弄崩。 */
  const warn = typeof logger === 'function' ? logger : warnBili;
  const whitelist = (Array.isArray(recipients) ? recipients : [recipients])
    .map((item) => String(item ?? '').trim())
    .filter((item) => /^\d+$/.test(item));

  /** B站自己的落盘子目录：`capture/bilibili/`（根目录沿用抖音那一套，别另起一套）。 */
  const imageDir = captureDirOption
    ? path.join(captureDirOption, 'bilibili')
    : captureSubdir(ROOT, 'bilibili');
  const roundImageCap = Math.max(1, Number(maxImagesPerRound) || MAX_IMAGE_DOWNLOADS_PER_ROUND);

  /** 已经为哪条图打过「下载失败」的日志（同一条消息只喊一次，别每 15 秒刷屏）。 */
  const warnedImage = new Set();
  /**
   * 下载失败过的消息：`msgKey -> { reason, at }`。
   * 失败之后 10 分钟内不再试（图床 403/挂了的时候，每轮撞一次是纯浪费）；
   * 过期后自动重试一次，所以「临时抽风」能自己长回来。
   */
  const imageFailures = new Map();
  /** 本轮图片下载还剩几次、到什么时候停手。每轮 poll 开头重置。 */
  let imageBudget = { remaining: roundImageCap, until: 0 };
  /** 轮询轮数：清理落盘文件这类事情不要每轮都干。 */
  let pollCount = 0;

  function loadCred() {
    try {
      const parsed = JSON.parse(readFileSync(credentialPath, 'utf8'));
      if (!parsed?.sessdata) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** 列会话（原始）。返回 { sessions, flags } —— 登录问题走 flags，其余照抛。 */
  async function listSessions(cred, signal) {
    const { json } = await biliGet(
      'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&Build=0&mobi_app=web',
      cred,
      signal,
    );
    if (json?.code !== 0) return { sessions: [], flags: describeApiError(json) };
    const list = Array.isArray(json?.data?.session_list) ? json.data.session_list : [];
    return {
      sessions: list
        .map((session) => ({
          talkerId: String(session?.talker_id ?? ''),
          unread: Number(session?.unread_count) || 0,
          lastTs: Number(session?.last_msg?.timestamp) || 0,
          raw: session,
        }))
        .filter((session) => /^\d+$/.test(session.talkerId) && session.talkerId !== '0'),
      flags: {},
    };
  }

  /** 读一个会话的消息（原始）。 */
  async function fetchMessages(cred, talkerId, signal, size = messagesPerConversation) {
    const url =
      'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs' +
      `?talker_id=${Number(talkerId)}&session_type=1&size=${Math.max(1, Math.min(50, size))}&build=0&mobi_app=web`;
    const { json } = await biliGet(url, cred, signal);
    if (json?.code !== 0) return { rows: [], flags: describeApiError(json) };
    const rows = Array.isArray(json?.data?.messages) ? json.data.messages : [];
    return { rows, flags: {} };
  }

  /**
   * 发完之后回读，确认它真的进了会话。
   *
   * 为什么不信接口的返回值：抖音那边实测过「接口说成功 ≠ 界面上真有」，
   * 评论那条更狠 —— `lib/verify.mjs` 里写着「接口回发送成功 ≠ 公开可见」。
   * 所以这里一律以「再拉一次消息列表，能找到这条」为准。
   */
  async function confirmSent(cred, receiverId, msgKey, text, signal) {
    const wanted = String(text);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { rows } = await fetchMessages(cred, receiverId, signal, 10);
      const hit = rows.find((row) => {
        const key = String(row?.msg_key ?? '');
        if (msgKey && key === String(msgKey)) return true;
        if (Number(row?.sender_uid) !== Number(cred.dedeuserid)) return false;
        return String(parseContent(row?.content)?.content ?? '') === wanted;
      });
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    return null;
  }

  /**
   * 把一条图片消息的画面落到本地，并把结果挂回 `media`。
   *
   * 为什么是「下载原图」而不是截图：这个通道**根本不碰浏览器**（走 API），
   * 没有视口可截 —— 和抖音那边「下载优先、截图兜底」的选择天然对齐，
   * 而且实测图床上给的就是 305x305 的原图（90KB），比截图清楚。
   *
   * 失败不抛错：画面是增强信息，绝不能因为它挡住文字/水位上报。
   * 但**必须出声** —— 返回的 media 里带 `captureError`，`describe()` 会把它写进
   * 上报文本（`（画面未取到：下载失败：HTTP 403，messageId=…）`），日志里也有一条。
   * 三种「没画面」要能分开：
   *   ① `没有 URL`       —— content 里没找到图床地址（接口形状变了）
   *   ② `下载失败：HTTP 403` —— 防盗链/图床拒绝（实测现在不需要 Referer，见下）
   *   ③ `本轮预算用完`    —— 没失败，只是这一轮没轮到（下一轮接着下）
   */
  async function saveImage(message, { signal } = {}) {
    const media = message.media ?? {};
    const urls = Array.isArray(media.urls) ? media.urls.filter((url) => typeof url === 'string' && url) : [];
    const msgKey = String(message.id ?? '');
    /** 文件名用**裸 msg_key**（`7700219232671842682-0.png`），不带 `bili:` 前缀 ——
     *  从文件名就能直接回查私信，也能直接拿去调 fetch_session_msgs 对账。 */
    const fileStem = msgKey.replace(/^bili:/, '');

    // ① 一条地址都没有：说清楚是「没有 URL」，不是「下载失败」
    if (!urls.length) {
      return { ...message, media: { ...media, requiresVisual: true, captureError: '没有 URL（content 里没找到图床地址）' } };
    }

    // 按策略跳过（默认只下对方发的）：不算失败，describe 里一个字都不加
    if (captureIncomingOnly && message.direction !== 'incoming') {
      return { ...message, media: { ...media, requiresVisual: false, captureSkipped: 'outgoing' } };
    }

    // 刚失败过的别每轮重撞：把上次的原因（和上次已经下成功的那几张）原样挂回去，
    // 让上报文本保持稳定 —— 别让同一条消息在两轮里说两套话
    const failed = imageFailures.get(msgKey);
    if (failed && Date.now() - failed.at < IMAGE_RETRY_AFTER_MS) {
      const kept = Array.isArray(failed.files) ? failed.files : [];
      return {
        ...message,
        media: {
          ...media,
          ...(kept.length ? { files: kept } : {}),
          requiresVisual: kept.length < urls.length,
          captureError: failed.reason,
        },
      };
    }

    const files = [];
    let error = null;
    for (const [index, url] of urls.entries()) {
      if (imageBudget.remaining <= 0 || Date.now() > imageBudget.until) {
        /**
         * 没轮到：说清「不是失败、是还没轮到」，并给出**文件会落在哪** ——
         * 这条消息只会被上报一次，下一次轮询补下的文件不会有第二次上报机会，
         * 所以这里必须让人（或模型）知道去哪个目录找。
         */
        error =
          `本轮下载预算用完（每轮 ${roundImageCap} 张 / ${IMAGE_BUDGET_MS}ms），` +
          `下轮才落盘：${imageDir}\\${fileStem}-<序号>.<ext>`;
        break;
      }
      imageBudget.remaining -= 1;
      const saved = await downloadResource({
        url,
        messageId: msgKey,
        name: fileStem,
        type: 'image',
        index,
        dir: imageDir,
        signal,
        timeoutMs: IMAGE_TIMEOUT_MS,
        /**
         * 实测（2026-10-26，同一张图用 curl 和 node fetch 各试一次）：
         * 不带任何头也回 `HTTP 200 / content-type: image/png / 90549 字节`，
         * **不需要 Referer、不需要 Cookie**。这两行仍然带着，是防它哪天加防盗链 ——
         * 代价是两个请求头，不是一条出错的原因。
         */
        headers: { 'User-Agent': UA, Referer: 'https://message.bilibili.com/' },
      }).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));

      if (saved.ok) {
        files.push(saved.path);
        imageFailures.delete(msgKey);
        continue;
      }

      // ② 下载失败：记住原因（10 分钟内不再重试），日志里只喊一次
      error = saved.error;
      imageFailures.set(msgKey, { reason: error, at: Date.now(), files: files.slice() });
      if (!warnedImage.has(`${msgKey}:${index}`)) {
        warnedImage.add(`${msgKey}:${index}`);
        warn(`[bilibili] 图片落盘失败（${msgKey}/${index}）：${error}`);
      }
      break;
    }

    const next = { ...media, requiresVisual: files.length < urls.length };
    if (files.length) next.files = files;
    if (error) next.captureError = error;
    else delete next.captureError;
    return { ...message, media: next };
  }

  /** 给一个会话的消息整体挂画面（逐条顺序处理：预算和失败记录都是共享的）。 */
  async function attachImages(messages, { signal } = {}) {
    // 明确关掉落盘时不假装失败：只摘掉「需要画面」的标记，describe() 就退回干净的 [图片]
    if (captureImages !== true) {
      return messages.map((message) =>
        message?.media?.type === 'image'
          ? { ...message, media: { ...message.media, requiresVisual: false, captureSkipped: 'disabled' } }
          : message,
      );
    }
    const out = [];
    for (const message of messages) {
      if (message?.media?.type !== 'image') {
        out.push(message);
        continue;
      }
      try {
        out.push(await saveImage(message, { signal }));
      } catch (error) {
        // 落盘这一步出任何意外都不许拖垮这一轮
        warn(`[bilibili] 图片落盘异常（${message?.id ?? '?'}）：${error?.message ?? error}`);
        out.push({ ...message, media: { ...message.media, requiresVisual: true, captureError: String(error?.message ?? error) } });
      }
    }
    return out;
  }

  /**
   * 看门狗在这里先声明、等通道对象建好之后再赋值。
   *
   * 为什么不在上面直接建：它需要 `verify: () => channel.status()`，
   * 而 status() 是这个对象上的方法。用晚绑定比在方法里写 `this` 稳 ——
   * 有人把 `channel.poll` 摘下来单独调用时，`this` 就不是通道了。
   */
  let zeroSessionWatch;

  const channel = {
    id: 'bilibili',
    label: 'B站',

    /** 框架优先用通道自己的文字化规则（抖音那边也是这么做的）。 */
    describe(message) {
      return describeBiliMessage(message);
    },

    /**
     * 读一轮。**只读，没有任何写操作**（不标记已读、不改任何状态）。
     *
     * 返回契约里的 conversations 数组：每个会话一个 bundle，
     * 框架按 message.id 建水位、按 direction === 'incoming' 决定要不要上报。
     */
    async poll({ signal } = {}) {
      const cred = loadCred();
      if (!cred) {
        return {
          channel: 'bilibili',
          conversation: null,
          messages: [],
          flags: { loginRequired: true },
          reason: `读不到 B站凭证（${credentialPath}）。跑 \`node tools/bili-login.mjs\` 续一次（二维码会发到 QQ）。`,
        };
      }

      const { sessions, flags } = await listSessions(cred, signal);
      if (flags.loginRequired || flags.blocked) {
        return { channel: 'bilibili', conversation: null, messages: [], flags, reason: flags.reason };
      }

      /**
       * 列表接口**成功**但给了 0 个会话 —— 这是唯一会「静默失效」的形状，
       * 交给看门狗盯着（连续几轮才验一次 status()，只写日志，不动返回值）。
       *
       * 注意喂的是 `sessions.length`（接口原样给的），不是 `conversations.length`：
       * 后者会被 recipients 白名单影响，配错 uid 就永远是 0，那是配置问题。
       */
      await zeroSessionWatch.observe(sessions.length);

      const targets = whitelist.length
        ? sessions.filter((session) => whitelist.includes(session.talkerId))
        : sessions;
      const selected = targets.slice(0, Math.max(1, maxConversations));
      const dropped = targets.length - selected.length;

      /**
       * 图片下载预算每轮重置一次。
       *
       * 放在这里（而不是每次 saveImage 里算）是为了让「一轮」这个概念只有一个定义：
       * 进了这一轮就最多下 roundImageCap 张、最多花 IMAGE_BUDGET_MS；
       * 没轮到的消息在 describe() 里会写「本轮预算用完，下一轮再取」，
       * 下一轮它还在窗口里就接着下（已经下过的按文件名命中缓存，不会重下）。
       */
      imageBudget = { remaining: roundImageCap, until: Date.now() + IMAGE_BUDGET_MS };

      const conversations = [];
      let failed = 0;
      for (const session of selected) {
        try {
          const { rows, flags: messageFlags } = await fetchMessages(cred, session.talkerId, signal);
          if (messageFlags.loginRequired || messageFlags.blocked) {
            return { channel: 'bilibili', conversation: null, messages: [], flags: messageFlags, reason: messageFlags.reason };
          }
          // 接口是倒序（新→旧），契约里要正序（旧→新），跟抖音那边一致
          const ordered = rows.slice().reverse();
          const contract = ordered.map((row) => toContractMessage(session.talkerId, row, cred.dedeuserid));
          // 图片落盘：只在这一步做 IO，解析阶段（toContractMessage）保持纯函数
          const messages = await attachImages(contract, { signal });
          conversations.push({
            conversation: {
              id: `uid:${session.talkerId}`,
              displayName: displayNameOf(session.raw),
              kind: 'private',
              unread: session.unread,
            },
            messages,
            diagnostics: {
              kind: 'private',
              talkerId: session.talkerId,
              windowMessages: ordered.length,
              incoming: ordered.filter((row) => Number(row?.sender_uid) !== Number(cred.dedeuserid)).length,
              unread: session.unread,
              /**
               * 图片的落盘结果，让「窗口里 3 张图但一张都没下下来」和「本来就没图」
               * 在状态里能分开 —— 只看 `[图片]` 三个字是分不出来的。
               */
              images: {
                messages: messages.filter((message) => message.media?.type === 'image').length,
                saved: messages.filter((message) => message.media?.files?.length).length,
                failed: messages.filter((message) => message.media?.captureError).length,
              },
            },
          });
        } catch (error) {
          // 一个会话失败不能拖垮其他会话
          failed += 1;
          if (failed === 1) warn(`[bilibili] 读会话 ${session.talkerId} 失败：${error?.message ?? error}`);
        }
      }

      if (dropped > 0) {
        warn(
          `[bilibili] 有 ${dropped} 个会话超出单轮上限 ${maxConversations}，本轮没读。` +
            '要读全部就配 recipients 白名单，或把 maxConversations 调大（但轮询会变慢）。',
        );
      }

      // 落盘文件按修改时间保留最近 400 个；每 20 轮扫一次，别每轮都扒目录
      pollCount += 1;
      if (pollCount % 20 === 0) {
        try {
          pruneCapture(imageDir);
        } catch {
          /* 清理失败不影响轮询 */
        }
        /**
         * 顺手给两张记账表瘦身。
         *
         * 它们只在「某条图失败过」时才长一条，正常量很小；但常驻进程跑几周、
         * 图床时不时抖一下，理论上会一直长。超过上限就整体清掉 ——
         * 代价最多是「同一张坏图再报一次日志、再试一次」，比无界增长好。
         */
        if (imageFailures.size > 500) imageFailures.clear();
        if (warnedImage.size > 2000) warnedImage.clear();
      }

      const totalMessages = conversations.reduce((sum, item) => sum + item.messages.length, 0);
      const totalIncoming = conversations.reduce((sum, item) => sum + (item.diagnostics?.incoming ?? 0), 0);
      const allMessages = conversations.flatMap((item) => item.messages);
      return {
        channel: 'bilibili',
        // 老字段（向后兼容）：第一个会话，跟抖音那边一个约定
        conversation: conversations[0]?.conversation ?? null,
        messages: conversations[0]?.messages ?? [],
        conversations,
        flags: {},
        /**
         * `windowMessages` / `incoming` 这两个名字是 adopter 的日志在用的
         * （它拼「窗口 N 条／对方 M 条」）。缺了这两个字段，日志会印出
         * 「窗口 undefined 条」—— 实测启动后第一轮就是这样，难看且误导。
         *
         * ⚠️ 多会话时这里是**汇总值**，和抖音那边（报主会话那一份）语义不同。
         */
        diagnostics: {
          conversationCount: conversations.length,
          totalMessages,
          windowMessages: totalMessages,
          incoming: totalIncoming,
          failedConversations: failed,
          truncated: dropped,
          sendEnabled: allowSend === true,
          messagesWithPictures: allMessages.filter((message) => message.media?.files?.length).length,
          picturesFailed: allMessages.filter((message) => message.media?.captureError).length,
          captureDir: imageDir,
        },
      };
    },

    /**
     * 发一条私信。**默认关着（`allowSend: false`），调用会 throw。**
     *
     * 放开它要同时满足两条：
     *   ① `createChannel({ allowSend: true })`
     *   ② 插件的私信监听（dmWatch）已经关掉 —— 否则同一个人的私信会被两边各回一条
     *
     * 接口参数是从本机 `bilibili-api-python` 的 `session.py` 读出来的（不是猜的）：
     *   POST https://api.vc.bilibili.com/web_im/v1/web_im/send_msg
     *   表单：msg[sender_uid] / msg[receiver_id] / msg[receiver_type]=1 / msg[msg_type]=1
     *        / msg[msg_status]=0 / msg[content]={"content":"…"} / msg[dev_id]=DEV_ID
     *        / msg[new_face_version]=0 / msg[timestamp]=<秒> / from_filework=0 / build=0
     *        / csrf=<bili_jct> / csrf_token=<bili_jct>
     * 不需要 wbi 签名。
     *
     * 返回 `{ ok: true, confirmed: true, messageId }` 才算数 —— confirmed 只认回读。
     */
    async send({ conversationId, text, signal } = {}) {
      if (allowSend !== true) {
        throw new Error(
          'B站私信通道默认只读，没有开启发送。' +
            '放开它要两条：① createChannel({ allowSend: true })；' +
            '② 先关掉 dsh-bili-scroll 插件的「私信监听」（dmWatch），否则同一个人的私信会被两边各回一条。' +
            '详见 src/channels/bilibili.mjs 顶部注释。',
        );
      }

      const cred = loadCred();
      if (!cred) throw new Error('读不到 B站凭证，跑 `node tools/bili-login.mjs` 续一次。');

      const receiverId = String(conversationId ?? '').replace(/^uid:/, '').trim();
      if (!/^\d+$/.test(receiverId)) {
        throw new Error('需要会话 ID（`uid:<数字>`）或直接给数字 uid。');
      }
      const body = typeof text === 'string' ? text.trim() : '';
      if (!body) throw new Error('发送内容不能为空。');
      if ([...body].length > MAX_MESSAGE_LENGTH) {
        throw new Error(`私信单条上限 ${MAX_MESSAGE_LENGTH} 字，这条 ${[...body].length} 字。`);
      }

      const form = new URLSearchParams({
        'msg[sender_uid]': String(cred.dedeuserid),
        'msg[receiver_id]': receiverId,
        'msg[receiver_type]': '1',
        'msg[msg_type]': String(MSG_TYPE.TEXT),
        'msg[msg_status]': '0',
        'msg[content]': JSON.stringify({ content: body }),
        'msg[dev_id]': DEV_ID,
        'msg[new_face_version]': '0',
        'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
        from_filework: '0',
        build: '0',
        csrf: String(cred.bili_jct ?? ''),
        csrf_token: String(cred.bili_jct ?? ''),
      });

      const timeout = AbortSignal.timeout(20_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
        method: 'POST',
        headers: { ...headersOf(cred), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: combined,
      });
      const raw = await response.text();
      const json = parseBiliJson(raw);
      if (json?.code !== 0) {
        throw new Error(`B站拒绝发送：code=${json?.code} ${json?.message ?? ''}（HTTP ${response.status}）`);
      }

      const msgKey = json?.data?.msg_key ? String(json.data.msg_key) : null;
      const confirmedRow = await confirmSent(cred, receiverId, msgKey, body, signal);
      if (!confirmedRow) {
        // 不抛成「失败」—— 接口说成功了，只是没读到。跟抖音那边「不确定」的口径一致
        return { ok: false, confirmed: false, deliveryUncertain: true, messageId: msgKey, reason: '接口回成功，但回读没读到这条，结果不确定。' };
      }

      return {
        ok: true,
        confirmed: true,
        messageId: String(confirmedRow.msg_key ?? msgKey ?? ''),
        sentAt: confirmedRow.timestamp ? new Date(Number(confirmedRow.timestamp) * 1000).toISOString() : null,
      };
    },

    /**
     * 自检。除了登录态，还要报两件「下一个人必须知道」的事：
     *   · 这个通道是只读的
     *   · 插件的私信监听现在开着 —— 它决定了「能不能加回」
     */
    async status() {
      const cred = loadCred();
      const plugin = readPluginDmWatch();
      const base = {
        implemented: true,
        readOnly: allowSend !== true,
        sendEnabled: allowSend === true,
        pluginDmWatch: plugin.state,
        credentialPath,
        // 图片落在哪、有没有开、每轮最多几张 —— 排查「图没下来」时要看的就是这三样
        captureDir: imageDir,
        captureImages: captureImages === true,
        captureIncomingOnly: captureIncomingOnly === true,
        maxImagesPerRound: roundImageCap,
      };
      if (!cred) {
        return {
          ...base,
          ok: false,
          loggedIn: false,
          reason: `读不到 B站凭证（${credentialPath}）。跑 \`node tools/bili-login.mjs\` 续一次（二维码会发到 QQ）。`,
        };
      }

      try {
        const { json } = await biliGet('https://api.bilibili.com/x/web-interface/nav', cred, null);
        if (json?.code !== 0 || !json?.data?.isLogin) {
          return {
            ...base,
            ok: false,
            loggedIn: false,
            // 给看门狗用的原始 nav 错误码（-101 / -352 才是「cookie 过期」那种）
            navCode: json?.code ?? null,
            // 凭证无效时的固定出口：别让人对着 loginRequired 干瞪眼，直接告诉他跑哪条命令
            reason:
              `B站登录态失效（nav code=${json?.code ?? '?'}），跑 \`node tools/bili-login.mjs\` 续一次：` +
              '它会生成二维码、经 NapCat 发到 QQ、扫完自动把凭证写回这个文件。',
          };
        }
        const { sessions, flags } = await listSessions(cred, null);
        if (flags.loginRequired || flags.blocked) {
          return { ...base, ok: false, loggedIn: false, reason: flags.reason };
        }
        return {
          ...base,
          ok: true,
          loggedIn: true,
          uname: json.data.uname ?? null,
          mid: json.data.mid ?? null,
          level: json.data.level_info?.current_level ?? null,
          conversationCount: sessions.length,
          whitelist: whitelist.length ? whitelist : null,
          maxConversations,
          reason: 'B站私信只读：能读能报，不能回。加「回」之前先关插件的 dmWatch。',
        };
      } catch (error) {
        return { ...base, ok: false, loggedIn: null, reason: error?.message ?? String(error) };
      }
    },

    /** 会话列表（id 是 `uid:<talker_id>`，和 poll 里的 id 一致）。 */
    async contacts({ signal } = {}) {
      const cred = loadCred();
      if (!cred) throw new Error('读不到 B站凭证，跑 `node tools/bili-login.mjs` 续一次。');
      const { sessions, flags } = await listSessions(cred, signal);
      if (flags.loginRequired || flags.blocked) throw new Error(flags.reason);
      return sessions
        .filter((session) => !whitelist.length || whitelist.includes(session.talkerId))
        .map((session) => ({
          id: `uid:${session.talkerId}`,
          displayName: displayNameOf(session.raw),
          unread: session.unread,
        }));
    },

    /** 原始快照，给调试和命令行用。不经过契约转换，看到什么就是什么。 */
    async read({ conversationId, signal } = {}) {
      const cred = loadCred();
      if (!cred) throw new Error('读不到 B站凭证。');
      const talkerId = String(conversationId ?? '').replace(/^uid:/, '');
      if (!/^\d+$/.test(talkerId)) throw new Error('需要一个 uid:<数字> 形式的会话 ID，或直接给数字 uid。');
      const { sessions, flags } = await listSessions(cred, signal);
      if (flags.loginRequired || flags.blocked) throw new Error(flags.reason);
      const session = sessions.find((item) => item.talkerId === talkerId);
      const { rows } = await fetchMessages(cred, talkerId, signal, 50);
      return {
        conversationId: `uid:${talkerId}`,
        displayName: session ? displayNameOf(session.raw) : `uid:${talkerId}`,
        selfUid: cred.dedeuserid ?? null,
        rawMessages: rows,
        messages: rows.slice().reverse().map((row) => toContractMessage(talkerId, row, cred.dedeuserid)),
      };
    },

    /** 这个通道不持有浏览器连接，没什么要关的。 */
    async close() {},
  };

  // 对象建好了，现在把看门狗接上（它要调用 channel.status()，见上面的注释）
  zeroSessionWatch = createZeroSessionWatchdog({
    rounds: zeroSessionRounds,
    verify: () => channel.status(),
    logger: warn,
  });

  return channel;
}

export default createChannel;
