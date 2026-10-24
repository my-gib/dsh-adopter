// 把一个抖音作品分享给指定好友。
//
// 这段逻辑原来只在 tools/share-video.mjs 里，现在抽出来给两边用：
//   - adopter.mjs 的 POST /share
//   - tools/share-video.mjs 的命令行
//
// ── 两种页面布局（都会遇到）─────────────────────────────────────────
//   A) 图文 / note 页：右侧竖列，[data-e2e="video-player-share"] 可见
//   B) 视频详情页  ：底部横排「赞/评/藏/转发」，四个按钮没有 data-e2e，
//                    只有 .o2tLobnl 容器；而 video-player-share 节点存在但尺寸 0x0
//
// ── 三个必须守住的坑（都实测踩过）─────────────────────────────────
//   1. 转发是 **hover** 出面板，click 会把面板关掉。所以 hover 优先，click 只兜底。
//   2. 点错一位就是给人家点赞，所以底部那排必须按 left 排序取最右，且同一个 left 先去重。
//   3. 复用标签页时 controller 不会重新导航，可能停在推荐流上——那样分享的是
//      流里当前那条视频。所以必须校验「页面上的作品 ID == 目标 ID」才继续。
//
// ── 选择器（2026-10-23 现场挖的，抖音改版就重挖）──────────────────
//   面板 .VzoNDwLw / 好友行 .otFjqQEX / 名字 .EnYt_IKl / 按钮 .xu0OjnsQ

import { BrowserController } from '../browser/controller.mjs';

const PANEL = '.VzoNDwLw';
const FRIEND_ROW = '.otFjqQEX';
const FRIEND_NAME = '.EnYt_IKl';
const FRIEND_BUTTON = '.xu0OjnsQ';
const SHARE_ICON = '[data-e2e="video-player-share"]';
const ACTION_BUTTON = '.o2tLobnl';
const MARKED_SHARE = '[data-adopter-share="1"]';

const JINGXUAN = 'https://www.douyin.com/jingxuan';

/** 接受「纯数字 ID」或各种抖音链接，抽出作品 ID；抽不出就抛错。 */
export function parseVideoId(input) {
  const value = String(input ?? '').trim();
  if (!value) throw new Error('缺少作品 ID 或链接。');
  if (/^\d{6,25}$/.test(value)) return value;
  const match = /\/(?:video|note)\/(\d+)/.exec(value) ?? /[?&](?:modal_id|aweme_id)=(\d+)/.exec(value);
  if (match) return match[1];
  throw new Error(`从「${value.slice(0, 60)}」里认不出作品 ID。给纯数字 ID 或 douyin.com/video/数字 的链接。`);
}

/** 在候选页（默认精选）上捡一条作品 ID。 */
async function pickFromPage(page, sourceUrl) {
  await page.goto(sourceUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  return page.evaluate(() => {
    const tagged = document.querySelector('[data-aweme-id]');
    const fromAttribute = tagged?.getAttribute('data-aweme-id');
    if (/^\d{15,20}$/.test(fromAttribute ?? '')) return fromAttribute;
    for (const link of document.querySelectorAll('a[href*="/video/"]')) {
      const match = /\/video\/(\d+)/.exec(link.getAttribute('href') ?? '');
      if (match) return match[1];
    }
    return null;
  });
}

/** 停掉页面上的视频，别在后台吵。 */
async function silenceVideos(page) {
  await page
    .evaluate(() => {
      for (const video of document.querySelectorAll('video')) {
        video.muted = true;
        video.pause();
      }
    })
    .catch(() => {});
}

/** 确认当前页面就是目标作品；不是就导航过去，导航完还不符就抛错。 */
async function ensureOnWorkPage(page, videoId) {
  if (!page.url().includes(String(videoId))) {
    await page.goto(`https://www.douyin.com/video/${videoId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3200);
    await silenceVideos(page);
  }

  const onPageId = await page.evaluate(() => {
    const match = /\/(?:video|note)\/(\d+)/.exec(location.pathname);
    return match ? match[1] : null;
  });
  if (!onPageId) throw new Error('当前不在作品详情页（URL 里没有作品 ID），无法确定会分享哪一条，已停止。');
  if (String(onPageId) !== String(videoId)) {
    throw new Error(`页面上的作品是 ${onPageId}，和目标的 ${videoId} 不一致，已停止。`);
  }
  return onPageId;
}

/**
 * 找到分享入口。
 * 返回一个 Playwright locator（不直接点，交给 openPanel 决定 hover 还是 click）。
 */
async function locateShareEntry(page) {
  const icon = page.locator(SHARE_ICON);
  await icon.first().waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
  const visibility = await icon.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { size: `${Math.round(box.width)}x${Math.round(box.height)}`, display: style.display, visibility: style.visibility };
    }),
  );
  const visibleIndex = visibility.findIndex(
    (item) => !item.size.startsWith('0x') && item.display !== 'none' && item.visibility !== 'hidden',
  );

  if (visibleIndex >= 0) {
    return { layout: 'A', entry: icon.nth(visibleIndex), detail: '右侧竖列' };
  }

  // 布局 B：底部操作栏，取最右那个（转发）
  const marked = await page.evaluate(
    ({ actionSelector, markAttr }) => {
      for (const stale of document.querySelectorAll(`[${markAttr}]`)) stale.removeAttribute(markAttr);
      const raw = [...document.querySelectorAll(actionSelector)]
        .filter((element) => element.querySelector('svg'))
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 24 && box.height > 24)
        .sort((a, b) => a.box.left - b.box.left || b.box.width - a.box.width);

      const unique = [];
      for (const item of raw) {
        if (unique.some((kept) => Math.abs(kept.box.left - item.box.left) < 6)) continue;
        unique.push(item);
      }
      if (unique.length < 4) return { ok: false, reason: `只找到 ${unique.length} 个候选按钮` };

      const rowTop = unique[0].box.top;
      const row = unique.filter((item) => Math.abs(item.box.top - rowTop) < 12);
      if (row.length < 4) return { ok: false, reason: `同一行只有 ${row.length} 个按钮` };

      const target = row[row.length - 1];
      target.element.setAttribute(markAttr, '1');
      return {
        ok: true,
        rowSize: row.length,
        rect: `${Math.round(target.box.width)}x${Math.round(target.box.height)}@${Math.round(target.box.left)},${Math.round(target.box.top)}`,
      };
    },
    { actionSelector: ACTION_BUTTON, markAttr: 'data-adopter-share' },
  );

  if (!marked.ok) throw new Error(`底部操作栏定位失败：${marked.reason}。抖音可能改版了，重跑 tools/probe-actionbar.mjs。`);

  const entry = page.locator(MARKED_SHARE);
  await entry.waitFor({ state: 'visible', timeout: 10_000 });
  return { layout: 'B', entry, detail: `底部操作栏，同行 ${marked.rowSize} 个，目标 ${marked.rect}` };
}

/** 打开分享面板：hover 优先（视频页 hover 才对，click 会关掉），click 只兜底。 */
async function openPanel(page, entry) {
  const panel = page.locator(PANEL);
  const waitPanel = (ms) =>
    panel
      .first()
      .waitFor({ state: 'visible', timeout: ms })
      .then(() => true)
      .catch(() => false);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await entry.hover({ timeout: 8000 }).catch(() => {});
    if (await waitPanel(4000)) return { how: 'hover', attempts: attempt };
    await entry.click({ timeout: 8000 }).catch(() => {});
    if (await waitPanel(3000)) return { how: 'click', attempts: attempt };
    await page.waitForTimeout(1000);
  }
  throw new Error('打不开分享面板（hover 和 click 都试了 3 轮）。');
}

/** 在面板里按昵称精确匹配好友行。必须唯一命中，否则不发。 */
async function findFriendRow(page, friendName) {
  const info = await page.evaluate(
    ({ rowSelector, nameSelector, buttonSelector, want }) => {
      const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
      const rows = [...document.querySelectorAll(rowSelector)].map((row, index) => ({
        index,
        name: clean(row.querySelector(nameSelector)?.textContent),
        buttonText: clean(row.querySelector(buttonSelector)?.textContent),
        hasButton: Boolean(row.querySelector(buttonSelector)),
      }));
      return { rows, matched: rows.filter((row) => row.name === want) };
    },
    { rowSelector: FRIEND_ROW, nameSelector: FRIEND_NAME, buttonSelector: FRIEND_BUTTON, want: friendName },
  );

  if (info.matched.length === 1) return { target: info.matched[0], rows: info.rows, unique: true };
  if (info.matched.length > 1) throw new Error(`面板里有 ${info.matched.length} 个同名好友「${friendName}」，无法确定发给谁，已停止。`);

  const near = info.rows.filter((row) => row.name.includes(friendName) || friendName.includes(row.name));
  const list = info.rows.map((row) => row.name).join('、') || '（空）';
  throw new Error(
    near.length
      ? `好友名没有完全匹配。面板里相近的是：${near.map((row) => JSON.stringify(row.name)).join('、')}。用面板里的原样名字重试。`
      : `面板里找不到好友「${friendName}」。面板里只有：${list}`,
  );
}

/**
 * 分享一个作品给好友。
 *
 * @param {object} options
 * @param {string} [options.videoId]   作品 ID 或链接；给了就用它
 * @param {string} [options.pick]      'jingxuan' 表示从精选页捡一条
 * @param {string} [options.to]        好友昵称（必须和私信面板里完全一致）
 * @param {boolean} [options.dryRun]   true 只走到找到好友和按钮，不点
 * @param {(msg: string) => void} [options.log]  进度回调
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} 结构化结果；失败抛错
 */
export async function shareVideo({ videoId, pick, to = 'your-name', dryRun = false, log = () => {}, signal } = {}) {
  if (!videoId && !pick) throw new Error('要么给 videoId（作品 ID 或链接），要么给 pick="jingxuan"。');

  const target = parseVideoIdSafe(videoId);

  const controller = new BrowserController({
    source: 'api-forward',
    homeUrl: target ? `https://www.douyin.com/video/${target}` : JINGXUAN,
    readySelector: '',
    allowedOrigins: ['https://www.douyin.com'],
    // 分享用的是一次性标签页，用完就关，别在用户窗口里堆
    closePageOnExit: true,
  });

  const steps = [];
  const note = (label, value) => {
    steps.push(`${label}: ${value}`);
    log(`${label}: ${value}`);
  };

  try {
    return await controller.withPage(async (page) => {
      await page.waitForLoadState('load').catch(() => {});
      await page.waitForTimeout(3200);
      await silenceVideos(page);

      // 1. 确定作品
      let resolvedId = target;
      if (!resolvedId) {
        const sourceUrl = pick === 'jingxuan' || pick === true ? JINGXUAN : String(pick);
        note('候选页', sourceUrl);
        resolvedId = await pickFromPage(page, sourceUrl);
        if (!resolvedId) throw new Error('候选页里没取到作品 ID。');
        note('取到作品', resolvedId);
      }

      // 2. 站到正确的作品页上（这一步是安全底线）
      const onPageId = await ensureOnWorkPage(page, resolvedId);
      note('作品 ID', onPageId);
      note('页面标题', (await page.title()).slice(0, 50));

      // 3. 找分享入口
      const located = await locateShareEntry(page);
      note('布局', `${located.layout}（${located.detail}）`);

      // 4. 打开面板
      const opened = await openPanel(page, located.entry);
      note('打开面板', `${opened.how}，第 ${opened.attempts} 轮`);

      // 5. 找好友
      const friend = await findFriendRow(page, to);
      note('命中好友', `${JSON.stringify(friend.target.name)}（第 ${friend.target.index} 行，按钮「${friend.target.buttonText}」）`);

      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          shared: false,
          videoId: onPageId,
          url: `https://www.douyin.com/video/${onPageId}`,
          to: friend.target.name,
          layout: located.layout,
          wouldClickButton: friend.target.buttonText,
          steps,
        };
      }

      // 6. 真发
      const row = page.locator(FRIEND_ROW).nth(friend.target.index);
      const button = row.locator(FRIEND_BUTTON);
      if ((await button.count()) !== 1) throw new Error('该好友行里没有唯一的分享按钮，未点击。');

      await button.click({ timeout: 8000 });
      await page.waitForTimeout(2000);

      const outcome = await page.evaluate(
        ({ rowSelector, nameSelector, buttonSelector, want }) => {
          const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
          const rows = [...document.querySelectorAll(rowSelector)].map((row) => ({
            name: clean(row.querySelector(nameSelector)?.textContent),
            buttonText: clean(row.querySelector(buttonSelector)?.textContent),
          }));
          return {
            myRow: rows.find((row) => row.name === want) ?? null,
            saidSuccess: /分享成功/.test(clean(document.body.innerText)),
            bodyHint: clean(document.body.innerText).slice(0, 160),
          };
        },
        { rowSelector: FRIEND_ROW, nameSelector: FRIEND_NAME, buttonSelector: FRIEND_BUTTON, want: friend.target.name },
      );

      const buttonChanged = Boolean(outcome.myRow?.buttonText) && outcome.myRow.buttonText !== friend.target.buttonText;
      const confirmed = buttonChanged || outcome.saidSuccess;
      note('界面确认', `按钮「${friend.target.buttonText}」→「${outcome.myRow?.buttonText ?? '?'}」，分享成功文案=${outcome.saidSuccess}`);

      if (!confirmed) {
        throw new Error(`点了分享但界面没给出确认（按钮没变、也没出现「分享成功」）。页面片段：${outcome.bodyHint}`);
      }

      return {
        ok: true,
        shared: true,
        confirmed,
        videoId: onPageId,
        url: `https://www.douyin.com/video/${onPageId}`,
        to: friend.target.name,
        layout: located.layout,
        evidence: { buttonChanged, saidSuccess: outcome.saidSuccess, buttonText: outcome.myRow?.buttonText ?? null },
        steps,
      };
    }, { signal });
  } finally {
    await controller.close().catch(() => {});
  }
}

/** videoId 可能是链接，解析失败时原样返回 null（让 pick 接手）。 */
function parseVideoIdSafe(input) {
  if (!input) return null;
  return parseVideoId(input);
}
