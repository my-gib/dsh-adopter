# NOTICE

本项目作者原创的代码以 **Unlicense（公共领域）** 发布，全文见 `LICENSE`。

但下面这些文件**不是原创**，它们带着别人的许可，不能被单方面改成公共领域。
再分发时必须保留这份声明。

---

## src/dom/ —— 来自 dsh-douyin-agent

| 文件 | 来源 | 许可 |
|---|---|---|
| `src/dom/chat-browser.mjs` | `dsh-douyin-agent`（作者 **LockyBee**） | MIT |
| `src/dom/chat-message.mjs` | 同上 | MIT |
| `src/dom/message-tracker.mjs` | 同上 | MIT |

- 上游：<https://github.com/LockyBee/dsh-douyin-agent>
- 改了什么：`chat-browser.mjs` 顶部那一行 `import BrowserController from './core.mjs?v=9'`
  换成了 `'../browser/controller.mjs'`（那边是 43KB 的 `core.mjs`，这边只保留
  `ChatBrowser` 真正用到的 `withPage / source / limits / close` 四个能力）。
  另外有几处 `[adopter 改动]` 注释标出的修复（发送确认的假失败、草稿清理顺序）。
- MIT 条款要求：保留版权声明与许可文本。原文见上游仓库的 `LICENSE`。

---

## 依赖（运行时）

全部通过 `npm install` 获得，不在本仓库里：

| 包 | 用途 | 许可 |
|---|---|---|
| `playwright-core` | 驱动本机 Edge（抖音 DOM 通道） | Apache-2.0 |
| `qrcode` | 生成 B 站登录二维码 | MIT |

---

## 协议与实现参考（没有复制代码，只用作事实依据）

- **B 站私信 API 的参数形状**参考 `bilibili-api-python`（MIT）里的 `session.py`。
  代码是本仓库自己写的，只有那个硬编码的 `dev_id` 常量是照抄的（上游注释说明它本身
  就是服务端不校验真实性的固定值）。
- **B 站扫码登录的接口**参考 `bilibili-API-collect`（上游文档项目）。
- **消息 API 的可用 `msg_type`**（1/2/5，不含 7）经本机实测确认，未复制代码。

---

## 本项目**不包含**的东西

以下都在使用者的本机，不进仓库（见 `.gitignore`）：

- `logs/` —— 运行日志，含真实聊天内容
- `capture/` —— 私信图片落盘
- `archive/` —— 历史侦察截图
- `config.json` —— 真实联系人 ID、群 ID
- `HANDOFF.md` / `NEXT.md` —— 作者本人的开发记录与待办
- `docs/bilibili/` —— 调研报告，含真实账号与 mid
