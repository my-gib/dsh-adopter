// 媒体画面落盘：把私信里表情包 / 图片 / 分享卡封面的**原始资源**下载到本地文件。
//
// 为什么不截图（插件原件的 captureMessage 是截图）：
//   1. 截图要求那条消息**当时**在视口里、没被遮挡，而私信列表是约 11 条的滑动窗口，
//      消息一被挤出去就再也截不到（实测 captureMessage 会抛「指定消息不在当前视口内」）。
//   2. 表情包在页面里是 110x110 的缩略显示，而 CDN 上有 280x280 的原图（实测 png 121KB）。
//      下载原图比截图更清楚，也不依赖滚动位置。
//   3. 截图要重读整个会话做身份/内容前后核对（stableConversation），慢且容易因窗口滑动失败。
//
// 所以主路径是「下载资源」，截图只作为兜底（见通道的 observe()）。
//
// 安全边界：URL 来自页面 DOM，仍然只允许 https + 抖音自家 CDN 域，避免被页面内容带去
// 访问 localhost 或任意主机（那会变成一个可被消息内容触发的请求原语）。

import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';

/** 允许的 CDN 域名后缀（抖音 / B站 两家的图床都在这几个域下）。 */
const ALLOWED_HOST_SUFFIXES = [
  // 抖音
  'douyinpic.com',
  'douyin.com',
  'byteimg.com',
  'zjcdn.com',
  'bytedance.com',
  'pstatp.com',
  // B站（实测 2026-10-26：私信图片在 `message.biliimg.com/bfs/im_new/<md5>.png`，
  // 305x305 的 PNG 原图 90KB；`hdslb.com` 是 B站主图床，同一个下载器以后也用得上）
  'biliimg.com',
  'hdslb.com',
];

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 8000;

/** 落盘目录：项目根下的 capture/，和 archive/（调试归档）分开。 */
export function captureDir(root) {
  return path.join(root, 'capture');
}

/**
 * 某条通道自己的子目录：`capture/<channel>/`。
 *
 * 为什么按通道分：抖音那批文件是**平铺**在 capture/ 下的（历史形状，别动它，
 * douyin.mjs 还在按平铺写），B站新加进来如果再平铺，两边文件名规则不同、
 * 清理策略也不同（各自 prune 各自的），混在一个目录里必然互相踩。
 * 所以新通道一律走子目录，老通道维持原样。
 */
export function captureSubdir(root, channel) {
  return path.join(captureDir(root), String(channel));
}

/** 只保留能直接当文件名用的字符，避免路径穿越和非法字符。 */
function slug(value, length = 12) {
  const text = String(value ?? '').replace(/^msg:/, '').replace(/[^a-zA-Z0-9]/g, '');
  return text.slice(0, length) || 'unknown';
}

/**
 * 文件名前缀（不带扩展名），给「可追溯」的命名用：`<msg_key>-<序号>.<ext>`。
 *
 * 和 slug() 的区别：slug() 是**丢掉**非字母数字（`bili:7700219232671842682`
 * 会变成 `bili770021923`，消息 ID 的尾巴反而没了），这里是把分隔符换成 `-`，
 * 让 `bili:77…` 变成 `bili-77…` —— 名字里还能看出这是哪条消息。
 */
export function safeName(value, length = 48) {
  const text = String(value ?? '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return text.slice(0, length) || 'unknown';
}

export function isAllowedUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return ALLOWED_HOST_SUFFIXES.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
}

/**
 * 照片消息在抖音私信里是**内嵌 base64** 的（`data:image/png;base64,UklGR…`，实测一张 46KB），
 * 跟表情包的 CDN 链接完全不同。这种不用下载，直接解码落盘；
 * 但也不能因此把「任意 URL」放行——它必须过 isDataImage 的严格形状检查。
 */
export function isDataImage(value) {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(String(value));
}

/**
 * 按文件头判断真实格式。
 * 抖音把 webp 标成 image/png（实测那张照片的 base64 以 `UklGR…` 开头，是 RIFF/WEBP，
 * 声明却是 png）。扩展名跟着声明走会让 read_image 认错格式，所以看魔数。
 */
export function extensionOfBytes(buffer, fallback = 'png') {
  if (!buffer || buffer.length < 12) return fallback;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return fallback;
}

function decodeDataImage(value) {
  const text = String(value);
  const payload = text.slice(text.indexOf(',') + 1);
  const buffer = Buffer.from(payload, 'base64');
  return buffer.length ? buffer : null;
}

function extensionOf(contentType, url) {
  const type = String(contentType ?? '').toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('avif')) return 'avif';
  const pathname = (() => {
    try {
      return new URL(String(url)).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  for (const ext of ['png', 'webp', 'gif', 'jpg', 'jpeg', 'avif', 'heic']) {
    if (pathname.endsWith(`.${ext}`)) return ext === 'jpeg' ? 'jpg' : ext;
  }
  return 'png'; // 抖音图片绝大多数是 png/webp；大不了浏览器按内容自动识别
}

/**
 * 下载一个资源到本地。
 *
 * @param {object} options
 * @param {string} options.url 资源地址（http(s) 或 data:image base64）
 * @param {string} [options.messageId] 消息 ID，用来生成**稳定**的文件名（重复轮询复用同一个文件）
 * @param {string} [options.type] 媒体类型（emoji / image / shared-work …）
 * @param {number} [options.index] 同一条消息里的第几个资源，从 0 起
 * @param {string} [options.dir] 落盘目录
 * @param {AbortSignal} [options.signal] 外部取消信号
 * @param {string} [options.name] **文件名前缀**（不带扩展名），给了就用 `<name>-<index>.<ext>`。
 *   抖音不传（沿用 `slug(messageId)-slug(type)-index`）；B站传 msg_key，落成
 *   `7700219232671842682-0.png` —— 从文件名能直接找回是哪条私信。
 * @param {Record<string,string>} [options.headers] 额外请求头（对付图床防盗链；抖音不需要）
 * @param {number} [options.timeoutMs] 单次下载超时
 * @returns {Promise<{ok:boolean, path?:string, bytes?:number, contentType?:string, error?:string, cached?:boolean}>}
 */
export async function downloadResource({
  url,
  messageId,
  type,
  index = 0,
  dir,
  signal,
  name,
  headers,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const base = path.join(
    dir,
    name ? `${safeName(name)}-${index}` : `${slug(messageId)}-${slug(type, 16)}-${index}`,
  );
  const existing = ['png', 'jpg', 'webp', 'gif', 'avif'].map((ext) => `${base}.${ext}`).filter((file) => existsSync(file));
  // 同一 messageId 重复轮询不重复下载：文件名按 messageId 稳定，存在就复用。
  if (existing.length === 1) {
    const file = existing[0];
    const size = statSync(file).size;
    if (size > 0) return { ok: true, path: file, bytes: size, cached: true };
  }

  // 照片是内嵌 base64（不是链接）：解码落盘，不走网络
  if (isDataImage(url)) {
    const buffer = decodeDataImage(url);
    if (!buffer) return { ok: false, error: '内嵌图片解码失败' };
    if (buffer.byteLength > MAX_BYTES) return { ok: false, error: `图片过大：${buffer.byteLength} 字节` };
    mkdirSync(dir, { recursive: true });
    const file = `${base}.${extensionOfBytes(buffer)}`;
    writeFileSync(file, buffer);
    return { ok: true, path: file, bytes: buffer.byteLength, contentType: 'data-uri' };
  }

  if (!isAllowedUrl(url)) return { ok: false, error: `不允许下载的主机或协议：${String(url).slice(0, 60)}` };

  const abort = AbortSignal.timeout(timeoutMs);
  const composed = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, abort]) : abort;
  let response;
  try {
    response = await fetch(url, { headers: headers && typeof headers === 'object' ? headers : undefined, signal: composed });
  } catch (error) {
    return { ok: false, error: `下载失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) return { ok: false, error: `下载失败：HTTP ${response.status}` };
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^image\//i.test(contentType)) return { ok: false, error: `返回的不是图片：${contentType || '(无 content-type)'}` };
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) return { ok: false, error: '下载到 0 字节' };
  if (buffer.byteLength > MAX_BYTES) return { ok: false, error: `图片过大：${buffer.byteLength} 字节` };

  mkdirSync(dir, { recursive: true });
  const file = `${base}.${extensionOf(contentType, url)}`;
  writeFileSync(file, buffer);
  return { ok: true, path: file, bytes: buffer.byteLength, contentType };
}

/**
 * 清掉过旧的落盘文件，避免无限增长。
 * 按修改时间保留最新 maxFiles 个。
 *
 * **只清文件，不动子目录**：capture/ 下现在有各通道自己的子目录
 * （capture/bilibili/），抖音那边的 prune 是跑在 capture/ 顶层的，
 * 要是把子目录也算进去，迟早有一天会用 unlinkSync 去删一个目录（必失败且意义不明），
 * 或者按 mtime 把「整个通道的目录」排进淘汰名单 —— 那等于一次删掉所有 B站图。
 */
export function pruneCapture(dir, maxFiles = 400) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { removed: 0, kept: 0 };
  }
  const files = names
    .map((name) => {
      const file = path.join(dir, name);
      try {
        const stats = statSync(file);
        if (stats.isDirectory()) return null;
        return { file, at: stats.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.at - left.at);
  let removed = 0;
  for (const entry of files.slice(maxFiles)) {
    try {
      unlinkSync(entry.file);
      removed += 1;
    } catch {
      /* 删不掉就算了，下次再试 */
    }
  }
  return { removed, kept: Math.min(files.length, maxFiles) };
}
