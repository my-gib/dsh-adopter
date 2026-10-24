#!/usr/bin/env node
// 抖音 / B站 等网页社交平台的 adopter —— 这些平台没有推送协议，这个进程负责把它伪装成「有」。
//
// 架构（和以前一样，只是把「抖音」这一层抽掉了）：
//
//   专用 Edge（CDP 9227）
//         ↑ 读 DOM                          ↓ 写 DOM
//   [本进程]  ── src/channels/ 下的通道实现（douyin.mjs / bilibili.mjs…）
//         │ POST {userId, chatId, text, messageId}
//         ↓
//   dsh-notifier  inbound.<channel>（抖音是 127.0.0.1:8106/douyin）
//         │ bus.accept → agent-router → DSH 会话
//         ↓ turn/end 最后一条 assistant 消息
//   replyUrl → [本进程] /send → 通道 → 写回输入框
//
// 本文件不含任何平台 DOM 逻辑；平台差异全在 src/channels/ 里。加一个平台不用改这里。
//
// 用法：
//   node adopter.mjs                     # 用同目录 config.json，按 config.channels 起通道
//   node adopter.mjs --list-channels     # 看有哪些通道实现
//   node adopter.mjs --status            # 各通道自检（登录/可用）
//   node adopter.mjs --dump-contacts     # 打印联系人（拿 recipientId）

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChannel, listChannelNames } from './src/channels/registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, 'config.json');

const DEFAULTS = {
  listenHost: '127.0.0.1',
  listenPort: 9320,
  pollMs: 15000,
  token: '',
  /** 单通道时的兜底上报地址 */
  notifierUrl: '',
  channels: [],
};

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const warn = (...args) => console.error(`[${new Date().toISOString()}]`, ...args);
const msgOf = (error) => (error instanceof Error ? error.message : String(error));

const config = { ...DEFAULTS, ...(existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {}) };

/**
 * 把 config 归一化成通道清单。
 * 新格式：channels: [{ id, enabled?, notifierUrl?, userId?, ...通道自己的参数 }]
 * 旧格式（只有顶层 recipientId/contactName 等）：等价于单个 douyin 通道。
 */
function normalizeChannelConfigs(raw) {
  if (Array.isArray(raw.channels) && raw.channels.length) {
    return raw.channels
      .filter((item) => item && item.enabled !== false)
      .map((item) => ({
        ...item,
        id: item.id ?? 'douyin',
        notifierUrl: item.notifierUrl ?? raw.notifierUrl ?? '',
        userId: item.userId ?? item.contactName ?? item.id ?? 'default',
      }));
  }
  // 旧配置兼容：顶层字段就是抖音那一套
  const legacy = {
    recipientId: raw.recipientId,
    contactName: raw.contactName,
    notifierUrl: raw.notifierUrl,
    userId: raw.userId,
  };
  if (!legacy.notifierUrl) return [];
  return [{ ...legacy, id: 'douyin' }];
}

// ---- 启动时加载通道 ----
const entries = []; // { channel, notifierUrl, userId, reported:Set, baselineReady, failures, ok }

async function bootChannels() {
  const wanted = normalizeChannelConfigs(config);
  if (!wanted.length) {
    warn('config.json 里没有配置任何通道（channels 为空且没有旧格式的 notifierUrl）。');
    return;
  }
  for (const item of wanted) {
    const { id, notifierUrl, userId, ...options } = item;
    try {
      const channel = await loadChannel(id, options);
      entries.push({
        channel,
        notifierUrl,
        userId,
        reported: new Set(),
        /** 媒体消息的内容指纹：ID 会漂，用它兜住"旧卡片被当成新消息再报一次" */
        reportedFingerprints: new Set(),
        /** 分享卡片等待计数：messageId → 已经等了几轮，防止永远卡在等待里 */
        shareWaits: new Map(),
        /**
         * 哪些会话已经建过基线。**必须按会话记，不能用全局的 baselineReady**：
         * 群可能因为轮转/单轮预算被推迟到第 N 轮才第一次读到，那时全局基线早建好了，
         * 于是它整个窗口（最多 11 条历史）会被当成新消息一次性灌进会话。
         */
        conversationBaselines: new Set(),
        /**
         * 群成员白名单：群会话 id → 允许的发言人昵称数组（groups[].onlyFrom）。
         *
         * 为什么需要它：群消息的 userId 是**号主身份键**（见文件头 report 注释），
         * 所以总线白名单只能拦「这个群」，拦不到「群里是谁在说话」——
         * 群里任何人发言都会被当成号主本人上报进来。要按人拦，只能在这里做。
         * 值为空数组或缺省 = 不限制（保持旧行为）；数组里含 '*' 表示显式全放开。
         */
        groupAllowFrom: new Map(
          (Array.isArray(options.groups) ? options.groups : [])
            .filter((group) => group && typeof group.id === 'string' && group.id !== '')
            .map((group) => [
              group.id,
              (Array.isArray(group.onlyFrom) ? group.onlyFrom : [])
                .map((name) => String(name).trim())
                .filter((name) => name !== ''),
            ]),
        ),
        /**
         * 群会话能不能被回发（groups[].allowGroupReply，默认 false）。
         *
         * 为什么要默认关：agent 每一轮都会产出文本，notifier 在 turn 结束时会把这轮回复
         * 回发到来源 chatId。群消息进来 ⇒ 回复进群，而 agent 没有「这一轮闭嘴」的能力
         * ——连「这条我不接话」这句话本身都会进群。默认关掉，群消息照收、回复留在会话里。
         */
        groupReplyAllowed: new Map(
          (Array.isArray(options.groups) ? options.groups : [])
            .filter((group) => group && typeof group.id === 'string' && group.id !== '')
            .map((group) => [group.id, group.allowGroupReply === true]),
        ),
        baselineReady: false,
        failures: 0,
      });
      if (notifierUrl) {
        log(`通道已加载：${channel.label}（${channel.id}）→ ${notifierUrl}`);
      } else {
        // 没配总线地址就当「本地监听」：消息只进日志和 /status，不往不存在的端点发请求。
        // 通知通道的 inbound 还没建时就是这个状态。
        log(`通道已加载：${channel.label}（${channel.id}）→ 本地监听（只记日志，不接总线）`);
      }
    } catch (error) {
      warn(`通道「${id}」加载失败：${msgOf(error)}`);
    }
  }
}

// ---- 命令行 ----
const argv = process.argv.slice(2);
if (argv.includes('--list-channels')) {
  const names = await listChannelNames();
  console.log('可用通道实现：');
  for (const name of names) console.log(`  - ${name}`);
  process.exit(0);
}

if (argv.includes('--status')) {
  await bootChannels();
  for (const entry of entries) {
    const result = await entry.channel.status().catch((error) => ({ ok: false, reason: msgOf(error) }));
    console.log(`\n[${entry.channel.id}] ${entry.channel.label}`);
    console.log(JSON.stringify(result, null, 2));
  }
  for (const entry of entries) await entry.channel.close?.().catch(() => {});
  process.exit(entries.every((entry) => entry.channel.id !== 'douyin') ? 0 : 0);
}

await bootChannels();

// ---- 上报 ----
/**
 * 把一条消息交给总线。
 *
 * 信封形状照 NapCat（`dsh-notifier/inbound/onebot-in.mjs`）那一套 —— 它已经在 QQ 上跑通了：
 *   私聊：userId = 联系人, chatId = 联系人, chatType = 'private'
 *   群聊：userId = 号主,   chatId = 群,     chatType = 'group', senderName = 发言人
 * notifier 的 `decorateInbound()` 据此打 `[群 <chatId> · <发言人>]` 前缀。
 *
 * ⚠️ 群消息的 userId 必须是**号主身份键**，不能是发言人（2026-10-24 修）：
 * userId 在总线那边是绑定键（`douyin:your-name`），填成发言人昵称 ⇒ 查不到绑定 ⇒
 * 命中「陌生人防打扰」⇒ 配对提示被回帖**发进群里**。谁说的只走 senderName。
 */
async function report(entry, conversationId, message, options = {}) {
  const text = describe(entry.channel, message);
  // 画面的落盘路径随消息一起进会话：会话那边拿到路径就能直接看图，
  // 不必再为了一条表情包去驱动浏览器（路线 A：上报时带上可看的画面）。
  const files = Array.isArray(message?.media?.files) ? message.media.files : [];
  const response = await fetch(entry.notifierUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
    },
    body: JSON.stringify({
      userId: options.userId ?? entry.userId,
      chatId: conversationId,
      text,
      messageId: message.id,
      displayName: entry.channel.label,
      // 只有 'group' 才带这个字段；私信不带，保持和以前完全一样的请求体
      ...(options.chatType === 'group' ? { chatType: 'group' } : {}),
      // 群里的发言人名（光靠 userId 有时不够直观，会话那边能直接用）
      ...(options.senderName ? { senderName: options.senderName } : {}),
      // 好友分享的作品：让会话那边知道这条消息本身带着一个可看的东西
      ...(message.share ? { share: message.share } : {}),
      // 媒体画面的本地路径（总线目前只取 text，这里留着方便诊断和将来扩展）
      ...(files.length ? { media: { type: message.media?.type ?? null, files } } : {}),
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return text;
}

/** 画面路径 → 一句话。标签用词对齐 QQ 那条入站（[表情包] / [图片] + 资源位置）。 */
function fileHint(media, messageId) {
  if (Array.isArray(media?.files) && media.files.length) return `（画面：${media.files[0]}）`;
  if (media?.requiresVisual) return `（画面未取到${messageId ? `，messageId=${messageId}` : ''}）`;
  return '';
}

/** 文字化优先用通道自己的实现（它能讲清分享卡片），没有就退回通用规则。 */
function describe(channel, message) {
  if (typeof channel.describe === 'function') {
    try {
      return channel.describe(message);
    } catch {
      /* 通道描述失败就退回通用 */
    }
  }
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (text) return text;
  const hint = fileHint(message?.media, message?.id);
  if (message?.share) {
    const title = message.share.title ? `：${message.share.title}` : '';
    return `[分享作品${title}]${hint}`;
  }
  if (message?.media?.type === 'emoji') return `[表情包${message.media.label ? `：${message.media.label}` : ''}]${hint}`;
  if (message?.media?.type === 'image') return `[图片]${hint}`;
  return `[非文本消息]${hint}`;
}

// ---- 轮询 ----
let polling = false;

/**
 * 分享卡片是异步渲染的：轮询正好撞上卡片刚出现的那一瞬，作者名/封面还没填上，
 * 这时候上报出去就是一条光秃秃的「[分享作品]」。
 *
 * 判断依据只用作者名：videoId 和 title 在卡片 DOM 里本来就不存在（卡片没有链接、
 * 也不显示标题），拿它们当「没渲染完」的证据会永远为真。
 */
function shareLooksUnrendered(message) {
  const share = message?.share;
  if (!share) return false;
  return !share.author && !share.title && !share.videoId;
}

/**
 * 照片（图片消息）也是异步渲染的：它刚出现那一瞬间，DOM 里可能还没有那个 `<img>`，
 * 于是被解析成 `kind: 'unsupported'`、`media: null`，上报出去只剩一个「[非文本消息]」，
 * 那一刻也谈不上落盘画面。
 *
 * 实测代价（2026-10-23）：用户发的第一张照片就是这么丢的 —— 04:46:08 上报成
 * 「[非文本消息]」，几分钟后用探针读同一个窗口，它明明已经是 `kind: 'image'` 了。
 *
 * 判断只看「没有正文、没有 media、也不是文本」，所以表情/分享/文本都不受影响；
 * 语音这类真正解析不出来的消息会多等一轮再照发，代价可接受。
 */
function mediaLooksUnrendered(message) {
  if (!message || message.media) return false;
  if (typeof message.text === 'string' && message.text.trim()) return false;
  return message.kind === 'unsupported';
}

/**
 * 消息 ID 不稳定：插件用「时序窗口重叠」推导 ID，窗口一滑动，同一条消息就换了 ID
 * （实测同一张卡片先后拿到过 msg:96dbe6… 和 msg:934cd1…）。
 * `reported` 靠 ID 判重，于是认不出它，旧卡片被当成新消息再上报一次，
 * 表现出来就是十几分钟前分享的东西突然又触发一轮回复。
 *
 * 只对**没有正文**的媒体消息做内容指纹：
 * 带正文的消息如果也按内容判重，「连发两次同一句话」会被误杀成重复，代价更大。
 * 所以有正文一律返回 null，继续走 ID 判重。
 */
function fingerprintOf(message) {
  const text = String(message?.text ?? '').trim();
  if (text) return null;
  const media = message?.media ?? null;
  if (!media || typeof media !== 'object') return null;
  const ref = Array.isArray(media.resources) && media.resources[0]?.resourceRef
    ? String(media.resources[0].resourceRef)
    : '';
  const author = String(media.author ?? '').trim();
  const label = String(media.label ?? '').trim();
  const type = String(media.type ?? '').trim();
  if (!type) return null;
  /**
   * 2026-10-25：指纹必须包含**能区分内容本身**的字段。
   *
   * 之前只用了 `type|author|label|ref`，而 B 站分享卡片的形状是
   * `media = { type:'share', title, author, videoId, url }` —— 没有 `resources`、没有 `label`，
   * 于是整张卡片的指纹退化成 `share|<作者>||`。
   * 后果不只是「同一条视频重复分享被吞」，而是**同一个人分享的任何视频共用一个指纹**：
   * 第一张进水位之后，后面每一张都被判成重复、静默吞掉（实测：第二次分享没有上报）。
   *
   * `videoId` / `title` 是内容身份，必须进指纹；只有它们也没有时才算「认不出内容」。
   */
  const ident = String(media.videoId ?? media.title ?? '').trim();
  /**
   * 🔴 2026-10-24：三个判别字段全空时**不能**拿 `"type|||"` 当指纹。
   *
   * 那样同一个平台上所有「无正文的媒体消息」会共享一个指纹，
   * 第一张进了 `reportedFingerprints` 之后，**后面每一张都会被判成重复而静默吞掉**。
   *
   * B 站私信图片正是这种形状：`media = { type:'image', urls:[…], files:[…] }`，
   * 没有 `resources` / `author` / `label` ⇒ 指纹恒为 `image|||`。
   * 实测代价（2026-10-24）：连发三张图，只有第一张（建基线那轮）进了水位，后两张全丢。
   *
   * 而 B 站不需要内容指纹兜底 —— 它的 `msg_key` 是服务端给的稳定唯一 ID，
   * 不像抖音那边「时序窗口重叠推导出来的 ID 会漂移」。
   * 所以这里返回 null ⇒ 只按 ID 判重，这正是 B 站需要的语义。
   */
  if (!ref && !author && !label && !ident) return null;
  return `${type}|${author}|${label}|${ref}|${ident}`;
}

async function pollEntry(entry) {
  const { channel } = entry;
  let snapshot;
  try {
    snapshot = await channel.poll({});
  } catch (error) {
    entry.failures += 1;
    warn(`[${channel.id}] 轮询失败：${msgOf(error)}`);
    return;
  }

  const flags = snapshot?.flags ?? {};
  if (flags.blocked || flags.loginRequired || flags.verificationRequired) {
    warn(`[${channel.id}] 当前不可用（登录/验证/拦截），本轮跳过。${snapshot?.reason ?? ''}`);
    return;
  }

  /**
   * 一个通道可能同时轮询好几个会话：私信一个，群里若干个。
   * 老通道只给 `conversation` / `messages`，那就等价于「只有一个会话」，行为完全不变。
   */
  const bundles = Array.isArray(snapshot?.conversations) && snapshot.conversations.length
    ? snapshot.conversations
    : [{
        conversation: snapshot?.conversation ?? null,
        messages: Array.isArray(snapshot?.messages) ? snapshot.messages : [],
        diagnostics: snapshot?.diagnostics ?? null,
      }];
  // 通道自己报的窗口统计（有就带上，没有就 null）。用它区分
  // 「窗口里没 incoming」和「一条都没读到」——这两种在日志里都是一句「已知 0 条」。
  entry.diagnostics = snapshot?.diagnostics ?? null;
  let fresh = 0;

  for (const bundle of bundles) {
    const conversationId = bundle?.conversation?.id ?? null;
    const isGroup = bundle?.conversation?.kind === 'group';
    /**
     * 这个会话是不是第一次见。
     * 按会话单独建基线（见 conversationBaselines 的注释）：群被轮转推迟到第 N 轮才第一次
     * 读到时，全局 baselineReady 早就 true 了，不能因此把它的历史消息全灌进会话。
     */
    const firstSeen = conversationId !== null && !entry.conversationBaselines.has(conversationId);
    const convoName = bundle?.conversation?.displayName ?? conversationId ?? '?';
    const messages = Array.isArray(bundle?.messages) ? bundle.messages : [];
    /** 群消息带上「谁说的」：群前缀只靠 senderName，身份键不跟着它走 */
    const groupOptions = (message) => {
      if (!isGroup) return {};
      const speaker = typeof message.senderName === 'string' ? message.senderName.trim() : '';
      /**
       * 群成员白名单（groups[].onlyFrom），三种状态：
       *   缺省 / 空数组  → 不限制，谁说的都收（旧行为）
       *   ['*']          → 显式全放开，等价于不限制（写出来更明确，也方便临时切换）
       *   ['your-name', ...] → 只收名单里的发言人，其余静默跳过
       *
       * 名字里带 '*' 是刻意选的：`onlyFrom` 一个字段承担「放开/收紧」两件事，
       * 不用再加一个 allowAll 开关去和它互相打架。
       * 发言人为空时**不在这一层拦** —— 下面还有「读不出发言人就不上报」那条规则，
       * 那条会 warn，这里的静默过滤不该把它盖掉。
       */
      const allowFrom = conversationId !== null ? entry.groupAllowFrom?.get(conversationId) : null;
      const allowAll = Array.isArray(allowFrom) && allowFrom.includes('*');
      const restricted = Array.isArray(allowFrom) && allowFrom.length > 0 && !allowAll;
      if (restricted && speaker !== '' && !allowFrom.includes(speaker)) {
        return { chatType: 'group', senderName: speaker, droppedByAllowList: true };
      }
      // userId 故意留空：让 report() 的 `options.userId ?? entry.userId` 兜到号主身份键。
      // 这里一旦填发言人，绑定就查不到，配对提示会被回帖发进群（见文件头注释）。
      return speaker ? { chatType: 'group', senderName: speaker } : { chatType: 'group' };
    };

    for (const message of messages) {
      const direction = message.direction ?? message.sender;
      if (direction !== 'incoming') continue;
      if (typeof message.id !== 'string' || !message.id) continue;
      if (entry.reported.has(message.id)) continue;

      // ID 漂移兜底：媒体消息按内容指纹再判一次。认得出的旧卡片直接吞掉，
      // 并把它的新 ID 也记进水位，下一轮就不用再做这层判断。
      const fingerprint = fingerprintOf(message);
      if (fingerprint !== null && entry.reportedFingerprints.has(fingerprint)) {
        entry.reported.add(message.id);
        continue;
      }

      // 卡片/照片还没渲染完就先别标记已读，下一轮再读，最多等 3 轮（约 45 秒）还不行就照发，
      // 避免某天结构又变了导致这条永远卡在等待里。
      if (entry.baselineReady && (shareLooksUnrendered(message) || mediaLooksUnrendered(message))) {
        const isShare = shareLooksUnrendered(message);
        // 卡片最多等 3 轮（作者名要等异步填充）；照片最多等 2 轮（img 插入比卡片快）
        const waited = (entry.shareWaits.get(message.id) ?? 0) + 1;
        if (waited <= (isShare ? 3 : 2)) {
          entry.shareWaits.set(message.id, waited);
          log(
            `[${channel.id}] ${isShare ? '分享卡片' : '媒体消息'}还没渲染完（第 ${waited} 次等待），下一轮再上报。`,
          );
          continue;
        }
      }
      entry.shareWaits.delete(message.id);

      entry.reported.add(message.id);
      if (fingerprint !== null) entry.reportedFingerprints.add(fingerprint);
      if (!entry.baselineReady || firstSeen) continue; // 首轮/首次见的会话：只记水位，不把历史消息当新消息灌进去

      // 群消息读不出发言人就**不上报**：宁可漏，也不能让别人的话被当成本人说的。
      // 单聊没有这个问题（会话里只有对方），所以这条只对群生效。
      const options = groupOptions(message);
      if (isGroup && !options.senderName) {
        fresh += 1;
        warn(
          `[${channel.id}] 群「${convoName}」有消息读不出发言人（senderName 为空），已跳过上报：` +
            `${describe(entry.channel, message).slice(0, 40)}`,
        );
        continue;
      }

      // 群成员白名单：名单外的发言人静默跳过（已记水位，不会反复重试）。
      // 用 log 而不是 warn —— 这是配置的预期行为，不是故障，群活跃时不该刷警告。
      if (options.droppedByAllowList === true) {
        fresh += 1;
        log(
          `[${channel.id}] 群「${convoName}」/${options.senderName} 不在白名单（groups[].onlyFrom），已跳过：` +
            `${describe(entry.channel, message).slice(0, 40)}`,
        );
        continue;
      }

      // 通道可以把消息标成「不值得惊动会话」（比如抖音的点赞/关注通知）。
      // 这类仍然计入水位并写日志，但不往总线发 —— 否则每次点赞都会变成一次模型调用。
      if (message.important === false) {
        fresh += 1;
        log(`[${entry.channel.id}] 新消息（低优先级，仅记录）：${describe(entry.channel, message)}`);
        continue;
      }

      // 没有配总线地址就只记本地日志：这样通知通道的 inbound 还没建时也能先跑起来监听，
      // 不然每轮都往一个不存在的端点发请求，日志里全是失败。
      if (!entry.notifierUrl) {
        fresh += 1;
        log(`[${entry.channel.id}] 新消息（未接总线）：${describe(entry.channel, message)}`);
        continue;
      }

      try {
        const text = await report(entry, conversationId, message, options);
        fresh += 1;
        const tag = message.share ? `（含分享：${message.share.title ?? message.share.videoId ?? '作品'}）` : '';
        const where = isGroup ? `群「${convoName}」/ ${options.senderName}` : '';
        log(`[${entry.channel.id}] 已上报新消息${where ? `（${where}）` : ''}${tag}：${text.slice(0, 40)}`);
      } catch (error) {
        // 上报失败把水位退回，下轮重试，别让消息凭空消失
        entry.reported.delete(message.id);
        warn(`[${entry.channel.id}] 上报失败，下轮重试：${msgOf(error)}`);
      }
    }
    // 这一轮见过了：记进集合，下一轮它就不再是「第一次见」
    if (conversationId !== null) entry.conversationBaselines.add(conversationId);
  }

  // 把窗口统计拼成一小段，让日志能自己解释「0 条」是什么意思
  const d = entry.diagnostics;
  const windowHint = d ? `，窗口 ${d.windowMessages} 条／对方 ${d.incoming} 条` : '';
  // 多个会话时把群的数量写进日志：不然「无新消息」看不出群到底轮询了没有
  const groupCount = bundles.filter((bundle) => bundle?.conversation?.kind === 'group').length;
  const bundleHint = bundles.length > 1 ? `，会话 ${bundles.length} 个（群 ${groupCount} 个）` : '';

  // 护栏（ISSUES-PLUGIN P6 建议的那条）：窗口里有消息、但一条对方发的都认不出来，
  // 连续若干轮就是异常——一个正常私信会话不会只剩我方发言。
  // 这种故障不抛错、不进 failures，日志里只有平静的「已知 0 条」，所以要主动喊一声。
  if (d && d.windowMessages >= 10 && d.incoming === 0) {
    entry.incomingZeroStreak = (entry.incomingZeroStreak ?? 0) + 1;
    if (entry.incomingZeroStreak === 3 && !entry.warnedIncomingZero) {
      entry.warnedIncomingZero = true;
      warn(
        `[${channel.id}] 窗口有 ${d.windowMessages} 条消息，但连续 3 轮一条「对方发的」都认不出来——` +
          `方向判定可能坏了（消息会因此全部不上报）。跑 node tools/probe-media-dom.mjs 看方向证据。`,
      );
    }
  } else {
    entry.incomingZeroStreak = 0;
    entry.warnedIncomingZero = false;
  }

  /**
   * 列表类通道的「0 条不算基线」。
   *
   * 通知通道的列表是异步渲染的：进程刚起来时第一轮常常读到 0 条，那不是「没有通知」，
   * 是「浮层还没画出来」。拿 0 条当基线，随后渲染出来的那批历史通知就全成了「新消息」
   * ——2026-10-25 实测：重启后基线记 0 条，紧接着 4 条旧通知被逐条上报。
   *
   * 通道用 `emptyMeansUnrendered` 声明自己属于这种形态；最多等 5 轮（约 75 秒），
   * 等不到就照实建基线，免得真没通知时永远不建。
   */
  if (!entry.baselineReady && channel.emptyMeansUnrendered === true) {
    const polledMessages = bundles.reduce(
      (sum, bundle) => sum + (Array.isArray(bundle?.messages) ? bundle.messages.length : 0),
      0,
    );
    if (polledMessages === 0) {
      entry.emptyBaselineWaits = (entry.emptyBaselineWaits ?? 0) + 1;
      if (entry.emptyBaselineWaits < 5) {
        log(`[${channel.id}] 列表还是空的（第 ${entry.emptyBaselineWaits} 次），暂不建立基线`);
        return;
      }
      warn(`[${channel.id}] 连续 ${entry.emptyBaselineWaits} 轮读到 0 条，仍按 0 条建立基线`);
    }
  }

  if (!entry.baselineReady) {
    entry.baselineReady = true;
    entry.failures = 0;
    log(`[${channel.id}] 已建立消息基线：${entry.reported.size} 条已知消息／${entry.conversationBaselines.size} 个会话${windowHint}${bundleHint}，只上报此后新收到的。`);
  } else if (fresh === 0) {
    log(`[${channel.id}] 轮询：无新消息（已知 ${entry.reported.size} 条${windowHint}${bundleHint}）`);
  }
}

async function tick() {
  if (polling) return;
  polling = true;
  try {
    // 各通道独立：一个平台挂了不该拖住另一个
    await Promise.allSettled(entries.map((entry) => pollEntry(entry)));
  } finally {
    polling = false;
  }
}

// ---- 回程：notifier 把要发的话 POST 过来 ----
function pickChannel(name) {
  if (name) {
    const hit = entries.find((entry) => entry.channel.id === name);
    if (!hit) throw new Error(`没有运行中的通道「${name}」。`);
    return hit;
  }
  if (entries.length === 1) return entries[0];
  const douyin = entries.find((entry) => entry.channel.id === 'douyin');
  if (douyin) return douyin;
  throw new Error(`有 ${entries.length} 个通道在跑，请在请求里用 channel 指明发给谁。`);
}

/**
 * 抖音编辑器（Slate）会把 Markdown 标记改写：`**文字**` 落盘后回读不再等于原文，
 * 插件的「填写后回读比对」就会判定不一致而拒绝点击发送，文本便留在输入框里变成草稿、
 * 再把下一次发送也堵死。发送前先剥成纯文本，从源头避开这个不一致。
 */
function toPlainText(text) {
  return String(text)
    .replace(/\*\*(.+?)\*\*/g, '$1') // **粗体**
    .replace(/`([^`]+)`/g, '$1') // `行内代码`
    .replace(/^#{1,6}\s+/gm, '') // # 标题
    .replace(/^\s{0,3}[-*+]\s+/gm, '· ') // - 列表
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 $2') // [文字](链接)
    .replace(/\n{3,}/g, '\n\n') // 多余空行
    .trim();
}

async function handleSend(payload) {
  const entry = pickChannel(typeof payload?.channel === 'string' ? payload.channel.trim() : '');
  // 通知类入站（@提醒等）没有会话 ID，硬塞给 send 会被插件判成「需要已发现的精确联系人 ID」。
  // 各平台的会话 ID 形状不同：抖音是 `conv:<64hex>`，B 站是 `uid:<数字>`。
  // 两种都原样交给通道，由通道自己校验（它比这里更清楚自己认什么格式）；
  // 其余格式仍然丢弃 ⇒ 通道回落到自己的默认联系人。
  const rawId = typeof payload?.chatId === 'string' ? payload.chatId.trim() : '';
  const conversationId =
    /^conv:[a-f0-9]{64}$/.test(rawId) || /^uid:\d+$/.test(rawId) ? rawId : undefined;

  /**
   * 群会话默认禁止回发（2026-10-25）。
   *
   * 现场：群里有人说话 → 消息进会话 → agent 每轮都会产出文本 → notifier 在 turn 结束
   * 把这轮回复回发到同一个 chatId ⇒ 群里看到一句句本该只在会话内部的话（调试过程、
   * 对第三方的评论）。agent 没有「这一轮不输出」的能力，所以「我不接话」也会被发出去。
   *
   * 默认关；某个群想放开就给它加 `"allowGroupReply": true`。
   */
  if (conversationId !== undefined && entry.groupReplyAllowed?.has(conversationId) && entry.groupReplyAllowed.get(conversationId) !== true) {
    throw new Error(
      `群会话 ${conversationId.slice(0, 13)}… 不回发（groups[].allowGroupReply 未开启）。` +
        `群消息照收，回复只留在会话里；要放开给该群加 "allowGroupReply": true。`,
    );
  }

  // 表情：走平台内置表情面板（点一项直接发出，不经过编辑器，因此不会留草稿）
  //   { "emoji": "续火花" }        按名字（推荐，抖音自带的 21 个都有中文名）
  //   { "emoji": 0 }               按内置表情里的序号（名字拿不到时的退路）
  //   { "emoji": { "name": "比心" } }
  const emoji = payload?.emoji;
  if (emoji !== undefined && emoji !== null && emoji !== '') {
    const result = await entry.channel.send({ conversationId, emoji });
    return { ...result, channel: entry.channel.id };
  }

  // 图片：走上传 → 确认弹窗 → 发送。image 是本机绝对路径，caption 是可选附带文字
  // （抖音会把附带文字作为独立的一条文字消息发出去，所以一次会新增两条气泡）。
  if (typeof payload?.image === 'string' && payload.image.trim()) {
    const caption = typeof payload?.caption === 'string' ? payload.caption : undefined;
    const result = await entry.channel.send({ conversationId, image: payload.image.trim(), caption });
    return { ...result, channel: entry.channel.id };
  }

  // 纯文本：**原路径一个字都没改**（这条链路已验证过，别动）
  const raw = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (!raw) throw new Error('回发内容为空。');
  const text = toPlainText(raw);
  if (!text) throw new Error('回发内容去掉标记后为空。');
  const result = await entry.channel.send({ conversationId, text });
  return { ...result, channel: entry.channel.id };
}

// ---- 列出可发的内置表情：POST /emojis ----
// 只读：打开面板读一遍名字就关掉，不发任何消息。调用方据此决定发哪个，别写死表情名单。
async function handleEmojis(payload) {
  const entry = pickChannel(typeof payload?.channel === 'string' ? payload.channel.trim() : '');
  if (typeof entry.channel.emojis !== 'function') throw new Error(`通道「${entry.channel.id}」不支持列表情。`);
  const emojis = await entry.channel.emojis({});
  return { ok: true, emojis, channel: entry.channel.id };
}

// ---- 分享作品：POST /share ----
// 真逻辑在 src/douyin/share.mjs（tools/share-video.mjs 用的也是同一份）。
// 一次只允许一个：分享要独占一个标签页几十秒，并发跑只会互相踩。
let sharing = false;

async function handleShare(payload) {
  if (sharing) throw Object.assign(new Error('另一个分享正在进行中，请稍后重试。'), { status: 429 });
  sharing = true;
  try {
    const { shareVideo } = await import('./src/douyin/share.mjs');
    return await shareVideo({
      videoId: payload?.videoId ?? payload?.url,
      pick: payload?.pick,
      to: typeof payload?.to === 'string' && payload.to.trim() ? payload.to.trim() : 'your-name',
      dryRun: payload?.dryRun === true,
      log: (line) => log(`[share] ${line}`),
    });
  } finally {
    sharing = false;
  }
}

// ---- 按需取画面：POST /observe ----
// 路线 B 的入口：上报只保证「消息＋画面路径」，万一路径丢了/落盘失败，
// 会话侧可以拿 messageId 来这里补一次。视频限额不管这一步（纯读画面，不开作品页）。
async function handleObserve(payload) {
  const entry = pickChannel(typeof payload?.channel === 'string' ? payload.channel.trim() : '');
  if (typeof entry.channel.observe !== 'function') throw new Error(`通道「${entry.channel.id}」不支持按需取画面。`);
  const messageId = typeof payload?.messageId === 'string' ? payload.messageId.trim() : '';
  if (!messageId) throw new Error('需要 messageId（形如 msg:<64位十六进制>）。');
  const rawId = typeof payload?.chatId === 'string' ? payload.chatId.trim() : '';
  const conversationId = /^conv:[a-f0-9]{64}$/.test(rawId) ? rawId : undefined;
  const result = await entry.channel.observe({ conversationId, messageId });
  return { ...result, channel: entry.channel.id };
}

const server = createServer((request, response) => {
  let responded = false;
  const finish = (status, body = '') => {
    if (responded) return;
    responded = true;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(body);
  };

  const route = (request.url ?? '').split('?')[0];

  if (route === '/status') {
    return finish(
      200,
      JSON.stringify({
        ok: true,
        channels: entries.map((entry) => ({
          id: entry.channel.id,
          label: entry.channel.label,
          baselineReady: entry.baselineReady,
          knownMessages: entry.reported.size,
          /** 上一轮 poll 看到的窗口构成；null 表示通道没报（不影响功能） */
          window: entry.diagnostics ?? null,
          failures: entry.failures,
          notifierUrl: entry.notifierUrl,
        })),
      }),
    );
  }

  if (route !== '/send' && route !== '/share' && route !== '/observe' && route !== '/emojis') return finish(404, JSON.stringify({ ok: false, error: 'not found' }));
  if (request.method !== 'POST') return finish(405, JSON.stringify({ ok: false, error: 'method not allowed' }));
  if (config.token && request.headers.authorization !== `Bearer ${config.token}`) {
    return finish(401, JSON.stringify({ ok: false, error: 'unauthorized' }));
  }

  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > 256 * 1024) {
      finish(413, JSON.stringify({ ok: false, error: 'payload too large' }));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return finish(400, JSON.stringify({ ok: false, error: 'invalid json' }));
    }
    const task =
      route === '/share'
        ? handleShare(payload)
        : route === '/observe'
          ? handleObserve(payload)
          : route === '/emojis'
            ? handleEmojis(payload)
            : handleSend(payload);
    task
      .then((result) => {
        if (route === '/share') log(`已分享给「${result.to ?? '?'}」：${result.url ?? '?'}`);
        else if (route === '/observe') log(`已取画面（${result.source ?? '?'}）：${(result.files ?? []).join(' , ') || result.reason || '无'}`);
        else if (route === '/emojis') log(`可发表情 ${(result.emojis ?? []).length} 个`);
        else if (result.kind === 'emoji') log(`已发表情到 ${result.channel}：${result.emoji ?? '?'}`);
        else if (result.kind === 'image') log(`已发图片到 ${result.channel}：${result.image?.path ?? '?'}${result.caption ? `（附带「${String(result.caption).slice(0, 30)}」）` : ''}`);
        else log(`已回发到 ${result.channel}：${String(payload.text).slice(0, 40)}`);
        finish(200, JSON.stringify(result));
      })
      .catch((error) => {
        const status = Number.isInteger(error?.status) ? error.status : 500;
        warn(`${route} 失败：${msgOf(error)}`);
        finish(status, JSON.stringify({ ok: false, error: msgOf(error) }));
      });
  });
  request.on('error', () => {
    /* 连接层错误忽略 */
  });
});

// ---- --dump-contacts：列出联系人，用来拿 recipientId ----
if (argv.includes('--dump-contacts')) {
  const entry = entries.find((item) => item.channel.id === 'douyin') ?? entries[0];
  if (!entry) {
    warn('没有已加载的通道，无法列出联系人。');
    process.exit(1);
  }
  try {
    const contacts = await entry.channel.contacts({});
    console.log(JSON.stringify(contacts, null, 2));
  } catch (error) {
    warn(`列出联系人失败：${msgOf(error)}`);
    process.exitCode = 1;
  }
  for (const item of entries) await item.channel.close?.().catch(() => {});
  process.exit(process.exitCode ?? 0);
}

// ---- 常驻 ----
if (!entries.length) {
  warn('没有可运行的通道，进程退出。请检查 config.json 的 channels。');
  process.exit(1);
}

server.listen(config.listenPort, config.listenHost, () => {
  log(`回发端点：http://${config.listenHost}:${config.listenPort}/send`);
  log(`状态查询：http://${config.listenHost}:${config.listenPort}/status`);
  log(`轮询间隔：${config.pollMs}ms`);
});

await tick();
const timer = setInterval(tick, config.pollMs);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    log('收到退出信号，正在关闭…');
    clearInterval(timer);
    await Promise.allSettled(entries.map((entry) => entry.channel.close?.()));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
