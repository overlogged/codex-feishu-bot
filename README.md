# Codex Feishu Bot

把 `codex app-server` 接到飞书群聊，并把“创建飞书应用、开事件订阅、补权限、发布版本、宿主机启动”这整套流程尽量交给用户自己的 Codex 自动完成。

这个仓库的主路径不是“用户自己看文档手点控制台”，而是：

1. 用户打开 Codex，模型切到 `GPT-5.4`，推理强度设成 `xhigh`
2. 用户把仓库地址贴给 Codex
3. Codex 按本仓库的 `README.md`、`AGENTS.md` 和 `docs/` 自己完成环境准备、浏览器自动化和部署
4. 用户只在必须的时候介入：登录 Feishu / OpenAI，或处理租户管理员审批

## 这套仓库能自动做什么

- 用 Chrome DevTools Protocol 启动一个专用浏览器实例
- 让 Codex 通过浏览器自动化操作飞书开放平台
- 创建或复用一个企业自建应用
- 打开机器人能力
- 切到飞书长连接模式
- 订阅 `im.message.receive_v1`
- 补齐 IM 相关权限
- 发布版本
- 把 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 写回 `.env.real`
- 在宿主机启动 `codex app-server` 和 `app` 服务
- 跑健康检查和 smoke check

默认情况下，运行时 `Codex` 看到的工作目录是 `DEFAULT_WORKSPACE`（默认 `/home/overlogged`），不是这个仓库本身。给用户的导出文件会写到这个工作目录下的 `.codex-feishu-bot/artifacts/`。
聊天运行态快照也会写到工作目录下的 `.codex-feishu-bot/runtime-state.json`，因此服务重启后仍能保留 `chat -> thread` 映射和最近消息投影；但重启前未完成的 run 会被标记为已中断，不会继续占着 active turn。服务重启完成后，机器人会自动在受影响的群里发一条提示，告诉用户可以直接回复“继续”。

## 用户还需要做什么

只有这几类动作仍然属于用户：

- 登录飞书开放平台
- 登录 OpenAI / Codex
- 处理 SSO、2FA 或租户管理员审批

不要把普通的开发者平台配置步骤推回给用户。

## 最短上手路径

### 1. 准备机器

建议环境：

- macOS 或 Linux
- Node.js 22+
- `pnpm`
- Google Chrome
- Codex Desktop 或可用的 Codex 会话

### 2. 让 Codex 接管

把这段 prompt 直接贴给 Codex：

```text
打开这个仓库后，严格按照 README.md、AGENTS.md、docs/codex-bootstrap-playbook.md、docs/feishu-console-automation.md 执行，不要把普通的控制台配置步骤推回给我。先运行 pnpm install、pnpm bootstrap:env、pnpm chrome:debug。然后先明确问我一个问题：是否要创建新的机器人。如果我回答“要”，就异步执行 `npx -y lark-op-cli@latest create-bot --name "Codex 机器人"` 并持续读取输出；如果过程中出现扫码登录，请把 ASCII 二维码原样转发给我。如果我回答“不要”，再确认我是否已经登录飞书开放平台或 OpenAI/Codex；如果我没登录，再停下来让我登录。登录完成后，就继续走原来的浏览器和 agent-browser / Chrome CDP 方案，只选择已有机器人并完成后续配置，不要再创建新的机器人。拿到 FEISHU_APP_ID 和 FEISHU_APP_SECRET 后写回 .env.real，然后在宿主机运行 `pnpm codex:host`、`pnpm build:host`、`pnpm start`，再用 `pnpm host:smoke` 验证服务，最后告诉我怎么在飞书里测试。群聊工作区绑定必须通过私聊机器人发送“工作区”获取编号，再回群里 `@机器人 编号`，或用自然语言完成绑定。
```

同样的 prompt 也单独放在 [docs/codex-bootstrap-prompt.md](docs/codex-bootstrap-prompt.md)。

### 3. Codex 会执行的本地命令

```bash
pnpm install
pnpm bootstrap:env
pnpm chrome:debug
pnpm codex:host
pnpm build
pnpm start
pnpm host:smoke
```

## 关键文档

- [AGENTS.md](AGENTS.md)：给 Codex 的仓库级操作约束
- [docs/codex-bootstrap-playbook.md](docs/codex-bootstrap-playbook.md)：Codex 的执行剧本
- [docs/feishu-console-automation.md](docs/feishu-console-automation.md)：飞书开放平台需要达到的目标状态
- [docs/open-source-scope.md](docs/open-source-scope.md)：v1 自动化边界

## 浏览器自动化路径

这个仓库默认把“飞书开发者平台配置”视为浏览器自动化任务，而不是应用运行时的一部分。

推荐做法：

```bash
pnpm chrome:debug
```

这会启动一个专用的 Chrome 调试实例，并暴露本地 CDP 端口。之后 Codex 可以通过任意可用的浏览器自动化能力接管这个浏览器；如果机器上装了 `agent-browser`，典型命令是：

```bash
agent-browser --cdp 9222 open https://open.feishu.cn/app
```

如果 `agent-browser` 不在机器上，Codex 也可以用任何可用的 CDP/DevTools 能力，只要它真的去操作浏览器，而不是让用户手动点一遍。

## Host 运行架构

```mermaid
flowchart LR
  U["Feishu 用户 / 群聊"] --> F["Feishu 长连接事件"]
  F --> A["宿主机 app 进程"]
  A --> C["宿主机 codex app-server"]
  C --> O["OpenAI / Codex"]
  A --> M["Feishu OpenAPI 发消息 / 更新卡片 / 发文件"]
  M --> U
```

默认运行路径是宿主机双进程：

- `codex app-server`：先在宿主机独立启动
- `app`：Node 服务，连接外部 `codex app-server`

对应命令：

```bash
pnpm codex:host
pnpm build:host
pnpm start
pnpm host:smoke
```

各 CLI 都按常驻 server/会话协议接入，不再每条消息重开进程：

- `codex`：连接宿主机 `codex app-server`（WebSocket JSON-RPC）
- `kimi`：启动 `kimi acp`（Agent Client Protocol，stdio JSON-RPC），按群复用长驻会话
- `pi`：启动 `pi --mode rpc`（stdio JSON-RPC server），按群复用长驻进程；仅配置 OpenCode Go 订阅，默认 `deepseek-v4.1-flash` / `high`。活跃 turn 内收到新消息会用 `abort` 打断当前 turn，再用最新消息立即重跑
- `dsh`：启动 `dsh --profile acp`（DeepSeek Harness 的 ACP v1 stdio 协议），按群复用长驻会话。`ds` / `deepseek` 默认使用 DeepSeek 账号的 Flash；支持按群选择 OpenCode Go 订阅、DeepSeek API 和 OpenModel。模型及别名在 `config/providers.json` 配置，凭据沿用本机 dsh。先切换模型，再设置该模型支持的思考深度（群绑定优先，`DSH_ACP_REASONING` 默认 `high`）。
- `devin`：启动 `devin acp`，复用本机 Devin 登录和会话；支持过程输出、工具卡片及进程重启后的会话恢复。执行中追加消息按顺序排队，不中断当前任务。
- `claude`：活跃任务使用 `--input-format stream-json` 持续接收输入，新消息通过原生 steer 注入同一个进程；任务结束后关闭输入，下一轮恢复会话。

默认工作目录是 `/home/overlogged`。群聊只能绑定这个根目录下的一级子目录，不能直接把仓库根目录当运行工作区。

## 按群绑定

每个群的绑定会决定：

- 目录编号
- CLI 类型
- Codex 模型与思考深度（使用 Codex 时）

所有会话都在宿主机裸机直接运行。
Codex 默认使用 `gpt-6-astra` 和 `high`；也可以绑定 `gpt-6.1-sol` 或 `gpt-5.6-sol`，并显式指定 `low`、`medium`、`high`、`xhigh`、`max` 或 `ultra`。

常见绑定方式：

- 私聊机器人发 `工作区`
- 回到群里发 `@机器人 12`
- 或 `@机器人 claude 12`
- 或 `@机器人 devin 12`
- 或 `@机器人 codex GPT6 high 12`
- 或 `@机器人 codex 6.1 Sol high 12`
- 或 `@机器人 codex 5.6 Sol xhigh 12`
- 或 `@机器人 kimi 12`
- 或 `@机器人 pi 12`
- 或 `@机器人 pi ds4 flash 12`
- 或 `@机器人 ds 12`（默认 DeepSeek 账号 + Flash）
- 或 `@机器人 dsh DeepSeek 账号 pro 12`
- 或 `@机器人 dsh opencode flash 12`
- 或 `@机器人 dsh opencode kimi-k3 12`
- 或自然语言，例如 `@机器人 把这个群切到 12 号目录`

### 所有后端的模型与 provider 配置热加载

统一配置文件为 `config/providers.json`，包含 `codex`、`claude`、`kimi`、`pi`、`dsh`、`mcode`、`devin` 七个已接入后端。编辑保存后，下次绑定、控制提示和新任务读取时生效，无需构建或重启机器人。使用 `CHAT_PROVIDER_CONFIG_FILE` 可指定其他路径（更改路径变量需要重启）。配置文件无法创建新的 CLI 协议适配器。

每个 `backends.<cli>` 支持以下字段：

| 字段 | 用途 |
| --- | --- |
| `aliases` | CLI 的别名，例如 `ds` 对应 dsh |
| `models` | 模型列表，每项包含 `id`、`aliases` |
| `providers` | 已在对应 CLI 中配置的 provider ID 和别名 |
| `defaultModel` | 默认模型，必须引用本段 `models` 中的 ID |
| `defaultProvider` | 默认供应商，必须引用本段 `providers`；Pi 支持，Kimi/DSH 取决于 ACP 能力 |
| `defaultThinking` | 默认思考深度；Codex/Pi 支持，Kimi/DSH 取决于 ACP 能力；Claude/Devin 沿用原生行为 |
| `nativeSettings` | 为 true 时使用 CLI 本机配置，不传 model/provider/thinking；Kimi 默认开启，DSH 默认关闭 |

模型项还可设置 `provider`（固定路由）、`fallbackProvider`（没有指定供应商时的运行时兜底）、`providerModels`（Pi/DSH 的 provider → 实际模型 ID 映射）。例如，在 Pi 的 `providers` 中加入 `{"id":"my-gateway","aliases":["我的网关"]}`，并在 `models` 中加入：

```json
{
  "id": "my-model",
  "aliases": ["我的模型"],
  "provider": "my-gateway",
  "providerModels": { "my-gateway": "vendor/model-v2" }
}
```

之后可用 `@机器人 pi 我的模型 12` 绑定。网关地址和密钥仍须配置在 Pi 原生配置中，这份文件只负责选择和映射。Codex 严格校验模型白名单；其他后端允许未列出的原生模型 ID 交给 CLI 校验。显式群绑定优先于配置默认值，配置默认值优先于 CLI 环境默认值。

Claude 的 `providers` 配置用于 `切换 claude provider <别名>`，运行时会与 CC Switch 实际供应商列表核对，切换仍是全局操作。Claude/Codex/Devin 不支持通过群绑定指定 provider，因此不接受 `defaultProvider` 或模型项 provider 路由。Kimi 如需显式模型/provider 设置，先设 `nativeSettings: false`，再填写模型和默认值；执行时只会应用 ACP 会话实际提供的配置项，未支持的选项会明确报错。

别名忽略大小写，空格和下划线按连字符匹配；同一命名空间中的不同项目不能共用别名。无效配置、缺失文件或未写完的 JSON 会保留上一份有效配置并记录警告，修复后自动恢复；启动时没有有效配置则报错。更新不会改写已保存的显式绑定或打断正在执行的任务；删除 Codex 模型前请先迁移使用它的群绑定。

兼容旧环境变量 `CODEX_BINDING_MODELS_FILE`：显式设置时只覆盖 Codex 模型配置，原 `config/codex-models.json` 仅保留作为旧格式示例；未设置时 Codex 也从统一文件读取。



## Pi 与 @机器人 控制请求

Pi 的供应商列表仅保留 `opencode-go`，默认模型为 `deepseek-v4.1-flash`，思考档位为 `high`。`dsf4.1`、`ds4.1 flash` 和旧的 `deepseek-flash` 都映射到该模型。也可用 `@机器人 pi kimi-k3 12` 或 `@机器人 pi glm-5.3-flash 12`，仍通过 OpenCode Go 调用；Flash 与 Pro 分开选择。

`@机器人` 的自然语言控制请求固定交给 **Pi + OpenCode Go + DeepSeek V4.1 Flash + high** 解析。即使用户要求把群绑定到其他模型，或控制提示包含完整模型列表，解析模型也保持不变。普通任务有显式群绑定模型时同样优先使用绑定；未指定模型的调用才从消息中匹配模型。

Pi 登录信息保存在 `~/.pi/agent/auth.json` 的 `opencode-go` 项；本机 `settings.json` 的默认 provider/model 应与机器人配置一致。可用 `pi update --models` 刷新订阅模型目录。旧的 OpenModel、DeepSeek API、OpenRouter 或本地模型供应商不再在 Pi 连接配置中启用；旧群绑定需要迁移到 `opencode-go`。运行时会拒绝不在 Pi 配置供应商列表中的路由。

## DSH：DeepSeek 账号与 OpenCode Go

`ds` / `deepseek` 是 dsh 后端的别名。默认绑定 `deepseek-account` / `deepseek-flash`，使用本机已登录的 DeepSeek 账号。修改默认值会影响未保存显式模型/provider 的旧绑定；已经明确指定的群绑定保持原选择。

| 群里发送（12 换成目录编号） | 来源与模型 |
| --- | --- |
| `@机器人 ds 12` | DeepSeek 账号，Flash |
| `@机器人 dsh DeepSeek 账号 pro 12` | DeepSeek 账号，V4 Pro |
| `@机器人 dsh opencode flash 12` | OpenCode Go，V4.1 Flash |
| `@机器人 dsh opencode pro 12` | OpenCode Go，V4 Pro |
| `@机器人 dsh opencode kimi-k3 12` | OpenCode Go，Kimi K3 |
| `@机器人 dsh opencode glm-5.3 12` | OpenCode Go，GLM 5.3 |
| `@机器人 dsh opencode minimax-m3 12` | OpenCode Go，MiniMax M3 |
| `@机器人 dsh openmodel flash 12` | 原 OpenModel 网关，Flash |

`opencode` / `OpenCode Go` 映射到 `opencode-go`，`DeepSeek API` 映射到 `deepseek-official`。可让机器人“列出 dsh 的模型和 provider 选项”，也可在 `config/providers.json` 查看和修改别名。OpenCode 模型是否可调用取决于该订阅实际权限；列表不是额度或权限保证。

运行时从 ACP 返回的 provider 分组中匹配完整模型选项，不会因模型同名而混用账号和订阅。Flash 在 DeepSeek 账号中的 ID 是 `deepseek-flash`，在 OpenCode/OpenModel 中是 `deepseek-v4.1-flash`，适配器自动映射；Pro 使用独立的 `deepseek-v4-pro`。未列入机器人配置的模型也可显式填写 provider 和原生模型 ID，由 ACP 校验。无效或歧义选项会报错，不能悄悄改走其他供应商。

支持在绑定时附加 `high`、`max`、`off` 等思考档位，以所选模型实际支持的选项为准。显式指定不支持的档位会报错；环境默认档位不受支持时记录警告并使用模型默认值。

dsh 的 provider 和凭据仍由本机 dsh 管理；当前版本的 ACP profile 位于 `~/.dsh/profiles/acp/cordis.patch.yml`，不再依赖旧的 `~/.dsh/settings.yaml`。如要完全沿用本机默认设置，可将 DSH 的 `nativeSettings` 设为 `true`，同时清空 `models` 并删除 `defaultModel` / `defaultProvider` / `defaultThinking`。

## Devin

先在宿主机完成 `devin auth login`，私聊机器人发送 `工作区` 获取目录编号，再在群里发送 `@机器人 devin 12`。后续普通消息使用本机 Devin 登录账号执行，默认沿用 Devin 的模型；`DEVIN_ACP_MODEL` 可指定新会话默认模型。群绑定显式指定模型时，优先于环境默认值；支持完整模型 ID（例如 `swe-2-high`）或名称（例如 `Claude Opus 5.5`）。运行时根据 Devin 实际模型列表匹配；未指定档位时优先沿用同模型当前档位，其次选 medium，不支持的名称会明确报错。

`DEVIN_ACP_COMMAND` 默认 `devin`；服务 PATH 找不到时可设绝对路径。`DEVIN_PROXY_URL` 可为 Devin 子进程单独指定代理。无人值守任务使用 bypass 权限模式。任务执行中发来的消息会收到排队回执，依次续接会话；目前不支持原生 steer。可用群状态里的 `devin --resume <会话 ID>` 命令在本机恢复会话。

## Claude 与 CC Switch

群里发送 `@机器人 claude 12` 绑定 Claude 工作区（先私聊发送 `工作区` 获取编号）。后续普通消息调用宿主机 Claude Code，并自动续接会话。执行中会实时发送阶段说明；没有文字说明时显示精简工具状态，工具卡片仍由群设置控制。任务执行中再发普通消息，会通过 Claude 原生 steer 调整当前任务并收到回执，保持进程与会话；Claude 可能取消或重新安排当前工具步骤。若消息恰好到达任务收尾阶段，会等本轮结束再恢复会话处理。

- `@机器人 provider` 或 `@机器人 列出 claude provider`：列出 CC Switch 的 Claude 供应商，标记当前项。
- `@机器人 切换 claude provider ikuncode`：按完整 ID 或唯一名称切换；也支持自然语言向主控提出查看和切换请求。
- 私聊也可使用以上 provider 命令，无需 @。

切换使用 `cc-switch -a claude provider switch`，影响本机所有使用全局配置的 Claude 会话，后续任务生效；进行中的任务继续使用原配置。列表仅展示 ID、名称和当前标记，不展示密钥。Claude 默认模型来自供应商配置，群绑定显式指定模型时优先使用绑定模型。

`CLAUDE_CLI_COMMAND` 默认 `claude`，`CC_SWITCH_COMMAND` 默认 `cc-switch`，服务 PATH 未包含它们时可配置绝对路径。如供应商需要代理，可设置独立的 `CLAUDE_PROXY_URL`，仅传给 Claude 子进程。Claude 任务默认绕过交互式权限询问，与宿主机无人值守运行方式一致。

## 额度与用量统计

- 私聊机器人发 `额度` / `余量` / `用量` / `token` / `usage` / `quota` / `stats`，或在群里 `@机器人 额度`，即可同步查看额度与用量统计，不会启动任务
- 群里也可以用自然语言问额度，例如 `@机器人 还剩多少额度`，由群控制 agent 的 `show_quota` 意图返回同一份报告
- 报告包含 Codex 账号实时额度窗口、Kimi 账号实时额度（读取本机 kimi CLI 登录态，含 k3 等全部模型）、Codex 累计用量、**今日各 CLI 消耗**、**近 1 小时消耗（按用量快照估算）**，以及各 CLI 本月历史用量（后者依赖可选的全局命令 `npm install -g ccusage`，缺失时自动跳过；费用按 `USAGE_USD_TO_CNY_RATE` 折算为人民币）
- 用量统计仅在用户查询额度/用量，或已开启的 token 日报到达发送时间时触发。启动和后台定时器不再采集用量；普通聊天、@绑定、查看日报设置不会触发统计。
- 查询和日报生成时顺带保存快照（`USAGE_SNAPSHOT_FILE`）。「近 1 小时消耗」需要当天 45–75 分钟前的快照，否则显示暂无法估算；不会将数小时前的差值当成一小时用量。
- CLI 用量统计仅包含 Codex、Claude、Kimi 和 Pi；Devin 不参与报告、合计、快照或日报，也不读取其会话数据库。Devin 聊天后端仍可正常使用。

### 每日 token 消耗日报

- 在群里 `@机器人 打开 token 日报` 即可为这个群开启每日 token 消耗日报；`@机器人 关闭 token 日报` 关闭；`@机器人 token日报` 查看状态
- `@机器人 token 日报 23:30` 可单独调整这个群的发送时间；默认时间由 `TOKEN_DAILY_REPORT_TIME` 控制（HH:mm，本地时区，默认 23:00）
- 日报内容为当天各 CLI 的 token 消耗与估算费用；机器人不主动发送额度告警，只在被问到时返回报告

## 后台运行

最直接的后台方式是各起一个宿主机进程：

```bash
nohup pnpm codex:host > /tmp/codex-feishu-bot-codex.log 2>&1 &
nohup pnpm start > /tmp/codex-feishu-bot-app.log 2>&1 &
pnpm host:smoke
```

如果只是临时跑，这已经够用；但长期运行更推荐 `systemd --user`。

## User Service

仓库里提供了 user service 安装脚本：

```bash
pnpm service:install:user
systemctl --user enable --now codex-feishu-bot-codex.service
systemctl --user enable --now codex-feishu-bot-app.service
pnpm host:smoke
```

常用运维命令：

```bash
systemctl --user status codex-feishu-bot-app.service
systemctl --user restart codex-feishu-bot-app.service
journalctl --user -u codex-feishu-bot-app.service -f
journalctl --user -u codex-feishu-bot-codex.service -f
```

如果你希望退出登录后服务继续运行，再执行：

```bash
loginctl enable-linger "$USER"
```

## 环境变量

Codex 主要会写这个文件：

```bash
.env.real
```

先由仓库脚本生成：

```bash
pnpm bootstrap:env
```

然后由 Codex 自动补齐至少这些值：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `CODEX_HOME_SOURCE` 或 `OPENAI_API_KEY`
- `DEFAULT_WORKSPACE`
- `CHAT_WORKSPACE_BINDINGS_FILE`
- `CODEX_ARTIFACTS_DIR`
- `RUNTIME_STATE_FILE`

推荐优先让 Codex 检查宿主机是否已经存在 `~/.codex/auth.json`。如果存在，就把 `CODEX_HOME_SOURCE` 改成这个宿主机绝对路径；只有在本机没有 Codex 登录态时，才退回 `OPENAI_API_KEY`。

`.env.real.example` 里对每一项都有注释。

代理使用 `CODEX_PROXY_URL`（例如 `http://127.0.0.1:7891`），只传给 Codex
app-server 和 codex-auth 子进程。机器人启动时清除继承的通用代理变量，飞书、Kimi、
Pi 和 dsh 默认直连；到本机 Codex app-server 的 WebSocket 也直连。
如需确保飞书长连接直连，设置 `FEISHU_WS_PROXY_DISABLED=true`。

## 飞书目标状态

Codex 在飞书开放平台里最终应达到这个状态：

- 企业自建应用
- 已打开机器人能力
- 已切到长连接模式
- 已订阅 `im.message.receive_v1`
- 已补齐 IM 权限
- 已发布版本，测试租户可用

详细说明见 [docs/feishu-console-automation.md](docs/feishu-console-automation.md)。

## 验证

服务起来后：

```bash
pnpm host:smoke
```

再去飞书里：

- 把机器人拉进一个群
- 先用私聊 `工作区` 获取编号，再在群里通过 `@机器人` 完成绑定
- 绑定后群里直接发普通消息即可，不需要每条都 `@`
- 或直接单聊机器人

如果自动化配置和部署都完成，机器人应能直接回消息、更新过程卡片、发送文件。

## 本地开发

本地代码开发仍可用：

```bash
cp .env.example .env
pnpm dev
```

但这条路径只适合写代码，不是推荐的集成验证路径。真实联调、验收和排查默认都走宿主机 `pnpm start`。

## Fake Feishu 联调

仓库仍保留 fake Feishu 环境，适合纯本地联调：

```bash
pnpm fake-feishu &
pnpm dev
curl -X POST http://localhost:3400/fake/events/message \
  -H 'content-type: application/json' \
  -d '{
    "chatId": "oc_demo_local",
    "messageId": "om_demo_local_1",
    "text": "帮我总结一下当前联调链路",
    "mentionsBot": true
  }'
curl http://localhost:3400/fake/state
```

fake Feishu 只提供 HTTP/WS 模拟（`scripts/fake-feishu-server.mjs`），不依赖额外服务。

## 注意事项

- `.env.real`、本地 Chrome profile、`.codex-local/` 都不要提交到 GitHub
- 用户可见导出文件默认会落到 `.codex-local/workspace/artifacts/`，这是预期行为，不是源码目录
- 运行时用户可见的文件必须通过飞书 API 发布，工作空间文件默认只有 Codex 自己可见
- 这套仓库默认不会为用户申请不存在的“飞书开发者平台管理 API”；平台配置路径是浏览器自动化

## License

MIT

DSH 网关需要代理时可设置 `DSH_PROXY_URL`，只传给 DSH 子进程，同时开启 Node fetch 的环境代理支持（已在当前宿主机 Node 24.14 验证）。飞书仍保持直连；修改环境变量后需重启机器人。
