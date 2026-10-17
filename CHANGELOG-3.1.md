# 3.1.0

日期：2026-10-17。状态：本地验证，未实服验证。

- 参考 Carpet 重写左右键：单次、持续、1–1200 tick 间隔，右键支持副手。
- 左键攻击准星命中的实体（含玩家），限制距离和遮挡，不挖掘。左右键同时开启时，同 tick 右键优先。
- 窗口或外部物品使用期间暂停；死亡、重生、切维度、掉线后停止，不自动恢复。
- TUI 复用原状态栏，每 2 秒显示点击模式、间隔、副手和暂停状态。
- 新增 control_clicks、get_click_status、morph_player、mount_player、board_minecart、go_home、sign_in，目前共 27 个 AI 工具。
- 伪装复用申请、等待同意和恢复流程；骑乘复用原状态管理；回家和签到区分指令提交与服务器执行成功。

命令详见 [左右键说明](docs/carpet-clicks.md)；权限与 AI 用法见 [AI 交互工具说明](docs/ai-interactions.md)。

## 安装与升级

先备份旧部署，解压本发布包到新目录。将旧部署的 `.env`、`data/`、`mc-tokens/` 及自定义 `config/` 迁入新目录，再安装依赖和启动。包内配置为本项目当前配置，升级时保留你实际部署的配置。

使用 npm：执行 `npm ci`，再运行 `start.ps1` 或 `npm start`。不需要 Viewer 时可用 `npm ci --omit=optional`，跳过 canvas 等可选依赖。启动会编译 TypeScript，不要省略开发依赖。

沿用 Yarn 的部署可执行 `yarn install` 后启动，但 Yarn 不使用 `package-lock.json`；建议固定使用一种包管理器。已在依赖中声明官方 `openai@7.36.0`，无需额外添加。

发布包包含源码、全新编译产物、配置和文档。不包含 `.env`、数据库、登录令牌、日志、依赖目录或历史备份。

清理前 43 项测试通过。测试目录已手动删除，本次重新打包验证 TypeScript 编译和发布包内容，未重新运行测试。
