// 抖音通知通道：读「@我的 / 评论 / 赞 / 粉丝」这类入站通知。
//
// 为什么要单开一个通道：通知**不走私信**（实测确认），它在顶部「通知」浮层里。
// 私信通道盯的是会话，读不到这些；两者是同一平台的两类数据。
//
// ── 侦察结论（2026-10-23 实测）──────────────────────────────────
//   入口：顶部「通知」→ 浮层。默认列表就是「全部消息」，@ 通知按时间倒序在里面，
//         不用切类别（切了之后下拉按钮的文本会变成类别名，反而更难定位）。
//   类别：全部消息 / 粉丝 / @我的 / 评论 / 赞
//
// ── 入口是 hover 打开的，不是 click（2026-10-23 用户口述 + 实测）─────
//   「把鼠标移上去，通知页面就打开了，不需要点击」。
//   实测（tools/probe-notice-hover-timing.mjs）：hover 后浮层 0.4~0.9 秒出现，6/6 成功；
//   把鼠标移开约 220ms 自动收起；**ESC 关不掉它**（6/6 仍开着）。
//   这条事实很重要：旧实现的 click 只是「碰巧」常常成功（Playwright 的 click 会先把鼠标
//   移过去，等于顺手 hover 了一下），点不开就走整页重载 —— 于是每轮轮询都刷新页面。
//   现在：hover 优先、click 兜底、移开鼠标收起、**默认不重载**（详见 ensurePanel）。
//   锚点：[data-e2e="user-name-card"]（昵称）、[data-e2e="user-avatar-card"]（头像）
//   缩略图：48x48 的 <img>，douyinpic 签名链接（不含 aweme id）
//
// ── 视频 ID 怎么拿 ───────────────────────────────────────────────
//   通知项的 <a href> 指向**用户主页**，不是作品。点昵称、点头像都跳主页。
//   只有点「内容文字区」（在评论中提到了你…）才会打开作品弹窗：
//     https://www.douyin.com/?modal_id=<视频ID>
//   实测可行。但这一步有副作用（会弹 modal），所以 poll 里**不做**，
//   只有 resolveVideo() 按需调用。
//
// ── 消息 ID 怎么来 ───────────────────────────────────────────────
//   通知没有稳定 ID，而且时间文案会变（"刚刚" → "3分钟前"）。
//   所以 ID = 昵称 + 动作 + 封面图片文件名，**不含时间**。
//   同一人对同一作品的重复通知会撞 ID（少见且无害：少报一次比重复报好）。

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserController } from '../browser/controller.mjs';

const HOME = 'https://www.douyin.com/?recommend=1&from_nav=1';
const PANEL_TITLE = '互动消息';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(HERE, '..', '..', 'logs');
/** 每次真重载都追加一行：时间 / 第几次 / 为什么。用户据此确认「到底还刷不刷」。 */
export const RELOAD_LOG = path.join(LOG_DIR, 'notice-reloads.log');

/**
 * 「真重载」的闸门，只用来救「页面状态真坏死」这一种情况，**不当日常路径**。
 *
 * 为什么要这么严：原来打不开浮层就无条件 `page.goto(HOME)`，等于每轮轮询都整页刷新 ——
 * 平台看到的是一个高频刷新的账号（风控风险），还白烧设备、白拉一堆网络请求。
 * 用户 2026-10-23 明确要求：连续失败到阈值才许重载一次，且两次重载至少隔 10 分钟。
 */
export const RELOAD_AFTER_FAILURES = 5;
export const RELOAD_MIN_GAP_MS = 10 * 60 * 1000;

const hash = (value) => createHash('sha256').update(value).digest('hex');

/**
 * 相对时间文案。
 *
 * 2026-10-25：抖音的通知列表把「什么时候」写进同一行文本里，而这段文字**每分钟都在变**
 * （刚收到的显示「刚刚」，过一会儿变成「3分钟前」，再往后「昨天 12:40」）。
 * 它不能参与通知 ID 的哈希，否则同一条通知每过一分钟就换一个 ID，
 * adopter 的 `reported` 集合认不出来，于是「删掉的评论又冒出来」。
 */
const RELATIVE_TIME = /刚刚|片刻前|\d+\s*秒前|\d+\s*分钟前|\d+\s*(?:小时|天|周|个月|年)前|昨天(?:\s*\d{1,2}:\d{2})?|前天(?:\s*\d{1,2}:\d{2})?|今天(?:\s*\d{1,2}:\d{2})?|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}|\d{1,2}:\d{2}/g;

/** 把时间文案剥掉，只留稳定的部分（导出是为了让测试直接钉住这条）。 */
export function stripRelativeTime(value) {
  return String(value ?? '').replace(RELATIVE_TIME, ' ');
}

/**
 * 重载放行判断（纯函数，测试里直接调）。
 * 两个条件**都要**满足：连续失败够多、且距上次重载够久。
 *
 * @returns {{ allowed: boolean, reason: string }}
 */
export function reloadGate({
  consecutiveFailures,
  lastReloadAt = 0,
  now = Date.now(),
  threshold = RELOAD_AFTER_FAILURES,
  minGapMs = RELOAD_MIN_GAP_MS,
} = {}) {
  if (consecutiveFailures < threshold) {
    return { allowed: false, reason: `连续失败 ${consecutiveFailures}/${threshold} 轮，没到重载阈值` };
  }
  if (lastReloadAt > 0 && now - lastReloadAt < minGapMs) {
    const elapsed = Math.max(0, Math.round((now - lastReloadAt) / 60000));
    const wait = Math.ceil((minGapMs - (now - lastReloadAt)) / 60000);
    return { allowed: false, reason: `距上次重载才 ${elapsed} 分钟，还要再等 ${wait} 分钟` };
  }
  return {
    allowed: true,
    reason: `连续失败 ${consecutiveFailures} 轮，且距上次重载已超过 ${Math.round(minGapMs / 60000)} 分钟`,
  };
}

/**
 * 上一条重载记录的时间。
 * 读日志而不是只放内存：进程重启后 10 分钟闸门依然有效（否则重启一次就等于闸门清零）。
 */
export function readLastReloadAt(file = RELOAD_LOG) {
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const at = Date.parse(lines[lines.length - 1].split('\t')[0]);
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

/** 追加一行重载记录，返回写进文件的文本；写不进去也不影响轮询。 */
export function appendReloadLog({ at, attempt, failures, reason, file = RELOAD_LOG }) {
  const line = [new Date(at).toISOString(), `第 ${attempt} 次`, `连续 ${failures} 轮打不开`, reason].join('\t');
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${line}\n`);
  } catch {
    /* 日志是给人看的，写不进去不能拖垮轮询 */
  }
  return line;
}

/** 从整行文本里判断这是哪一类通知。 */
function kindOf(text) {
  if (/提到了你/.test(text)) return 'mention';
  if (/回复了你/.test(text)) return 'reply';
  if (/赞了你|点赞/.test(text)) return 'like';
  if (/关注了你/.test(text)) return 'follow';
  if (/评论/.test(text)) return 'comment';
  return 'unknown';
}

const KIND_LABEL = {
  mention: '在评论里 @ 了你',
  reply: '回复了你的评论',
  like: '赞了你',
  follow: '关注了你',
  comment: '评论了你',
  unknown: '有互动',
};

/**
 * 读通知浮层里当前可见的通知项。
 * 会把「谁说、什么动作、什么时候、封面」提出来，但不点任何东西。
 */
async function readNoticeItems(page) {
  return page.evaluate(() => {
    const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();

    const nameNodes = [...document.querySelectorAll('[data-e2e="user-name-card"]')];
    const seen = new Set();
    const items = [];

    for (const nameNode of nameNodes) {
      // 从昵称往上找「整行」：要包含属性动作文字，且有图片
      let row = nameNode.parentElement;
      for (let depth = 0; depth < 7 && row; depth += 1) {
        if (/提到了你|回复了你|赞了你|关注了你/.test(clean(row.innerText)) && row.querySelector('img')) break;
        row = row.parentElement;
      }
      if (!row) continue;

      const key = `${clean(nameNode.textContent)}|${clean(row.innerText)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // 缩略图：行里除头像之外的那张图（douyinpic 的 p-0015 路径一般是作品封面）
      const images = [...row.querySelectorAll('img')].map((image) => (image.currentSrc || image.getAttribute('src') || ''));
      const cover = images.find((src) => /tos-cn-p-0015|tplv-dy/.test(src)) ?? null;

      items.push({
        name: clean(nameNode.textContent),
        text: clean(row.innerText).slice(0, 200),
        cover,
        href: row.querySelector('a[href]')?.getAttribute('href') ?? null,
      });
    }
    return items;
  });
}

export async function createChannel({
  port = 9227,
  profileDir,
  controlDir,
  policy = null,
  autoLaunch = true,
} = {}) {
  const controller = new BrowserController({
    source: 'douyin-notice',
    port,
    profileDir,
    controlDir,
    homeUrl: HOME,
    readySelector: '',
    allowedOrigins: ['https://www.douyin.com'],
    policy,
    autoLaunch,
    // 常驻进程，别每次退出都关页面
    closePageOnExit: false,
  });

  // ── 浮层状态 + 重载闸（每个进程一份）──────────────────────────
  /** 只统计「连续打不开」，任何一次成功都清零。 */
  let consecutiveOpenFailures = 0;
  /** 从日志恢复上次重载时间：进程重启不该等于闸门清零（否则重启一次就能立刻再刷一遍）。 */
  let lastReloadAt = readLastReloadAt();
  let reloadCount = 0;
  /** 每种打开方式的次数，用来事后回答「hover 到底够不够用」。status() 里带出去。 */
  const openCounts = Object.create(null);
  const noteOpened = (how) => {
    openCounts[how] = (openCounts[how] ?? 0) + 1;
  };

  /** 浮层开着？判据沿用原来的两条：有通知卡 + 正文里有标题。 */
  const panelOpen = (page) =>
    page
      .evaluate(
        (title) =>
          Boolean(document.querySelector('[data-e2e="user-name-card"]')) && document.body.innerText.includes(title),
        PANEL_TITLE,
      )
      .catch(() => false);

  /** 等浮层出现。用 Playwright 的文本等待（内部靠 MutationObserver），比每 200ms 轮询 innerText 便宜。 */
  const waitPanel = (page, ms) =>
    page
      .getByText(PANEL_TITLE, { exact: true })
      .first()
      .waitFor({ state: 'visible', timeout: ms })
      .then(() => true)
      .catch(() => false);

  /**
   * 把鼠标移到页面左上角空白处。
   *
   * 「通知」浮层是 **hover 打开**的，所以收起方式就是移开鼠标 —— 实测约 220ms 自然收起。
   * 刻意不用两种旧办法：
   *   - ESC：实测关不掉 hover 打开的浮层（tools/probe-notice-hover-timing.mjs，6/6 仍开着）
   *   - 点空白处：那一下万一落在视频/点赞按钮上就是一次真误操作
   */
  const parkMouse = (page) => page.mouse.move(4, 4).catch(() => {});

  /**
   * 一轮「打开浮层」的尝试：**先 hover，click 只当兜底**。
   *
   * 为什么改 hover：这个入口是 hover 打开的（用户实测：「把鼠标移上去，通知页面就打开了，
   * 不需要点击」；tools/probe-notice-hover-timing.mjs 里 6/6 成功，浮层 0.4~0.9 秒出现）。
   * 原来的 click 之所以有时也能开，是因为 Playwright 的 click 会先把鼠标移过去，等于顺手
   * hover 了一下 —— 但多按的那一下经常让浮层来不及渲染，于是表现为「点不开」。
   * 实测确认：hover 打开之后再 click 同一入口**不会**把浮层关掉，所以 click 兜底是安全的。
   */
  async function openOnce(page) {
    // 挑**可见**的那个（导航栏有时会同时存在隐藏的一套 DOM，.first() 可能命中不可见的那个）。
    const entry = page
      .locator('div,span,a,button')
      .filter({ hasText: /^通知$/ })
      .filter({ visible: true })
      .first();
    const exists = await entry
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (!exists) return { ok: false, how: '入口没出现' };

    await entry.hover({ timeout: 4000 }).catch(() => {});
    if (await waitPanel(page, 4000)) return { ok: true, how: 'hover' };

    // 有时判据比 DOM 慢半拍：文本还没被判可见，卡其实已经渲染出来了。这时别再点。
    if (await panelOpen(page)) return { ok: true, how: 'hover（判据滞后）' };

    await entry.click({ timeout: 4000 }).catch(() => {});
    if (await waitPanel(page, 4000)) return { ok: true, how: 'click' };
    return { ok: false, how: 'hover + click 都没开' };
  }

  /**
   * 确保通知浮层是开着的。**默认不重载页面。**
   *
   * 顺序（用户 2026-10-23 定的规则）：
   *   1. 已经开着 → 直接用
   *   2. hover 入口（click 兜底）→ 开了就完事
   *   3. 没开 → ESC 清场（收掉上一轮 resolveVideo 可能留下的作品弹窗）→ 再 hover 一次
   *   4. 还没开 → **本轮放弃**，抛错让框架记一次失败，15 秒后下一轮再来
   *   5. 只有「连续失败 ≥5 轮」**且**「距上次重载 ≥10 分钟」才真重载一次
   *
   * 第 4、5 步是这次改动的重点：原来第 4 步是无条件 `page.goto(HOME)` —— 打不开就整页刷新，
   * 而「打不开」在换成 hover 之前是常态，于是每一轮轮询都刷一次。实测那会儿通知通道单轮
   * poll 要 8~10 秒，全花在这个 goto 上，用户看到的就是「页时不时刷新」。
   */
  async function ensurePanel(page) {
    if (await panelOpen(page)) {
      noteOpened('already-open');
      return { how: 'already-open' };
    }

    const first = await openOnce(page);
    if (first.ok) {
      consecutiveOpenFailures = 0;
      noteOpened(first.how);
      return first;
    }

    // 第二级：清场再试。ESC 收的是 modal（对 hover 浮层本身无效），移开鼠标收浮层。
    await page.keyboard.press('Escape').catch(() => {});
    await parkMouse(page);
    await page.waitForTimeout(500);
    if (await panelOpen(page)) {
      consecutiveOpenFailures = 0;
      noteOpened('escape 之后仍在');
      return { how: 'escape 之后仍在' };
    }

    const second = await openOnce(page);
    if (second.ok) {
      consecutiveOpenFailures = 0;
      noteOpened(second.how);
      return second;
    }

    // 两级都没开：本轮放弃，**不碰页面**。下一轮再来。
    consecutiveOpenFailures += 1;
    const now = Date.now();
    const gate = reloadGate({ consecutiveFailures: consecutiveOpenFailures, lastReloadAt, now });
    if (!gate.allowed) {
      throw new Error(
        `打不开通知浮层（hover 两轮 + click 兜底都试过：${second.how}）。本轮放弃，不重载页面 —— ${gate.reason}。`,
      );
    }

    // 到这里说明页面状态多半真坏死了：允许重载一次，并记进 logs/notice-reloads.log。
    const failures = consecutiveOpenFailures;
    consecutiveOpenFailures = 0;
    lastReloadAt = now;
    reloadCount += 1;
    const line = appendReloadLog({ at: now, attempt: reloadCount, failures, reason: gate.reason });
    console.log(`[douyin-notice] 整页重载（${line.split('\t').join(' | ')}）`);

    await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page
      .evaluate(() => {
        for (const video of document.querySelectorAll('video')) {
          video.muted = true;
          video.pause();
        }
      })
      .catch(() => {});

    const third = await openOnce(page);
    if (third.ok) {
      noteOpened(`重载后 ${third.how}`);
      return third;
    }
    throw new Error('重载页面后仍然打不开通知浮层（下一轮继续，但 10 分钟内不会再重载）。');
  }

  return {
    id: 'douyin-notice',
    label: '抖音通知',
    /**
     * 通知列表是「hover 打开浮层 → 异步渲染」的，刚起来那几轮可能读到 0 条。
     * 那不是「没有通知」，是「还没画出来」。拿 0 条当基线等于把随后渲染出的整批历史
     * 通知都放进来（2026-10-25 实测：重启后基线 0 条 → 4 条旧通知全被当新消息上报）。
     * 声明这个开关，adopter 会等几轮再建基线（见 adopter.mjs 的 emptyMeansUnrendered）。
     */
    emptyMeansUnrendered: true,

    async poll({ signal } = {}) {
      return controller.withPage(async (page) => {
        await page.waitForLoadState('load').catch(() => {});
        await ensurePanel(page);

        const items = await readNoticeItems(page);

        // 读完把浮层收起来：**移开鼠标就行**（实测约 220ms 自然收起）。
        // 不用 ESC（实测关不掉 hover 打开的浮层），也不再点空白处（万一落在视频/点赞上就是误操作）。
        await parkMouse(page);
        await page.waitForTimeout(250);

        const messages = items.map((item) => {
          const kind = kindOf(item.text);
          /**
           * 通知 ID 只由**稳定部分**算：昵称 + 动作 + 剥掉时间后的同一行文本。
           *
           * 2026-10-25 修（现象：删掉的 @ 通知反复冒出来）：
           * 原实现是 `hash(昵称|动作|coverFile || item.text)`，两个回退候选都会漂——
           *  - 封面是带签名的 douyinpic URL，页面重载/重渲染后签名变 → 文件名变 → ID 变
           *  - item.text 里带「刚刚 / 3分钟前 / 昨天」这类相对时间，随分钟变
           * ID 一变，adopter 的 reported 集合就认不出这是同一条 → 再上报一次。
           *
           * 代价：同一人对同一动作的重复通知会被合并（同一人连 @ 两次只报一次）。
           * 这是刻意选的取舍——少报一次比反复打扰好。
           */
          const stableBody = stripRelativeTime(item.text).replace(/\s+/g, ' ').trim();
          const id = `notice:${hash(`${item.name}|${kind}|${stableBody}`)}`;
          return {
            id,
            direction: 'incoming',
            kind,
            text: `${item.name} ${KIND_LABEL[kind]}`,
            /**
             * 值不值得惊动会话。
             * mention（@ 我）和 reply（回复我）是真正需要回应的；like / follow 只是知会，
             * 抖音上这两类量最大，全丢进会话会把每条都变成一次模型调用。
             * 框架看到 important === false 时只记本地日志，不上报总线。
             */
            important: kind === 'mention' || kind === 'reply',
            notice: {
              who: item.name,
              kind,
              kindLabel: KIND_LABEL[kind],
              cover: item.cover,
              /** 点开才知道，poll 阶段一律 null */
              videoId: null,
            },
          };
        });

        return {
          channel: 'douyin-notice',
          conversation: { id: 'douyin-notice/全部消息', displayName: '抖音通知' },
          messages,
          flags: {},
        };
      }, { signal });
    },

    /** 通知通道只读，不能往回发。 */
    async send() {
      throw new Error('通知通道是只读的，不能发消息。要回评论请单独实现（涉及公开发布，需要明确授权）。');
    },

    async status() {
      try {
        return await controller.withPage(async (page) => {
          await page.waitForLoadState('load').catch(() => {});
          const opened = await ensurePanel(page);
          const items = await readNoticeItems(page);
          await parkMouse(page);
          return {
            ok: true,
            loggedIn: true,
            noticeCount: items.length,
            kinds: [...new Set(items.map((item) => kindOf(item.text)))],
            /**
             * 给「到底还刷不刷」留个可查的地方：整页重载只在连续失败到阈值、且距上次
             * 重载超过 10 分钟时才会发生，每次都写一行到 logs/notice-reloads.log。
             */
            panel: {
              openedBy: opened.how,
              openCounts: { ...openCounts },
              consecutiveFailures: consecutiveOpenFailures,
              reloadsThisProcess: reloadCount,
              lastReloadAt: lastReloadAt ? new Date(lastReloadAt).toISOString() : null,
              reloadRule: `连续失败 ${RELOAD_AFTER_FAILURES} 轮 + 两次重载间隔 ≥${RELOAD_MIN_GAP_MS / 60000} 分钟`,
            },
          };
        });
      } catch (error) {
        return {
          ok: false,
          loggedIn: null,
          reason: error instanceof Error ? error.message : String(error),
          consecutiveFailures: consecutiveOpenFailures,
          reloadsThisProcess: reloadCount,
        };
      }
    },

    /**
     * 按需解析：点开某条通知的「内容文字区」，从 modal_id 里拿到作品 ID。
     * 有副作用（会打开作品弹窗），所以不放进 poll。用完把弹窗关掉。
     *
     * @param {string} noticeId  poll() 里给出的 message.id
     */
    async resolveVideo(noticeId, { signal } = {}) {
      return controller.withPage(async (page) => {
        // 上一次解析可能留下打开的 modal，甚至卡在导航中间 —— 那样后面每一次 evaluate
        // 都会抛「Execution context was destroyed」，怎么重试都没用。先回一趟干净首页。
        await page.goto(HOME, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(3000);
        await page
          .evaluate(() => {
            for (const video of document.querySelectorAll('video')) {
              video.muted = true;
              video.pause();
            }
          })
          .catch(() => {});

        await ensurePanel(page);
        const items = await readNoticeItems(page);
        // 与 poll() 用同一套 ID 算法（时间已剥掉）。两份算法必须一致，
        // 否则这里永远匹配不上，报「这条通知已经不在列表里了」——而它其实还在。
        const index = items.findIndex((item) => {
          const kind = kindOf(item.text);
          const stableBody = stripRelativeTime(item.text).replace(/\s+/g, ' ').trim();
          return `notice:${hash(`${item.name}|${kind}|${stableBody}`)}` === noticeId;
        });
        if (index < 0) throw new Error('这条通知已经不在列表里了（可能被刷新掉了）。');

        // 用「内容文字区」定位：头像和昵称会跳用户主页，只有内容区跳作品
        const content = page.getByText(/提到了你|回复了你|赞了你/).nth(index);
        if ((await content.count()) === 0) throw new Error('找不到这条通知的内容文字区。');
        const box = await content.boundingBox();
        if (!box) throw new Error('内容文字区不可见，无法点击。');

        await page.mouse.click(Math.round(box.x + box.width - 6), Math.round(box.y + box.height / 2));

        // 点开作品会触发**导航**（有时是 modal 参数变化，有时接近整页跳转）。
        // 导航期间执行上下文会被销毁，紧接着 evaluate 会抛
        // 「Execution context was destroyed, most likely because of a navigation」。
        // 所以先等 load 稳定，再用重试去读 URL。
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(2500);

        const readVideoId = () =>
          page.evaluate(() => {
            const match = /[?&]modal_id=(\d+)/.exec(location.href);
            if (match) return match[1];
            const path = /\/(?:video|note)\/(\d+)/.exec(location.pathname);
            return path ? path[1] : null;
          });

        let videoId = null;
        for (let attempt = 1; attempt <= 5 && !videoId; attempt += 1) {
          try {
            videoId = await readVideoId();
          } catch {
            // 还在导航，等一下再来
          }
          if (!videoId) await page.waitForTimeout(900);
        }

        // 关掉弹窗，别把页面留给下一个人
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(600);

        if (!videoId) throw new Error('点开了通知但没拿到作品 ID（导航后 URL 里既没有 modal_id 也没有 /video/）。');
        return { videoId, url: `https://www.douyin.com/video/${videoId}` };
      }, { signal });
    },

    async close() {
      await controller.close();
    },
  };
}

export default createChannel;
