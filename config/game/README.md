# 游戏内配置说明

配置文件支持 `//` 行注释与 `/* */` 块注释（由程序加载时剥离）。

配置优先级：`.env` > `config/game/*.json`

## 文件一览

| 文件 | 用途 |
|------|------|
| `command.json` | 命令前缀、公屏/私聊渠道、回复方式 |
| `bot.json` | 待命、AFK、交互距离、转发等待 |
| `teleport.json` | 传送指令、传送点列表、数据库路径 |
| `viewer.json` | 网页可视化 viewer |
| `messages.json` | 所有命令回复文案（唯一文案来源） |

## 环境变量（.env）

账号、服务器、管理员等部署参数从项目根目录 `.env` 加载；当前目录不附带 `.env.example`。

- `MC_ADMIN_LIST`：管理员游戏名，逗号分隔，启动时增量同步到 `data/admins.db`
- `MC_WHITELIST`：白名单玩家，逗号分隔，启动时增量同步到 `data/whitelist.db`
- 白名单与管理员分开管理，匹配忽略大小写；管理员无需加入白名单
- `MC_USERNAME`：微软账号邮箱（必填）

## messages.json

占位符用 `{name}` 形式，运行时替换。常用变量：

- `{prefix}` — 公屏命令前缀
- `{cmd}`、`{message}`、`{gameName}`、`{waypoints}` 等见各模板
