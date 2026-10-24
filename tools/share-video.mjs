// 命令行入口。真正的逻辑在 src/douyin/share.mjs —— adopter 的 POST /share 用的是同一份，
// 别在这里另写一套。
//
//   node tools/share-video.mjs --to your-name --video 7xxxxx --dry-run
//   node tools/share-video.mjs --to your-name --pick jingxuan
//   node tools/share-video.mjs --to your-name --video https://www.douyin.com/video/7xxxxx
//
// 或者直接用接口（adopter 常驻时）：
//   curl -X POST 127.0.0.1:9320/share -H "content-type: application/json" -d '{"to":"your-name","pick":"jingxuan"}'

import { shareVideo } from '../src/douyin/share.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : null;
}

const to = option('--to') || 'your-name';
const videoArg = option('--video');
const pick = option('--pick');
const dryRun = process.argv.includes('--dry-run');

try {
  const result = await shareVideo({
    videoId: videoArg,
    pick,
    to,
    dryRun,
    log: (line) => console.log(`  ${line}`),
  });

  console.log('\n=== 结果 ===');
  console.log(JSON.stringify({ ...result, steps: undefined }, null, 2));

  if (result.dryRun) {
    console.log('\n[dry-run] 没有真发。去掉 --dry-run 就会发出去。');
  } else {
    console.log(`\n✅ 已分享给「${result.to}」：${result.url}`);
  }
} catch (error) {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
