// 端到端验证：通知通道在**打不开浮层**时到底会不会刷页面。
//
// 做法：把「通知」入口临时 display:none 掉，制造「hover 也开不了」的状态，
// 然后调通道自己的 poll()，看三件事：
//   1. 本轮是「放弃」还是「重载页面」（应当放弃，抛一条清楚的错）
//   2. 页面的 performance.timeOrigin 有没有变（变了就是整页重载 —— 不该变）
//   3. logs/notice-reloads.log 有没有多出一行（不该多）
// 最后把 DOM 恢复，再调一次 poll()，确认能自己回到正常（hover 打开）。
//
// ⚠️ 要在 **adopter 停掉**的时候跑：两边都抢 tab-douyin-notice 锁、操作同一张页面，
//    同时跑会互相干扰（不会崩，但验证结果不可信）。
//
//   node tools/verify-notice-no-reload.mjs

import { existsSync, readFileSync } from 'node:fs';

import { BrowserController } from '../src/browser/controller.mjs';
import { RELOAD_LOG } from '../src/channels/douyin-notice.mjs';
import { loadChannel } from '../src/channels/registry.mjs';

const HOME = 'https://www.douyin.com/?recommend=1&from_nav=1';

const reloadLogLines = () => {
  try {
    return existsSync(RELOAD_LOG) ? readFileSync(RELOAD_LOG, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  } catch {
    return 0;
  }
};

const channel = await loadChannel('douyin-notice', {});
// 和通道同一个 source → 同一个 window.name → 同一张页面。
const controller = new BrowserController({
  source: 'douyin-notice',
  homeUrl: HOME,
  readySelector: '',
  allowedOrigins: ['https://www.douyin.com'],
  closePageOnExit: false,
});

/** 页面当前状态：URL、是否重载过、入口可见几个。 */
const snapshotPage = () =>
  controller.withPage(async (page) => {
    await page.mouse.move(4, 4).catch(() => {});
    await page.waitForTimeout(400);
    return page.evaluate(() => {
      const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
      const entries = [...document.querySelectorAll('div,span,a,button')].filter((el) => clean(el.innerText) === '通知');
      return {
        url: location.href,
        origin: performance.timeOrigin,
        entries: entries.length,
        visibleEntries: entries.filter((el) => el.checkVisibility?.() ?? el.offsetParent !== null).length,
        panelOpen: Boolean(document.querySelector('[data-e2e="user-name-card"]')) && document.body.innerText.includes('互动消息'),
      };
    });
  });

/** 把「通知」入口藏起来（模拟页面状态坏死：hover 也开不了）。 */
const hideEntry = () =>
  controller.withPage(async (page) =>
    page.evaluate(() => {
      const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
      const targets = [...document.querySelectorAll('div,span,a,button')].filter((el) => clean(el.innerText) === '通知');
      for (const el of targets) {
        el.setAttribute('data-adopter-hidden', '1');
        el.style.setProperty('display', 'none', 'important');
      }
      return targets.length;
    }),
  );

const restoreEntry = () =>
  controller.withPage(async (page) =>
    page.evaluate(() => {
      const restored = [...document.querySelectorAll('[data-adopter-hidden]')];
      for (const el of restored) {
        el.style.removeProperty('display');
        el.removeAttribute('data-adopter-hidden');
      }
      return restored.length;
    }),
  );

const steps = [];

async function runPoll(label) {
  const before = await snapshotPage();
  const startedAt = Date.now();
  let outcome;
  try {
    const snapshot = await channel.poll({});
    outcome = { ok: true, count: snapshot.messages.length };
  } catch (error) {
    outcome = { ok: false, error: String(error?.message ?? error).slice(0, 220) };
  }
  const ms = Date.now() - startedAt;
  const after = await snapshotPage();
  const step = {
    label,
    ms,
    ...outcome,
    urlChanged: before.url !== after.url,
    pageReloaded: before.origin !== after.origin,
    beforeUrl: before.url,
    afterUrl: after.url,
    entriesVisibleBefore: before.visibleEntries,
    entriesVisibleAfter: after.visibleEntries,
    reloadLogLines: reloadLogLines(),
  };
  steps.push(step);
  console.log(
    `\n[${label}] ${step.ok ? `成功，读到 ${step.count} 条` : '按预期放弃'}｜耗时 ${ms}ms` +
      `｜页面重载=${step.pageReloaded}｜URL 变化=${step.urlChanged}｜可见入口 ${step.entriesVisibleBefore}→${step.entriesVisibleAfter}` +
      `｜重载日志行数=${step.reloadLogLines}`,
  );
  if (!step.ok) console.log(`    放弃原因：${step.error}`);
  return step;
}

try {
  await runPoll('1 入口正常（基线）');

  const hidden = await hideEntry();
  console.log(`\n（已把 ${hidden} 个「通知」入口设为 display:none）`);
  await runPoll('2 入口被藏起来');
  await runPoll('3 入口仍然藏着（第二次连续失败）');

  const restored = await restoreEntry();
  console.log(`\n（已恢复 ${restored} 个入口）`);
  await runPoll('4 恢复入口后');

  const report = {
    steps,
    verdict: {
      打不开时是否刷了页面: steps.filter((s) => !s.ok && s.pageReloaded).length > 0,
      放弃轮次是否写了重载日志: steps.some((s) => !s.ok && s.reloadLogLines > 0),
      恢复后是否自愈: steps.find((s) => s.label.startsWith('4'))?.ok ?? null,
      总重载次数: steps.filter((s) => s.pageReloaded).length,
    },
  };
  console.log('\n=== 结论 ===');
  console.log(JSON.stringify(report.verdict, null, 2));
} finally {
  await channel.close().catch(() => {});
  await controller.close().catch(() => {});
}
