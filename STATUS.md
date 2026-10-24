# STATUS

> 一页纸看清「现在有什么、怎么用、坑在哪」。详细历史在 `HANDOFF.md`，插件侧问题在 `ISSUES-PLUGIN.md`。
> 最后更新：2026-10-24

## 这是什么

把**抖音网页版**接进本机总线的适配器。抖音没有推送协议，所以由本进程轮询浏览器 DOM，
把消息伪装成「有推送」上报给 `dsh-notifier`，再把回复写回网页。

原来的 `dsh-douyin-browser-local` 插件还在，其他网页社交平台的接入走这个项目。
B 站**目前不在这里做任何事**（看 → 浏览器 + `bilibili_extract`；评论 → 暂缓，以后单独接；
私信 → 不做），但**不是永远不做** —— 见下面「现在有什么」那三行。

## 现在有什么

| 能力 | 状态 | 入口 |
|---|---|---|
| 收私信 | ✅ | 常驻轮询，`[抖音 your-name]` 前缀进会话 |
| 收群消息 | ✅ | `config.channels[douyin].groups` 里配群 conv ID；群里只有已绑定身份（your-name）的话进会话 |
| 发私信（文字） | ✅ | `POST 127.0.0.1:9320/send`，`confirmed` 只认界面回读 |
| 发群消息 | ✅ | 同一个 `/send`，`chatId` 换成群 conv ID（`node adopter.mjs --dump-contacts` 能看到） |
| 发内置表情 | ✅ | `/send` 带 `"emoji": "比心"`；`POST /emojis` 查可用名单（21 个，都有中文名） |
| 发本地图片 | ✅ | `/send` 带 `"image": "<本机绝对路径>"`，可另带 `caption`；jpg/png/gif/mp4，≤20MB |
| 收通知（@/评论/赞/关注） | ✅ | `channels/douyin-notice.mjs`，`mention`/`reply` 才进会话；**hover 打开浮层、轮询不刷页面**（见坑 12） |
| 解析好友分享的作品 | ✅ | `message.share`（作者 + 封面） |
| 看到表情/图片/卡片的画面 | ✅ | 落盘到 `capture/`，路径随上报；`POST /observe` 可按需补取 |
| 点开分享拿作品 ID | ✅ | `openShare()` / `tools/open-share.mjs` |
| 主动分享视频给好友 | ✅ | `POST /share` 或 `tools/share-video.mjs` |
| 从 @ 通知回复评论 | ⚠️ 能跑但会触发风控 | `tools/reply-comment.mjs` |
| B 站 · 看（列表/字幕/评论/画面） | 不归本项目 | 浏览器扒基础信息 + `bilibili_extract`（dsh-bilibili），流程见 `browse-social-feeds` skill |
| B 站 · 说（发/回评论） | ⏸ 暂缓，以后单独接 | 2026-10-24 用户暂缓（「稍等，后面再处理」），工具还没做；**不该做成通道** —— 评论是「一次动作」不是「会话」（形状参考 `tools/reply-comment.mjs`） |
| B 站 · 私信会话 | ❌ 有意不做 | `channels/bilibili.mjs` 只是占位：过 `validateChannel`、能被 `--list-channels` 列出、调用时如实报未实现（理由见 `B站接入-总纲.md` §2.1，若还在） |
| 开机自启 | ✅ | 启动文件夹里的 `start-adopter.vbs` |

## 怎么用

```powershell
# 常驻（已在跑，一般不用手动起）
node adopter.mjs
node adopter.mjs --status          # 各通道自检
node adopter.mjs --list-channels   # 有哪些通道
node adopter.mjs --dump-contacts   # 拿 recipientId

# 看现在什么情况
curl 127.0.0.1:9320/status

# 日常排查
node tools/peek.mjs 8              # 私信最近 8 条（带方向）
node tools/peek-notice.mjs         # 通知列表
node tools/cleanup-pages.mjs --close  # 清掉探针页（默认只列不关）
node tools/clear-draft.mjs --index 0  # 清某个会话的输入框草稿（发送失败后通道被堵时用）
node tools/probe-group-chat.mjs --index 0  # 看群里消息的发言人/@ 结构（群相关探针，改版时要重跑）
node tools/probe-poll-cost.mjs       # 实测一轮轮询花多久、几个群会追不上（加群前先跑）

# 通知通道：页面到底还刷不刷
node tools/dump-pages.mjs            # 每张页面叫什么、停在哪、导航类型、入口有没有
node tools/watch-page-reloads.mjs 10 # 挂 10 分钟数重载次数（区分 adopter 的 goto / 页面自己 reload）
node tools/navigate-notice-home.mjs --go   # 通知页被带到个人主页时拨回首页（一次性）
node tools/verify-notice-no-reload.mjs     # 失败注入：藏掉入口，验证「打不开也不刷页面」（要停 adopter 跑）
node tools/probe-notice-hover.mjs          # 复验「通知」是 hover 打开、移开鼠标能收起

# 测试
npm test                           # 35 个用例，不碰浏览器
```

## 最重要的坑（都实测踩过）

1. **消息列表是滑动窗口**（约 11 条）。`incoming` 会变 0 条，日志只剩「已知 0 条」——
   看起来像坏了，其实正常。`/status` 的 `window` 字段能分辨。
2. **点开发送 = 可能触发短信验证**，但**弹验证 ≠ 没发出去**。实测评论其实已提交。
   撞到就停、不碰验证码，人工处理完再核实评论区。
3. **兜底发送前必须剥纯文本**。Slate 会改写 Markdown，回读比对不上 → 留草稿 → 堵死通道。
   **清草稿必须走 `Ctrl+A`+`Delete`**：`textContent=''` 只清 DOM，编辑器 model 里的字还在
   ——`innerText` 读 0 字、下一次输入却把旧文本渲染回来，失败一次多攒一段（自累积）。
   见 HANDOFF 第二十二节。
4. **页面的 window.name 是唯一身份**。复用旧标签页时 controller 不导航，可能停在推荐流上——
   所以分享/评论前必须校验「页面上的作品 ID == 目标 ID」。
5. **发送键/回复框别按颜色和文字找**。评论发送键红色在 svg 内部（`backgroundColor` 透明），
   回复框和主评论框同名——判据只能是「编辑器右侧最右的 36×36 图标」「`closest(comment-item)`」。
6. **媒体画面必须当场取，不能事后补**。私信列表是约 11 条的滑动窗口，消息被挤出去之后
   `captureMessage` 只会在视口里找不到它；所以表情/图片在**轮询那一刻**就下载落盘，
   而不是等会话想看时再截。顺带：表情包 CDN 上有 280×280 原图，比页面里 110×110 的显示更清楚。
7. **发表情 / 发图片完全不走编辑器**，所以它们不会留草稿、也不会堵死文本发送——
   但代价是**不能靠文字回读确认**：表情要点一项就发出去（面板会自己关），图片要
   点上传→**在确认弹窗里再点一次「发送」**（选完文件只是待确认）。两条都在
   `chat-browser.mjs` 的 `sendEmoji` / `sendImage` 里，判据都是「前后消息 ID 差集 + 类型」。
8. **表情面板是 `semi-modal` 模态遮罩**，会拦住对笑脸图标本身的点击 —— 所以「再点一次笑脸」
   和 ESC **都关不掉**它，只能点面板外的消息区；而且它**会记住上次停留的 tab**，
   第 0 个 tab 才是带中文名的内置表情，其余是没有名字的表情包。名字只存在于面板里，
   发出去的气泡上**没有** alt/aria-label，所以"发哪个表情"只能按名字在面板里指定。
9. **群会话的标题带成员数，列表不带**。列表里是 `示例群`，会话头部是 `示例群(5)`。
   凡是拿「列表名 vs 头部名」做相等比较的地方，群会话都会失败，而且失败得很安静：
   `select()` 会卡在 `waitForFunction` 超时（群根本打不开）、发送按钮定位为 0（报
   「没有唯一的指定会话发送按钮」）。**三处**都要处理：身份核对、发送按钮正则、发送后回读。
   现在的做法是 `stripMemberCount()` + `sameIdentity()` / `sameName()`，且**只对
   `isGroupHint === true` 放宽**，单聊仍然严格相等。
10. **群会话的发送按钮在 350ms 内不稳定**。群会话每轮轮询都被切走再切回，刚打开时
   浮层有滑入动画、消息列表还在滚到底部，Playwright 的 350ms 稳定性窗口刚好卡住：
   `trial` 能过、真点超时。更糟的是**文字留在输入框变成草稿**，而 `sendMessage` 开头
   的硬闸「当前会话已有草稿，已停止发送」会让一次失败变成永久堵死。
   修法：群会话点击前等 500ms、超时放宽到 3000ms（单聊参数不动）；
   草稿用 `node tools/clear-draft.mjs` 清（`Ctrl+A`+`Delete`）。
11. **`isGroup` 那个判据是坏的，别信它**。`[class*="GroupAvatar"]` 在抖音里根本不存在
   （真实类名见抖音自己的 CSS，`tools/probe-group-classes.mjs` 会 dump 到
   `logs/group/classes.txt`），所以它恒为 `false`，那句「属于群聊，已停止操作」
   **从来没生效过**。可靠的群判据是：头像容器是 `commonConversationIcon` 且**没有**
   `commonIMAvatar`（→ `isGroupHint`）；`*headImageGroup` 只在没设群头像、用成员头像
   拼图时才出现，不能当唯一判据。
12. **「通知」入口是 hover 打开的，不是 click；轮询绝不许自己 goto**。
   - hover 后浮层 0.4~0.9 秒出现，移开鼠标约 220ms 收起；**ESC 关不掉它**。
     `click` 之所以以前「有时能开」，是因为 Playwright 会先把鼠标移过去（等于顺手 hover）。
   - 旧实现「点不开就 `page.goto(HOME)`」= 每轮轮询整页刷新（实测 1 分钟 4 次），
     现在改成：hover → click 兜底 → ESC 清场再 hover → 本轮放弃；
     只有**连续失败 ≥5 轮且距上次重载 ≥10 分钟**才真重载一次，且每次写
     `logs/notice-reloads.log`（该文件不存在 = 没刷过）。
   - **页面被带到 `user/self`（个人主页）时**，hover 也能开浮层但列表是空的 →
     通道一直读到 0 条通知、也不会触发重载闸。用
     `node tools/navigate-notice-home.mjs --go` 拨回首页（一次性，别做成自动的）。
   - 复验工具：`dump-pages.mjs` / `watch-page-reloads.mjs` / `verify-notice-no-reload.mjs`。
     注意区分两种刷新：adopter 的 goto 会**换 URL**，抖音自己的路由刷新**URL 不变**
     （`tools/probe-reload-initiator.mjs` 能抓 initiator 栈）。

## 目录

```
adopter.mjs            主进程：只认通道契约，不含平台 DOM
src/browser/           自有轻量 CDP controller（替代插件 43KB 的 core.mjs）
src/channels/          通道实现：douyin / douyin-notice / bilibili(私信通道占位，不做)
src/dom/               从插件剥离的私信 DOM（与插件原件已不同步，以这里为准）
src/douyin/share.mjs   分享作品的逻辑（接口和 CLI 共用）
tools/                 40+ 个脚本：长期工具 + 一次性探针（探针别删，选择器改版时要重跑）
test/                  单元测试
archive/               调试输出和旧日志（归档，不是删除）
```

## 两个开销要注意

- **私信和通知都路由到 `session-f6774ea8`**（抖音专用会话），不是开发会话。
  原因：那边 1.5MB、开发会话已 1.9MB，灌进来会让上下文更快爆。
- **通知里 `like` / `follow` 默认只记日志不进会话**，因为这两类量最大。
  要全量就把 `douyin-notice.mjs` 里的 `important` 改成 `true`。

## 下一步候选

1. ~~B 站私信通道~~ **已否**（2026-10-24）：没人要私信会话，`channels/bilibili.mjs` 保持占位，
   **别去实现它**。「看」走浏览器 + `bilibili_extract`；「说」（发/回评论）**暂缓，以后单独接**
   （2026-10-24 用户暂缓，工具还没做），它**不该做成通道**。
2. 评论改成「我准备好、人按发送」（绕开风控）
3. 把评论/记忆从插件剥出来（用户提过「至少评论要拿」）

## 群多了会怎样（实测，2026-10-23）

`node tools/probe-poll-cost.mjs` 实测一轮轮询的耗时（15s 间隔）：

| 会话 | 单轮耗时 | 15s 间隔 |
|---|---|---|
| 1 私信 + 1 群 | **2.38s** | ok（16% 占用） |
| 1 私信 + 3 群 | 6.41s | ok |
| 1 私信 + 5 群 | 10.44s | ok（70%） |
| 1 私信 + 8 群 | 16.49s | ⚠ 追不上 |

**关键**：每个群真正读消息只要 0.3s，其余约 **1.7s 全花在「切会话 + 等动画/等标题出现」**上。
所以成本几乎不受消息量影响，只受**会话个数**影响。

### 为什么不会「好友一多就炸」

轮询目标是**配置驱动的显式白名单**，不是「列表里有什么就读什么」：

- 私信：只有 `config.channels[douyin].recipientId` **那一个**，加多少好友都不会多看一个
- 群：只有 `groups` 里列出来的，加多少群都不会自动收

所以「加很多好友」不影响任何东西；只有「往 `groups` 里堆群」才会线性变慢。

### 三道闸（都只在群多时才生效，1 个群时行为完全不变）

1. **`MAX_GROUPS = 8`**（`channels/douyin.mjs`）——超出部分截断，并在启动时**显式警告**
   被丢掉的是哪几个。让「加太多」在加载时就看得见，而不是悄悄变慢。
2. **`POLL_BUDGET_MS = 10_000`** ——单轮超过预算就跳过剩下的群，下一轮从游标继续（轮转），
   保证不饿死排在后面的群。实测：调成 3000ms 时会打印
   `单轮预算用完（3000ms），本轮跳过 7 个群；下一轮从「假群1」继续。`
3. **按会话建基线**（`adopter.mjs` 的 `conversationBaselines`）——群因为轮转被推迟到第 N 轮
   才第一次读到的时候，**不能**用全局的 `baselineReady` 放行，否则它整个窗口（最多 11 条
   历史）会被一次性灌进会话。

### 要更多群怎么办

- 调大 `pollMs`：`30000` 大约能撑 15 个群，`60000` 能撑 30 个（延迟同比变长）
- 或者拆到另一个进程（多开一个 adopter 配不同的 `listenPort`）

### 代价（要提前知道）

每轮都要把每个群切过去读一遍，这会**把这些群的消息标成已读**。群多了以后，
手机上看到的「未读」会被 adopter 清掉。要避免，只能改成「只对 `unread` 的会话读」，
但那依赖 `readContactDom` 的 `unread` 判据可靠（尚未单独验证）。
