# ResponsibilityStack · AI 责任追溯

简体中文 | [English](README.md)

> 已于 2026-10-10 停止开发和维护。本仓库仅作为实验项目的公开源码备份，不应视为已完成生产验证的产品。最终修复在本地通过了 32 项自动化测试，但尚未验证真实 Codex 客户端中的安装及采集流程。

**追溯责任，不是让 AI 背锅。**

ResponsibilityStack 记录 AI 会话期间观察到的代码变化，区分工具相关变化与未经证实的作者身份，保存带签名的本地证据和用户声明的可用功能状态，并提供带安全检查的细粒度回退。

## 默认接入方式

项目以 Codex 插件形式接入：

- **Hooks 自动采集。** `UserPromptSubmit` 建立本轮基线，`PostToolUse` 记录工作区变化，`Stop` 为产生变化的轮次签名。成功时不输出内容。
- **MCP 按需查询。** 提供历史、功能对比、证据验证、回退预览与执行工具。
- **Skill 只路由相关请求。** 日常开发不会自动查询历史或追加本项目上下文。
- **CLI 包装模式保留兼容性**，但不再是推荐入口。

插件安装完成、Hooks 获得信任后，按平常方式使用 Codex，无需给命令增加前缀。

## 一键初始化已有项目

在已有 Git 仓库中运行：

```bash
respstack onboard
```

该命令可重复执行。它创建带签名的本地证据存储，记录开始追踪的时间，将接入前已有改动标为无法归属，并验证已有证据；不会修改业务源码或为业务源码创建快照。`respstack init` 仍作为别名保留。

初始化成功不代表采集已经生效。报告分别给出 `storageReady` 和 `capture.status`；只有证据有效、且最近 15 分钟内观察到完整的 `UserPromptSubmit → PostToolUse → Stop` 生命周期签名回执时，`ready` 才为真。回执只证明对应时间发生过采集，不保证插件一直启用；缺失、过期或无效的回执都不能报告采集就绪。

安装、启用并信任插件 Hooks 后，在 Codex 中完成一轮包含只读 `Read` 或 `Bash` 调用的会话，再执行 `respstack onboard --json`，即可在不修改源码的情况下检查 Hook 链路。CLI 退出成功仅表示存储初始化或验证成功，脚本仍须单独检查 `ready` 或 `capture.status`。

Codex 内对应工具为 `responsibility_onboard`。接入前的历史 AI 责任不会被补造。

## 证据与归属

每轮用户请求将观察到的修改与以下信息关联：

- 用户意图、会话及轮次 ID；
- 观察者的 agent、模型、工具名称及调用 ID；
- 时间、Git 基准提交，以及修改前后的内容摘要。

这些字段描述观察上下文，不必然证明是谁写了代码。历史和 MCP 返回值明确区分归属等级：

| 等级 | 含义 |
| --- | --- |
| `tool-correlated` | 支持的 `Edit` / `Write` 输入与观察到的路径、内容变换匹配，且不存在重叠的已记录会话。这是相关性，不是模型提供方认证的作者身份。 |
| `unattributed` | 并发会话、Shell / 包装模式观察、缺少工具输入，或其他无法核实作者的情况。 |
| `declared` | 核心 API 调用方明确声明的修改前后变化。 |
| `system` | ResponsibilityStack 自身的恢复操作。 |

并发会话共享观察到的文件状态，避免同一变化被各会话分别认领。未经证实的观察者不会被直接显示为作者；观察者信息另行提供。缺少归属字段的旧事件仍可读取，但按无法归属处理，不重写其签名。历史和解释查询遇到无效签名或损坏证据时会拒绝返回事实结论。

修改事件组成哈希链，完整轮次使用仓库本地的 Ed25519 密钥签名。运行时证据存放在 `.git/respstack`，不进入工作树。

保存提示词前，会尽力脱敏常见秘密，包括带引号的 JSON 密码和 Token 值，并保留原始提示词的 SHA-256 摘要用于关联。脱敏不是对任意敏感文本的识别保证，已有签名证据也不会自动改写。

## 保存已知可用的功能状态

确认某个功能可用时，显式保存其当前源码状态：

```bash
respstack feature checkpoint login --path src/auth --path test/auth --note "login verified manually"
respstack feature status login
respstack feature history login
respstack rollback feature login --dry-run
respstack rollback feature login
```

检查点是本地签名记录，范围应限定为定义该功能所需的最小文件或目录。它记录源码状态与用户的“已知可用”声明；没有外部测试证据时，不宣称已经证明运行正常。检查点不会自动创建。

功能回退先预览受影响的文件、差异片段和 JavaScript / TypeScript 符号，再通过一个可恢复事务还原可归属文件。责任链断裂、包含无法归属的观察，或文件在最新记录后又发生变化时，会拒绝回退。

## MCP 工具

- `responsibility_onboard`：初始化并验证仓库追踪状态。
- `responsibility_history`：查询精简修改历史。
- `responsibility_why`：查询路径变化及记录的原因与归属信息。
- `responsibility_verify`：验证对象、哈希链和签名。
- `responsibility_feature_checkpoint`：显式保存已知可用的功能状态。
- `responsibility_feature_list`：列出功能检查点。
- `responsibility_feature_status`：比较当前文件与检查点。
- `responsibility_feature_history`：查看检查点之后可归属的修改。
- `responsibility_rollback_plan`：生成安全检查失败即拒绝执行的回退预览。
- `responsibility_rollback`：执行并记录精确回退或移植回退。

支持回退功能检查点、完整 AI 轮次、单次编辑、单个差异片段，以及单个 JavaScript / TypeScript 符号。精确回退不会覆盖后续或无法归属的修改。

### 安全边界

- 轮次和功能回退拒绝不确定的作者归属。显式选择单次编辑、片段或符号时，可在提示作者未经证实并通过内容冲突检查后恢复，但这不能证明原作者是谁。
- 片段回退拒绝重复上下文造成的歧义；文件在记录后发生变化时，不会隐式搬移片段。符号回退隔离单个变量声明，拒绝歧义符号及不支持的声明删除。
- 拒绝包含符号链接、Git 元数据、目录或重复目标的恢复路径，不会偷偷跟随或转换符号链接。
- 文件修改与签名恢复记录共用恢复日志。签名或记录失败时还原操作前文件；完成签名的轮次是事务提交点。重启时恢复未完成事务，不撤销已完成事务。若中断后出现人工修改，则停止恢复并保留日志供检查。
- 锁只协调 ResponsibilityStack 自身操作，不约束任意外部写入。并发 agent 建议使用独立 Git worktree。这不是针对恶意进程的文件系统沙箱，也不是文件系统级多文件原子事务或断电持久性保证。

## 成本与项目影响

- 默认记录不增加模型上下文 Token：成功的 Hooks 不向模型输出内容。
- 仅在请求历史或回退时，MCP 响应才消耗模型 Token。
- 功能检查点仅在显式请求时产生工作量，日常轮次不自动维护。
- Hooks 运行 `git status`，只对变化或触及的文件计算摘要，不在每次工具调用后快照整个仓库。
- 不向工作树添加业务源码或生成的证据文件；本地证据仅存放在 `.git/respstack`。
- Git Blob 和 Git 文件列表输出设有 64 MiB 安全上限；超限会明确报错，不会静默丢失证据。普通多兆字节文件不再受此前默认子进程缓冲区大小限制。

## 构建与验证

需要 Node.js 22 或更新版本。

```bash
pnpm install
pnpm build
pnpm check
pnpm test
```

`pnpm build` 会在 `dist/plugin` 下生成独立的 Hook 与 MCP 包，已安装插件不需要自带 `node_modules`。

当前适配器面向 Codex 生命周期 Hooks。Cursor、GitHub Copilot 和 OpenCode 适配器可作为未来扩展接入相同证据存储，无需改变回退语义；本仓库并未实现或验证这些额外适配器。

## 兼容 CLI 模式

没有生命周期 Hooks 的 agent 可使用包装命令：

```bash
respstack onboard
respstack run --intent "Fix login button copy" --agent codex --model model-name -- codex exec "Fix it"
```

终端仍可查询、验证和回退：

```bash
respstack why src/auth/token.ts
respstack history --path src/auth
respstack verify
respstack rollback edit <edit-id> --dry-run
respstack rollback edit <edit-id>
```

同一 agent 运行不要同时使用包装命令与 Hook 适配器。包装的子进程会自动禁用插件采集，避免重复证据。

## 信任边界

本地签名证明的是：证据在完成签名后没有被更改。它不证明机器、操作者或模型提供方诚实。提供方回执、工作负载身份、透明日志、CI 证据和部署关联可作为未来扩展，不属于本仓库已经验证的能力。
