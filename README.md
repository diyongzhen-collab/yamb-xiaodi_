# yamb

**版本：`3.1` · xiaodi_ 版 · 本地构建，未实服验证**

本版新增左右键、TUI 点击状态和五个 AI 交互工具，详见 [3.1 更新说明](CHANGELOG-3.1.md)。

**Yet Another MChatBot** — 基于 [Mineflayer](https://github.com/PrismarineJS/mineflayer) 的 Minecraft 游戏内机器人。

支持私聊/公屏命令、传送与白名单、玩家交互（骑乘/矿车）、容器登记与存取、背包管理、持久化定时任务、AI 工具调用、待命与 AFK、AstrBot HTTP API 集成与可选网页 Viewer。

## 功能概览

- **命令渠道**：私聊无前缀；公屏需在 `command.json` 配置前缀（默认关闭）
- **权限**：白名单与管理员分开管理，分别存于 `data/whitelist.db` 与 `data/admins.db`，启动时从 `.env` 增量同步；匹配忽略大小写（`xiaodi_` 与 `Xiaodi_` 视为同一人），不在白名单的用户使用命令会收到提示
- **传送**：自动接受 tpa/tpahere、传送点拉人、锁定/滞空锁定
- **交互**：骑乘玩家、登上矿车
- **左右键**：参考 Carpet 重写，准星攻击实体（含玩家，不挖掘）、右键交互，支持单次/持续/tick 间隔和副手；[命令与限制](docs/carpet-clicks.md)
- **物品**：容器登记与存取、丢弃、背包查询、快捷栏切换
- **待命**：自动回家、吃金胡萝卜、AFK，带指数退避
- **定时任务**：单次/每天/循环，SQLite 持久化，重启后恢复
- **AI**（可选）：OpenAI 兼容接口，白名单与管理员自然语言调用工具
- **AI 交互工具**：伪装、骑乘玩家、上矿车、回家与签到已接入；[用法与权限](docs/ai-interactions.md)
- **AstrBot**（可选）：QQ 机器人接口（`/ybot ai` + FunctionTool + 掉线/重连通知）
- **Viewer**（可选）：`prismarine-viewer` 网页可视化

## 安装

```bash
yarn install
# 沿用已有部署的 .env，首次部署需自行填写账号及接口配置
# 编辑 .env 与 config/game/
yarn start
```

开发模式（免编译）：

```bash
yarn dev
```

> 游戏视距默认 4 个区块，可用 `.env` 的 `MC_VIEW_DISTANCE` 调整（2–32）；需要观察常驻内存时打开 `MEMORY_LOG_ENABLED=true`，每分钟记录 RSS、区块与实体数量。

## 配置

| 层级 | 位置 | 内容 |
|------|------|------|
| 部署/账号 | `.env` | MC 账号、服务器、`MC_ADMIN_LIST`、AI/API 密钥 |
| 游戏行为 | `config/game/*.json` | 前缀、待命、传送点、交互距离、viewer 等 |

详见 [config/game/README.md](config/game/README.md)。

### Viewer

启用 viewer 需安装原生模块：

```bash
yarn add canvas
```

在 `config/game/viewer.json` 中设置 `"enabled": true`，启动后访问 `http://localhost:3007`（端口可配置）。

## 游戏内命令

私聊无需前缀；公屏需 `{prefix}`（见 `config/game/command.json`）。`allowPublicCommands` 为 `false` 时仅私聊可用。

### 白名单

| 命令 | 说明 |
|------|------|
| `help` | 帮助 |
| `status` | 状态 |
| `players [名字]` | 在线玩家 / 模糊查找（含小镇识别） |
| `inv` | 查看 bot 背包 |
| `slot <1-9>` | 切换快捷栏栏位 |
| `ai <需求>` | AI 工具调用；`ai 清空记忆` 清除上下文 |
| `phome <别名>` | 经传送点拉取玩家 |
| `mount [玩家]` / `cart` / `unmount` | 骑乘（默认为自己）/ 登上最近矿车 / 下马 |
| `lock` / `lock hover` / `unlock` | 锁定 / 滞空锁定 / 解锁 |
| `store <容器> <物品> [数量]` | 存入已登记容器 |
| `take <容器> <物品> [数量]` | 从容器取出 |
| `drop <物品> [数量]` | 丢弃背包物品 |

> 锁定状态会持久化到 `game.db`，bot 重启后自动恢复普通锁定（滞空锁定因重启后物理落地，不会恢复）。

白名单玩家对 bot 发送 `/tpa` 或 `/tpahere` 时 bot 会自动接受（锁定期间 `tpahere` 会被拒绝并通知）。

> 管理员无需加入白名单即可使用全部命令；白名单与管理员均忽略大小写，
> 同名不同大小写只保留一条记录。白名单/管理员命令、AI 工具与 HTTP API
> 使用同一套匹配规则。

### 管理员

| 命令 | 说明 |
|------|------|
| `container add <别名>` / `container remove <别名>` | 登记 / 删除容器记录 |
| `add <游戏名>` / `remove <游戏名>` | 白名单管理 |
| `say <消息>` | 发送公屏消息或服务器指令 |
| `forward <消息>` | 发公屏并转发随后系统消息 |
| `timer <add\|in\|every\|list\|remove>` | 定时任务（详见下） |

## 定时任务

| 命令 | 行为 |
|------|------|
| `timer in 30m <指令>` | 30 分钟后执行一次 |
| `timer add 2026-08-01 22:00 <指令>` | 指定日期时间执行一次 |
| `timer add 22:00 <指令>` | 每天 22:00 循环执行 |
| `timer every 30m <指令>` | 每 30 分钟循环执行 |
| `timer list` / `timer remove <ID>` | 查看 / 删除任务 |

任务保存在 SQLite 中，重启后恢复；执行失败 30 秒后重试，永久性错误（权限丢失、指令无效）自动删除；循环任务按原计划时间推进，不补跑停机期间错过的次数。

## AI 工具调用

使用官方 `openai` SDK（7.36.0），TypeScript 编译输出保持 CommonJS，通过 Chat Completions 调用 OpenAI 或兼容服务。单次请求总超时 30 秒，SDK 自动重试关闭；已有工具权限、多轮调用与会话记忆保持不变。

在 `.env` 配置以下项目即可启用 OpenAI 兼容接口：

```env
AI_ENABLED=true
AI_BASE_URL=https://api.example.com/v1
AI_API_KEY=your_api_key
AI_MODEL=your_model
```

`AI_CACHE_PROMPT` 默认 `true`，保留旧版中转兼容参数 `cache_prompt: true`。连接 OpenAI 官方接口或不支持该扩展的服务时，设置 `AI_CACHE_PROMPT=false`，请求中将不发送此字段；该开关不代表服务商一定提供缓存，也不控制官方自动缓存。

依赖版本记录在 `package-lock.json`，新环境可运行 `npm ci` 安装，再运行 `npm run build` 编译。

白名单与管理员均可直接私聊自然语言需求（非命令私聊自动转交 AI）；已知本地指令优先本地处理。AI 可调用状态、坐标朝向、血量/饥饿/氧气、在线玩家、白名单、背包、传送点、快捷栏、锁定、定时任务等工具。白名单用户可调用查询与游戏操作类工具；管理类工具（白名单增删、`say` 发言、定时任务增删）仍仅管理员可用，白名单用户触发会被拒绝并说明原因。`AI_BLOCKED_SLASH_COMMANDS` 可配置禁止发送的斜杠指令，默认禁止 `/pay`。对话记忆按玩家隔离，仅保存在进程内，重启后清空。

## AstrBot 集成（可选）

1. 在 `.env` 设置 `ASTRBOT_ENABLED=true`、`API_PORT` 与 `API_KEY`
2. 另行安装配套 AstrBot 插件（当前源码目录不包含插件）
3. 在插件配置中填写 API 地址、API Key 与 QQ 管理员列表

插件提供 `/ybot ai <需求>` 手动入口，并将 `yamb_ai` 注册为 AstrBot FunctionTool；
另有掉线/重连通知：bot 断线或恢复后，插件轮询 `GET /api/notices` 并主动推送到
管理员绑定的 QQ 群和个人（群内 `/ybot setnotify` 绑群、私聊 `/ybot setnotify`
绑个人，也可在插件配置中填写 `notify_target_umo` 或 `notify_qq_users`）。
HTTP 路由见 `src/api/routes/`。

## 目录结构

| 目录 | 说明 |
|------|------|
| `src/` | TypeScript 源码 |
| `dist/` | 编译产物（可重新生成） |
| `config/` | 游戏行为配置 |
| `data/` | SQLite 运行数据库：`game.db`（容器/定时任务）、`whitelist.db`（白名单）、`admins.db`（管理员）（私密，勿提交） |
| `logs/` | 每日日志（可定期清理） |
| `mc-tokens/` | 微软登录令牌（私密，勿提交） |

## 许可证

本项目采用 [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html)（GPL-3.0）。

基于 GPL 发布：你可以自由使用、修改和分发本软件；若分发修改后的版本，须以相同许可证公开源代码。
