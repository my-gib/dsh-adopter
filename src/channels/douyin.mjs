// 抖音通道：把插件的私信 DOM 能力包成符合 registry 契约的适配器。
//
// DOM 逻辑本身不是这里写的 —— 是本项目 src/dom/ 下从插件剥离出来的那份
// （chat-browser.mjs 及其依赖），已验证过消息稳定 ID、方向判定、水位核对、
// 发送后界面回读确认。这一层只做四件事：
//   1. 把 config 变成 ChatBrowser 认识的参数
//   2. 把插件的返回结构翻译成契约形状
//   3. 把好友分享的作品挂到 message.share 上，给框架当内容入口
//   4. 把表情包 / 图片 / 卡片封面的**实际画面**落到本地文件，路径随消息一起上报
//      —— 否则会话那边只能看到「[表情]」三个字，不知道是什么

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatBrowser } from '../dom/chat-browser.mjs';
import { BrowserController, DOUYIN_RECOMMEND } from '../browser/controller.mjs';
import { captureDir, downloadResource, pruneCapture } from '../media/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/**
 * 群会话数量的硬上限。
 *
 * 实测成本（`tools/probe-poll-cost.mjs`，2026-10-23，15s 轮询间隔）：
 *   1 私信 + 1 群 一轮 2.38s；每多一个群 +2.02s；**8 个群就 16.5s，超过间隔追不上**。
 *   注意每个群真正读消息只要 0.3s，其余 ~1.7s 全花在「切会话 + 等动画/等标题出现」上。
 *
 * 所以这不是拍脑袋的数：它是「15s 间隔下还能跑顺」的安全区上沿。
 * 配多了不会崩，只是超出部分被截掉并**显式警告** —— 让「加太多」在加载时就看得见，
 * 而不是悄悄变慢、日志里只看到「轮询没动」。
 */
const MAX_GROUPS = 8;

/**
 * 单轮轮询的时间预算。超过就跳过剩下的群，下一轮从游标继续（轮转）。
 *
 * 和 MAX_GROUPS 的分工：MAX_GROUPS 挡「配置层堆太多」，这条兜住「单轮跑太久」。
 * 有了它，无论配多少群，一轮都被封顶在这儿；代价只是每个群的检查频率变低
 * （消息不会丢：水位按 messageId 记，晚读到也会补报）。
 * 也避免和 `tick()` 里的 `if (polling) return` 撞成「丢拍」。
 */
const POLL_BUDGET_MS = 10_000;

/**
 * 媒体消息的画面提示。
 *   - 落盘成功：给出本地路径，会话侧 read_image 直接看
 *   - 落盘失败：明说「画面未取到」并带上 messageId，可以调 POST /observe 重取
 *   别让会话把「只有标签」当成「本来就没画面」。
 *
 * 标签用词对齐 QQ 那条入站（dsh-notifier 的 onebot-in.mjs）：表情包 `[表情包]`、照片 `[图片]`，
 * 后面跟资源位置。区别只在资源位置：QQ 给 CDN 链接（dsh-notifier 原样转发），
 * 抖音这边给落盘路径 —— 签名链接有 277 个字符，路径只有 60 来个，
 * 而且模型侧的 read_image 只吃本地文件，不吃 URL。
 */
function pictureHint(media, messageId) {
  if (Array.isArray(media?.files) && media.files.length) return `（画面：${media.files[0]}）`;
  if (media?.requiresVisual) return `（画面未取到${messageId ? `，messageId=${messageId}` : ''}）`;
  return '';
}

/** 一条私信压成一行文字。分享卡片/表情要留痕，别退化成一个 [非文本消息] 就没了。 */
export function describeMessage(message) {
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (text) return text;
  const media = message?.media;
  const hint = pictureHint(media, message?.id);
  if (media?.type === 'emoji') return `[表情包${media.label ? `：${media.label}` : ''}]${hint}`;
  if (media?.type === 'shared-work') {
    const title = media.title ? `：${media.title}` : '';
    const author = media.author ? ` @${media.author}` : '';
    return `[分享作品${title}${author}]${hint}`;
  }
  if (media?.type === 'image') return `[图片]${hint}`;
  return `[非文本消息]${hint}`;
}

/** 把插件的 shared-work 媒体翻译成契约里的 message.share。 */
export function toShare(media, cover = null) {
  if (media?.type !== 'shared-work') return undefined;
  const videoId = media.videoId ?? null;
  return {
    // 类型三态：true=图文、false=视频、null=未核实（卡片 DOM 里没有可靠依据，
    // 详见 chat-browser.mjs 里那段注释）。别把「不知道」硬说成「视频」或「图文」。
    kind: media.isPhotoGallery === true ? 'note' : media.isPhotoGallery === false ? 'video' : 'work',
    videoId,
    url: media.url ?? (videoId ? `https://www.douyin.com/video/${videoId}` : null),
    title: media.title ?? null,
    author: media.author ?? null,
    // 卡片封面落盘后的本地路径（拿不到就是 null，不编造）
    cover: cover ?? null,
  };
}

export async function createChannel({
  recipientId = '',
  contactName = 'your-name',
  port = 9227,
  profileDir,
  controlDir,
  /** 时间策略，注入给 controller.limits()；不传则一律放行。 */
  policy = null,
  autoLaunch = true,
  /** 媒体画面落盘目录，默认项目根下 capture/ */
  captureDir: captureDirOption,
  /** 只给「对方发的」消息落盘（省流量；我方发的不需要看回来） */
  captureIncomingOnly = true,
  /**
   * 群聊（2026-10-23 加）。
   *
   * groups 是要一起轮询的群会话：`[{ id: 'conv:<64位>', name: '示例群' }]`。
   * id 来自 `browser.listContacts()` 的 conv ID（`--dump-contacts` 或 /status 都能看）。
   * 不配就是空数组 —— 行为和以前完全一样（只盯主会话），私信链路一个字都没动。
   *
   * 为什么要显式列 ID，而不是「列表里有群就自动全收」：
   * 群 ID 是 hash(群名 + 群头像)，而群名可以被任何人改。自动全收等于把
   * 「别人建个群、改个名」变成「adopter 自动开始读那个群」。显式白名单更安全。
   */
  groups = [],
} = {}) {
  const configuredGroups = (Array.isArray(groups) ? groups : [])
    .map((item) => (typeof item === 'string' ? { id: item, name: null } : item))
    .filter((item) => item && typeof item.id === 'string' && /^conv:[a-f0-9]{64}$/.test(item.id));
  // 超出上限的显式截掉并警告：宁可少看几个群，也不要让轮询悄悄追不上（见 MAX_GROUPS 注释）
  const groupTargets = configuredGroups.slice(0, MAX_GROUPS);
  if (configuredGroups.length > MAX_GROUPS) {
    const dropped = configuredGroups.slice(MAX_GROUPS).map((item) => item.name ?? item.id);
    console.warn(
      `[douyin] 配了 ${configuredGroups.length} 个群，超过上限 ${MAX_GROUPS}（15s 间隔下跑不动），` +
        `以下群本轮不轮询：${dropped.join('、')}。要加就把 pollMs 调大，或拆到另一个进程。`,
    );
  }
  /** 群轮转游标：一轮读不完的，下一轮从这里接着读（保证公平，不饿死排在后面的群） */
  let groupCursor = 0;

  const controller = new BrowserController({
    source: 'api-chat',
    port,
    profileDir,
    controlDir,
    homeUrl: DOUYIN_RECOMMEND,
    readySelector: '[data-e2e="im-entry"]',
    allowedOrigins: ['https://www.douyin.com'],
    policy,
    autoLaunch,
    // 常驻进程退出时不要关掉私信页：下次启动省一次重建，用户也可能正开着看
    closePageOnExit: false,
  });
  // 只有真的配了群才放开群会话（ChatBrowser 默认拒绝群，等于旧行为）
  const browser = new ChatBrowser({ source: 'api-chat', controller, allowGroups: groupTargets.length > 0 });

  const captureRoot = captureDirOption || captureDir(ROOT);
  /** 已经为哪条消息打过「下载失败」的警告，避免每 15 秒刷一遍同样的错 */
  const warnedCapture = new Set();
  let pollCount = 0;

  let current = recipientId || '';
  let currentName = contactName;

  function unavailable(flags) {
    if (flags?.loginRequired) return '抖音私信需要登录，请在专用 Edge 里扫码。';
    if (flags?.verificationRequired) return '抖音弹出了验证，请在专用 Edge 里手动完成。';
    if (flags?.blocked) return '抖音私信当前不可用。';
    return null;
  }

  /** 敲定要盯的会话：config 里给了 id 就用，否则按显示名匹配一次。 */
  async function ensureRecipient({ signal } = {}) {
    if (current) return current;
    const { contacts = [], ...flags } = await browser.listContacts({ signal });
    const problem = unavailable(flags);
    if (problem) throw new Error(problem);
    const hit = contacts.find((contact) => contact.displayName === contactName);
    if (!hit) {
      const names = contacts.map((contact) => contact.displayName).join('、') || '（空）';
      throw new Error(`没找到联系人「${contactName}」。当前可见：${names}`);
    }
    current = hit.id;
    currentName = hit.displayName;
    return current;
  }

  /**
   * 把一条媒体消息的画面存成本地文件。
   *
   * 走「下载原始资源」而不是截图：表情包在页面里只显示 110x110，CDN 上是 280x280 原图；
   * 图片消息同理。截图还要求消息当时在视口里且没被遮挡，而消息列表是约 11 条的滑动窗口，
   * 稍一滑动就截不到了。
   *
   * 失败不抛错：画面是增强信息，绝不能因为它挡住文字上报。
   */
  async function savePictures(message, { signal, force = false } = {}) {
    const media = message?.media;
    if (!media || !Array.isArray(media.resources) || !media.resources.length) return [];
    // 常驻轮询只给对方发的落盘（省流量）；/observe 是明确要看，传 force 绕过这条限制
    if (!force && captureIncomingOnly && message.direction !== 'incoming') return [];
    const files = [];
    for (const [index, resource] of media.resources.entries()) {
      // publicMessages 把真实 src 收进了 mediaResources，契约里的 resourceRef 只是个哈希
      const hit = browser.mediaResources.get(resource.resourceRef);
      if (!hit?.src) continue;
      const saved = await downloadResource({
        url: hit.src,
        messageId: message.id,
        type: media.type ?? 'media',
        index,
        dir: captureRoot,
        signal,
      }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      if (saved.ok) {
        files.push(saved.path);
      } else if (!warnedCapture.has(`${message.id}:${index}`)) {
        warnedCapture.add(`${message.id}:${index}`);
        console.warn(`[douyin] 媒体画面保存失败（${media.type}/${index}）：${saved.error}`);
      }
    }
    return files;
  }

  /**
   * 读一个会话：媒体落盘、分享卡片翻译、诊断统计都在这里做。
   *
   * 抽成函数是为了让「主会话」和「群会话」走**完全同一套**代码 ——
   * 否则哪天只在一边修 bug，另一边会悄悄退化（表情/图片/分享三类媒体尤其容易漏）。
   */
  async function readBundle(target, { signal, kind = 'private', fallbackName = null } = {}) {
    const snapshot = (await browser.readConversation(target, { allowed: true, signal })) || {};
    const problem = unavailable(snapshot);
    if (problem) return { problem, flags: snapshot, conversation: null, messages: [], diagnostics: null };
    const rawMessages = snapshot.messages ?? [];
    const messages = [];
    for (const message of rawMessages) {
      const files = await savePictures(message, { signal });
      const withFiles = files.length ? { ...message, media: { ...message.media, files } } : message;
      const share = toShare(withFiles.media, files[0] ?? null);
      messages.push(share ? { ...withFiles, share } : withFiles);
    }
    return {
      problem: null,
      flags: {},
      conversation: {
        id: target,
        // 群头部标题带成员数（"示例群(5)"），保留它是有用的：上报里能看出这个群现在几个人
        displayName: snapshot.conversation?.displayName ?? fallbackName ?? target,
        kind,
      },
      messages,
      diagnostics: {
        kind,
        windowMessages: rawMessages.length,
        incoming: rawMessages.filter((message) => (message.direction ?? message.sender) === 'incoming').length,
        outgoing: rawMessages.filter((message) => (message.direction ?? message.sender) === 'outgoing').length,
        pictures: messages.filter((message) => message.media?.files?.length).length,
      },
    };
  }

  /** 同一个群反复失败只警告一次 —— 别让「被踢出群」这种事每 15 秒刷一遍日志。 */
  const warnedGroups = new Set();
  function warnGroupOnce(id, message) {
    if (warnedGroups.has(id)) return;
    warnedGroups.add(id);
    console.warn(`[douyin] ${message}`);
  }

  return {
    id: 'douyin',
    label: '抖音',

    /**
     * 让框架直接用通道自己的文字化规则。
     *
     * 以前 adopter.mjs 里还有一份兜底 describe()，两边各写一遍同一套标签，迟早会不一致
     * （比如分享作品的作者名，兜底那份就没带）。通道有这个能力就用通道的。
     */
    describe(message) {
      return describeMessage(message);
    },

    async poll({ signal } = {}) {
      // 预算从这里开始算：私信也吃时间，别让它在群循环之外「免费」
      const roundStarted = Date.now();
      const conversationId = await ensureRecipient({ signal });
      const primary = await readBundle(conversationId, { signal, kind: 'private', fallbackName: currentName });
      if (primary.problem) {
        return { channel: 'douyin', conversation: null, messages: [], flags: primary.flags, reason: primary.problem };
      }

      // 群会话：一个群失败**绝不能拖垮主会话**（被踢出群、群解散、DOM 改版都会抛）。
      // 失败的群每轮只警告一次，避免日志被同一个错刷满。
      const bundles = [primary];
      // 轮转读取：每轮从游标开始，读不完的下一轮接着读
      const ordered = groupTargets.length
        ? groupTargets.map((_, offset) => groupTargets[(groupCursor + offset) % groupTargets.length])
        : [];
      let visited = 0;
      let skipped = 0;
      for (const group of ordered) {
        // 永远至少读一个群：私信可能已经把预算吃掉大半，但不能因此一个群都不看
        if (visited > 0 && Date.now() - roundStarted > POLL_BUDGET_MS) {
          skipped += 1;
          continue;
        }
        visited += 1;
        try {
          const bundle = await readBundle(group.id, { signal, kind: 'group', fallbackName: group.name });
          if (bundle.problem) {
            warnGroupOnce(group.id, `群「${group.name ?? group.id}」当前不可用：${bundle.problem}`);
            continue;
          }
          bundles.push(bundle);
        } catch (error) {
          warnGroupOnce(group.id, `读群「${group.name ?? group.id}」失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (groupTargets.length) groupCursor = (groupCursor + visited) % groupTargets.length;
      if (skipped > 0) {
        console.warn(
          `[douyin] 单轮预算用完（${POLL_BUDGET_MS}ms），本轮跳过 ${skipped} 个群；` +
            `下一轮从「${groupTargets[groupCursor]?.name ?? groupTargets[groupCursor]?.id ?? '?'}」继续。`,
        );
      }

      // 落盘文件只按修改时间保留最近 400 个；顺带跑，别每次轮询都扫目录
      pollCount += 1;
      if (pollCount % 20 === 0) {
        try {
          pruneCapture(captureRoot);
        } catch {
          /* 清理失败不影响轮询 */
        }
      }

      return {
        channel: 'douyin',
        // 向后兼容：conversation/messages/diagnostics 仍然是「主会话」那一份，
        // 老调用方（/status、peek、只认这三样的代码）一个字都不用改。
        conversation: primary.conversation,
        messages: primary.messages,
        /**
         * 新增：每个被轮询的会话一组，`conversation.kind` 是 'private' | 'group'。
         * adopter 优先用这一份；没有的时候退回上面那三个老字段。
         */
        conversations: bundles.map(({ problem, flags, ...rest }) => rest),
        flags: {},
        /**
         * 诊断信息：让「窗口里没有 incoming」和「一条都没读到」能分开。
         *
         * 消息列表是滑动窗口（只保留最近十来条），回复多了之后对方的旧消息会被挤出去，
         * 于是 incoming 变成 0，日志只剩一句「已知 0 条」——看起来像通道坏了，其实正常。
         * 带上这两个数字，状态里一眼就能分辨。
         */
        diagnostics: primary.diagnostics,
      };
    },

    /**
     * 发一条消息：文字 / 表情 / 图片，三者互斥。
     *
     * 判据顺序是 emoji → image → text，**都不给时行为和以前完全一样**（纯文本那条已验证的
     * 链路一个字都没动）。表情和图片走的是另外两条 DOM 路径，都不经过编辑器，
     * 所以它们不会留下草稿、也就不会堵死文本发送。
     *
     * emoji 接受三种写法：
     *   '续火花'（名字，推荐，抖音自带 21 个都有中文名）
     *   0（内置表情里第几个，从 0 起 —— 名字拿不到时的退路）
     *   { name } / { index } 原样对象
     * image 是**本地绝对路径**（jpg/jpeg/png/gif/mp4），可另带 caption 作为附带文字；
     * 附带文字会作为独立的第二条消息发出去（抖音就是这么设计的，不是图片的说明）。
     */
    async send({ conversationId, text, emoji, image, caption, signal } = {}) {
      const target = conversationId || (await ensureRecipient({ signal }));

      if (emoji !== undefined && emoji !== null && emoji !== '') {
        const options = typeof emoji === 'string' ? { name: emoji } : typeof emoji === 'number' ? { index: emoji } : emoji;
        const delivery = await browser.sendEmoji(target, options, { allowed: true, signal });
        if (delivery?.confirmed !== true) {
          throw new Error(delivery?.reason || '未取得表情发送确认。');
        }
        return { ok: true, confirmed: true, kind: 'emoji', emoji: delivery.emoji ?? null, messageId: delivery.messageId ?? null };
      }

      if (image !== undefined && image !== null && image !== '') {
        if (text !== undefined && text !== null && text !== '') {
          throw new Error('图片和正文只能选一个：要带话就把内容放进 caption。');
        }
        const delivery = await browser.sendImage(target, { path: String(image), caption }, { allowed: true, signal });
        if (delivery?.confirmed !== true) {
          throw new Error(delivery?.reason || '未取得图片发送确认。');
        }
        return {
          ok: true,
          confirmed: true,
          kind: 'image',
          image: delivery.image ?? null,
          caption: delivery.caption ?? null,
          captionMessageId: delivery.captionMessageId ?? null,
          messageId: delivery.messageId ?? null,
        };
      }

      const delivery = await browser.sendMessage(target, text, { allowed: true, signal });
      if (delivery?.confirmed !== true) {
        // 插件的发送前检查会把真实原因放在 reason（草稿/水位/身份变化），原样抛出去别吞。
        throw new Error(delivery?.reason || '未取得发送确认。');
      }
      return { ok: true, confirmed: true, messageId: delivery.messageId ?? null };
    },

    /**
     * 列出当前能发的内置表情（名字 + 序号）。只读，不发任何消息。
     * 调用方拿不准「有哪些表情可发」时用它，别写死常量 —— 抖音改版时这里会跟着变。
     */
    async emojis({ signal } = {}) {
      const { emojis = [], ...flags } = await browser.listEmojis({ signal });
      const problem = unavailable(flags);
      if (problem) throw new Error(problem);
      return emojis;
    },

    /**
     * 按需取一条消息的画面（路线 B）。
     *
     * 顺序：先试下载原始资源（便宜、不受视口限制），失败才退回截图 captureMessage。
     * 注意消息可能已经被滑动窗口挤出去，这时候会抛「当前窗口里没有这条消息」——
     * 这是如实报告，不是 bug；所以 poll 阶段就已经把画面落盘了。
     */
    async observe({ conversationId, messageId, signal } = {}) {
      if (typeof messageId !== 'string' || !messageId) throw new Error('需要消息 ID。');
      const target = conversationId || (await ensureRecipient({ signal }));
      const snapshot = (await browser.readConversation(target, { allowed: true, signal })) || {};
      const problem = unavailable(snapshot);
      if (problem) throw new Error(problem);
      const message = (snapshot.messages ?? []).find((item) => item.id === messageId);
      if (!message) throw new Error('当前消息窗口里没有这条消息（可能已被滑动窗口挤出去），无法取画面。');
      const files = await savePictures(message, { signal, force: true });
      if (files.length) return { ok: true, messageId, type: message.media?.type ?? null, files, source: 'resource' };
      // 兜底：截整张卡片/图片的画面（表情的 CDN 挂了、或者资源拿不到时才有这一步）
      const shot = await browser.captureMessage(target, messageId, { allowed: true, signal });
      const frames = Array.isArray(shot?.frames) ? shot.frames : [];
      if (!frames.length) return { ok: false, messageId, type: message.media?.type ?? null, files: [], reason: shot?.imageStatus || '没有取到画面。' };
      mkdirSync(captureRoot, { recursive: true });
      const shotFiles = frames.map((frame, index) => {
        const file = join(captureRoot, `${String(messageId).replace(/^msg:/, '').slice(0, 12)}-shot-${index}.jpg`);
        writeFileSync(file, Buffer.from(frame.data, 'base64'));
        return file;
      });
      return { ok: true, messageId, type: message.media?.type ?? null, files: shotFiles, source: 'screenshot' };
    },

    async status() {
      try {
        const { contacts = [], ...flags } = await browser.listContacts({});
        const problem = unavailable(flags);
        if (problem) return { ok: false, loggedIn: false, blocked: true, reason: problem };
        return {
          ok: true,
          loggedIn: true,
          contactCount: contacts.length,
          captureDir: captureRoot,
          watching: current
            ? { id: current, displayName: currentName }
            : { byName: contactName },
        };
      } catch (error) {
        return { ok: false, loggedIn: null, reason: error instanceof Error ? error.message : String(error) };
      }
    },

    async contacts({ signal } = {}) {
      const { contacts = [], ...flags } = await browser.listContacts({ signal });
      const problem = unavailable(flags);
      if (problem) throw new Error(problem);
      return contacts;
    },

    async read({ conversationId, signal } = {}) {
      const target = conversationId || (await ensureRecipient({ signal }));
      return browser.readConversation(target, { allowed: true, signal });
    },

    async openShare({ conversationId, messageId, signal } = {}) {
      const target = conversationId || (await ensureRecipient({ signal }));
      return browser.openSharedVideo(target, messageId, { allowed: true, signal });
    },

    async close() {
      await browser.close();
    },
  };
}

export default createChannel;
