# Carpet 风格左右键

参考用户提供的 `fabric-carpet-1.21.11-1.4.194+v251223 (1).jar`，通过 `javap -c -p` 检查 `carpet.helpers.EntityPlayerActionPack`、`Action` 和 `ActionType` 的 USE/ATTACK。参考文件 SHA256：`1B4D66F0332BDA5DEEE08755E493C2D6AC64D64D5285E1134AA03604975C2521`。

独立实现于 Mineflayer 客户端，不需要安装 Carpet。修改前源码备份：`release-staging/pre-carpet-clicks.zip`。

## 文字命令

私聊 bot 使用以下命令；公屏沿用项目配置的前缀和权限。白名单、管理员可用，锁定期间可用。

| 命令 | 行为 |
| --- | --- |
| `attack once` | 下一个物理 tick 左键一次 |
| `attack continuous` | 每个物理 tick 左键 |
| `attack interval 20` | 每 20 tick 左键一次，首次也等待 20 tick |
| `attack stop` | 停止左键 |
| `use once` | 右键一次，下一 tick 松开 |
| `use continuous` | 持续右键，弓、盾、食物等保持使用 |
| `use interval 20` | 每 20 tick 右键一次，每次随后松开 |
| `use continuous offhand` | 用副手持续右键；once/interval 同样可加 offhand |
| `use stop` | 停止右键并释放本服务保持的物品使用 |
| `click status` | 查询模式、暂停或停止原因 |
| `click stop` | 停止左右键 |

间隔为 1–1200 个客户端物理 tick，正常约 20 tick/秒，不保证等于服务器 TPS。连续攻击不会绕过服务器武器冷却。

左键只攻击准星命中的最近实体，包含玩家、生物、盔甲架等有碰撞体的实体。忽略掉落物、经验球及部分不可交互投射物；不自动找目标，不追踪，不穿墙，不挖掘。左右键射线范围均为眼睛起 3 格。

右键按准星操作实体、方块或空气中的手持物品。操作方块使用当前位置、命中面和主/副手，不自动转头；方块右键要求 Minecraft 1.14 或更新协议。放置和交互是否成功由服务器规则决定。

## AI 与生命周期

TUI 顶部原有状态栏显示左右键的单次、持续、间隔 tick、副手及暂停状态，沿用每 2 秒刷新；单次动作可能在刷新前已经完成，届时显示停止。完整停止原因使用 `click status` 查询。

新增 `control_clicks` 和 `get_click_status`，沿用白名单和管理员权限。可说“每 20 tick 左键一次”“持续使用副手”“停止左右键”。旧 `autoclick/rightclick/rc` 及旧中文点击别名仍不恢复，避免历史定时任务误启动旧行为。

打开窗口或其他服务使用物品时暂停。点击运行期间暂停自动回家和 AFK 调度。死亡、重生、切维度、掉线时清除动作；重连或重启不会自动恢复。用户另行创建的定时任务仍可按计划重新启动动作。

## 与 Carpet 的差异

Carpet 在服务端可读取交互成功结果；客户端无法可靠取得该结果。这里以发送右键交互作为本 tick 已使用，抑制同 tick 左键；持续实体/方块使用后间隔 3 tick 再试。不自动尝试另一只手或在交互失败后追加空气使用，可明确指定 offhand，或移开准星使用空气中的物品。

持续物品使用按 Mineflayer 使用状态和物品种类处理。服务器拒绝食用、插件自定义物品、较新版本的特殊使用动作仍需实服验证；可用 `use interval 20` 定期重试，或 `use stop` 释放。单次使用不适用于需要长按完成的进食或蓄力。

本地测试覆盖准星遮挡、玩家攻击、tick 时序、主副手包、释放、暂停、断线清理和参数校验；未连接真实服务器验证交互结果。
