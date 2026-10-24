import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';
// 原来是插件 core.mjs 的 BrowserController；现换成 adopter 自有的轻量实现。
import { BrowserController } from '../browser/controller.mjs';
import { messageFingerprint } from './chat-message.mjs';
import { MessageIdentityTracker } from './message-tracker.mjs';
export { MessageIdentityTracker } from './message-tracker.mjs';

const HOME = 'https://www.douyin.com/?recommend=1&from_nav=1';
const hash = value => createHash('sha256').update(value).digest('hex');
const stop = signal => signal?.throwIfAborted();
const readableDraft = value => value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();

// [adopter 改动 / P2] 抖音编辑器是 Slate，会把 `**粗体**`、`# 标题`、`- 列表`、`[文字](链接)`
// 这类 Markdown 标记改写掉。于是「填进去的原文」和「回读出来的文字」永远不相等，
// 原来那种字面严格比对等于**永远失败** —— 文本留在输入框变草稿，把下一次发送也堵死。
//
// 所以比对前把两边都归一化到「纯文本形态」：标记剥掉、空白折叠。
// 真正的差异（内容被吃掉、被换成别的字、只剩一半）归一化之后依然存在，照样拦得住。
const normalizeForCompare = value => readableDraft(value)
  .replace(/\*\*(.+?)\*\*/g, '$1')            // **粗体**
  .replace(/__(.+?)__/g, '$1')                // __粗体__
  .replace(/\*(.+?)\*/g, '$1')                // *斜体*
  .replace(/(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g, '$1') // _斜体_（不误伤 snake_case）
  .replace(/`([^`]+)`/g, '$1')                // `行内代码`
  .replace(/^#{1,6}\s+/gm, '')                // # 标题
  .replace(/^\s{0,3}[-*+]\s+/gm, '')          // - 列表
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 $2') // [文字](链接)
  .replace(/\s+/g, ' ')                       // 空白折叠
  .trim();
/**
 * [adopter 改动 / 草稿残留 2026-10-23] 读输入框里「看得见的字」。
 *
 * 为什么要读两遍（innerText + textContent）：抖音私信输入框是**受控编辑器**
 * （ace 系，`ace-line` / `data-leaf` 结构，挂着 data-slate-editor），DOM 只是
 * 它的渲染结果，真身在它自己的 model 里。上一轮失败时用 `element.textContent = ''`
 * 清理，只删了 DOM 节点，model 里那段字还在 —— 于是 innerText / textContent /
 * childNodes 全都读到空，下一次输入却把旧文本一起渲染回来。
 *
 * 实测（tools/probe-draft-mutation.mjs，2026-10-23）：
 *   起点 innerText="" textContent="" childNodes=0     ← DOM 看起来一片空白
 *   fill('一一一') 之后读回「它出来我再汇总给你。\n一一一」  ← model 里那句复活了
 * 这就是日志里「填写前 0 字／期望 68 字／回读 91 字」那个矛盾的来源：
 * 0 字是 DOM，23 字是 model。差的那 23 字正是上一条回复的开头。
 *
 * 所以这里两个都读：innerText 是"渲染出来的"，textContent 是"节点里的"，
 * 任何一个非空都算有东西。用 readableDraft 而不是 normalizeForCompare：
 * 判断"有没有字"时不该把用户打的 `**` 这种标记当成空。
 */
const readEditor = async (editor) => ({
  rendered: readableDraft(await editor.innerText().catch(() => '')),
  raw: readableDraft(await editor.evaluate((element) => element.textContent ?? '').catch(() => '')),
});

/**
 * [adopter 改动 / 草稿残留] 把输入框清干净，而且只认「清到编辑器自己也认账」。
 *
 * 四种清法实测（tools/probe-draft-mutation.mjs 的 group1–group5）：
 *   - fill('')                     ✖ 空串不替换选区，一个字都删不掉（实测读回原样）
 *   - textContent='' + InputEvent  ✖ 只删 DOM、model 留字 → 下次输入复活 ← 这就是 bug 本体
 *   - Ctrl+A + insertText          ✖ 新文本被吃掉，只把旧 model 渲染回来
 *   - Ctrl+A + Delete              ✔ 编辑器在 model 层全选后删除，DOM 只剩一个空行占位
 *
 * 有个反直觉的点：DOM 是空的时候按 Ctrl+A，`getSelection()` 读出来是 collapsed、
 * 空字符串，看起来"什么都没选中"；但编辑器自己接管了这次按键，后面的 Delete
 * 依然把 model 清掉了（group4 实测：再输入只有新文本，没有旧残留跟着回来）。
 *
 * 返回清完之后仍然读到的内容：空字符串 = 干净。
 */
const clearEditor = async (page, editor) => {
  await editor.click({ timeout: 3000 });
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(120);
  const left = await readEditor(editor);
  return left.rendered || left.raw;
};

const localDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));

// ===================== 发表情 / 发图片（2026-10-23 新增） =====================
//
// 抖音网页私信除了文字，还能发两种东西，走的是**完全不同的两条 DOM 路径**，
// 而且都不经过编辑器（这点很重要：不走编辑器 = 不会留下草稿，也就不会堵死文本发送）：
//
//   A. 平台内置表情
//        点输入框里的笑脸图标 `svg.messageMsgInputiconAction`
//        → 弹 `div.componentsemojiemojiPanel`（**是 semi-modal 模态遮罩，不是普通浮层**）
//        → 面板底部 `.emojiEmojisModalTabsubTab` 是分类：第 0 个是内置表情
//          （21 个，每项 `.emojiEmojiItememojiItem` + `<img>` + `.emojiEmojiItememojiItemDesc` 文字名字：
//           续火花/比心/在干嘛/笑死/…/已阅/生日祝福），其余 tab 是没有名字的表情包
//        → **点一项就直接发出去**，不需要再按发送
//        → 面板会自己关掉
//      实测：点完消息列表立刻多一条 outgoing、kind=emoji 的气泡
//      （`<div class="MessageItemEmojiemojiBox"><img class="MessageItemEmojiimage"></div>`），
//      气泡上**没有** alt / aria-label / title —— 表情名字只存在于面板里，发出去之后就没了。
//
//   B. 本地图片（也可以带一句附带文字）
//        点 `div.semi-upload-add` → 浏览器文件框 → 塞文件
//        → 弹确认窗 `semi-modal-wrap-center`：
//            `.MsgInputSendFileModalreceiver` =「发送给 <昵称>」
//            `.MsgInputSendFileModalitemContentTitle/Desc` = 文件名 / 大小
//            `textarea[placeholder="有什么想和朋友说的..."]` = 可选的附带文字
//            `.MsgInputSendFileModalbtnCancle`「取消」 / `.MsgInputSendFileModalbtnSure`「发送」
//        → **必须点「发送」才算发出去**（选完文件只是"待确认"）
//      实测：带一句附带文字会发出**两条**消息 —— 先 image 气泡、再 text 气泡。
//
// 踩过的三个坑（改这里之前先看）：
//   1. 面板遮罩会**拦住对笑脸图标本身的点击**，所以"再点一次笑脸"和 ESC 都关不掉面板；
//      唯一可靠关法是点面板外的消息区（遮罩上），而且关闭动画期间点击会被吞。
//   2. 面板会**记住上次停留的 tab**，所以不能假设打开就是内置表情那一栏，必须显式切/探测。
//   3. 直接对隐藏的 `input[type=file]` 用 setInputFiles **没有任何反应**
//      （实测等 6 秒：编辑器空、无网络请求、无 console 报错）。必须走
//      「点上传按钮 → 接 filechooser → setFiles」这条真实交互路径。

/** 内侧表情面板（semi-modal 遮罩里的那个容器） */
const EMOJI_PANEL = '.componentsemojiemojiPanel';
/** 面板里的一项（含 img + 名字） */
const EMOJI_ITEM = `${EMOJI_PANEL} .emojiEmojiItememojiItem`;
/** 面板底部分类 */
const EMOJI_TAB = '.emojiEmojisModalTabsubTab';
/** 图片确认弹窗 */
const FILE_MODAL_SURE = '.MsgInputSendFileModalbtnSure';
const FILE_MODAL_CANCEL = '.MsgInputSendFileModalbtnCancle';

/** 抖音上传框 accept 是 ".jpg,.jpeg,.png,.gif,.mp4"，只放行这几个（不接受任意文件） */
const UPLOAD_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.mp4']);
/** 单文件上限。抖音真实限额未测，这里给一个保守值挡住误传的巨大文件 */
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 读表情面板：当前这一栏里有哪些项、叫什么名字、屏幕坐标在哪。
 * 在页面里执行。
 */
function readEmojiPanelDom() {
  const clean = value => (value ?? '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
  const panel = document.querySelector('.componentsemojiemojiPanel');
  if (!panel) return null;
  const visible = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const items = [...panel.querySelectorAll('.emojiEmojiItememojiItem')].map((element, index) => {
    const rect = element.getBoundingClientRect();
    const image = element.querySelector('img');
    return {
      index,
      name: clean(element.querySelector('.emojiEmojiItememojiItemDesc')?.textContent) || null,
      // 面板项的 CDN 地址是不带签名参数的稳定 id，可以做「这个表情是哪个」的第二判据
      source: (image?.getAttribute('src') || '').split('?')[0].split('/').pop() || null,
      rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      visible: visible(element),
    };
  });
  const tabs = [...document.querySelectorAll('.emojiEmojisModalTabsubTab')].map((element, index) => ({
    index,
    active: /active/i.test(element.getAttribute('class') || ''),
    rect: (() => { const rect = element.getBoundingClientRect(); return [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]; })(),
  }));
  return { panelVisible: visible(panel), items, tabs };
}

/**
 * 读图片确认弹窗。在页面里执行。
 * 返回 null 表示没有弹窗。
 */
function readFileConfirmDom() {
  const wrap = document.querySelector('.semi-modal-wrap');
  if (!wrap || getComputedStyle(wrap).display === 'none') return null;
  const clean = value => (value ?? '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
  const textarea = wrap.querySelector('textarea');
  return {
    receiver: clean(wrap.querySelector('.MsgInputSendFileModalreceiver')?.textContent),
    fileName: clean(wrap.querySelector('.MsgInputSendFileModalitemContentTitle')?.textContent),
    fileSize: clean(wrap.querySelector('.MsgInputSendFileModalitemContentDesc')?.textContent),
    hasTextarea: Boolean(textarea),
    textareaPlaceholder: textarea?.getAttribute('placeholder') ?? null,
    textareaValue: textarea?.value ?? null,
    hasSure: Boolean(wrap.querySelector('.MsgInputSendFileModalbtnSure')),
    hasCancel: Boolean(wrap.querySelector('.MsgInputSendFileModalbtnCancle')),
  };
}


export function analyzeConversationDay(snapshot, { now = Date.now, confirmedHistory = [] } = {}) {
  const current = typeof now === 'function' ? now() : now, today = localDay(current);
  const recipientId = snapshot?.conversation?.id || snapshot?.contact?.id;
  if (typeof recipientId === 'string' && recipientId.trim() && confirmedHistory.some(item => item?.confirmed === true && item.recipientId === recipientId && typeof item.messageId === 'string' && item.messageId.trim() && item.date === today && Number.isFinite(Date.parse(item.at)) && localDay(Date.parse(item.at)) === today && Date.parse(item.at) <= current)) return { status: 'already-sent', reason: '共同账本已确认今天向这位好友发过消息。' };
  const evidence = snapshot?.dayEvidence;
  if (snapshot?.blocked || snapshot?.loginRequired || snapshot?.verificationRequired || !recipientId || !Array.isArray(snapshot.messages) || !evidence?.latestEndVerified || evidence.chronology !== 'oldest-first' || !Number.isFinite(Date.parse(evidence.observedAt)) || localDay(Date.parse(evidence.observedAt)) !== today || Date.parse(evidence.observedAt) > current || current - Date.parse(evidence.observedAt) > 60_000) return { status: 'date-unknown', reason: '会话最新端、日期或快照时效尚未核实。' };
  const messages = snapshot.messages;
  if (messages.some(item => !['incoming', 'outgoing'].includes(item.sender || item.direction) || item.pending || item.failed)) return { status: 'date-unknown', reason: '会话含方向不明或未确认的消息，未自动问候。' };
  const dayOf = item => {
    if (item.dateEvidence?.kind === 'unknown') return null;
    const raw = String(item.dateEvidence?.raw ?? item.sentAt ?? item.timestamp ?? '').trim();
    if (/^今天(?:\s|$)/.test(raw)) return today;
    const date = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?:$|[ T\s])/.exec(raw);
    if (!date) return null;
    const padded = `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`;
    if (!Number.isFinite(Date.parse(padded + 'T00:00:00+08:00')) || localDay(Date.parse(padded + 'T00:00:00+08:00')) !== padded) return null;
    if (/T.*(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return Number.isFinite(Date.parse(raw)) ? localDay(Date.parse(raw)) : null;
    return padded;
  };
  if (messages.some(item => (item.sender || item.direction) === 'outgoing' && dayOf(item) === today)) return { status: 'already-sent', reason: '当前会话已读到今天真实发出的消息。' };
  const outgoing = messages.findLastIndex(item => (item.sender || item.direction) === 'outgoing');
  if (messages.slice(outgoing + 1).some(item => (item.sender || item.direction) === 'incoming')) return { status: 'pending-incoming', reason: '对方有待回复消息，优先交给聊天回复。' };
  if (!messages.length && evidence.emptyTodayVerified === true) return { status: 'eligible', reason: '当前最新会话明确显示今天尚无消息。' };
  if (outgoing >= 0) {
    const date = dayOf(messages[outgoing]);
    if (date && date < today) return { status: 'eligible', reason: '已核对最新端，最近发出消息的明确日期早于今天。' };
  }
  return { status: 'date-unknown', reason: '没有足够日期证据判断今天是否发过消息。' };
}

// 只采集会话身份和未读标识，不读取预览或其他会话正文。
export function readContactDom() {
  const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
  const resource = value => { try { return new URL(value, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch { return ''; } };
  const dialog = document.querySelector('[data-e2e="im-dialog"]');
  return [...(dialog?.querySelectorAll('[data-e2e="conversation-item"]') ?? [])].map((row, index) => ({
    index,
    displayName: clean(row.querySelector('.conversationConversationItemtitle,[data-e2e="conversation-name"]')?.textContent),
    nativeId: row.getAttribute('data-conversation-id') || row.getAttribute('data-conversation-short-id') || null,
    avatar: resource(row.querySelector('.commonIMAvataravatarContainer img,img')?.getAttribute('src')),
    unread: Boolean(row.querySelector('[class*="unread"],[class*="Unread"],[data-e2e="unread-count"]')),
    isGroup: Boolean(row.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]')),
    /**
     * [adopter 改动 / 群聊侦察] 群会话的几个候选判据，一次全打出来，用真实数据决定用哪个。
     *
     * 上面的 `isGroup` 是从插件原样抄的，`[class*="GroupAvatar"]` 在抖音里**根本不存在**
     * （真实类名见抖音自己的 CSS，tools/probe-group-classes.mjs 落盘在 logs/group/classes.txt），
     * 所以它恒为 false —— 它挡不住群，只是看起来挡了。
     *
     * 实测（2026-10-23，群「示例群(5)」vs 单聊 your-name）：
     *   单聊头像容器 = commonIMAvataravatarContainer + semi-avatar-img
     *   群聊头像容器 = commonConversationIcon（img 直接挂在里面，没有 semi-avatar）
     *   而 conversationConversationItemheadImageGroup 在这个群上**没出现** ——
     *   它应该是「没设群头像、用成员头像拼图」时才有，不能用它当唯一判据。
     *
     * 这里只**新增**观测字段，不改 isGroup 的含义，私信链路一个字都没动。
     */
    markers: {
      conversationIcon: Boolean(row.querySelector('[class*="commonConversationIcon"]')),
      imAvatar: Boolean(row.querySelector('[class*="commonIMAvatar"]')),
      semiAvatar: Boolean(row.querySelector('[class*="semi-avatar"]')),
      headImageGroup: Boolean(row.querySelector('[class*="headImageGroup"]')),
      groupAvatar: Boolean(row.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]')),
    },
    /** 兼容旧名：先给 isGroupHint 挂上「没有个人头像框架」这个判据，等实测确认后再定。 */
    isGroupHint: Boolean(row.querySelector('[class*="commonConversationIcon"]')) && !row.querySelector('[class*="commonIMAvatar"]'),
  }));
}

export function readChatBlockers() {
  const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const labels = [...document.querySelectorAll('body *')].filter(e => !e.childElementCount && visible(e) && !e.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]'));
  return {
    loginRequired: labels.some(e => /扫码登录|验证码登录|登录后即可|手机扫码登录/.test(e.textContent)),
    verificationRequired: labels.some(e => /请完成下方验证|请完成验证|安全验证|拖动滑块/.test(e.textContent)),
  };
}

export function readConversationDom() {
  const clean = value => (value ?? '').trim();
  const resource = value => { try { return new URL(value, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch { return ''; } };
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
  const dialog = document.querySelector('[data-e2e="im-dialog"]');
  const headers = [...(dialog?.querySelectorAll('.StackLayoutStackChatHeaderuser,[data-e2e="chat-header"]') ?? [])].filter(visible);
  const header = headers.length === 1 ? headers[0] : null;
  const root = header?.closest('.StackLayoutpagespageRoot,[data-e2e="chat-page"]');
  const displayName = clean(header?.querySelector('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]')?.textContent);
  const avatar = resource(header?.querySelector('img')?.getAttribute('src'));
  let timestamp = null;
  const messages = [];
  const nodes = root?.querySelectorAll('.MessageBoxTimetimeLayout,time,[data-e2e="msg-item-content"]') ?? [];
  const list = root?.querySelector('.messageMessageListlist');
  let newestFirst = false, chronologySource = list ? 'message-list-order-unverified' : 'dom-order';
  if (list) {
    const style = getComputedStyle(list);
    let verticallyFlipped = false;
    try { verticallyFlipped = style.transform !== 'none' && new DOMMatrix(style.transform).d < 0; } catch {}
    newestFirst = verticallyFlipped || style.flexDirection === 'column-reverse';
    if (newestFirst) chronologySource = verticallyFlipped ? 'message-list-vertical-transform' : 'message-list-column-reverse';
  }
  for (const node of nodes) {
    if (!node.matches('[data-e2e="msg-item-content"]')) { timestamp = node.getAttribute('datetime') || clean(node.textContent) || timestamp; continue; }
    const box = node.closest('.messageMessageBoxmessageBox,[data-e2e="message-row"]') || node;
    const fromMe = Boolean(node.closest('.MessageBoxContentisFromMe,.messageMessageBoxisFromMe,[data-direction="outgoing"]'));
    const direction = fromMe ? 'outgoing' : box.matches('.messageMessageBoxmessageBox,[data-e2e="message-row"]') ? 'incoming' : 'unknown';
    const textNode = node.querySelector('.MessageItemTextcontainer,[data-e2e="message-text"]');
    const emoji = node.querySelector('.MessageItemEmojiemojiBox');
    const share = node.querySelector('.MessageItemShareAwemecontainer');
    // [adopter 改动] 图片消息（用户发的照片）原来落到 unsupported：没文本节点、不是表情、
    // 不是分享卡片，media 就成了 null，画面被整个丢掉，上报只剩一个「[非文本消息]」。
    // 这里只在「文本/表情/分享」都不成立时才找图片，所以文本气泡里内嵌的小表情、
    // 分享卡上的角标都不会被误判成图片消息。尺寸过滤挡掉装饰性小图。
    const pictures = !textNode && !emoji && !share
      ? [...node.querySelectorAll('img')].filter(image => { const rect = image.getBoundingClientRect(); return rect.width >= 40 && rect.height >= 40; })
      : [];
    const kind = textNode ? 'text' : emoji ? 'emoji' : share ? 'video' : pictures.length ? 'image' : 'unsupported';
    const text = textNode ? clean(textNode.innerText || textNode.textContent) : '';
    let media = null;
    if (emoji) {
      const images = [...emoji.querySelectorAll('img')].map(image => ({ src: image.currentSrc || image.getAttribute('src') || '', label: clean(image.getAttribute('alt') || image.getAttribute('aria-label') || image.getAttribute('title')) || null }));
      const label = clean(emoji.getAttribute('aria-label') || emoji.getAttribute('title')) || images.map(image => image.label).filter(Boolean).join(' ') || null;
      media = { type: 'emoji', label, images, requiresVisual: true, understandingScope: 'single-message-image' };
    }
    if (!media && pictures.length) {
      const images = pictures.map(image => ({ src: image.currentSrc || image.getAttribute('src') || '', label: clean(image.getAttribute('alt') || image.getAttribute('aria-label')) || null }));
      media = { type: 'image', label: null, images, requiresVisual: true, understandingScope: 'single-message-image' };
    }
    if (share) {
      let url = null, videoId = null;
      for (const link of share.querySelectorAll('a[href]')) {
        try { const candidate = new URL(link.getAttribute('href'), location.href); const match = /^\/video\/(\d+)\/?$/.exec(candidate.pathname);
          if (candidate.protocol === 'https:' && /^(?:www\.)?douyin\.com$/.test(candidate.hostname) && match) { videoId = match[1]; url = `https://www.douyin.com/video/${videoId}`; break; }
        } catch {}
      }
      const title = clean(share.querySelector('.MessageItemShareAwemetitle,.MessageItemShareAwemedesc,[data-e2e="shared-video-title"]')?.textContent) || null;
      const author = clean(share.querySelector('.MessageItemShareAwemeauthorName,[data-e2e="shared-video-author"]')?.textContent) || null;
      const cover = share.querySelector('.MessageItemShareAwemeawemeContainer,img:not(.MessageItemShareAwemephotosTag):not(.MessageItemShareAwemeauthorAvatar)');
      // [adopter 改动] 原来这里判 isPhotoGallery: Boolean(share.querySelector('.MessageItemShareAwemephotosTag'))，
      // 是错的。那个 class 元素其实是一张 base64 的小角标 PNG，几乎每张分享卡片都带，
      // 所以它永远为 true —— 实测把一个 3 秒的真视频判成了图文作品。
      // 卡片 DOM 里没有任何可靠的「视频 vs 图文」依据，这里如实标为「未知」，
      // 要看真类型，得点开作品页看有没有可播放的 <video>（tools/probe-work.mjs 就是这么查的）。
      media = { type: 'shared-work', videoId, url, title, author, isPhotoGallery: null,
        images: cover ? [{ src: cover.currentSrc || cover.getAttribute('src') || '', label: clean(cover.getAttribute('alt')) || null }] : [],
        requiresVisual: true, understandingScope: 'card-cover-and-dom-metadata', publicUrlSource: url ? 'dom-link' : null, canResolveByOpeningCard: true };
    }
    const indexNode = node.closest('[data-index]');
    const rawOrder = indexNode?.getAttribute('data-index');
    const order = rawOrder !== null && rawOrder !== undefined && /^\d+$/.test(rawOrder) ? Number(rawOrder) : null;
    const nativeId = box.getAttribute('data-message-id') || box.getAttribute('data-msg-id') || node.getAttribute('data-message-id') || null;
    const ownTimestamp = box.getAttribute('data-sent-at') || box.getAttribute('data-timestamp') || node.getAttribute('data-sent-at');
    const ownTimeNode = box.querySelector('.MessageBoxTimetimeLayout,time');
    const ownTime = ownTimeNode?.getAttribute('datetime') || clean(ownTimeNode?.textContent);
    const dated = ownTimestamp || ownTime || (!newestFirst ? timestamp : null);
    /**
     * [adopter 改动 / 群聊侦察] 发言人昵称 + @ 提及。
     *
     * 群聊里每条消息上方有一条「头像 + 昵称」的标题行，类名来自抖音自己的 CSS：
     *   MessageBoxMessageTitleavatarName      昵称
     *   Theme.../mentionText                 普通 @
     *   mentionTextSelf                      @ 到自己
     * 单聊里这些节点都不存在 → senderName=null、mentions=[]，所以私信链路行为不变。
     *
     * 只在消息盒子内部找昵称，**不往上翻父级**：父级可能是整个消息列表，
     * querySelector 会把隔壁消息的昵称读成本条的（静默认错人比读不到更糟）。
     * 群真的出现后先看 senderName 有没有值，没有再决定要不要精确地往上取。
     */
    const titleNode = box.querySelector('[class*="MessageBoxMessageTitle"]');
    const senderName = titleNode
      ? clean(titleNode.querySelector('[class*="avatarName"]')?.textContent || titleNode.textContent) || null
      : null;
    // 自己发出去的消息里 @ 别人也会算 mentionText，所以「@ 我」必须结合方向判断
    const mentionNodes = [...node.querySelectorAll('[class*="mentionText"]')];
    const mentions = mentionNodes.map(element => ({
      self: /mentionTextSelf/.test(element.getAttribute('class') || ''),
      text: clean(element.textContent),
    }));
    messages.push({ nativeId, direction, sender: direction, text, kind, media, timestamp: ownTimestamp || timestamp, order, domIndex: order, domPosition: messages.length, orderMode: list ? 'relative' : 'absolute',
      senderName, mentions, mentionedMe: direction === 'incoming' && mentions.some(item => item.self),
      dateEvidence: { raw: dated || timestamp || '', kind: dated ? /^今天(?:\s|$)/.test(dated) ? 'today' : /^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(dated) ? 'absolute' : 'unknown' : 'unknown', source: ownTimestamp ? 'message-attribute' : ownTime ? 'message-time' : !newestFirst ? 'group-label' : 'unverified-group-label' },
      failed: Boolean(box.querySelector('[class*="sendFail"],[class*="SendFail"],[data-e2e="message-failed"]')),
      pending: Boolean(box.querySelector('[class*="sending"],[class*="Sending"],[data-e2e="message-pending"]')) });
  }
  const emptyTodayVerified = messages.length === 0 && [...(root?.querySelectorAll('[data-e2e="empty-conversation"],[class*="empty" i]') ?? [])].some(element => visible(element) && /^今天(?:还)?(?:暂无|没有|尚无)消息[。！!\s]*$/.test(clean(element.textContent)));
  const latestEndVerified = emptyTodayVerified || newestFirst && messages.some(message => message.domIndex === 0);
  if (list) messages.forEach(message => { message.latestEndVerified = latestEndVerified; });
  if (newestFirst) {
    messages.reverse();
    let previousTime = null;
    messages.forEach((message, index) => { message.order = index; message.timestamp ??= previousTime; previousTime = message.timestamp; });
  }
  const loading = [...(root?.querySelectorAll('[class*="loading"],[class*="Loading"],[aria-busy="true"]') ?? [])].some(visible);
  const historyStartVerified = [...(root?.querySelectorAll('[data-e2e="history-start"],[class*="no-more-tip"],[class*="noMoreTip"]') ?? [])].some(element => visible(element) && /没有更多消息|暂无更多消息|已显示全部消息/.test(clean(element.textContent)));
  return { displayName, avatar, messages, loading, latestEndVerified, emptyTodayVerified, historyStartVerified, observedAt: new Date().toISOString(), chronology: list && !newestFirst && !emptyTodayVerified ? 'unknown' : 'oldest-first', chronologySource, sourceDomOrder: newestFirst ? 'newest-first' : list ? 'unknown' : 'oldest-first' };
}

export function readChatIdentityDom() {
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
  const headers = [...document.querySelectorAll('[data-e2e="im-dialog"] .StackLayoutStackChatHeaderuser,[data-e2e="im-dialog"] [data-e2e="chat-header"]')].filter(visible);
  const header = headers.length === 1 ? headers[0] : null;
  const src = header?.querySelector('img')?.getAttribute('src');
  let avatar = ''; try { avatar = new URL(src, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch {}
  return { displayName: header?.querySelector('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]')?.textContent.trim(), avatar };
}

/**
 * [adopter 改动 / 群聊] 群会话标题带成员数，列表标题不带。
 *
 * 实测（2026-10-23，群「示例群(5)」）：
 *   conversation-item 的标题       →  "示例群"
 *   会话头部 StackChatHeadertitle  →  "示例群(5)"
 * 原来的 select() 直接用 === 比较这两个，于是群会话永远等不到「名字对上」，
 * 抛 `page.waitForFunction: Timeout 10000ms exceeded`。
 * 换句话说：群打不开**不是**被那句「属于群聊，已停止操作」拦住的（那条恒 false），
 * 而是卡在这道名字核对上。
 *
 * 单聊名字没有成员数后缀，所以剥不剥都一样 —— 单聊的核对一个字都没放宽。
 */
const MEMBER_COUNT_SUFFIX = /[（(]\d+[)）]$/;

export function stripMemberCount(value) {
  return String(value ?? '').replace(MEMBER_COUNT_SUFFIX, '').trim();
}

/**
 * 会话身份是否一致：头像必须完全相等；名字只在群会话上允许「成员数后缀」的差异。
 * 单聊（isGroupHint !== true）仍然严格按原文比较。
 */
function sameName(current, contact) {
  if (!current || !contact) return false;
  if (current.displayName === contact.displayName) return true;
  if (contact.isGroupHint !== true) return false;
  return stripMemberCount(current.displayName) === stripMemberCount(contact.displayName);
}

function sameIdentity(current, contact) {
  if (!current || !contact) return false;
  if (current.avatar !== contact.avatar) return false;
  return sameName(current, contact);
}

export class ChatBrowser {
  constructor({ source = 'api-chat', controller, allowGroups = false } = {}) {
    if (!['api-chat', 'dsh-chat'].includes(source)) throw new TypeError('私信入口须为 api-chat 或 dsh-chat。');
    this.controller = controller ?? new BrowserController({ source });
    this.contacts = new Map();
    this.following = null;
    this.identities = new MessageIdentityTracker();
    this.mediaResources = new Map();
    /** 群会话默认仍然拒绝（等于现在的行为），要开群得显式传 allowGroups: true。 */
    this.allowGroups = allowGroups === true;
  }
  async dialog(page, signal) {
    stop(signal);
    await page.evaluate(() => {
      if (!window.__deepseekChatPauseVideo) {
        window.__deepseekChatPauseVideo = true;
        document.addEventListener('play', event => { if (event.target instanceof HTMLVideoElement) event.target.pause(); }, true);
      }
      for (const video of document.querySelectorAll('video')) video.pause();
    });
    const flags = await page.evaluate(readChatBlockers);
    if (flags.loginRequired || flags.verificationRequired) return { ...flags, blocked: true };
    if (!await page.locator('[data-e2e="im-dialog"]').isVisible().catch(() => false)) {
      const entry = page.locator('[data-e2e="im-entry"]');
      try { await entry.waitFor({ state: 'visible', timeout: 20_000 }); }
      catch { throw new Error('没有找到抖音消息入口。'); }
      await entry.click();
      await page.locator('[data-e2e="im-dialog"]').waitFor({ state: 'visible' });
    }
    stop(signal);
    return { ...flags, blocked: false };
  }
  async verifyFollowing(page, signal) {
    // 本人的关注名单仅在首次发现联系人时核对；后续新增联系人不会进入服务的固定白名单。
    await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    const my = page.locator('a').filter({ has: page.locator('span').filter({ hasText: /^我的$/ }) });
    await my.waitFor({ state: 'visible', timeout: 10_000 });
    const href = await my.getAttribute('href');
    const target = new URL(href, HOME);
    if (target.hostname !== 'www.douyin.com' || !target.pathname.startsWith('/user/')) throw new Error('本人的关注入口不符合当前网页约定。');
    await page.goto(target.href, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-e2e="user-info-follow"]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(800);
    const expectedCount = await page.locator('[data-e2e="user-info-follow"]').evaluate(element => Number(/\d+/.exec(element.textContent)?.[0] ?? 0));
    const first = page.locator('[data-e2e="user-fans-container"] .OlxToPIh').first();
    for (let attempt = 0; attempt < 3 && !await first.isVisible().catch(() => false); attempt += 1) {
      stop(signal);
      await page.locator('[data-e2e="user-info-follow"]').click();
      await first.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    }
    if (!await first.isVisible()) throw new Error('本人的关注列表未就绪，未确认联系人关系。');
    if (expectedCount > 0 && expectedCount <= 20) await page.waitForFunction(count => document.querySelectorAll('[data-e2e="user-fans-container"] .OlxToPIh').length >= count, expectedCount, { timeout: 10_000 });
    stop(signal);
    this.following = await page.evaluate(() => [...document.querySelectorAll('[data-e2e="user-fans-container"] .OlxToPIh')].map(row => ({
      displayName: row.querySelector('.Zce7SWd3 a')?.textContent.trim(),
      mutual: [...row.querySelectorAll('button')].some(button => button.textContent.trim() === '相互关注'),
    })));
    await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    await this.dialog(page, signal);
  }
  async contactList(page, signal) {
    const flags = await this.dialog(page, signal);
    if (flags.blocked) return { ...flags, contacts: [] };
    await page.locator('[data-e2e="im-dialog"] [data-e2e="conversation-item"]').first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
    if (this.following?.length === 2) await page.waitForFunction(() => document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="conversation-item"]').length >= 2, undefined, { timeout: 5000 }).catch(() => {});
    const rows = await page.evaluate(readContactDom);
    const identities = rows.map(row => `conv:${hash(row.nativeId ? `native:${row.nativeId}` : `${row.displayName}\0${row.avatar}`)}`);
    if (new Set(identities).size !== identities.length || rows.some(row => !row.displayName || (!row.nativeId && !row.avatar))) throw new Error('联系人身份不完整或存在歧义，已停止读取会话。');
    const contacts = [];
    this.contacts.clear();
    for (const [index, row] of rows.entries()) {
      const id = identities[index];
      const matching = this.following?.filter(item => item.displayName === row.displayName && item.mutual) ?? [];
      const uniqueName = rows.filter(item => item.displayName === row.displayName).length === 1;
      const followed = matching.length === 1 && uniqueName ? true : null;
      const contact = { id, displayName: row.displayName, name: row.displayName, unread: row.unread, followed, isGroup: row.isGroup ? true : followed ? false : null,
        // [adopter 改动 / 群聊侦察] 观测字段透传（close 里 select 的身份核对要用到同一个来源）
        markers: row.markers ?? null, isGroupHint: row.isGroupHint === true,
        relationshipEvidence: followed ? { source: 'self-follow-list', label: '相互关注', matchedBy: 'unique-display-name', accountIdCrossChecked: false } : null };
      this.contacts.set(id, { ...contact, avatar: row.avatar });
      await page.locator('[data-e2e="conversation-item"]').nth(index).evaluate((element, value) => { element.setAttribute('data-deepseek-chat-id', value); }, id);
      contacts.push(contact);
    }
    return { ...flags, contacts };
  }
  listContacts({ signal, verifyFollowing = this.following === null } = {}) {
    return this.controller.withPage(async page => {
      const initial = await this.dialog(page, signal);
      if (initial.blocked) return { ...initial, contacts: [] };
      if (verifyFollowing) await this.verifyFollowing(page, signal);
      return this.contactList(page, signal);
    }, { signal });
  }
  async select(page, recipientId, signal) {
    if (typeof recipientId !== 'string' || !/^conv:[a-f0-9]{64}$/.test(recipientId)) throw new TypeError('需要已发现的精确联系人 ID。');
    const flags = await this.contactList(page, signal);
    if (flags.blocked) return { flags };
    const contact = this.contacts.get(recipientId);
    // 原来的 `contact.isGroup === true` 恒不成立（isGroup 的判据本身就是坏的），
    // 真正的群拒绝改由 isGroupHint + 显式开关决定；单聊完全不受影响。
    if (!contact || (contact.isGroupHint === true && !this.allowGroups)) throw new Error('指定联系人已变化或属于群聊，已停止操作。');
    const row = page.locator(`[data-e2e="conversation-item"][data-deepseek-chat-id="${recipientId}"]`);
    if (await row.count() !== 1) throw new Error('指定会话不是唯一匹配，已停止操作。');
    const current = await page.evaluate(readChatIdentityDom);
    if (!sameIdentity(current, contact)) {
      const back = page.locator('[data-stack-layer="chat"] .StackLayoutStackTitleBarbackBtn');
      if (current.displayName && await back.count() === 1) {
        await back.click();
        await this.contactList(page, signal);
      }
      try { await row.click(); }
      catch { throw new Error('指定会话未成功打开，未读取正文或点击发送。'); }
      await page.waitForFunction(expected => {
        const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
        const headers = [...document.querySelectorAll('[data-e2e="im-dialog"] .StackLayoutStackChatHeaderuser,[data-e2e="im-dialog"] [data-e2e="chat-header"]')].filter(visible);
        if (headers.length !== 1) return false;
        const header = headers[0];
        const name = header.querySelector('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]')?.textContent.trim();
        let avatar = ''; try { avatar = new URL(header.querySelector('img')?.getAttribute('src'), location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch {}
        // 群会话头部标题带成员数（"示例群(5)"），列表标题不带；单聊严格相等。
        const strip = value => String(value ?? '').replace(/[（(]\d+[)）]$/, '').trim();
        const nameOk = name === expected.displayName
          || (expected.group === true && strip(name) === strip(expected.displayName));
        return nameOk && avatar === expected.avatar;
      }, { displayName: contact.displayName, avatar: contact.avatar, group: contact.isGroupHint === true }, { timeout: 10_000 });
      await page.waitForTimeout(300);
    }
    const identity = await page.evaluate(readChatIdentityDom);
    if (!sameIdentity(identity, contact)) throw new Error('会话标题或头像回读与联系人不一致，已停止操作。');
    stop(signal);
    return { contact, flags };
  }
  async stableConversation(page, contact, signal) {
    let previous;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      stop(signal);
      const current = await page.evaluate(readConversationDom);
      if (!sameIdentity(current, contact)) throw new Error('读取前会话身份发生变化。');
      const signature = JSON.stringify(current.messages);
      if (!current.loading && previous === signature) return current;
      previous = current.loading ? undefined : signature;
      await page.waitForTimeout(150);
    }
    throw new Error('指定会话的消息列表仍在加载或变化，未确认正文快照。');
  }
  publicMessages(recipientId, rawRows) {
    const rows = rawRows.map(row => {
      if (!row.media) return row;
      const { images = [], ...media } = row.media;
      const resources = images.filter(image => image.src).map(image => {
        const ref = `media:${hash(image.src.startsWith('data:') ? image.src : (() => { try { return new URL(image.src).pathname; } catch { return image.src; } })())}`;
        this.mediaResources.set(ref, { src: image.src, label: image.label ?? null, recipientId });
        return { resourceRef: ref, label: image.label ?? null };
      });
      return { ...row, media: { ...media, imageCount: resources.length, resources } };
    });
    const identified = this.identities.identify(recipientId, rows);
    return identified.map(row => row.media?.type === 'shared-work' ? { ...row, media: { ...row.media,
      safeOpenSelector: `[data-deepseek-message-id="${row.id}"] .MessageItemShareAwemecontainer` } } : row);
  }
  async markMessages(page, messages) {
    await page.evaluate(mapping => {
      const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
      const header = [...document.querySelectorAll('[data-e2e="im-dialog"] .StackLayoutStackChatHeaderuser,[data-e2e="im-dialog"] [data-e2e="chat-header"]')].filter(visible);
      const root = header.length === 1 ? header[0].closest('.StackLayoutpagespageRoot,[data-e2e="chat-page"]') : null;
      const nodes = [...(root?.querySelectorAll('[data-e2e="msg-item-content"]') ?? [])];
      if (nodes.length !== mapping.length || new Set(mapping.map(item => item.domPosition)).size !== nodes.length) throw new Error('消息窗口已经改变。');
      for (const item of mapping) {
        if (!Number.isSafeInteger(item.domPosition) || item.domPosition < 0 || item.domPosition >= nodes.length) throw new Error('消息 DOM 位置不可核对。');
        nodes[item.domPosition].setAttribute('data-deepseek-message-id', item.id);
      }
    }, messages.map((message, index) => ({ id: message.id, domPosition: message.domPosition ?? index })));
  }
  readConversation(recipientId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('读取正文需要这个指定联系人的明确授权。'));
    return this.controller.withPage(async page => {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, conversation: null, contact: null, messages: [] };
      const raw = await this.stableConversation(page, contact, signal);
      if (!sameIdentity(raw, contact)) throw new Error('读取前会话身份发生变化。');
      const { avatar, ...publicContact } = contact;
      const messages = this.publicMessages(recipientId, raw.messages);
      await this.markMessages(page, messages);
      return { ...flags, conversation: { id: contact.id, displayName: contact.displayName }, contact: publicContact,
        messages, dayEvidence: { observedAt: raw.observedAt, latestEndVerified: raw.latestEndVerified, chronology: raw.chronology, historyStartVerified: raw.historyStartVerified, emptyTodayVerified: raw.emptyTodayVerified } };
    }, { signal });
  }
  captureMessage(recipientId, messageId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('查看画面需要这个指定联系人的明确授权。'));
    if (typeof messageId !== 'string' || !/^msg:[a-f0-9]{64}$/.test(messageId)) return Promise.reject(new TypeError('需要已读取的精确消息 ID。'));
    return this.controller.withPage(async page => {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, frames: [], imageStatus: '登录或验证画面未采集。' };
      const raw = await this.stableConversation(page, contact, signal);
      const messages = this.publicMessages(recipientId, raw.messages);
      const message = messages.find(item => item.id === messageId);
      if (!message?.media || message.unsupported) throw new Error('该消息没有已识别的表情、图片或分享作品画面。');
      await this.markMessages(page, messages);
      // [adopter 改动] 图片消息没有专属容器 class，画面目标就是内容节点里那张唯一的大图。
      const pictureSelector = message.media?.type === 'image'
        ? 'img'
        : '.MessageItemEmojiemojiBox,.MessageItemShareAwemecontainer';
      const frame = page.locator(`[data-e2e="im-dialog"] [data-deepseek-message-id="${messageId}"]`).locator(pictureSelector);
      if (await frame.count() !== 1) throw new Error('没有唯一的指定消息画面。');
      const current = await page.evaluate(readChatIdentityDom);
      const protectedScreen = await page.evaluate(readChatBlockers);
      if (protectedScreen.loginRequired || protectedScreen.verificationRequired) return { ...protectedScreen, frames: [], imageStatus: '登录或验证画面未采集。' };
      if (!sameIdentity(current, contact)) throw new Error('截取画面前会话身份发生变化。');
      stop(signal);
      const rectangle=await frame.boundingBox();
      const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
      if(!rectangle) throw new Error('指定消息画面目前不可见，未采集。');
      const clip={x:Math.max(0,rectangle.x),y:Math.max(0,rectangle.y),width:Math.min(viewport.width,rectangle.x+rectangle.width)-Math.max(0,rectangle.x),height:Math.min(viewport.height,rectangle.y+rectangle.height)-Math.max(0,rectangle.y)};
      if(clip.width<2||clip.height<2) throw new Error('指定消息不在当前视口内，未采集其他区域。');
      const unobstructed=await frame.evaluate(element=>{const r=element.getBoundingClientRect(),x=Math.max(1,Math.min(innerWidth-1,r.x+r.width/2)),y=Math.max(1,Math.min(innerHeight-1,r.y+r.height/2));return element.contains(document.elementFromPoint(x,y));});
      if(!unobstructed) throw new Error('指定消息被其他界面遮挡，未采集。');
      // 倒转的虚拟列表不能依赖 locator 的自动滚动稳定等待；只截取当前消息的可见矩形。
      const data = await page.screenshot({ type:'jpeg',quality:70,clip,timeout:5000 });
      const afterRectangle=await frame.boundingBox();
      if(!afterRectangle||['x','y','width','height'].some(key=>Math.abs(afterRectangle[key]-rectangle[key])>1)) throw new Error('截图期间指定消息位置改变，画面已丢弃。');
      const afterIdentity=await page.evaluate(readChatIdentityDom);
      const afterProtection=await page.evaluate(readChatBlockers);
      if(afterProtection.loginRequired||afterProtection.verificationRequired) return {...afterProtection,frames:[],imageStatus:'截图期间出现登录或验证，本次画面已丢弃。'};
      if(afterIdentity.displayName!==contact.displayName || afterIdentity.avatar!==contact.avatar) throw new Error('截图期间会话身份发生变化，画面已丢弃。');
      const afterRaw=await this.stableConversation(page,contact,signal);
      const afterMessages=this.publicMessages(recipientId,afterRaw.messages);
      const afterMessage=afterMessages.find(item=>item.id===messageId);
      const mediaIdentity=value=>JSON.stringify([value?.sender,value?.kind,value?.text,value?.media?.type,value?.media?.resources,value?.media?.label,value?.media?.title,value?.media?.videoId]);
      if(!afterMessage || mediaIdentity(afterMessage)!==mediaIdentity(message)) throw new Error('截图期间指定消息发生变化，画面已丢弃。');
      return { ...flags, conversation: { id: recipientId, displayName: contact.displayName }, messageId,
        media: message.media, understandingScope: message.media.understandingScope,
        frames: [{ mimeType: 'image/jpeg', data: data.toString('base64') }], imageStatus: '已采集指定消息的实际画面，尚需支持图像的模型读取。' };
    }, { signal });
  }
  openSharedVideo(recipientId, messageId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('打开分享作品需要这个指定联系人的明确授权。'));
    if (typeof messageId !== 'string' || !/^msg:[a-f0-9]{64}$/.test(messageId)) return Promise.reject(new TypeError('需要已读取的精确消息 ID。'));
    return this.controller.withPage(async page => {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, opened: false };
      const raw = await this.stableConversation(page, contact, signal);
      const messages = this.publicMessages(recipientId, raw.messages);
      const message = messages.find(item => item.id === messageId);
      if (message?.media?.type !== 'shared-work') throw new Error('该消息不是已识别的分享作品卡片。');
      if (message.media.url) return { ...flags, opened: false, videoId: message.media.videoId, url: message.media.url, source: 'dom-link' };
      await this.markMessages(page, messages);
      const card = page.locator(`[data-e2e="im-dialog"] ${message.media.safeOpenSelector}`);
      if (await card.count() !== 1) throw new Error('没有唯一的指定分享卡片。');
      const beforeUrl = new URL(page.url());
      const beforeId = /^\/video\/(\d+)\/?$/.exec(beforeUrl.pathname)?.[1] || beforeUrl.searchParams.get('modal_id') || null;
      const pop = page.waitForEvent('popup', { timeout: 2500 }).catch(() => null);
      stop(signal);
      const parentSource = this.controller.source?.startsWith('dsh') ? 'dsh' : 'api';
      const decision = this.controller.limits().beforeAction(parentSource, 'douyin_open_video');
      if (!decision.allowed) throw new Error(decision.reason || '当前时间不允许打开分享作品。');
      let popup, target = page;
      try {
        await card.click();
        popup = await pop;
        target = popup ?? page;
        if (popup) await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await target.waitForFunction(({ beforeId, newPopup }) => {
          const observed = new URL(location.href);
          const id = /^\/video\/(\d+)\/?$/.exec(observed.pathname)?.[1] || observed.searchParams.get('modal_id');
          return /^\d+$/.test(id || '') && (newPopup || id !== beforeId);
        }, { beforeId, newPopup: Boolean(popup) }, { timeout: 5000 }).catch(() => {});
        const observed = new URL(target.url());
        const id = /^\/video\/(\d+)\/?$/.exec(observed.pathname)?.[1] || observed.searchParams.get('modal_id');
        if (observed.protocol !== 'https:' || !/^(?:www\.)?douyin\.com$/.test(observed.hostname) || !/^\d+$/.test(id || '')) return { ...flags, opened: true, videoId: null, url: null, reason: '实际打开页面没有可核实的公开作品 ID。' };
        if (!popup && id === beforeId) return { ...flags, opened: true, videoId: null, url: null, reason: '点击后没有核实新的作品页面，未采用原详情页的作品 ID。' };
        return { ...flags, opened: true, videoId: id, url: `https://www.douyin.com/video/${id}`, source: 'actual-opened-page-url', isPhotoGallery: message.media.isPhotoGallery };
      } finally {
        if (!popup) { popup = await pop; if (popup) target = popup; }
        await target.evaluate(() => { for (const video of document.querySelectorAll('video')) video.pause(); }).catch(() => {});
        if (popup) await popup.close().catch(() => {});
      }
    }, { signal });
  }
  sendMessage(recipientId, message, { allowed = false, expectedMessageIds, expectedMessageContent, signal: parentSignal, authorize } = {}) {
    if (allowed !== true) return Promise.reject(new Error('发送需要这个指定联系人的明确授权。'));
    if (typeof message !== 'string' || !message.trim() || [...message].length > 1000) return Promise.reject(new TypeError('发送内容须为 1 到 1000 字的非空文字。'));
    if (authorize !== undefined && (typeof authorize !== 'function' || typeof authorize.beginDispatch !== 'function')) return Promise.reject(new TypeError('主动问候需要本机许可检查和最终短输入控制。'));
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    const authorized = async phase => { stop(signal); if (authorize && await authorize({ phase, recipientId }) !== true) throw new Error('主动问候许可已撤回，未继续发送。'); stop(signal); };
    return this.controller.withPage(async page => {
      await authorized('prepare');
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, confirmed: false, deliveryUncertain: false };
      const before = await page.evaluate(readConversationDom);
      const initialMessages = this.publicMessages(recipientId, before.messages);
      const expected = expectedMessageIds ?? initialMessages.map(item => item.id);
      const contentOf = messages => messages.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }));
      const expectedContent = expectedMessageContent ?? contentOf(initialMessages);
      if (!Array.isArray(expected) || expected.some(id => typeof id !== 'string') || initialMessages.some(item => item.direction === 'unknown') || JSON.stringify(initialMessages.map(item => item.id)) !== JSON.stringify(expected)
        || !Array.isArray(expectedContent) || expectedContent.some(item => !item || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint ?? '')) || JSON.stringify(contentOf(initialMessages)) !== JSON.stringify(expectedContent)) return { confirmed: false, deliveryUncertain: false, reason: '私信水位或内容已变化，未填写或发送回复。' };
      const receipt = { conversation: { id: contact.id, displayName: contact.displayName }, contact: { id: contact.id, name: contact.displayName } };
      const editor = page.locator('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]');
      if (await editor.count() !== 1) throw new Error('没有唯一的私信文字输入框。');
      // [adopter 改动 / 草稿残留] 先保护人打的草稿：看得见内容就不发，原样留着。
      // 只认「看得见的」是有意的 —— 看不见却压在 model 里的，是上一轮失败留下的垃圾，
      // 归下面那次硬清处理；而人手动敲字一定是可见的，所以不会误删。
      const existingDraft = await readEditor(editor);
      if (existingDraft.rendered || existingDraft.raw || await editor.locator('img,video,audio,[data-slate-void="true"]').count()) throw new Error('当前会话已有草稿，已停止发送以保留原内容。');
      // 硬清一次。DOM 看着空不代表编辑器空（见 readEditor / clearEditor 的注释）。
      // 不清掉的话，fill 会把上一轮的残留一起渲染出来 → 回读 ≠ 期望 → 不点发送 →
      // 再留一段，这就是「失败一次就多攒一段」的自累积。
      const leftover = await clearEditor(page, editor);
      if (leftover) throw new Error(`发送前清理输入框失败：清完仍读到「${leftover.slice(0, 60)}」，未填写、未发送。`);
      let clicked = false, monitoring = false, monitor, polling, releaseDispatch, clearProblem = '';
      const witnessId = `chat-${hash(`${recipientId}:${Date.now()}:${Math.random()}`)}`;
      try {
        // [adopter 改动 / 诊断] 这一格原来记的是「fill 之前 DOM 里有多少字」。可 DOM 读 0
        // 也可能是编辑器的 model 里压着残留（就是这个 bug），那个数字区分不出东西。
        // 现在它记的是「硬清之后的读回」：正常恒为 0，非 0 就说明清不干净。
        const beforeFillText = (await readEditor(editor)).rendered;
        await editor.fill(message);
        stop(signal);
        const ready = await page.evaluate(readConversationDom);
        // [adopter 改动 / P2] 用归一化比对代替字面比对，见 normalizeForCompare 的注释
        // [adopter 改动 / 诊断] 原来「身份变了」和「文字被编辑器改写」合成同一句话，
        // 日志里只有一句「回读不一致」，完全看不出是哪一种。分开报，并把差异片段带出来。
        const identityProblem = !sameIdentity(ready, contact);
        const readbackText = normalizeForCompare(await editor.innerText());
        const expectedText = normalizeForCompare(message);
        if (identityProblem || readbackText !== expectedText) {
          const detail = identityProblem
            ? `会话身份/头像回读与联系人不一致（回读「${ready.displayName ?? '?'}」）`
            : `文字回读不一致（填写前 ${beforeFillText.length} 字／期望 ${expectedText.length} 字／回读 ${readbackText.length} 字）填写前「${beforeFillText.slice(0, 40)}」期望「${expectedText.slice(0, 55)}」回读「${readbackText.slice(0, 55)}」`;
          throw new Error(detail);
        }
        const readyMessages = this.publicMessages(recipientId, ready.messages);
        if (readyMessages.some(item => item.direction === 'unknown') || JSON.stringify(readyMessages.map(item => item.id)) !== JSON.stringify(expected) || JSON.stringify(contentOf(readyMessages)) !== JSON.stringify(expectedContent)) throw new Error('填写回复期间私信水位或内容发生变化，未点击发送。');
        const escaped = contact.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // [adopter 改动 / 群聊] 群会话的头部标题带成员数（列表是「示例群」，头部是「示例群(5)」），
        // 而这里原来拿列表名拼了个 `^示例群$` —— 匹配不到，targetPage 为 0，
        // 于是报「没有唯一的指定会话发送按钮」（实测 2026-10-23，日志 15:00:12）。
        // 群会话放宽成「可选成员数后缀」，单聊仍然是严格的 `^名字$`。
        const titlePattern = contact.isGroupHint === true
          ? new RegExp(`^${escaped}(?:[（(]\\d+[)）])?$`)
          : new RegExp(`^${escaped}$`);
        const targetPage = page.locator('.StackLayoutpagespageRoot,[data-e2e="chat-page"]').filter({ has: page.locator('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]').filter({ hasText: titlePattern }) });
        const send = targetPage.locator('.e2e-send-msg-btn,[data-e2e="send-msg-btn"]');
        if (await send.count() !== 1) throw new Error('没有唯一的指定会话发送按钮。');
        await send.evaluate((button, token) => {
          const entries = window.__deepseekChatInputs ??= Object.create(null), entry = { dispatched: false };
          const witness = event => { if (event.isTrusted && (event.target === button || button.contains(event.target))) entry.dispatched = true; };
          document.addEventListener('click', witness, true);
          entry.cleanup = () => document.removeEventListener('click', witness, true); entries[token] = entry;
        }, witnessId);
        const inputDispatched = () => page.evaluate(token => window.__deepseekChatInputs?.[token]?.dispatched === true, witnessId);
        const checkPendingInput = async () => {
          if (clicked && await inputDispatched()) return;
          await authorized('monitor');
          // [adopter 改动] 发送成功后抖音会立刻清空输入框，40ms 一次的监控会把它误判成
          // 「等待期间草稿发生变化」并中途 abort 掉整个流程。草稿变空不算异常（很可能就是
          // 刚发出去），只有被换成别的文字才拦。
          const pendingDraft = readableDraft(await editor.innerText());
          // [adopter 改动 / P2] 同一处问题的第二处：监控也要用归一化比对，
          // 否则刚填完就因为 Markdown 被改写而判定「草稿变了」。
          if (await editor.count() !== 1 || await send.count() !== 1 || (pendingDraft !== '' && normalizeForCompare(pendingDraft) !== normalizeForCompare(message))) throw new Error('等待期间发送按钮或草稿发生变化，未发送。');
          const current = await page.evaluate(readConversationDom), blockers = await page.evaluate(readChatBlockers);
          if (blockers.loginRequired || blockers.verificationRequired || !sameIdentity(current, contact)) throw new Error('等待期间会话身份或页面许可发生变化，未发送。');
          const messages = this.publicMessages(recipientId, current.messages);
          if (messages.some(item => item.direction === 'unknown') || JSON.stringify(messages.map(item => item.id)) !== JSON.stringify(expected) || JSON.stringify(contentOf(messages)) !== JSON.stringify(expectedContent)) throw new Error('等待期间收到新消息或消息内容变化，未发送。');
          stop(signal);
        };
        monitoring = true;
        monitor = setInterval(() => { if (polling || !monitoring) return; polling = checkPendingInput().catch(async error => { if (monitoring && !await inputDispatched().catch(() => false)) interrupt.abort(error); }).finally(() => { polling = null; }); }, 40);
        await checkPendingInput();
        await send.click({ trial: true, timeout: 3000 });
        stop(signal); await checkPendingInput(); await authorized('before-click');
        if (await inputDispatched()) throw new Error('等待期间已发生发送输入，未再点击一次。');
        if (authorize) { releaseDispatch = await authorize.beginDispatch(); if (typeof releaseDispatch !== 'function') throw new Error('最终输入控制没有返回可释放的许可。'); }
        stop(signal); clicked = true;
        // [adopter 改动 / 群聊] 群会话是每轮轮询被切走再切回的：刚打开时浮层有滑入动画、
        // 消息列表还在滚到底部，发送按钮在几百毫秒内「位置不稳定」，Playwright 的
        // 350ms 稳定性窗口刚好卡在这（实测 2026-10-23：trial 通过、真点超时、
        // 文字留在输入框里变成草稿，把通道堵死）。
        // [2026-10-24 用户拍板] 单聊也统一放宽到 3000ms：单聊同样偶发这个超时
        // （改前就有，04:04 / 15:03 / 16:14 / 16:16 各有记录），而失败一次会留草稿、
        // 把后续发送一起堵死，代价远大于多等一会儿。
        if (contact.isGroupHint === true) await page.waitForTimeout(500);
        await send.click({ timeout: 3000, noWaitAfter: true });
        releaseDispatch?.(); releaseDispatch = null;
        // [adopter 改动] 先停监控再核对回执：点击之后输入框被清空是正常的，不该在这里判死。
        monitoring = false; clearInterval(monitor);
        // [adopter 改动] CDP 派发的 click 有时收不到页面监听器的回执（React 重渲染会让事先
        // 绑定的按钮引用失联），原实现直接抛错，结果就是「消息其实发出去了却报失败」。
        // 真正的证据是下面的界面回读，所以这里只记录，不中断。
        const dispatched = await inputDispatched().catch(() => false);
        if (!dispatched) this.lastDispatchUnwitnessed = true;
        stop(signal);
        const beforeIds = new Set(expected);
        // [adopter 改动 / 多行误判] 最后这道确认原来用严格相等比文本，可编辑器会把段间
        // 空行吞掉（实测 group6：填「第一段\n\n第二段」，读回「第一段\n第二段」）。
        // 于是含空行的回复**明明发出去了却报「未取得界面回读」** —— 2026-10-23
        // 05:03:03 和 05:04:10 两次都是这么误报的，那两条其实一直躺在窗口里。
        // 前面「填写后回读」用的是 normalizeForCompare，这里也用同一套，两道闸标准一致。
        const sentText = normalizeForCompare(message);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const after = await page.evaluate(readConversationDom);
          if (!sameIdentity(after, contact)) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '发送后会话发生变化，未再次发送。' };
          const messages = this.identities.identify(recipientId, after.messages);
          const sent = messages.find(item => item.direction === 'outgoing' && !beforeIds.has(item.id) && normalizeForCompare(item.text ?? '') === sentText);
          if (sent && !sent.failed && !sent.pending) return { ...receipt, confirmed: true, messageId: sent.id, deliveryUncertain: false };
          if (sent?.failed) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '网页显示发送失败，未自动重试。' };
          stop(signal);
          await page.waitForTimeout(200);
        }
        return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '未取得新发出消息的界面回读，未自动重试。' };
      } catch (error) {
        // [adopter 改动 / P3] 原实现只在「输入框内容完全等于我填的原文」时才清理。
        // 可 Slate 会改写富文本，那个条件永远不成立 —— 于是它既没保护任何东西，
        // 又把自己写进去的垃圾留在输入框；L444 的「当前会话已有草稿」随即让下一次发送
        // 直接失败，一次失败就卡死整条通道（这次联调就是这么卡住的）。
        //
        // 改成按「快照恢复」的思路：进到这里时输入框本来是空的（L444 已检查过），
        // 所以只要还没点发送，里面剩的东西就该清掉。但先确认它确实像我填的，
        // 免得把用户在这几百毫秒里手动敲的字也抹掉。
        if (!clicked) {
          // [adopter 改动 / P3 修正 —— 这是本 bug 的正主]
          // 原来用 `element.textContent = ''` 清，只删 DOM 节点、清不掉编辑器的 model。
          // 于是它既没保护任何东西，又留下自己造成的垃圾：下一次 fill 会把旧文本
          // 一起渲染出来，回读永远对不上 —— 一次失败就自累积一次。
          // 现在走和发送前同一套硬清（Ctrl+A → Delete），清不掉只记录，不遮蔽真正的错误。
          const left = await clearEditor(page, editor).catch((error) => `清理本身失败：${error instanceof Error ? error.message : String(error)}`);
          if (left) clearProblem = String(left).slice(0, 60);
        }
        // [adopter 改动] 原来这里吞掉了具体错误，只留一句「结果不确定」，没法诊断。
        const detail = error instanceof Error ? error.message : String(error);
        const tail = clearProblem ? `；清理输入框未成功（${clearProblem}），下一次可能仍被残留挡住` : '';
        return { ...receipt, confirmed: false, deliveryUncertain: clicked, reason: clicked ? `发送动作已尝试但结果不确定（${detail}），未自动重试。` : `发送前检查未通过，未点击发送：${detail}${tail}` };
      } finally {
        monitoring = false; clearInterval(monitor); releaseDispatch?.();
        await page.evaluate(token => { const entry = window.__deepseekChatInputs?.[token]; entry?.cleanup(); if (window.__deepseekChatInputs) delete window.__deepseekChatInputs[token]; }, witnessId).catch(() => {});
      }
    }, { signal });
  }
  /**
   * 打开表情面板并切到「带名字的那一栏」，返回 { panel }。
   * **调用方负责关面板**（见 sendEmoji/listEmojis 的 finally）。
   *
   * 为什么要"切"：面板会记住上次停留的 tab（实测停在无名字的表情包栏），
   * 所以不能假设打开就是内置表情那一栏；按名字发之前必须先探测到有名字的那栏。
   */
  async openNamedEmojiPanel(page, signal) {
    stop(signal);
    await page.locator('svg.messageMsgInputiconAction').first().click({ timeout: 8000 });
    await page.locator(EMOJI_PANEL).first().waitFor({ state: 'visible', timeout: 8000 });
    const readPanel = () => page.evaluate(readEmojiPanelDom);
    const named = panel => Boolean(panel?.items?.length) && panel.items.every(item => item.name);
    let panel = await readPanel();
    if (!named(panel)) {
      for (let attempt = 0; attempt < (panel?.tabs?.length ?? 0) && !named(panel); attempt += 1) {
        stop(signal);
        await page.locator(EMOJI_TAB).nth(attempt).click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(450);
        panel = await readPanel();
      }
    }
    if (!panel?.items?.length) throw new Error('表情面板里没有读到任何表情。');
    if (!named(panel)) throw new Error(`表情面板里的 ${panel.items.length} 项都没有名字（可能是纯表情包分类），无法按名字指定，未发送。`);
    return panel;
  }

  /** 关掉表情面板。不能点笑脸图标（semi-modal 遮罩会拦住它，实测点不动），只能点面板外的消息区。 */
  async closeEmojiPanel(page) {
    const isOpen = () => page.evaluate(() => { const panel = document.querySelector('.componentsemojiemojiPanel'); return Boolean(panel) && getComputedStyle(panel).display !== 'none'; });
    let open = await isOpen().catch(() => false);
    for (let attempt = 0; attempt < 6 && open; attempt += 1) {
      const box = await page.locator('.messageMessageListlist, [data-e2e="msg-item-content"]').first().boundingBox().catch(() => null);
      await page.mouse.click(box ? Math.round(box.x + Math.min(30, box.width / 2)) : 1080, box ? Math.round(box.y + Math.min(20, box.height / 2)) : 300).catch(() => {});
      await page.waitForTimeout(300);
      open = await isOpen().catch(() => false);
    }
    return !open;
  }

  /** 列出当前可发的内置表情（面板里带名字的那一栏）。只读，不改任何消息。 */
  listEmojis({ signal } = {}) {
    return this.controller.withPage(async page => {
      const flags = await this.dialog(page, signal);
      if (flags.blocked) return { ...flags, emojis: [] };
      try {
        const panel = await this.openNamedEmojiPanel(page, signal);
        return { emojis: panel.items.map(item => ({ index: item.index, name: item.name })) };
      } finally {
        await this.closeEmojiPanel(page).catch(() => {});
      }
    }, { signal });
  }

  /**
   * 发表情：点笑脸打开面板 → 切到「带名字的那一栏」→ 按名字（或序号）点一项 → 直接发出去。
   *
   * 为什么必须有名字：气泡里**没有** alt/aria-label/title，发出去之后名字就没了，
   * 所以「发哪个表情」这件事只能在**面板里**按名字指定；发完只能用「新增了一条
   * outgoing 的 emoji 气泡」来确认，无法再从气泡反查是哪一个。
   *
   * @param {string} recipientId 已发现的 conv ID
   * @param {{ name?: string, index?: number }} options name=中文名（续火花/比心/…），index=内置表情里第几个（0 起）
   */
  sendEmoji(recipientId, options = {}, { allowed = false, signal: parentSignal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('发表情需要这个指定联系人的明确授权。'));
    const wantedName = typeof options?.name === 'string' ? readableDraft(options.name) : '';
    const wantedIndex = Number.isSafeInteger(options?.index) ? options.index : null;
    if (!wantedName && wantedIndex === null) return Promise.reject(new TypeError('发表情要指定 name（表情名）或 index（内置表情里第几个，从 0 起）。'));
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    return this.controller.withPage(async page => {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, confirmed: false, deliveryUncertain: false };
      const receipt = { conversation: { id: contact.id, displayName: contact.displayName }, contact: { id: contact.id, name: contact.displayName } };
      const editor = page.locator('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]');
      if (await editor.count() !== 1) throw new Error('没有唯一的私信文字输入框。');
      // 人打的草稿优先 —— 和 sendMessage 同一条规矩，绝不动别人正在写的东西
      const draft = await readEditor(editor);
      if (draft.rendered || draft.raw || await editor.locator('img,video,audio,[data-slate-void="true"]').count()) throw new Error('当前会话已有草稿，已停止发表情以保留原内容。');
      if (await page.evaluate(readFileConfirmDom)) throw new Error('页面上有未确认的发送弹窗，已停止发表情。');
      const before = await page.evaluate(readConversationDom);
      const beforeIds = new Set(this.publicMessages(recipientId, before.messages).map(item => item.id));
      let clicked = false;
      try {
        const panel = await this.openNamedEmojiPanel(page, signal);
        const available = panel.items.map(item => item.name);
        const target = wantedName ? panel.items.find(item => item.name === wantedName) : panel.items.find(item => item.index === wantedIndex);
        if (!target) throw new Error(`面板里没有${wantedName ? `叫「${wantedName}」的表情` : `第 ${wantedIndex} 个表情`}。当前可用：${available.join('、')}`);
        stop(signal);
        // 点一项 = 直接发出（不需要再按发送），面板随后自己关掉
        clicked = true;
        await page.locator(EMOJI_ITEM).nth(target.index).click({ timeout: 8000 });
        for (let attempt = 0; attempt < 25; attempt += 1) {
          const after = await page.evaluate(readConversationDom);
          if (!sameName(after, contact)) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '发送后会话发生变化，未再次发送。' };
          const messages = this.publicMessages(recipientId, after.messages);
          const sent = messages.find(item => item.direction === 'outgoing' && item.kind === 'emoji' && !beforeIds.has(item.id));
          if (sent) return { ...receipt, confirmed: true, messageId: sent.id, emoji: target.name, deliveryUncertain: false };
          if (sent?.failed) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '网页显示发送失败，未自动重试。' };
          stop(signal);
          await page.waitForTimeout(200);
        }
        return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '未取得表情发送的界面回读（表情可能已发出），未自动重试。' };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ...receipt, confirmed: false, deliveryUncertain: clicked, reason: clicked ? `点击表情后结果不确定（${detail}），未自动重试。` : `未点击任何表情：${detail}` };
      } finally {
        // 关面板：关不掉也不算失败（它只是浮层），但会挡住点击，所以尽量关。
        await this.closeEmojiPanel(page).catch(() => {});
      }
    }, { signal });
  }

  /**
   * 发本地图片（可选带一句附带文字）。
   *
   * 三步，缺一不可：点上传图标 → filechooser 塞文件 → **在确认弹窗里点「发送」**。
   * 「选完文件」只是待确认状态，不点发送就什么都不会出去（这是实测的第二个坑）。
   *
   * 附带文字会作为**独立的一条 text 消息**发出去（不是图片的 caption），
   * 所以一次成功的「图 + 文字」会在消息列表里新增两条气泡。
   *
   * @param {string} recipientId 已发现的 conv ID
   * @param {{ path: string, caption?: string }} options path=本地绝对路径（jpg/jpeg/png/gif/mp4）
   */
  sendImage(recipientId, options = {}, { allowed = false, signal: parentSignal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('发图片需要这个指定联系人的明确授权。'));
    const rawPath = typeof options?.path === 'string' ? options.path.trim() : '';
    if (!rawPath) return Promise.reject(new TypeError('发图片需要 path（本地文件绝对路径）。'));
    if (!isAbsolute(rawPath)) return Promise.reject(new TypeError('图片路径必须是绝对路径。'));
    const extension = extname(rawPath).toLowerCase();
    if (!UPLOAD_EXTENSIONS.has(extension)) return Promise.reject(new TypeError(`只支持 ${[...UPLOAD_EXTENSIONS].join(' / ')} 这些格式。`));
    let info;
    try { info = statSync(rawPath); } catch { return Promise.reject(new Error(`图片读不到：${rawPath}`)); }
    if (!info.isFile()) return Promise.reject(new Error(`不是一个文件：${rawPath}`));
    if (info.size <= 0) return Promise.reject(new Error('图片是空文件。'));
    if (info.size > UPLOAD_MAX_BYTES) return Promise.reject(new Error(`图片太大（${Math.round(info.size / 1048576)}MB），上限 ${UPLOAD_MAX_BYTES / 1048576}MB。`));
    const caption = typeof options?.caption === 'string' ? readableDraft(options.caption) : '';
    if ([...caption].length > 500) return Promise.reject(new TypeError('附带文字最多 500 字。'));
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    return this.controller.withPage(async page => {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, confirmed: false, deliveryUncertain: false };
      const receipt = { conversation: { id: contact.id, displayName: contact.displayName }, contact: { id: contact.id, name: contact.displayName } };
      const editor = page.locator('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]');
      if (await editor.count() !== 1) throw new Error('没有唯一的私信文字输入框。');
      const draft = await readEditor(editor);
      if (draft.rendered || draft.raw || await editor.locator('img,video,audio,[data-slate-void="true"]').count()) throw new Error('当前会话已有草稿，已停止发图片以保留原内容。');
      if (await page.evaluate(readFileConfirmDom)) throw new Error('页面上已经有一个未确认的发送弹窗，先把它处理掉再发。');
      // 关面板动画期间会有 .semi-modal-wrap 残留，它会把对上传图标的点击吞掉（实测卡 5 秒超时）
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const wraps = await page.evaluate(() => document.querySelectorAll('.semi-modal-wrap').length);
        if (wraps === 0) break;
        await page.waitForTimeout(200);
      }
      const before = await page.evaluate(readConversationDom);
      const beforeIds = new Set(this.publicMessages(recipientId, before.messages).map(item => item.id));
      let sureClicked = false;
      try {
        stop(signal);
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 15000 }),
          page.locator('[data-e2e="im-dialog"] div.semi-upload-add').first().click({ timeout: 8000 }),
        ]);
        await chooser.setFiles(rawPath);
        // 等确认弹窗（上传/预处理好才出现，大图会久一点）
        await page.locator(FILE_MODAL_SURE).first().waitFor({ state: 'visible', timeout: 25_000 });
        stop(signal);
        const modal = await page.evaluate(readFileConfirmDom);
        // 收件人校验：弹窗上明写着「发送给 X」，对不上就不发（防止发错人）
        if (!modal?.receiver || !modal.receiver.includes(contact.displayName)) {
          await page.locator(FILE_MODAL_CANCEL).first().click({ timeout: 4000 }).catch(() => {});
          throw new Error(`确认弹窗上的收件人（「${modal?.receiver ?? '空'}」）与会话（「${contact.displayName}」）不一致，已取消未发送。`);
        }
        if (caption && modal.hasTextarea) {
          const textarea = page.locator('.semi-modal-wrap textarea').first();
          await textarea.click({ timeout: 5000 });
          await textarea.fill(caption);
          stop(signal);
          const readback = readableDraft(await textarea.inputValue().catch(() => ''));
          if (readback !== caption) throw new Error(`附带文字回读不一致（期望 ${[...caption].length} 字，读回 ${[...readback].length} 字），未发送。`);
        }
        stop(signal);
        sureClicked = true;
        await page.locator(FILE_MODAL_SURE).first().click({ timeout: 8000 });
        let textMessageId = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const after = await page.evaluate(readConversationDom);
          if (!sameName(after, contact)) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '发送后会话发生变化，未再次发送。' };
          const messages = this.publicMessages(recipientId, after.messages);
          const fresh = messages.filter(item => item.direction === 'outgoing' && !beforeIds.has(item.id));
          const image = fresh.find(item => item.kind === 'image');
          const text = fresh.find(item => item.kind === 'text');
          if (image) {
            textMessageId = text?.id ?? null;
            return { ...receipt, confirmed: true, messageId: image.id, image: { path: rawPath, messageId: image.id }, caption: caption || null, captionMessageId: textMessageId, deliveryUncertain: false };
          }
          if (image?.failed) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '网页显示发送失败，未自动重试。' };
          stop(signal);
          await page.waitForTimeout(250);
        }
        return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '已在确认弹窗点击发送，但未取得图片消息的界面回读，未自动重试。' };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // 没点发送就失败了 → 把待确认弹窗取消掉，否则它会一直挡着后续所有操作
        if (!sureClicked) await page.locator(FILE_MODAL_CANCEL).first().click({ timeout: 3000 }).catch(() => {});
        return { ...receipt, confirmed: false, deliveryUncertain: sureClicked, reason: sureClicked ? `点击发送后结果不确定（${detail}），未自动重试。` : `发送前检查未通过，未点击发送：${detail}` };
      }
    }, { signal });
  }

  async close() { await this.controller.close(); }
}
