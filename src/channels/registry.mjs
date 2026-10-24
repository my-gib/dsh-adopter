// 通道契约（Channel Contract）—— 一个网页社交平台在本机的接入适配器。
//
// 为什么要这层：抖音、B站 的「读私信 / 回消息 / 解析好友分享的作品」是同一件事，
// 只是 DOM 不同。框架（adopter.mjs）只认契约，不认平台；加一个新平台 = 在
// src/channels/ 下加一个文件，主进程一行都不用改。
//
// ────────────────────────────────────────────────────────────────
// 必需实现
//   id                 string  通道名，必须和 dsh-notifier 的 inbound.<id> 一致
//   label              string  给人看的名字
//   poll({signal})            读一次最新状态，返回：
//       {
//         channel,                        // = id
//         conversation: { id, displayName } | null,
//         messages: [{ id, direction: 'incoming'|'outgoing'|'unknown',
//                      text, media?, share? }],
//         flags: { blocked?, loginRequired?, verificationRequired? }
//       }
//     去重不归通道管：框架自己按 message.id 建水位。
//   send({conversationId, text, emoji?, image?, caption?, signal})
//     返回 { ok: true, confirmed: true, messageId } 表示「界面回读确认已发出」；
//     没拿到确认就 throw，别返回 ok:true。
//     三种形态互斥，优先级 emoji → image → text（都不给 = 纯文本，向后兼容）：
//       emoji   平台内置表情。字符串 = 名字，数字 = 序号，或 { name } / { index }。
//               平台没有「名字」这种标识的（比如只有一堆无名贴纸）就用序号，
//               但要在通道文档里写清楚序号不稳定。
//       image   **本机绝对路径** + 可选 caption（附带文字）。是否支持取决于平台，
//               不支持的通道明确报错，别静默降级成发一条路径文字。
//               注意有些平台会把 caption 拆成独立的一条文字消息（抖音就是），
//               这时返回值里要分别给出 messageId / captionMessageId。
//   status()                  自检，返回 { ok, loggedIn, blocked?, reason? }
//
// 可选实现（有就更好用，没有框架会跳过）
//   contacts({signal})        列联系人 [{ id, displayName }]
//   read({conversationId, signal})   原始快照，给调试/命令行用
//   emojis({signal})          列出当前能发的内置表情 [{ index, name }]（只读、不发消息）。
//                             **发送方不要写死表情名单**，先问这个 —— 平台改版时名单会变。
//   observe({conversationId, messageId, signal})
//     按需补取一条消息的画面（表情包 / 图片 / 卡片封面）
//   openShare({conversationId, messageId, signal})
//     把好友分享的作品真正打开，返回 { url, videoId, source }
//   close()                   释放浏览器连接
//
// 关于 share：通道如果能从消息里认出「好友分享的作品」，就挂到 message.share 上：
//   { kind: 'video'|'note', videoId, url, title, author, cover }
// 框架据此把它当成内容入口（这正是「刷」的来源之一，而不是只有推荐流）。
// ────────────────────────────────────────────────────────────────

const REQUIRED = ['id', 'label', 'poll', 'send', 'status'];
const OPTIONAL = ['contacts', 'read', 'emojis', 'observe', 'openShare', 'close'];

/** 校验一个通道对象是否符合契约，返回不可用原因，没问题返回 null。 */
export function validateChannel(channel) {
  if (!channel || typeof channel !== 'object') return '通道不是对象';
  for (const name of REQUIRED) {
    if (name === 'poll' || name === 'send' || name === 'status') {
      if (typeof channel[name] !== 'function') return `缺少必需方法 ${name}()`;
    } else if (typeof channel[name] !== 'string' || !channel[name].trim()) {
      return `缺少必需字段 ${name}`;
    }
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(channel.id)) return `通道 id「${channel.id}」必须是小写字母开头`;
  for (const name of OPTIONAL) {
    if (channel[name] !== undefined && typeof channel[name] !== 'function') return `${name} 存在但不是函数`;
  }
  return null;
}

/**
 * 按名字加载通道实现并创建它。
 * @param {string} name            src/channels/<name>.mjs
 * @param {object} options         透传给通道工厂
 */
export async function loadChannel(name, options = {}) {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`通道名「${name}」不合法`);
  let module;
  try {
    module = await import(`./${name}.mjs`);
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(`没有名为「${name}」的通道。可用通道见 src/channels/ 目录。`);
    }
    throw error;
  }

  // 同时接受 `export default function createChannel(opts)` 和 `export function createChannel(opts)`
  const factory = module.createChannel ?? module.default;
  if (typeof factory !== 'function') {
    throw new Error(`通道「${name}」必须导出 createChannel(options) 或默认导出工厂函数。`);
  }
  const channel = await factory(options);
  const problem = validateChannel(channel);
  if (problem) throw new Error(`通道「${name}」不符合契约：${problem}`);
  return channel;
}

/** 列出 src/channels/ 下所有可用通道名（不含 registry 自身）。 */
export async function listChannelNames() {
  const { readdir } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const files = await readdir(here);
  return files
    .filter((file) => file.endsWith('.mjs') && file !== 'registry.mjs')
    .map((file) => file.slice(0, -4));
}
