// 专用 Edge 的宿主进程：由 controller 用 detached 方式拉起，自己写 browser.json 报活。
//
// 和插件里的 browser-host.mjs 行为一致（同一个 profile 目录、同一个调试端口），
// 这样 adopter 和 dsh 插件可以共享同一个 Edge，不会各开一个把登录态撕成两份。

import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { chromium } from './playwright.mjs';

const [profile, controlDir, portText] = process.argv.slice(2);
const port = Number(portText);
if (!profile || !controlDir || !Number.isInteger(port) || port < 1024 || port > 65535) process.exit(2);

mkdirSync(controlDir, { recursive: true });
const stateFile = path.join(controlDir, 'browser.json');

let context;

function writeState(ready) {
  const temporary = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, profile, port, ready, startedAt: Date.now() }));
  renameSync(temporary, stateFile);
}

try {
  writeState(false);
  context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge',
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--mute-audio'],
    args: [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  writeState(true);
  console.log('专用 Edge 已启动。');
  context.on('close', () => process.exit(0));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => context.close().finally(() => process.exit(0)));
  }
} catch (error) {
  // Playwright 的原始异常可能带用户资料路径，日志里只留可操作的原因。
  console.error(
    /ProcessSingleton|user data directory|profile.*in use/i.test(error.message)
      ? '专用资料目录正在被其他浏览器使用，请先正常关闭旧的专用窗口。'
      : `专用浏览器启动失败：${error.name}`,
  );
  process.exit(1);
}
