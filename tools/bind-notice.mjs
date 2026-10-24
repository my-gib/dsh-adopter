// 在 dsh-notifier 的 state.json 里加一条 `douyin:notice` 绑定。
//
// 为什么这么做而不是给 notifier 加新通道：
//   1. 加新通道要改 index.mjs 装配段 + identity 的 VALID_CHANNELS，**而且必须重启 dsh**
//      才生效（ESM 缓存）—— 重启会把正在跑的会话打断。
//   2. identity.readBindings() 用的是 store.get()，注释里写明「store 读收敛让宿主进程
//      半秒内看到 CLI/管理台写入」—— 也就是改 state.json 不用重启。
//   3. 通知和私信本来就是同一个平台的两类事件，复用 8106/douyin，只是 userId 换成 notice，
//      绑定表里就是两个不同身份。
//
// 代价：notifier 那边 channel 字段仍是 'douyin'，所以会话前缀会叫「抖音 notice」而不是
// 「抖音通知」。真正的独立通道等下次重启 dsh 时再补，不急。
//
//   node tools/bind-notice.mjs

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const file = path.join(homedir(), '.dsh', 'dsh-notifier', 'state.json');
const key = 'douyin:notice';

const state = JSON.parse(readFileSync(file, 'utf8'));
const bindings = state['inbound:bindings'];

if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
  throw new Error('state.json 里的 inbound:bindings 不是对象，先人工看一眼，别硬写。');
}

if (bindings[key] !== undefined) {
  console.log(`绑定「${key}」已存在，不重复添加：`);
  console.log(JSON.stringify(bindings[key], null, 2));
  process.exit(0);
}

const backup = `${file}.bak-before-notice`;
copyFileSync(file, backup);
console.log('已备份 →', backup);

bindings[key] = {
  channel: 'douyin',
  userId: 'notice',
  label: '抖音通知',
  role: 'member',
  pairedAt: Date.now(),
  lastSeenAt: 0,
  origin: 'paired',
};
state['inbound:bindings'] = bindings;

writeFileSync(file, JSON.stringify(state, null, 2));
console.log(`\n已添加绑定「${key}」，当前绑定表：`);
console.log(JSON.stringify(bindings, null, 2));
console.log('\ndsh 进程通过 store 读收敛，半秒内会看到这条（不用重启）。');
