// 自有轻量 CDP 控制器 —— 替代插件 core.mjs 里那 43KB 的 BrowserController。
//
// 只做 ChatBrowser 真正用到的事：withPage / source / limits / close。
// 刻意不复刻插件里的视频限额、记忆库、转发器、人格卡那一整套，那些是插件自己的业务。
//
// 设计成平台无关：抖音通道传抖音的 homeUrl / readySelector，B站通道传 B站的，
// 同一个 Edge 里各占一个标签页（靠 window.name 认领），互不打扰。
//
// 连接目标固定是本机专用 Edge（CDP）。连不上会自己把 Edge 拉起来。

import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from './playwright.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_SCRIPT = path.join(HERE, 'host.mjs');
const HOME = homedir();

export const DOUYIN_RECOMMEND = 'https://www.douyin.com/?recommend=1&from_nav=1';

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function aborted(signal) {
  signal?.throwIfAborted();
}

async function wait(ms, signal) {
  await delay(ms, undefined, { signal });
}

/**
 * 跨进程文件锁。插件里叫 tab-api-chat / tab-dsh-chat，adopter 与插件靠这个互斥同一张页面。
 * 语义照抄插件：拿不到就等，持有者死掉就抢，35 秒超时。
 */
export async function lock(controlDir, name, signal) {
  mkdirSync(controlDir, { recursive: true });
  const file = path.join(controlDir, `${name}.lock`);
  const deadline = Date.now() + 35_000;
  for (;;) {
    aborted(signal);
    try {
      const descriptor = openSync(file, 'wx');
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      closeSync(descriptor);
      return () => {
        try {
          unlinkSync(file);
        } catch {
          /* 已经释放的锁不用管 */
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(readFileSync(file, 'utf8'));
        if (!alive(owner.pid)) {
          unlinkSync(file);
          continue;
        }
      } catch {
        // 空锁要等两秒且内容两读一致才敢删，避免误杀刚开始写文件的持有者。
        try {
          const content = readFileSync(file, 'utf8');
          if (Date.now() - statSync(file).mtimeMs > 2000) {
            try {
              JSON.parse(content);
            } catch {
              if (readFileSync(file, 'utf8') === content) unlinkSync(file);
            }
          }
        } catch {
          /* 别人已经释放了 */
        }
      }
      if (Date.now() > deadline) throw new Error(`「${name}」仍被占用，请稍后重试。`);
      await wait(150, signal);
    }
  }
}

export class BrowserController {
  constructor({
    source = 'api-chat',
    port = 9227,
    profileDir = path.join(HOME, '.dsh', 'douyin-browser', 'cli-profile'),
    controlDir = path.join(HOME, '.dsh', 'douyin-browser', 'control'),
    homeUrl = DOUYIN_RECOMMEND,
    readySelector = '[data-e2e="im-entry"]',
    allowedOrigins = ['https://www.douyin.com'],
    autoLaunch = true,
    /**
     * 退出时要不要关掉「本进程自己新建的」那个标签页。
     * 临时探针脚本应该关（否则每跑一次就多一个窗口）；常驻的 adopter 不要关（下次启动省一次重建）。
     * 注意只关自己新建的，认领来的空白页和别人已经开着的页一律不碰。
     */
    closePageOnExit = true,
    /** 外部可注入的时间策略：{ beforeAction(source, action) => { allowed, reason? } } */
    policy = null,
  } = {}) {
    Object.assign(this, {
      source,
      port,
      profileDir,
      controlDir,
      homeUrl,
      readySelector,
      allowedOrigins: allowedOrigins.filter(Boolean),
      autoLaunch,
      closePageOnExit,
      policy,
    });
    this.browser = null;
    this.page = null;
    this.createdPage = false;
    this.queue = Promise.resolve();
  }

  /** ChatBrowser 只在这里取时间策略；默认放行，限额由调用方决定。 */
  limits() {
    if (this.videoLimits) return this.videoLimits;
    const policy = this.policy;
    this.videoLimits = {
      beforeAction: (source, action) => {
        if (typeof policy?.beforeAction !== 'function') return { allowed: true };
        return policy.beforeAction(source, action);
      },
      state: () => ({ enabled: Boolean(policy), source: this.source }),
    };
    return this.videoLimits;
  }

  async version() {
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
        signal: AbortSignal.timeout(1200),
      });
      return response.ok && /(?:Edg|Chrome)/.test((await response.json()).Browser ?? '');
    } catch {
      return false;
    }
  }

  stateFile() {
    return path.join(this.controlDir, 'browser.json');
  }

  readState() {
    try {
      return JSON.parse(readFileSync(this.stateFile(), 'utf8'));
    } catch {
      return null;
    }
  }

  /** 拿一个可用的 CDP 端点；没在跑就把 Edge 拉起来。 */
  async endpoint(signal) {
    const release = await lock(this.controlDir, 'launch', signal);
    try {
      if (await this.version()) {
        const state = this.readState();
        const mine = state?.profile === this.profileDir && state.port === this.port && alive(state.pid);
        if (!mine) {
          throw new Error(
            `${this.port} 端口已被别的浏览器占用，不是本工具的专用 Edge。请先关掉占用它的进程。`,
          );
        }
        return `http://127.0.0.1:${this.port}`;
      }

      if (!this.autoLaunch) {
        throw new Error(`专用 Edge 没在运行（端口 ${this.port}）。请先打开它，或允许 autoLaunch。`);
      }

      mkdirSync(this.controlDir, { recursive: true });
      const output = openSync(path.join(this.controlDir, 'browser-host.log'), 'a');
      try {
        const child = spawn(
          process.execPath,
          [HOST_SCRIPT, this.profileDir, this.controlDir, String(this.port)],
          { detached: true, windowsHide: true, stdio: ['ignore', output, output] },
        );
        child.unref();
      } finally {
        closeSync(output);
      }

      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        aborted(signal);
        await wait(250, signal);
        const state = this.readState();
        if (!state) continue;
        if (!alive(state.pid)) {
          throw new Error('专用 Edge 启动失败；请关闭仍占用 cli-profile 的旧窗口后重试。');
        }
        if (state.ready && state.profile === this.profileDir && state.port === this.port && (await this.version())) {
          return `http://127.0.0.1:${this.port}`;
        }
      }
      throw new Error('专用 Edge 启动超时，详情见控制目录里的 browser-host.log。');
    } finally {
      release();
    }
  }

  label() {
    return `deepseek-douyin-${this.source}`;
  }

  async pageName(page) {
    return page.evaluate(() => window.name).catch(() => '');
  }

  async connect(signal) {
    aborted(signal);
    if (this.browser?.isConnected() && this.page && !this.page.isClosed()) return this.page;

    if (!this.browser?.isConnected()) {
      this.browser = await chromium.connectOverCDP(await this.endpoint(signal), { timeout: 30_000 });
      this.page = null;
    }

    const context = this.browser.contexts()[0];
    if (!context) throw new Error('专用 Edge 没有可用窗口，请先在专用窗口里完成登录或验证。');
    const label = this.label();

    for (const candidate of context.pages()) {
      if (candidate.isClosed()) continue;
      if ((await this.pageName(candidate)) === label) {
        this.page = candidate;
        break;
      }
    }

    if (!this.page || this.page.isClosed()) {
      // 优先认领一个空的初始页，别在用户窗口里无限堆标签。
      const blanks = [];
      for (const candidate of context.pages()) {
        if (candidate.isClosed() || candidate.url() !== 'about:blank') continue;
        const pristine = await candidate
          .evaluate(
            () =>
              !window.name && !document.body?.textContent?.trim() && document.querySelectorAll('body *').length === 0,
          )
          .catch(() => false);
        if (pristine) blanks.push(candidate);
      }
      if (blanks.length === 1) {
        this.page = blanks[0];
        this.createdPage = false; // 认领来的，不算自己新建，退出时不能关
      } else {
        this.page = await context.newPage();
        this.createdPage = true;
      }
    }

    this.page.setDefaultTimeout(10_000);
    this.page.setDefaultNavigationTimeout(25_000);
    await this.page.evaluate((name) => {
      window.name = name;
    }, label);

    aborted(signal);
    if (this.page.url() === 'about:blank') {
      await this.page.goto(this.homeUrl, { waitUntil: 'domcontentloaded' });
      await this.page.evaluate((name) => {
        window.name = name;
      }, label);
      if (this.readySelector) {
        await this.page.locator(this.readySelector).waitFor({ state: 'visible', timeout: 15_000 });
      }
    }
    return this.page;
  }

  withPage(callback, { signal } = {}) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const release = await lock(this.controlDir, `tab-${this.source}`, signal);
      const onAbort = () => {
        this.browser?.close().catch(() => {});
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        aborted(signal);
        const page = await this.connect(signal);
        aborted(signal);
        if (this.allowedOrigins.length) {
          let origin = null;
          try {
            origin = new URL(page.url()).origin;
          } catch {
            /* about:blank 之类，下面按不允许处理 */
          }
          if (!this.allowedOrigins.includes(origin)) {
            throw new Error(`专用标签页已离开允许的站点（当前 ${origin ?? page.url()}），请回到页面后重试。`);
          }
        }
        return await callback(page, signal);
      } finally {
        signal?.removeEventListener('abort', onAbort);
        release();
      }
    });
    this.queue = operation;
    return operation;
  }

  async close() {
    // 只关自己新建的页面：探针脚本跑完自动收摊，别在人家窗口里留一地标签页
    if (this.closePageOnExit && this.createdPage && this.page && !this.page.isClosed()) {
      await this.page.close().catch(() => {});
    }
    try {
      await this.browser?.close();
    } catch {
      /* 断开连接失败不影响退出 */
    }
    this.browser = null;
    this.page = null;
    this.createdPage = false;
  }
}
