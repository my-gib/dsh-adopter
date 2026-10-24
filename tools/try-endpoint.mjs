// 往真实端点 POST /send 打一条，走完整链路（端点 → 通道 → chat-browser.sendMessage）。
//
// 和 tools/try-send.mjs 的区别：那个绕开 sendMessage、自己一步步操作页面，用来定位
// 「按钮点不动」这类问题；这个不绕，测的就是生产路径到底通不通。
//
// 文本写在脚本里而不是命令行参数：Windows 命令行会把中文按 ANSI 编码传给子进程，
// 测出来可能是乱码，白折腾一次。要换文本就用 --file。
//
//   node tools/try-endpoint.mjs
//   node tools/try-endpoint.mjs --file some.txt

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const fileIndex = args.indexOf('--file');
const text = fileIndex >= 0
  ? readFileSync(args[fileIndex + 1], 'utf8').trim()
  : '收到。这条就是用来测回复的：如果能正常出现在你那边，就说明没再踩到那个草稿残留的循环。如果没收到，说一声，我';

const endpoint = process.env.ADOPTER_URL ?? 'http://127.0.0.1:9320/send';
console.log(`POST ${endpoint}`);
console.log(`文本 ${[...text].length} 字：${text.slice(0, 40)}…`);

const started = Date.now();
try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'douyin', text }),
    signal: AbortSignal.timeout(120_000),
  });
  console.log(`HTTP ${response.status}，耗时 ${Date.now() - started}ms`);
  console.log(await response.text());
} catch (error) {
  console.log(`请求失败（${Date.now() - started}ms）：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
