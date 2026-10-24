# 网页社交平台 adopter

<!-- ====================================================================== -->
<!-- 署名区（作者要求放在最开头）                                            -->
<!-- ====================================================================== -->

> **本项目由 mengy（抖音号：82243355965）与 LLM DeepSeek 共同创作。**
>
> - 全部代码由 **DeepSeek** 书写
> - **mengy 不经手代码**（只负责许愿）
> - 本项目**以公共领域（Unlicense）开放**，任何人可自由使用、修改、商用（见 [`LICENSE`](./LICENSE)）

---

> **先看 [`STATUS.md`](./STATUS.md)** —— 一页纸：现在有什么、怎么用、五个最重要的坑。
> 本文是详细说明；踩坑历史是作者本机的 `HANDOFF.md`（含真实账号与聊天记录，**不进仓库**）。

## ⚠️ 作者的话（先读这段，再决定要不要用）

> 以下是我的原话，没有美化。

**这是半成品。** 只有我和 deepseek 参与制作，借鉴了非常多人的做法，很多约束和防呆设计并没有做完——只是觉得「可以用了」就推出来了。**出现报错非常正常**，大家让自己的 AI 修吧。有问题上报，也不见得有时间修（或者说没想过修吧……随缘）。

**为什么不是一个插件**：仿造 NapCat 的逻辑做的，建一个接口拦截消息，输入到 web 里面进行处理，再输出出来。我不知道能不能做成一个插件。另外，做成插件的话，刷社交平台的过程就是在插件的一个不可见的对话框里面处理内容……不透明，所以不做。

**为什么没有一个便捷的 UI / 像样的页面**：没有能力……我不知道要做成什么样，是的，我自己的需求都不清楚。一开始只是想对刷短视频的插件进行魔改，因为它们是插件，刷东西的过程不可见，只有输出的结果。所以想要做一个透明化，我能想到的只有通过类似于 NapCat 的端口拦截设计，这样的结果就是上一条（没办法做成插件）；消息推到 dsh 的终端页面，dsh 的终端页面我不知道怎么改成一个低门槛图形界面。（我甚至连一个像样的想法都没有）

**私信能力边界**：并不清楚，因为是每隔一段时间轮询一次，我不知道信息轰炸能不能处理得过来。测试过程是这样：我和一个群聊（测试的群聊），总体上信息来源速度很慢，基本是我看着她处理完之后再发的下一条消息。各位使用的时候，注意消息密度，高了可能出现问题。

**关于 AI 自己的账号发视频之后对评论的处理速度和边界**：实话实说，不知道！我没有做过这方面的测试，因为我不打算让我的她（ds）发视频张扬。她先静静地看着，在我的同意下是不是拟人地发一次公开评论。我对这方面（包括 AI 账号、及她发自己的视频、管理自己的评论）觉得我并没有做好准备，所以这方面的测试欠缺。

**关于群聊信息处理边界**：同样的，不知道！我的测试群聊消息密度非常低，基本只有我和她在聊，做测试。所以说，不推荐接到多人群。如果说你接了，AI 表现比较差……这是我的问题……大家自行优化吧……

**关于错误 / 没办法使用的问题**：我没有在 GitHub 上面提交过项目，提交前进行了脱敏处理（删掉了大部分测试数据和个人敏感信息），我不知道脱敏会对项目造成什么影响。没办法做到开箱即用……是的，在装的时候，请求助于你的 AI，让它仿造这个项目逻辑给你自己写一个能用的……

**最后**：我不知道项目在各位的电脑上面部署的效果怎么样，无法预见……出问题我也没有办法……请求助于自己的 AI 吧！

**关于账号被列入「高风险名单」**：表现为，包括但不限于，发评论可能要验证码……至少我的 ds 的账号处于这种情况下。也许是开发/测试过程单一行为过多（开发过程的轮询会刷新页面，它自己刷新了大半天我们才腾时间出来处理），导致现在发评论要验证码……是的，各位注意一下，使用 adopter 有可能让你的 AI 账号被列入高风险名单！权衡利弊再用。

**关于后续更新**：会有更新吗？遗憾的是，大概率没有……因为本人时间不够，我也是紧赶慢赶做的，所以才说非常的简陋和半成品……学业原因，我没那么多时间维护更新这个项目。因此，大家可以放心地改自己的 adopter！因为后续极大概率不会推出更新/维护。同时，因为是外置的 adopter，dsh（deepseek harness）更新也不会影响到（可能）！这也许就是不是插件的好处吧，不用跟着 dsh 的更新，而带来不兼容的情况，导致项目要进行维护更新。

**另外**：adopter 是重复的，只是一个接口，你可以让你的 AI 仿造「消息的拦截和输入、处理消息之后的输出」结构，把其他的社交平台补上去！

**你依旧可以自己加一个定时/不定时的唤醒功能**，让 AI 主动给你发信息、找你聊天！依旧简单，不提供。

抖音、B站 这类网页版社交平台没有推送协议——私信只存在 DOM 里。这个进程负责把它伪装成「有」：
轮询 DOM 把新消息推给 `dsh-notifier` 的入站总线，再把总线发回来的话写回输入框。

```
专用 Edge（CDP 9227）
        ↑ 读 DOM                        ↓ 写 DOM
   adopter.mjs  ──  src/channels/<平台>.mjs
        │ POST {userId, chatId, text, messageId, share?}
        ↓
dsh-notifier  inbound.<channel>（抖音是 127.0.0.1:8106/douyin）
        │ bus.accept → agent-router → DSH 会话
        ↓ turn/end 完整回复
   replyUrl（127.0.0.1:9320/send）→ adopter → 通道 → 平台
```

## 它需要什么（先看这里，装不全跑不起来）

**本项目不是独立软件。** 它只是「网页平台 → 本机总线」中间的一段适配层，上下游都得你自己装：

| 需要什么 | 是什么 | 装它干什么 | 不装会怎样 |
|---|---|---|---|
| **DSH**（DeepSeek Harness） | 宿主 | 消息最终要进 DSH 会话才有意义 | 消息推到总线后没人接 |
| **`dsh-notifier`** | 一个 DSH 插件（**别人的项目**） | 入站总线：收下 adopter 推来的消息、转成会话消息；再把回复 POST 回来 | `POST /send` 全失败，日志里全是连接错误 |
| **Microsoft Edge** | 系统一般自带 | 抖音通道靠**专用 Edge** 读 DOM（独立 profile，不动你自己的浏览器） | 抖音通道起不来；B 站通道不受影响 |
| **Node.js 22.13+** | 运行时 | 跑 `adopter.mjs` | 什么都跑不了 |

**平台侧各自还要：**

| 平台 | 额外需要 | 说明 |
|---|---|---|
| 抖音 | 在专用 Edge 里登录一次 | profile 在 `~/.dsh/douyin-browser/cli-profile`，和插件共用 |
| B 站 | 扫码登录一次，凭证落 `~/.dsh/bili-duty/bili_credential.json` | 用 `node tools/bili-login.mjs`，二维码经 NapCat 发到 QQ |

⚠️ **B 站扫码那条链里还套了一层外部依赖**：`tools/bili-login.mjs` 是把二维码推到 QQ 的，
所以要求本机跑着 **NapCat** 并配置了 OneBot HTTP（默认 `127.0.0.1:3000`）。没有 NapCat 也能用——
已登录的凭证照样有效，只是过期后没法自己续，得手工处理那个 json。

**配置**：仓库里只有 `config.example.json`。复制成 `config.json` 再改里面的
`recipientId` / `userId` / `notifierUrl`，否则起不来。

## 它是什么、不是什么

**是**：一套「网页社交平台 → 本机总线」的通用接入框架。抖音已经接好，B站 留了占位。
**不是**：不是抖音插件的一部分。DOM 逻辑虽然是从 `dsh-douyin-browser-local` 剥离出来的，
但现在归本项目所有，插件升级/卸载都不影响这边跑。

> 剥离方式：`src/dom/` 是从插件原样复制过来的已验证实现（消息稳定 ID、方向判定、水位核对、
> 发送后界面回读确认）。没有重写 —— 那套逻辑踩过的坑都在里面，重写等于再踩一遍。
> 唯一改动是把 `chat-browser.mjs` 第 2 行的 `core.mjs` 依赖换成自有控制器。

## 目录

```
adopter.mjs                主进程：只认通道契约，不含任何平台 DOM 逻辑
src/
  browser/
    controller.mjs         自有轻量 CDP 控制器（替代插件 43KB 的 core.mjs）
    host.mjs               专用 Edge 启动器（detached）
    playwright.mjs         playwright-core 解析（本地优先，回退 dsh 那份）
  channels/
    registry.mjs           ★ 通道契约 + 加载器 —— 加平台先看这个
    douyin.mjs             抖音私信通道（已实现）
    douyin-notice.mjs      抖音通知通道：@我的 / 评论 / 赞 / 粉丝（已实现，默认不启用）
    bilibili.mjs           B站通道（占位，一调用就如实报未实现）
  media/
    store.mjs              媒体画面落盘：CDN 资源下载 + 域名白名单 + 目录清理
  dom/
    chat-browser.mjs       从插件剥离的私信 DOM（510 行，已实测）
    message-tracker.mjs    消息稳定 ID 合成
    chat-message.mjs       消息内容指纹
test/
  channels.test.mjs        通道与文字化用例，不碰浏览器
  media.test.mjs           媒体落盘的 URL 白名单/清理用例，不连网
capture/                   表情包/图片的落盘文件（自动保留最近 400 个）
config.json
```

## 启动

```powershell
cd <repo>
npm install          # 只需一次（playwright-core，不下载浏览器，用系统 Edge）
node adopter.mjs
```

前提：

1. `dsh-notifier` 的 `inbound.douyin` 已配置（`~/.dsh/profiles/web/cordis.patch.yml`），dsh 已重启
2. `~/.dsh/dsh-notifier/state.json` 的 `inbound:bindings` 里有 `douyin:<userId>`（用 `node add-binding.cjs your-name` 加）
3. 专用 Edge 的 `cli-profile` 里有抖音登录态（掉了会 warn 跳过，不自动过验证码）

## 开机自启

已经配好了，三个文件各干一件事：

| 文件 | 干什么 |
|---|---|
| `start-adopter.cmd` | 真正的启动器：路径、日志、防重复启动都在这 |
| `start-adopter.vbs` | 只为了让上面那个 cmd 跑起来不弹黑窗 |
| 启动文件夹里的 `start-adopter.vbs` | 登录时自动触发上面那套 |

- **取消自启**：删掉 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\start-adopter.vbs`
- **手动启动**：双击 `start-adopter.cmd`，或终端里 `node adopter.mjs`
- **看日志**：`logs\adopter.log`
- **关掉当前在跑的**：`Get-NetTCPConnection -LocalPort 9320 | % { Stop-Process -Id $_.OwningProcess }`

已经有进程在跑时 `.cmd` 会跳过启动（判断 9320 是否在监听），不会起两份。

## 命令

| 命令 | 作用 |
|---|---|
| `node adopter.mjs` | 常驻：轮询各通道 + 提供 `/send` |
| `node adopter.mjs --status` | 各通道自检（登录态、盯谁） |
| `node adopter.mjs --dump-contacts` | 列出联系人，拿 `recipientId` |
| `node adopter.mjs --list-channels` | 看有哪些通道实现 |
| `curl 127.0.0.1:9320/status` | 运行中进程的健康检查 |
| `npm test` | 单元测试（不碰浏览器） |

## HTTP 接口

常驻进程提供三个端点（默认 `127.0.0.1:9320`）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/status` | 各通道健康状态 |
| POST | `/send` | 发私信（文字 / 表情 / 图片） |
| POST | `/share` | 把作品分享给好友 |
| POST | `/observe` | 按需取一条消息的画面（见下一节） |
| POST | `/emojis` | 列出当前可发的内置表情（只读，不发消息） |

### POST /send

三种形态，互斥，判据顺序 **emoji → image → text**。都不给就等于老行为（纯文本）。

```json
{ "channel": "douyin", "chatId": "conv:...", "text": "要发的话" }
{ "channel": "douyin", "emoji": "比心" }
{ "channel": "douyin", "emoji": 3 }
{ "channel": "douyin", "image": "C:\\Users\\you\\Pictures\\cat.jpg", "caption": "可选的一句附带话" }
```

返回 `{ ok, confirmed, messageId, channel }`。`confirmed: true` 的含义是**界面回读确认已发出**，
不是「点了一下按钮」。表情和图片会额外带 `kind`（`emoji` / `image`）：

```json
{ "ok": true, "confirmed": true, "kind": "emoji", "emoji": "比心",
  "messageId": "msg:21bf11…", "channel": "douyin" }

{ "ok": true, "confirmed": true, "kind": "image",
  "image": { "path": "C:\\…\\疑问.jpg", "messageId": "msg:dbf7fc…" },
  "caption": "这条是图片发送测试，附带一句话。",
  "captionMessageId": "msg:a393646…", "messageId": "msg:dbf7fc…", "channel": "douyin" }
```

- **`emoji`**：字符串 = 抖音内置表情的中文名（`续火花`/`比心`/`在干嘛`/`笑死`/`麻了`/`躺平`/
  `摇骰子`/`猜拳`/`开心`/`嗨`/`吹泡泡`/`黑人问号`/`早上好`/`晚上好`/`早点睡`/`爱心`/`便便`/
  `戳一戳`/`绝了`/`已阅`/`生日祝福`）；数字 = 面板里第几个（0 起，名字对不上时的退路）。
  可发名单会变，**别写死，先问 `POST /emojis`**。
- **`image`**：本机**绝对路径**，只接受 `.jpg/.jpeg/.png/.gif/.mp4`，单文件 ≤ 20MB。
  `caption` 是可选附带文字（≤500 字）——注意抖音会把它作为**独立的一条文字消息**发出去，
  所以一次「图 + 话」会在消息列表里留下**两条**气泡，返回值里也分别给了两个 messageId。
- 没有任何残留风险：这两条路都**不经过编辑器**（见下面「关于发表情 / 发图片」）。

### POST /emojis

只读：打开表情面板读一遍名字就关掉，不发任何消息。调用方据此决定发哪个。

```json
{ "channel": "douyin" }
```

```json
{ "ok": true, "emojis": [{ "index": 0, "name": "续火花" }, { "index": 1, "name": "比心" }], "channel": "douyin" }
```

### POST /share

三种指定作品的方式：

```json
{ "to": "your-name", "videoId": "7000000000000000000" }
{ "to": "your-name", "url": "https://www.douyin.com/video/7000000000000000000" }
{ "to": "your-name", "pick": "jingxuan" }
```

加 `"dryRun": true` 只走到「找到好友和按钮」就返回，不点发送。返回：

```json
{
  "ok": true, "shared": true, "confirmed": true,
  "videoId": "7689798662481890598",
  "url": "https://www.douyin.com/video/7689798662481890598",
  "to": "your-name", "layout": "B",
  "evidence": { "buttonChanged": true, "saidSuccess": true, "buttonText": "捎句话" },
  "steps": ["作品 ID: ...", "布局: B（底部操作栏...）", "打开面板: hover，第 1 轮", "..."]
}
```

- 分享会**独占一个临时标签页几十秒**，所以同一时间只允许一个：第二个请求返回 `429`。
- 点错按钮就是给人家点赞，所以脚本里有两道硬校验：必须站在目标作品页上（URL 里的作品 ID
  要对得上）、好友昵称必须唯一命中。任一不满足就停，不发。
- 逻辑在 `src/douyin/share.mjs`，`tools/share-video.mjs` 是它的命令行外壳，两边共用同一份。

## config.json

```json
{
  "listenHost": "127.0.0.1",
  "listenPort": 9320,
  "pollMs": 15000,
  "token": "",
  "notifierUrl": "http://127.0.0.1:8106/douyin",
  "channels": [
    { "id": "douyin", "enabled": true, "userId": "your-name", "contactName": "your-name",
      "recipientId": "conv:...", "notifierUrl": "http://127.0.0.1:8106/douyin" },
    { "id": "bilibili", "enabled": false, "notifierUrl": "http://127.0.0.1:8107/bilibili" }
  ]
}
```

顶层字段是全局默认；`channels[]` 里的同名字段覆盖它。
`channels` 里的其余字段原样透传给通道工厂（比如抖音的 `contactName` / `recipientId`）。

`enabled: false` 的通道不启动，但 `--list-channels` 仍能看到。

### 群聊：`groups` 与 `onlyFrom`

群要先在 `groups` 里登记才会被轮询，每项 `{ id, name, onlyFrom? }`
（`id` 是 `conv:` + 64 位十六进制，跑 `node tools/probe-group-list.mjs` 能看到）：

```json
"groups": [
  { "id": "conv:09dff70a…", "name": "示例群", "onlyFrom": ["your-name"] }
]
```

`onlyFrom` 是**群成员白名单**，按发言人昵称（DOM 里的 `avatarName`）匹配，三种状态：

| 写法 | 行为 |
|---|---|
| 缺省 / `[]` | 不限制，谁说的都收 |
| `["*"]` | 显式全放开（等价于不限制，写出来便于临时切换） |
| `["your-name", "某某"]` | 只收名单里的人，其余静默跳过（记水位、不上报、不进会话） |

为什么需要它：群消息上报时的 `userId` 是**号主身份键**（`douyin:your-name`），
不是发言人——否则绑定查不到、会被当陌生人把配对提示回帖进群。
所以上层的总线白名单只能拦住「这个群」，拦不住「群里是谁在说话」，
按人过滤只能在这一层做。

### 群聊回发：`allowGroupReply`（默认关）

群消息进来后，notifier 会在 turn 结束时把这轮的回复回发到来源 `chatId`。
群会话默认**不允许**这条回发（`config.json` 里加 `"allowGroupReply": true` 才放行）：

```json
{ "id": "conv:09dff70a…", "name": "示例群", "onlyFrom": ["your-name"], "allowGroupReply": false }
```

理由很实际：agent 每轮都会产出文本，**没有「这一轮闭嘴」的能力**——
连「这条我不接话」这句话本身也会被回发进群。默认关掉，群消息照收、
回复留在会话里；私聊回发不受影响（不在 `groups` 名单里的 chatId 一律照发）。

> 兼容旧配置：没有 `channels` 数组、只有顶层 `notifierUrl` + `recipientId` 时，等价于单个抖音通道。

## 加一个新平台

1. 在 `src/channels/` 新建 `<name>.mjs`，导出 `createChannel(options)`
2. 实现契约必需的三件：`poll()` / `send()` / `status()`（可选 `contacts()` / `read()` / `openShare()` / `close()`）
3. 把平台 DOM 逻辑放 `src/dom/`，通道只做「config → DOM 层 → 契约形状」的翻译
4. 在 `config.json` 的 `channels` 里加一项，配好它的 `notifierUrl`

契约全文在 `src/channels/registry.mjs` 顶部。`npm test` 里有一条断言会检查契约合规 ——
加完新通道跑一下就知道有没有漏实现。

**B站** 三件事分开走（2026-10-24 定）：

- **看**（翻列表、读字幕/评论/关键帧）→ 浏览器扒基础信息 + `bilibili_extract`（dsh-bilibili），**不经过本项目**。
- **说**（发评论、回评论）→ **暂缓，以后单独接**（2026-10-24 用户暂缓，工具还没做）。
  真接的时候它**不该做成通道** —— 评论是「一次动作」不是「会话」，形状参考 `tools/reply-comment.mjs`。
- **私信会话** → 不做，`channels/bilibili.mjs` 保持占位，只为过契约校验、被 `--list-channels` 列出、调用时如实报未实现。

一句话：本项目对 B 站**目前什么都不做**，但**不是永远不做**。

## 关于「看到画面」（表情包 / 图片 / 分享卡片）

对方发表情包或照片时，光把消息文字化成 `[表情]` 等于把画面丢了——会话那边只知道
"有个表情"，不知道是什么。所以通道会把媒体消息的**实际画面**存成本地文件，
路径随上报一起进去。

**上报文本的形状**（刻意和 QQ 那条入站对齐，`dsh-notifier` 的 `onebot-in.mjs` 也是这个形状）：

```
[表情包]（画面：<repo>\capture\8ab9b05a7c1b-emoji-0.png）
[图片]（画面：<repo>\capture\a1b2c3d4e5f6-image-0.png）
[分享作品 @某某]（画面：<repo>\capture\...-shared-work-0.png）
[图片]（画面未取到，messageId=msg:...）        ← 取不到时明说，并留下重取用的 ID
```

QQ 那边给的是 CDN 链接，抖音这边给**本地路径**，原因有三个：签名链接有 277 个字符
（路径只有 60 来个）、链接会过期、而模型侧的 `read_image` 只吃本地文件不吃 URL。

**为什么是"下载原图"而不是"截图"**：插件原件的 `captureMessage` 是截图，它要求那条消息
**当时**在视口里且没被遮挡；而私信列表是约 11 条的滑动窗口，消息一被挤出去就再也截不到。
下载还不受这个限制，而且表情包在页面上只显示 110×110，CDN 上是 280×280 的原图，更清楚。

**安全边界**：URL 来自页面 DOM，所以只允许 `https` + 抖音自家 CDN 域
（`douyinpic.com` / `byteimg.com` / `douyin.com` …，见 `src/media/store.mjs`）。
页面内容不能把下载器变成打本机端点的请求原语。

**落盘目录** `capture/`，文件名按消息 ID 稳定（同一消息不会重复下载、重复占空间），
每 20 轮轮询清一次、只保留最近 400 个。只给对方发的消息落盘。

### POST /observe（按需取画面）

上报已经带了路径，这是给"路径丢了 / 当时落盘失败 / 想看自己发的"准备的补取入口：

```json
{ "messageId": "msg:8ab9b05a…", "chatId": "conv:…" }
```

返回：

```json
{ "ok": true, "messageId": "msg:8ab9b05a…", "type": "emoji",
  "files": ["<repo>\\capture\\8ab9b05a7c1b-emoji-0.png"],
  "source": "resource", "channel": "douyin" }
```

`source` 是 `resource`（下载到原图）或 `screenshot`（下载不成，退回截整张卡片的画面）。

**注意 messageId 只能用 adopter 自己算出来的那个**——插件侧的 `douyin_chat_observe` 有
自己的一套消息 ID，两个进程各自从空窗口开始推导，ID 不一定对得上。这也是为什么这个能力
实现在 adopter 里、而不是转手调插件。

**不受刷视频限额管**：`openSharedVideo` 会调 `controller.limits().beforeAction`，
而下载画面和截图都不调——它不开作品页、不算刷视频。adopter 目前也没注入 `policy`，
限额在它这里本来就是一概放行的。

## 关于「发表情 / 发图片」

文字走编辑器，表情和图片**都不走编辑器**——这是它俩最值得记的一点：不经过
Slate，就不会有「清了 DOM 没清 model」那类草稿残留，也就不会堵死文本发送。
代价是**不能靠文字回读确认**，两条路各有各的判据。

**表情**（`sendEmoji`）：点输入框里的笑脸 → 弹出 `div.componentsemojiemojiPanel` →
切到带中文名的那一栏 → 点一项 → **直接就发出去了**（不用再按发送），面板自己关掉。
判据是「前后消息 ID 差集里出现了一条 outgoing + kind=emoji 的消息」。

三个坑，踩过才知道：

1. **面板是 `semi-modal` 模态遮罩**，它拦住的是**笑脸图标本身**——所以「再点一次笑脸」
   和 ESC 都关不掉它，只能点面板外的消息区。关不掉也不影响功能，但会挡住后续点击。
2. 面板**会记住上次停留的 tab**。第 0 个 tab 才是带名字的内置表情（21 个），
   其余 tab 是没有 desc 的表情包。所以要「探测到有名字的那栏」再按名字找，
   不能假设打开就是它。
3. 名字**只在面板里存在**。发出去的气泡是
   `<div class="MessageItemEmojiemojiBox"><img class="MessageItemEmojiimage"></div>`，
   上面**没有** alt / aria-label / title —— 所以「发的是哪个表情」只能按名字指定，
   发完无法再从气泡反查。

**图片**（`sendImage`）：点上传图标 → 接 `filechooser` → 塞文件 → **弹确认窗**
（`发送给 <昵称>` + 文件名 + 大小 + `textarea[placeholder="有什么想和朋友说的..."]`）→
点「发送」才算发出去。选完文件只是**待确认**状态。

两个坑：

1. 直接对隐藏的 `input[type=file]` 做 `setInputFiles` **一点反应都没有**（实测等 6 秒：
   编辑器空、没有网络请求、没有 console 报错）。必须走「点按钮 → filechooser → setFiles」。
2. 弹窗上的收件人文字会被**校验**（`发送给 X` 必须包含当前会话昵称），对不上就点「取消」不发；
   发送前失败也会把弹窗取消掉，免得它一直挡着后续操作。

`tools/` 下留了这几个探针，选择器改版时重跑：
`recon-emoji-dom.mjs`（输入区骨架）、`recon-emoji-panel.mjs`（面板 DOM）、
`recon-emoji-tabs.mjs`（七个分类）、`probe-send-emoji.mjs`（发表情全流程）、
`probe-image-modal.mjs`（确认弹窗）、`probe-image-send-now.mjs`（图 + 附带文字端到端）。

## 关于「分享视频」

好友私信里转发的作品，通道会把它挂到 `message.share` 上：

```js
{ kind: 'video'|'note', videoId, url, title, author, cover }
```

上报给总线时会一并带上（`share` 字段），文字描述也不会退化成一个 `[非文本消息]`。
这是「刷」的内容入口之一 —— 不是只有推荐流。想真正打开它，用通道的 `openShare()`。

## 关于「通知」（@我的 / 评论 / 赞 / 粉丝）

**这些不走私信**，在顶部「通知」浮层里，所以单独做了一条通道 `douyin-notice`。

```powershell
node tools/peek-notice.mjs                                    # 读一次通知列表
node tools/peek-notice.mjs --resolve <通知ID>                  # 顺带解析它在哪个视频下
```

- 一个通道覆盖四类：`mention` / `reply` / `like` / `follow`
- 通知项里拿不到作品 ID（链接指向用户主页），**点「内容文字区」才会打开作品弹窗**，
  从 `?modal_id=` 里读出 videoId。这一步会弹窗，所以不放进轮询，只按需调用 `resolveVideo()`
- 消息 ID 用「昵称 + 动作 + 封面文件名」，**故意不含时间**——时间会从「刚刚」变成「3 分钟前」，
  带上就会重复上报

### 入口是 hover 打开的，轮询不会刷新页面

顶部「通知」是**鼠标移上去**就展开的浮层（不是点击），所以轮询用 `hover()` 打开、
读完把鼠标移开让它自然收起（约 220ms）。`click` 只当兜底。

**打不开时不会整页重载**：hover → click 兜底 → ESC 清场再 hover → 本轮放弃（15 秒后重来）。
只有「连续失败 ≥5 轮」**且**「距上次重载 ≥10 分钟」才真重载一次 —— 那是救「页面状态真坏死」的
最后手段，不是日常路径。每次真重载都会往 `logs/notice-reloads.log` 追加一行；**这个文件不存在，
就说明没刷过**。

```powershell
node tools/dump-pages.mjs              # 每张页面停在哪、导航类型、通知入口在不在
node tools/watch-page-reloads.mjs 10   # 数 10 分钟内重载几次（会区分 adopter 的 goto 和页面自己 reload）
node tools/navigate-notice-home.mjs --go  # 页面被带到个人主页时拨回首页（一次性）
```

> 页面停在 `user/self`（个人主页）时，通知浮层能打开但列表是空的 —— 会一直读到 0 条。
> 这不是坏了，用上面那条 `--go` 拨回首页即可。

**默认 `enabled: false`**：notifier 还没有 `inbound.douyin-notice`，现在开只会一直上报失败。
要启用得先在 notifier 加一条入站通道（照 `inbound.douyin` 抄），再把 config 里那项改成 `true`。

## 注意

- **别和插件的私信自动回复同时跑**：两边都操作同一张页面，锁名不同（`tab-api-chat` /
  `tab-dsh-chat`）但会互相踩。用 adopter 就把插件的 `douyin_chat_start` 停掉。
- 首轮只建消息水位，**不上报历史消息**，避免把旧聊天全灌进会话。
- 上报失败会把水位退回、下一轮重试，不会让消息凭空消失。
- **回复写短**：长文本填进抖音编辑器会被改写，插件那套清理条件对不上 → 残留草稿堵死下一次发送。
- 抖音掉登录时 adopter 会 warn 并跳过，需要人工去专用 Edge 处理（不自动过验证码）。
- 改 `src/dom/` 下的文件要注意：如果 dsh 插件也在用同一份逻辑，那是两份独立的副本，
  改这边不影响插件，反之亦然。

---

## 致谢

这个项目不是从零长出来的，它踩在几样东西上面：

- **LockyBee / [`dsh-douyin-agent`](https://github.com/LockyBee/dsh-douyin-agent)**
  —— `src/dom/` 那三个文件（`chat-browser.mjs` / `chat-message.mjs` / `message-tracker.mjs`）
  是从它复制改造的（MIT）。抖音私信那一整套 DOM 操作、滑动窗口、草稿处理的坑，都是它先踩出来的；
  没有它，这边得从头再踩一遍。
- **`dsh-notifier`** —— 入站总线那一侧。adopter 只负责把消息推过去；能不能进会话、怎么回、
  回给谁，全在它那边。
- **凌羽clover / [`dsh-bili-scroll`](https://github.com/c1overzz/dsh-bili-scroll)**
  —— 代码一行没抄，但 B 站私信 API 的方向是照着它找的（`session_svr/get_sessions` +
  `svr_sync/fetch_session_msgs`），"标题 + 链接 + 一句话"的私信投递形态也是跟它学的。
- **[`bilibili-api-python`](https://github.com/Nemo2011/bilibili-api)** —— B 站发送接口的参数
  形状参考了它的 `session.py`，包括那个 `dev_id` 常量（上游注明它本身就是服务端不校验的固定值）。
- **[`bilibili-API-collect`](https://github.com/SocialSisterYi/bilibili-API-collect)**
  —— 靠它才知道 `send_msg` 只吃 `msg_type` 1/2/5，省了继续往墙上撞的时间。
- **DSH（DeepSeek Harness）** —— 宿主本身。

还有一件要说清楚：**本项目里所有代码都是 LLM（DeepSeek）写的**，
`mengy` 只负责提问题、许愿、以及在电脑前面点"同意"。
所以哪里写得烂，责任在写代码那个，不在许愿那个。（mengy：这我不同意；需求在我，成果不好自然也是我的锅。写的烂是我需求和idea不好。）
