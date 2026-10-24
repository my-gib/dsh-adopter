// 客户端小工具：发内置表情 / 发本地图片 / 列可发表情。
//
// 走的是常驻 adopter 的 HTTP 端点，所以它要求 adopter 在跑（9320）。
// 真正的 DOM 逻辑在 src/dom/chat-browser.mjs，这里只是命令行外壳。
//
//   node tools/send-emoji.mjs --list              列出能发的内置表情
//   node tools/send-emoji.mjs 比心                 发一个表情（按中文名）
//   node tools/send-emoji.mjs --index 3            按序号发（第 3 个）
//   node tools/send-emoji.mjs --image "C:\a.jpg"   发本地图片（jpg/jpeg/png/gif/mp4）
//   node tools/send-emoji.mjs --image "C:\a.jpg" --caption "附带一句"
//   node tools/send-emoji.mjs --image "C:\a.jpg" --chat conv:<64位十六进制>
//
// 注意：adopter 的 /send 端点只对 `config.json` 里配了 token 的部署要求 Bearer。
// 本机默认 token 为空，这里不传。

const HOST = process.env.ADOPTER_HOST || '127.0.0.1';
const PORT = Number(process.env.ADOPTER_PORT || 9320);
const base = `http://${HOST}:${PORT}`;

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : argv[index + 1] ?? '';
};
const has = (name) => argv.includes(`--${name}`);

/** POST JSON（显式 UTF-8：中文表情名不能靠默认编码蒙） */
async function post(path, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 非 JSON 就原样报出去 */
  }
  if (!response.ok || parsed?.ok === false) {
    throw new Error(`HTTP ${response.status}：${parsed?.error ?? text.slice(0, 200)}`);
  }
  return parsed;
}

async function main() {
  const image = flag('image');
  const listOnly = has('list');

  if (listOnly) {
    const result = await post('/emojis', { channel: 'douyin' });
    console.log(`可发表情 ${result.emojis.length} 个：`);
    for (const item of result.emojis) console.log(`  ${String(item.index).padStart(2)}  ${item.name}`);
    return;
  }

  const chatId = flag('chat') || undefined;

  if (image) {
    const caption = flag('caption') || undefined;
    const payload = { channel: 'douyin', image, ...(caption ? { caption } : {}), ...(chatId ? { chatId } : {}) };
    console.log(`发图片：${image}${caption ? `（附带「${caption}」）` : ''}`);
    const result = await post('/send', payload);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const index = flag('index');
  const name = index !== null ? null : argv.find((item) => !item.startsWith('--') && item !== chatId) ?? null;
  if (index === null && !name) {
    console.log('用法：\n  node tools/send-emoji.mjs --list\n  node tools/send-emoji.mjs 比心\n  node tools/send-emoji.mjs --index 3\n  node tools/send-emoji.mjs --image "C:\\a.jpg" [--caption "一句话"]');
    process.exitCode = 1;
    return;
  }
  const emoji = index !== null ? Number(index) : name;
  if (index !== null && !Number.isSafeInteger(emoji)) throw new Error(`--index 要整数，收到「${index}」`);
  console.log(`发表情：${index !== null ? `第 ${emoji} 个` : `「${emoji}」`}`);
  const result = await post('/send', { channel: 'douyin', emoji, ...(chatId ? { chatId } : {}) });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
