#!/usr/bin/env node
// B站扫码登录 —— 二维码经 QQ 发给使用者，他扫完我们把凭证写回磁盘。
//
//   node tools/bili-login.mjs                   二维码发到表号 10001，然后等扫码
//   node tools/bili-login.mjs --to 10002   发到里号
//   node tools/bili-login.mjs --dry-run         只生成 PNG、不发送（打印路径）
//   node tools/bili-login.mjs --timeout 240     等多久（秒，默认 180）
//
// ════════════════════════════════════════════════════════════════════
// 为什么要有这个东西
//
//   凭证 `~/.dsh/bili-duty/bili_credential.json` 原来由 dsh-bili-scroll 插件
//   扫码续期。插件被禁用（2026-10-24）之后，这个号就没人续期了 ——
//   cookie 一过期，本项目的 B站通道只会报 `loginRequired`，然后**永远好不了**。
//
//   所以 adopter 自己把这个能力接过来：生成二维码 → 经 NapCat 发到 QQ →
//   轮询 → 写盘。全程不需要浏览器，也不需要那个被禁用的 Python 环境。
//
// 两个接口（本机实测过，2026-10-25）：
//   ① 生成  GET  https://passport.bilibili.com/x/passport-login/web/qrcode/generate
//           → { code:0, data:{ url, qrcode_key } }
//           **实测：generate 不返回任何 Set-Cookie**（带了 UA/Referer 也一样），
//           所以二维码里的 buvid3 得从别处补（见 fillBuvid3）。
//   ② 轮询  GET  https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=<key>
//           注意：外层的 `code` 恒为 0，**真正的状态在 `data.code`**：
//             0 = 成功 / 86101 = 未扫码 / 86090 = 已扫码待确认 / 86038 = 已过期
//           实测未扫码时：{"code":0,…,"data":{"url":"","timestamp":0,"code":86101,"message":"未扫码"}}
//
//   cookie 从哪来：**两条路都要吃**。B站成功时通常
//     · 在 Set-Cookie 里给 SESSDATA / bili_jct / DedeUserID
//     · 同时在 data.url 里给一条 crossDomain 链接，`gourl` 参数里嵌着同样的 cookie
//   哪个来不一定，所以两边都收，**并且逐个拿 nav 接口验**（见 pickCredential）——
//   只认「验得过」的那一份，不猜。
//
// ⚠️ SESSDATA 的坑：文件里存的是**带百分号编码的原样值**（本机这个号 222 字节，
//   含 `%2C`）。所以从 data.url 里抠的时候**不能二次解码**，否则 `%2C` 变逗号、
//   整条 cookie 就废了。代码里 raw 形态和 decoded 形态都当候选去试，验得过才留。
// ════════════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import QRCode from 'qrcode';

// ── 常量 ────────────────────────────────────────────────────────────

const HOME = homedir();
/** 凭证文件。**本工具是唯一允许写它的地方**（通道那边只读）。 */
const CREDENTIAL_PATH = path.join(HOME, '.dsh', 'bili-duty', 'bili_credential.json');

/**
 * 二维码 PNG 放本项目 `logs/`，**不放** `~/.dsh/bili-duty/tmp/` ——
 * 那里属于被禁用的插件，按约定不去动它。
 */
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const QRCODE_DIR = path.join(PROJECT_ROOT, 'logs');

/** NapCat（OneBot v11）。本机实测：get_login_info → 深蓝 / 3251655221。 */
const NAPCAT_BASE = process.env.NAPCAT_BASE || 'http://127.0.0.1:3000';
const NAPCAT_TOKEN = process.env.NAPCAT_TOKEN || 'c669dfi5';

/** 默认发到表号（使用者原话：二维码通过 QQ 发给他扫）。 */
const DEFAULT_QQ = '10001';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

const GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
/** buvid3 的官方发号接口（返回 data.b_3 / data.b_4）。实测 b_3 = 46 字节、带 infoc，和文件里那个同形。 */
const FINGER_SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi';

/** 我们只关心这 4 个字段。JSON 里的键名**全小写**（Python 那边 d['sessdata'] 这么读）。 */
const WANTED_KEYS = ['sessdata', 'bili_jct', 'dedeuserid', 'buvid3'];

/** 轮询节奏：2.5 秒一次，最长 3 分钟（二维码本身也就 3 分钟寿命）。 */
const POLL_INTERVAL_MS = 2500;
const DEFAULT_TIMEOUT_S = 180;

/** data.code 的四个取值。 */
const QR_STATUS = {
  SUCCESS: 0,
  NOT_SCANNED: 86101,
  SCANNED: 86090,
  EXPIRED: 86038,
};

// ── 小工具 ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(line = '') {
  console.log(line);
}

function warn(line) {
  console.error(line);
}

/** 本地时间戳 `20261025-214355`，用来命名备份和 PNG（跟项目里既有的 .bak 命名一致）。 */
function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 显式 UTF-8 的 JSON POST —— 中文不能靠默认编码蒙。 */
async function postJson(url, payload, { headers = {}, timeoutMs = 30_000 } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: Buffer.from(JSON.stringify(payload), 'utf8'),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 就让它 null，原始文本留着报错 */
  }
  return { httpStatus: response.status, json, text };
}

/** B站 GET：带 UA/Referer/Origin（少了这些 passport 接口会被风控成 -412）。 */
async function biliGet(url, { cookie = null, timeoutMs = 20_000 } = {}) {
  const headers = {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
  };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 下面按 json === null 处理 */
  }
  return { status: response.status, json, text, response };
}

// ── ① 生成二维码 ────────────────────────────────────────────────────

/**
 * 要一张新码。
 * 返回 { url, qrcodeKey }；`url` 就是二维码里编的内容（B站给的是
 * `https://account.bilibili.com/h5/account-h5/auth/scan-web?...&qrcode_key=…`）。
 */
export async function generateQrcode() {
  const { status, json, text } = await biliGet(GENERATE_URL);
  if (!json) throw new Error(`生成二维码接口返回的不是 JSON（HTTP ${status}）：${text.slice(0, 200)}`);
  if (json.code !== 0 || !json.data?.qrcode_key || !json.data?.url) {
    throw new Error(`生成二维码失败：code=${json.code} ${json.message ?? ''}（HTTP ${status}）`);
  }
  return { url: String(json.data.url), qrcodeKey: String(json.data.qrcode_key) };
}

/** 把二维码内容渲染成 PNG，返回绝对路径。 */
export async function renderQrcodePng(url) {
  mkdirSync(QRCODE_DIR, { recursive: true });
  const file = path.join(QRCODE_DIR, `bili-qrcode-${stamp()}.png`);
  await QRCode.toFile(file, url, {
    type: 'png',
    width: 480,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
  return file;
}

// ── ② 发 QQ（NapCat / OneBot v11）────────────────────────────────────

/**
 * 调一个 OneBot 动作。
 *
 * 图片一律走 **base64://**，不用 file:// —— 后者要 NapCat 进程能读到那个路径，
 * 跨用户/跨盘符时会被权限卡住，而且路径里带中文更容易翻车。
 */
async function napcatAction(action, payload) {
  const result = await postJson(`${NAPCAT_BASE}/${action}`, payload, {
    headers: { Authorization: `Bearer ${NAPCAT_TOKEN}` },
  });
  const retcode = result.json?.retcode;
  if (result.httpStatus !== 200 || retcode !== 0) {
    // 原样把 NapCat 的话贴出来 —— 出错时别替它编原因
    throw new Error(
      `NapCat ${action} 失败：HTTP ${result.httpStatus}，retcode=${retcode ?? '?'}，` +
        `返回=${result.text.slice(0, 400)}`,
    );
  }
  return result.json;
}

/** 发一张本地图片给某个 QQ 号。返回 NapCat 的原始响应。 */
export async function sendQrcodeToQq(userId, pngPath) {
  const raw = readFileSync(pngPath);
  const magic = raw.subarray(0, 4).toString('hex');
  if (magic !== '89504e47') throw new Error(`不是 PNG（前 4 字节 ${magic}），不发给 QQ：${pngPath}`);
  const base64 = raw.toString('base64');
  return napcatAction('send_private_msg', {
    user_id: Number(userId),
    message: [{ type: 'image', data: { file: `base64://${base64}` } }],
  });
}

/** 配一条说明文字（纯文本）。失败只警告，不拖垮登录流程。 */
async function sendNoticeToQq(userId, text) {
  try {
    return await napcatAction('send_private_msg', {
      user_id: Number(userId),
      message: [{ type: 'text', data: { text } }],
    });
  } catch (error) {
    warn(`⚠️ 说明文字没发出去（二维码本身已发）：${error?.message ?? error}`);
    return null;
  }
}

// ── ③ 轮询 ──────────────────────────────────────────────────────────

/**
 * 问一次扫码状态。
 *
 * 返回 `{ code, message, source, response }` —— `code` 是 **data.code**，
 * 外层的 code 恒为 0，拿它判断状态会永远以为还没扫。
 */
export async function pollQrcode(qrcodeKey) {
  const url = `${POLL_URL}?qrcode_key=${encodeURIComponent(qrcodeKey)}&source=main-fe-header`;
  const { status, json, text, response } = await biliGet(url);
  if (!json) throw new Error(`轮询接口返回的不是 JSON（HTTP ${status}）：${text.slice(0, 200)}`);
  if (json.code !== 0) throw new Error(`轮询接口报错：code=${json.code} ${json.message ?? ''}（HTTP ${status}）`);
  return {
    code: Number(json.data?.code),
    message: json.data?.message ?? '',
    url: json.data?.url ?? '',
    response,
  };
}

// ── ④ 收 cookie：Set-Cookie 和 data.url 两条路 ───────────────────────

/**
 * 从 Set-Cookie 头里收。值**原样**拿（浏览器也是原样存的）。
 * 导出是给测试用的：这里最容易被人「顺手 decodeURIComponent 一下」搞废。
 */
export function parseSetCookieList(lines) {
  const found = {};
  for (const line of Array.isArray(lines) ? lines : []) {
    const pair = String(line ?? '').split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim().toLowerCase();
    const value = pair.slice(eq + 1).trim();
    if (!WANTED_KEYS.includes(key) || !value || found[key]) continue;
    found[key] = value;
  }
  return found;
}

/** 从一段**原始文本**里抠 `key=value`（不解码），命中返回 value。 */
function rawValueOf(text, key) {
  const match = new RegExp(`(?:^|[?&])${key}=([^&]*)`, 'i').exec(String(text ?? ''));
  return match && match[1] ? match[1] : null;
}

/** 一次解码，失败就原样返回（畸形 % 序列不该把整个登录搞崩）。 */
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * 从成功响应里收集**候选**凭证。宁可多收几个，等下逐个用 nav 验。
 *
 * 三个来源，按可信度排序：
 *   1. set-cookie             —— 原样值，最可靠
 *   2. data.url 一层解码后的 raw —— `gourl=...SESSDATA%3Dxxx%252Cyyy` 解一层 →
 *                                 `SESSDATA=xxx%2Cyyy`，这里取 raw 就是**对**的形态
 *   3. data.url 再解一层（decoded）—— 留着当兜底候选，验不过就丢
 */
export function collectCandidates(setCookieLines, dataUrl) {
  const candidates = [];

  const fromHeaders = parseSetCookieList(setCookieLines);
  if (fromHeaders.sessdata) candidates.push({ source: 'set-cookie', ...fromHeaders });

  if (dataUrl) {
    const level1 = safeDecode(String(dataUrl));
    const level2 = safeDecode(level1);
    for (const [source, text] of [
      ['gourl-raw', level1],
      ['gourl-raw0', String(dataUrl)],
      ['gourl-decoded', level2],
    ]) {
      const picked = {};
      for (const key of WANTED_KEYS) {
        const value = rawValueOf(text, key);
        if (value) picked[key] = value;
      }
      if (picked.sessdata) candidates.push({ source, ...picked });
    }
  }

  // 同一个 sessdata 只留第一次出现的那份
  const seen = new Set();
  return candidates.filter((item) => {
    if (seen.has(item.sessdata)) return false;
    seen.add(item.sessdata);
    return true;
  });
}

/** 拿 nav 接口验一份凭证：code 0 且 isLogin 才算真的登录了。 */
async function fetchNav(cred) {
  const cookie = [
    `SESSDATA=${cred.sessdata}`,
    cred.bili_jct ? `bili_jct=${cred.bili_jct}` : null,
    cred.buvid3 ? `buvid3=${cred.buvid3}` : null,
  ]
    .filter(Boolean)
    .join('; ');
  const { status, json } = await biliGet('https://api.bilibili.com/x/web-interface/nav', { cookie });
  const loggedIn = json?.code === 0 && json?.data?.isLogin === true;
  return {
    ok: loggedIn,
    httpStatus: status,
    code: json?.code,
    uname: loggedIn ? String(json.data.uname ?? '') : null,
    mid: loggedIn ? String(json.data.mid ?? '') : null,
    level: loggedIn ? (json.data.level_info?.current_level ?? null) : null,
  };
}

/**
 * 挑出**验得过**的那份凭证。
 *
 * 为什么要验而不是直接写：SESSDATA 有「带 %2C 的原样值」和「被解码过的值」
 * 两种形态，肉眼分不出哪个对，但服务端一验就知道。错的那份写进文件，
 * 通道就会一直报 loginRequired，比不写还糟。
 */
async function pickCredential(candidates) {
  for (const candidate of candidates) {
    const nav = await fetchNav(candidate);
    if (nav.ok) return { candidate, nav };
    warn(`· 候选（${candidate.source}）验不过：nav code=${nav.code ?? '?'}，换下一个`);
  }
  return null;
}

/** buvid3 兜底：走官方发号接口。拿不到就 null（不 fake 一个，因为假的值会让风控更凶）。 */
async function fillBuvid3() {
  try {
    const { json } = await biliGet(FINGER_SPI_URL);
    if (json?.code === 0 && json.data?.b_3) return String(json.data.b_3);
  } catch {
    /* 下面统一返回 null */
  }
  return null;
}

// ── ⑤ 写凭证（先备份，无 BOM）───────────────────────────────────────

/**
 * 备份旧文件 → 写新文件。
 *
 * 两个硬要求：
 *   · **先备份**（`.bak-<时间戳>`）：写坏了还能退回去，旧 cookie 也是证据
 *   · **UTF-8 无 BOM**：这个项目踩过 BOM 的坑，Node 的 writeFileSync 默认不加，
 *     这里显式写 `'utf8'`，并且只写 JSON 本身（不加任何前后缀）
 */
export function writeCredential(credential, { filePath = CREDENTIAL_PATH } = {}) {
  const fields = {};
  for (const key of WANTED_KEYS) {
    const value = credential[key];
    // buvid3 是设备指纹兜底来的，拿不到也不该把这次扫码作废（新 SESSDATA 比 buvid3 重要得多）；
    // 其余三个缺了就是真失败，不写盘。
    if (key === 'buvid3') {
      fields[key] = typeof value === 'string' ? value : '';
      continue;
    }
    if (typeof value !== 'string' || !value) throw new Error(`凭证缺字段 ${key}，不写盘`);
    fields[key] = value;
  }

  let backupPath = null;
  if (existsSync(filePath)) {
    backupPath = `${filePath}.bak-${stamp()}`;
    writeFileSync(backupPath, readFileSync(filePath), { flag: 'wx' });
  }

  // 字段顺序照原文件：sessdata / bili_jct / buvid3 / dedeuserid（无尾随换行，和原文件一致）
  const ordered = {
    sessdata: fields.sessdata,
    bili_jct: fields.bili_jct,
    buvid3: fields.buvid3,
    dedeuserid: fields.dedeuserid,
  };
  writeFileSync(filePath, JSON.stringify(ordered, null, 2), 'utf8');
  return { filePath, backupPath, fields: Object.keys(ordered) };
}

/** 文件头 4 字节是不是 PNG 的 `89 50 4E 47`。 */
export function isPngFile(filePath) {
  try {
    return readFileSync(filePath).subarray(0, 4).toString('hex') === '89504e47';
  } catch {
    return false;
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────

/**
 * 跑一次扫码登录。
 *
 * @param {object} options
 * @param {string} [options.to]         发到哪个 QQ（默认表号）
 * @param {boolean} [options.dryRun]    只生成不发送
 * @param {number} [options.timeoutS]   最多等多少秒
 * @param {(line:string)=>void} [options.onProgress] 进度出口（测试可换成静默）
 * @returns {Promise<object>} 成功 `{ok:true, uname, mid, ...}`；失败 `{ok:false, reason}`
 */
export async function loginViaQr({
  to = DEFAULT_QQ,
  dryRun = false,
  timeoutS = DEFAULT_TIMEOUT_S,
  onProgress = log,
} = {}) {
  const target = String(to ?? '').trim();
  if (!/^\d{5,12}$/.test(target)) throw new Error(`--to 要一个 QQ 号（5~12 位数字），收到「${to}」`);

  // ① 生成 + 存 PNG
  onProgress('① 向 B站要一张登录二维码…');
  const { url, qrcodeKey } = await generateQrcode();
  const pngPath = await renderQrcodePng(url);
  if (!isPngFile(pngPath)) throw new Error(`写出来的文件不是 PNG：${pngPath}`);
  onProgress(`   二维码 PNG：${pngPath}`);
  onProgress(`   二维码内容：${url}`);

  if (dryRun) {
    onProgress('（--dry-run：不发送、不轮询）');
    return { ok: false, dryRun: true, pngPath, qrcodeUrl: url, qrcodeKey, reason: 'dry-run，未发送' };
  }

  // ② 发到 QQ
  onProgress(`② 经 NapCat 发到 QQ ${target}…`);
  const sent = await sendQrcodeToQq(target, pngPath);
  const messageId = sent?.data?.message_id ?? null;
  onProgress(`   已发出（NapCat message_id=${messageId ?? '?'}）`);
  await sendNoticeToQq(
    target,
    'B站登录二维码，用 B站 App 扫一下（3 分钟内有效）。扫完在手机上点确认，我这边会自动把凭证写回去。',
  );

  // ③ 轮询
  onProgress(`③ 等你扫码（最多 ${timeoutS} 秒，每 ${POLL_INTERVAL_MS / 1000} 秒问一次）…`);
  const deadline = Date.now() + timeoutS * 1000;
  let scannedNotified = false;
  let lastHeartbeat = Date.now();

  while (Date.now() < deadline) {
    const result = await pollQrcode(qrcodeKey).catch((error) => {
      warn(`· 轮询出错，继续等：${error?.message ?? error}`);
      return null;
    });

    if (result) {
      if (result.code === QR_STATUS.SUCCESS) {
        onProgress('④ 扫码成功，正在收凭证…');
        const setCookieLines =
          typeof result.response.headers.getSetCookie === 'function' ? result.response.headers.getSetCookie() : [];
        const candidates = collectCandidates(setCookieLines, result.url);
        if (!candidates.length) {
          return { ok: false, reason: '扫码成功了，但响应里既没有 Set-Cookie 也没有 data.url 里的 cookie', pngPath };
        }

        const picked = await pickCredential(candidates);
        if (!picked) {
          return {
            ok: false,
            reason: `收到 ${candidates.length} 份候选凭证，但 nav 接口一个都验不过（可能 B站改了 cookie 形态）`,
            pngPath,
          };
        }
        onProgress(`   候选来源：${candidates.map((item) => item.source).join(' / ')}（逐个验 nav，只认验得过的）`);
        onProgress(`   命中的来源：${picked.candidate.source}`);

        const buvid3 = picked.candidate.buvid3 || (await fillBuvid3());
        if (!buvid3) warn('⚠️ 没拿到 buvid3（spi 接口也没给），通道可能会被风控');
        const dedeuserid = picked.candidate.dedeuserid || picked.nav.mid || '';

        const credential = {
          sessdata: picked.candidate.sessdata,
          bili_jct: picked.candidate.bili_jct ?? '',
          buvid3: buvid3 ?? '',
          dedeuserid: String(dedeuserid),
        };

        // 写完再验一次完整的（带 buvid3），确认「文件里那份」真的能用
        const written = writeCredential(credential);
        const confirm = await fetchNav({
          sessdata: credential.sessdata,
          bili_jct: credential.bili_jct,
          buvid3: credential.buvid3,
        });

        onProgress('⑤ 凭证已写盘（值不打印）：');
        onProgress(`   文件：${written.filePath}`);
        onProgress(`   备份：${written.backupPath ?? '（原来没有旧文件，没备份）'}`);
        onProgress(`   字段：${written.fields.join(' / ')}（全小写，无 BOM）`);
        onProgress(`   复验：${confirm.ok ? 'nav 通过' : `nav 没通过（code=${confirm.code ?? '?'}）`}`);

        if (!confirm.ok) {
          return {
            ok: false,
            reason: '凭证写进去了，但用文件里那份验 nav 不通过 —— 别当成功，先看备份',
            pngPath,
            backupPath: written.backupPath,
          };
        }

        return {
          ok: true,
          uname: confirm.uname,
          mid: confirm.mid,
          level: confirm.level,
          cookieSource: picked.candidate.source,
          credentialPath: written.filePath,
          backupPath: written.backupPath,
          pngPath,
        };
      }

      if (result.code === QR_STATUS.SCANNED) {
        if (!scannedNotified) {
          onProgress('   已扫码，等你在手机上确认');
          scannedNotified = true;
        }
      } else if (result.code === QR_STATUS.EXPIRED) {
        return { ok: false, reason: '二维码过期', pngPath };
      } else if (result.code !== QR_STATUS.NOT_SCANNED) {
        warn(`· 没见过的状态码 data.code=${result.code}（${result.message}），继续等`);
      }
    }

    // 每 30 秒说一声，别让命令行看起来像死了
    if (Date.now() - lastHeartbeat > 30_000) {
      onProgress(`   还在等…（剩 ${Math.max(0, Math.round((deadline - Date.now()) / 1000))} 秒）`);
      lastHeartbeat = Date.now();
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return { ok: false, reason: `等满 ${timeoutS} 秒还没扫，放弃（二维码应该也过期了）`, pngPath };
}

// ── 命令行 ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { to: DEFAULT_QQ, dryRun: false, timeoutS: DEFAULT_TIMEOUT_S };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--dry-run' || item === '--dryRun') options.dryRun = true;
    else if (item === '--to') options.to = argv[(index += 1)];
    else if (item.startsWith('--to=')) options.to = item.slice(5);
    else if (item === '--timeout') options.timeoutS = Number(argv[(index += 1)]);
    else if (item.startsWith('--timeout=')) options.timeoutS = Number(item.slice(10));
    else if (item === '--help' || item === '-h') options.help = true;
    else throw new Error(`不认识的参数：${item}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    log('用法：');
    log('  node tools/bili-login.mjs                  二维码发到表号 10001');
    log('  node tools/bili-login.mjs --to 10002  发到里号');
    log('  node tools/bili-login.mjs --dry-run        只生成不发送（打印 PNG 路径）');
    log('  node tools/bili-login.mjs --timeout 240    最多等 240 秒（默认 180）');
    return 0;
  }
  if (!Number.isFinite(options.timeoutS) || options.timeoutS <= 0) throw new Error('--timeout 要正数（秒）');

  const result = await loginViaQr(options);
  log('');
  log(`结果：${JSON.stringify(result)}`);
  if (result.ok) {
    log(`✔ B站登录成功：${result.uname}（mid ${result.mid}，等级 ${result.level ?? '?'}）`);
    return 0;
  }
  if (result.dryRun) return 0;
  warn(`✘ 登录没成：${result.reason}`);
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
