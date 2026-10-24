// playwright-core 的解析入口。
//
// 为什么不直接 `import { chromium } from 'playwright-core'`：
// 本项目（dsh-adopter）和 dsh 插件的 node_modules 不在一棵树上。adopter 想独立，
// 就得自己有一份；但用户环境里 playwright-core 往往已经躺在 dsh 的 web profile 里，
// 重复下载几十 MB 不值得。所以先找自己的，找不到再回退到 dsh 那份。
//
// 回退路径可通过 ADOPTER_PLAYWRIGHT_DIR 覆盖（比如 dsh 换了目录结构时）。

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

const ERRORS = [];

function attempt(label, loader) {
  try {
    const loaded = loader();
    if (!loaded?.chromium) throw new Error('包已解析但没有 chromium 导出');
    return loaded;
  } catch (error) {
    ERRORS.push(`${label} → ${error.code || error.name}: ${String(error.message).split('\n')[0]}`);
    return null;
  }
}

/** 在某个目录（当作 node_modules 的宿主）里 require 一个包。 */
function requireFrom(dir, specifier) {
  const base = path.join(dir, '__resolve__.cjs');
  return createRequire(base)(specifier);
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const home = homedir();

  const fallbacks = [
    process.env.ADOPTER_PLAYWRIGHT_DIR,
    path.join(home, '.dsh', 'profiles', 'web', 'node_modules'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules'),
  ].filter(Boolean);

  const found =
    attempt('本项目', () => require('playwright-core')) ||
    fallbacks.reduce(
      (hit, dir) => hit || attempt(`回退 ${dir}`, () => requireFrom(dir, 'playwright-core')),
      null,
    );

  if (!found) {
    throw new Error(
      '找不到 playwright-core。请在 <repo> 里执行 `npm install playwright-core`，' +
        `或用 ADOPTER_PLAYWRIGHT_DIR 指向一个含它的 node_modules。\n尝试记录：\n  ${ERRORS.join('\n  ')}`,
    );
  }
  return found;
}

const playwright = loadPlaywright();

export const { chromium } = playwright;
export const playwrightResolution = { errors: [...ERRORS] };
