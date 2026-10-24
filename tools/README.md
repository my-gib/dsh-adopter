# tools/ 索引

> 2026-10-24 整理。共 100 个文件，**别从头翻**——按下面三档找。
> 判据：**日常会敲的 / 改版时才用的 / 历史存档**。

---

## 一、日常会用（记住这几条就够）

| 命令 | 干什么 |
|---|---|
| `node tools/peek-bili.mjs` | B 站私信最近若干条（含 `--status` 看登录态、`--raw` 看原始结构） |
| `node tools/send-bili.mjs --to <uid> --text "…"` | 发 B 站私信。**默认 dry-run**，加 `--send` 才真发 |
| `node tools/bili-login.mjs` | B 站扫码续期：生成二维码 → 经 NapCat 发到 QQ → 扫完自动写回凭证 |
| `node tools/peek.mjs [n]` | 抖音私信最近 n 条（会抢 `tab-api-chat` 锁，和常驻进程冲突时先停它） |
| `node tools/peek-notice.mjs` | 抖音通知列表 |
| `node tools/verify-bili-inbound.mjs` | 自检：往 `8107/bilibili` POST 一条，看 notifier 收不收 |
| `node tools/verify-bili-image-capture.mjs` | 自检：B 站图片落盘链路（含 `--fail-drill` 失败演练） |
| `node tools/cleanup-pages.mjs --close` | 关掉探针留下的标签页（默认只列不关） |
| `node tools/clear-draft.mjs --index 0` | 清某会话输入框草稿。**发送失败后通道被草稿堵死时用这个** |
| `node tools/dump-pages.mjs` | 每张页面叫什么、停在哪、导航类型 |
| `node tools/watch-page-reloads.mjs 10` | 挂 10 分钟数重载次数（区分 adopter 的 goto 和页面自己 reload） |

## 二、改版时才用（平台 DOM 一变，重跑它们重新拿选择器）

- `probe-*.mjs`（58 个）—— 一次性侦察：评论、表情、媒体、群聊、通知、分享面板……
- `recon-*.mjs`（6 个）—— 表情面板 DOM 的逐层 recon
- `diagnose-*.mjs` / `diag-*.mjs` / `inspect-*.mjs` / `try-*.mjs` —— 故障定位与端点试探
- `manual-*.mjs` —— 手动操作辅助（比如手动敲一条评论看 DOM 怎么变）
- `verify-*.mjs` —— 失败注入式验证（`verify-send-guard` / `verify-notice-no-reload`）
- 其余单跑：`dump-card`（已移 legacy）、`open-share` / `check-share` / `pick-video` / `shot` / `send-media` / `bind-notice` / `make-dirty-editor` / `navigate-notice-home`

⚠️ 这些探针大都会**真开浏览器**、部分会**抢常驻进程的锁**。跑之前先想清楚要不要停 adopter。

## 三、历史存档

- `legacy/` —— 根目录搬过来的旧脚本：`dump-card.mjs`、`open-card.mjs`、`peek-last.mjs`、`read-draft.mjs`、`p3.txt`。零引用，留着当证据
- 侦察截图与原始输出在 `../logs/recon/`（`screenshots/` 33 张 / `texts/` 16 个）

---

## 相关文档

| 文档 | 内容 |
|---|---|
| `../STATUS.md` | 一页纸：现在有什么、怎么用、最重要的坑 |
| `../README.md` | 完整说明 |
| `../HANDOFF.md` | 历史账本（每一轮改了什么、为什么） |
| `../NEXT.md` | 下一步计划（部分已过时，看日期） |
| `../docs/bilibili/` | B 站接入的两份调研报告（判断 + 可行性） |
| `../backup/config/` | `config.json` 的历史备份 |
