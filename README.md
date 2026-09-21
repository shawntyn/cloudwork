# Cloud Work

基于 DeepSeek Harness 的多租户 Agent 工作台。Next.js 16 提供 Web/API，Better Auth 提供数据库邮箱密码登录，PostgreSQL/Drizzle 保存业务数据，独立 runtime-manager 通过宿主 Docker Engine 动态管理用户容器，MCP gateway 代理经授权的外部工具。没有 Kubernetes、Docker-in-Docker 或对象存储。

## 启动

宿主仅需 Docker Engine 与 Docker Compose，推荐 Linux；Docker Desktop 也支持，但需要配置可共享的宿主数据目录。

```bash
cp .env.example .env
# 编辑 .env：填写 DSH_API_KEY 和下文 MCP 管理令牌、加密密钥。
# Docker Desktop 必须修改 USER_DATA_ROOT。
docker compose up -d --build
```

访问 http://localhost:3000。当 `RUNTIME_IMAGE` 指定的镜像标签不存在时，manager 会从自身已经构建好的不可变镜像 ID 派生用户镜像，默认名为 `cloud-work-runtime:local`。派生层复用工具链和依赖，检查 Runtime 类型并设置非 root 用户、HOME 与启动命令，无需再次下载依赖。镜像中没有 Compose 注入的运行时秘密。期间健康检查显示 starting；可以用 `docker compose logs -f runtime-manager` 查看进度。

已有镜像标签和用户容器不会随 manager 重建自动更新。修改 DSH/Runtime 代码后，可将 `.env` 的 `RUNTIME_IMAGE` 改为新标签，再运行 `docker compose up -d --build`，由新 manager 派生对应镜像；也可通过 `docker build -f docker/runtime/Dockerfile -t cloud-work-runtime:local .` 独立构建。随后对已有用户 Runtime 执行 Remove，再 Start 或重新进入 Workspace，才会使用新镜像。仅修改 Key、模型或 Runtime 资源限制时，也需要更新 manager 并重建已有用户容器；用户文件会保留。

`.env.example` 的默认秘密仅用于绑定 127.0.0.1 的本地试用。允许远程访问前，应替换 `BETTER_AUTH_SECRET`、`MANAGER_TOKEN`、`RUNTIME_TOKEN_SECRET`、PostgreSQL 和 Redis 密码，为 MCP 生成独立管理令牌与加密密钥，设置准确的 `BETTER_AUTH_URL`，通过 HTTPS 反向代理提供服务。密码放进连接 URL 时须使用 URL 安全文字（例如随机十六进制）。Web 是唯一发布宿主端口的服务。

本次 macOS 本地验证使用项目 `.data/users` 的绝对路径，写入被 Git 忽略的 `.env`。Linux 默认仍为 `/data/cloud-work/users`。`USER_DATA_ROOT` 必须是绝对宿主路径，manager 中挂载到同一个绝对路径，Docker Engine 才能正确解析 bind mount。

## 架构与项目结构

```text
apps/
  web/                 Next.js 页面、Better Auth 路由、受保护业务 API、SSE
  runtime-manager/     Docker 生命周期、Redis busy leases、BullMQ 回收、运行事件转发
  mcp-gateway/         MCP 连接管理、凭据加密、出站地址策略、运行授权与工具代理
packages/
  auth/                Better Auth + Drizzle adapter
  database/            用户、鉴权、Workspace、Agent Session、Runtime、MCP 表及 migrations
  protocol/            平台事件、Runtime 状态、文件与 MCP 公共类型
  runtime-core/        AgentRuntime 接口
  runtime-dsh/         DSH SDK 适配、事件归一化、版本补丁与测试
  workspace/           ID、路径验证与真实 POSIX 文件操作
docker/
  Dockerfile           Web / manager / MCP gateway 构建目标
  runtime/             用户 Runtime 镜像、内部 HTTP 服务、DSH sandbox patch
scripts/integration.ts 真实运行集成验证
tests/                 文件边界测试
```

业务调用为：浏览器 → Next.js 验证 Better Auth 会话及资源所有权 → manager → 该用户的 Runtime HTTP → `AgentRuntime` → DSH。只有 `runtime-dsh` 依赖 DSH 的 SDK API。前端仅识别平台事件；工具调用、文字增量、状态与错误经过 Redis Stream 后通过 SSE 实时返回。DSH 继续拥有 Agent loop、工具、技能、subagents 和原生 JSONL Session 数据；MCP 连接和授权由平台管理，DSH 通过 gateway 调用获准工具。

## 用户与 Workspace

首次访问创建邮箱密码账号，密码至少 12 位；登录后点击 **New Workspace**。进入 Workspace 会确保该用户 Runtime 已就绪，再进入服务端生成的目录 `/home/work/workspaces/ws_<uuid>`。同一用户所有 Workspace 共用一个容器；不同用户分别拥有 `cloud-work-runtime-<安全 userId>`。业务 Workspace 不使用 DSH Workspace registry。

页面支持会话创建/切换、增量对话、工具调用详情、Stop、文件树、UTF-8 文件读写、目录创建、重命名与删除。文件编辑上限 2 MiB；二进制文件和符号链接内容不提供编辑。文件写入前会验证并固定父目录描述符，Linux `/proc/self/fd` 路径避免祖先目录被替换成符号链接的竞争。所有公共 Workspace/Session API 都检查当前用户，改变状态的请求验证 Origin。

## MCP 连接

第一版支持 **Streamable HTTP** MCP 服务，认证可选 None、Bearer token 或自定义 HTTP headers，仅开放 tools；不支持 OAuth、stdio、本地服务器启动、resources 或 prompts。

维护者先在 `.env` 配置：

- `MCP_GATEWAY_ADMIN_TOKEN`：独立的 32 随机字节十六进制令牌；用 `openssl rand -hex 32` 生成，勿复用其他服务秘密。
- `MCP_ENCRYPTION_KEY`：另生成一份 32 随机字节、64 个十六进制字符的密钥。长期保留并安全备份；更换或丢失后，已有凭据无法解密，不能将随意更换密钥当作轮换流程。
- `MCP_ALLOWED_ORIGINS`：逗号分隔的精确 HTTP(S) origin，例如 `https://mcp.example.com,https://tools.example.com:8443`，不含路径或通配符。留空即不允许连接任何服务。
- `MCP_ALLOWED_PRIVATE_IPS`：确需内网服务时，填写逗号分隔的精确 IP；不接受 CIDR、网段或主机名。地址还必须满足 origin 白名单。回环与链路本地地址始终拒绝，即使列入白名单也不会放行。

更新配置后运行 `docker compose up -d --build`。每次出站连接都会验证并固定 DNS 解析地址，禁止重定向；连接 URL 不接受内嵌凭据、query 或 fragment。内网服务 IP 改变时，维护者需重新核实并更新白名单。

登录后从页头连接图标进入 **MCP connections**（`/settings/mcp`），点击 **Add connection**，填写必填的 **Name**、可选的 **Display name**、完整 endpoint URL 和认证信息。Name 只允许小写字母、数字、下划线，共 1–24 字符，同一用户下唯一，创建后不可修改；例如 `sales_prod` 会生成工具名 `mcp__sales_prod__execute_sql`。Display name 支持中文，留空或清空时显示 Name。旧连接保留已有调用标识、凭据和绑定，无需数据库迁移。API 沿用现有字段：`serverName` 是必填调用标识，`name` 是可选显示名称；PATCH 不接受 `serverName`。

保存后点击 **Test connection** 查看连接状态及工具列表。已存凭据只显示 **Configured**；编辑时留空保留原值，填写自定义 headers 会替换整组旧 headers。进入 Workspace，点击工具栏 **Connections**，选择连接并保存。连接必须同时全局启用并绑定到该 Workspace，Agent 才能使用。

每条新消息创建一份连接配置快照，编辑连接或新增绑定在下一轮生效。禁用、删除或解除绑定会撤销对应运行授权，后续调用不能继续使用；已经由上游完成的操作不会被撤回。上游凭据仅由 gateway 解密和使用，以加密形式保存在 PostgreSQL；Web 公共 API 不回传秘密，用户 Runtime 只获得短期、限定当前运行的 gateway 授权。用户代码沙箱继续断网，MCP 并不为 Bash、Python 或 Node 开放网络。gateway 不挂载 Docker socket，仍只有 manager 管理 Docker。

可选本地验证服务位于 Compose 的 `mcp-test` profile，默认不启动：

```sh
docker compose --profile mcp-test up -d --build mcp-fixture
docker inspect "$(docker compose --profile mcp-test ps -q mcp-fixture)" \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{"\n"}}{{end}}'
```

将 `http://mcp-fixture:4100` 加入 `MCP_ALLOWED_ORIGINS`，将刚查得的实际 Docker IP 加入 `MCP_ALLOWED_PRIVATE_IPS`，保留已有条目，再执行 `docker compose up -d mcp-gateway` 应用配置。在控制台添加 `http://mcp-fixture:4100/mcp`，选择 Bearer token，填入 `MCP_FIXTURE_TOKEN` 的值；默认仅供测试的值为 `local-mcp-fixture-test-token`。测试发现工具后绑定 Workspace，再让 Agent 调用其中一个工具。fixture 容器重建可能改变 IP；此时重复检查并更新白名单。

MCP 集成验收可运行 `pnpm test:mcp`：需要已启动并获准的 fixture，以及 `.cache/integration-account-initial.json` 中的本地测试账号。脚本会创建验收 Workspace、测试账号和演示连接，验证 Runtime 重建、真实模型工具调用与 Python 断网，结果保存到 `artifacts/mcp-integration.json`。数据库层测试可单独运行 `docker compose exec -T mcp-gateway node --import tsx apps/mcp-gateway/test/store.integration.ts`，它仅清理自己创建的临时记录。

## 存储与删除语义

```text
/data/cloud-work/users/<userId>/
  home/                 → /home/work
    .dsh/               DSH profiles / 持久会话
    .cache/ .config/ .npm/
  workspaces/           → /home/work/workspaces
    ws_<uuid>/
```

**删除 Runtime Container != 删除用户数据。** Stop 保留容器与网络；Remove 删除容器及该用户专属的 control/egress 网络。手动操作与自动回收均不删除上述目录。恢复会重新挂载同一份 HOME 与 Workspace。HOME 中的配置和 Workspace 文件持久化；内置依赖来自镜像，随镜像更新。容器系统层修改在重建后消失。默认自动派生路径的系统工具来自 `docker/Dockerfile`；独立构建路径则由 `docker/runtime/Dockerfile` 定义。

删除 Workspace 则是用户显式要求删除该 Workspace 文件及平台会话元数据。用户 HOME 内的 DSH 历史日志不会作为该操作的副作用被擦除。当前不提供整账号清除接口。PostgreSQL 和 Redis 分别使用 Compose named volume；备份应同时覆盖数据库卷、Redis 卷与用户宿主目录，并单独安全备份对应的 `MCP_ENCRYPTION_KEY`，数据库备份本身无法恢复 MCP 凭据。不要执行 `docker compose down -v`，除非确实要删除平台数据。

## Runtime 生命周期与回收

数据库 `runtime_instances` 跟踪 `STARTING / RUNNING / IDLE / STOPPED / REMOVED / ERROR`。`ensureRuntime / startRuntime / stopRuntime / removeRuntime / touchRuntime / getRuntimeStatus` 由独立 manager 实现。使用 Redis 用户锁及确定容器名，保证并发创建也只产生一个用户容器。

BullMQ 周期任务读取数据库活动时间及平台 busy leases，默认每 60 秒扫描。无操作达到 30 分钟且没有 active agent、短期文件操作、foreground command 或 registered keepalive job 时 stop；停止达到 24 小时且仍无活跃工作时 remove。手动 Stop/Remove 同样会拒绝活跃工作，应先停止 Agent。被动打开 SSE 不会延长 Runtime 生命周期。

运行中的 Agent 租约有效期 120 秒，每 20 秒续期。manager 崩溃后，过期租约会在后续扫描中触发孤立执行清理：确认终止后写入 error 终态，保留文件并允许新一轮请求，不会自动续跑被中断的一轮。Redis 不可用或终止结果无法确认时，系统保留运行记录并等待恢复，不会将未知状态当作空闲回收。

内部管理接口 `POST /internal/users/:userId/leases/:kind/:leaseId` 可登记或续期 `foreground-commands` / `keepalive-jobs`，请求体为 `{ "ttlMs": 120000 }`；有效期支持 1 秒至 24 小时，调用方必须按需续期，`DELETE` 同一路径释放租约。它们不会仅因存在 OS 进程而被推断。接口需要 manager 凭证，当前 UI 不提供独立终端或常驻服务注册。

## Docker 隔离

只有 manager 挂载 `/var/run/docker.sock`。自动派生的用户镜像会记录 `cloud-work.runtime-source-image` 标签，便于核验来源；独立构建仍可使用 `docker/runtime/Dockerfile`。用户 Runtime 无 privileged，UID/GID 1000，drop ALL capabilities，no-new-privileges，默认 2 CPU / 4 GiB / 256 PIDs，并限制 swap 与日志。除 HOME、PATH 等基础配置外，Runtime 仅接收该用户 token、模型配置与 API Key，不含数据库/Redis/manager 凭证。

所有 Runtime 加入名为 `cloud-runtime` 的 internal 网络，该桥通过 `enable_icc=false` 禁止容器互访。每个用户另外拥有一个连接该用户 Runtime、manager 与 MCP gateway 的 internal control 网络，以及一个供 DSH 宿主调用模型网关的独立出站桥；出站桥具有更高的网关优先级。用户代码另受下述进程级断网限制，不能使用该出站桥。Runtime 不发布宿主端口，内部统一使用 3080。manager 使用只出现在该用户 control 网络中的 Docker DNS 别名 `cloud-work-control-<userId 的 SHA-256 前 24 位>` 访问 3080，并通过 Docker inspect 核验容器所有权、运行状态及网络别名。这个别名避免同一容器名在多个网络中解析到被禁止互访的共享桥。平台 Postgres/Redis 仅在独立 platform 内网可达。

DSH Sandbox 保持开启。Runtime 启动时功能探测 bubblewrap / Landlock，两者均不可用则拒绝就绪，绝不降级为无沙盒。具体强度取决于内核支持，健康状态会报告 backend/enforcement。`workspace-write` 阻止写出当前 cwd；DSH 默认仍允许读取同一用户容器的其他路径，因此同用户 Workspace 并不声明为独立保密边界，跨用户边界由独立容器、目录和网络提供。

## 离线用户工作区

用户代码使用镜像内置的 Node.js 24 和 Python 3.11。Python 预装 `pandas`、`numpy`、`python-docx`（导入名 `docx`）和 `PyYAML`（导入名 `yaml`）；运行 `python` 或 `python3` 即可使用。版本及传递依赖锁定在 `docker/runtime/requirements.txt`，安装在 root 拥有的 `/opt/workspace-python` 中；无需在工作区创建虚拟环境或下载安装。Node.js 提供标准库，如 `node:fs`、`node:path`、`node:crypto`；平台 `/app` 中的服务依赖不是用户项目的公共依赖清单。

DSH 工具执行边界同时应用文件沙箱和 Linux seccomp 网络限制，子进程及其后代不能访问互联网、内网、DNS 或回环服务。`npm install`、`pnpm add`、`pip install` 不能在线获取新依赖；增加内置库需由维护者修改镜像并重建用户 Runtime。用户已有文件仍保留，本地代码和已有文件不因断网被删除。

DSH 的模型请求由沙箱外的受控宿主进程发送，聊天、流式回复与平台文件操作仍可用。通用 Web 搜索/抓取和宿主进程内执行代码的 workflow 工具关闭；经平台绑定的 MCP 工具通过 gateway 独立授权。模型读写文件统一通过受限 Bash/Python 执行，避免原生父进程文件写入的符号链接竞态绕过内核边界。Web 文件 API 保留已有的路径及目录描述符校验。宿主上的 `docker exec` 属于管理员操作，不自动经过 DSH 命令沙箱；不能用这种方式的联网结果判断用户工具是否有网络。

更换内置依赖或断网策略后，按启动章节更新 `RUNTIME_IMAGE` 并重建已有用户容器。真实模型与离线工具的联合验证：

```sh
docker exec cloud-work-runtime-<test-user-id> \
  node --import /app/node_modules/tsx/dist/loader.mjs \
  /app/docker/runtime/src/offline-workspace-smoke.ts
```

该检查通过真实 DSH `bash` 工具运行 Python/Node：断网断言、DataFrame/NumPy 运算、CSV/YAML/DOCX 写入及读回必须全部成功，随后模型仍须正常回复。

## DSH 实际接口与停止限制

锁定 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-sdk-client` **0.1.5-rc.2**。SDK 的 npm `latest` 标签曾落后于 DSH，因此不依赖浮动标签。

适配器实际使用 `new DeepSeekHarness({ profile: 'sdk', cwd, processCwd, dshHome, provider, model, maxTokens, env, patches })`、`harness.run(prompt, { sessionId, onNotification })` 和 `harness.close()`。Cloud Work 生成 `sess_<uuid>`，同时存为业务 ID 和 `dshSessionId`。原生会话事件、状态及实时文字帧由适配器转成平台的 `text-delta / tool-start / tool-result / status / error`。

当前 SDK 没有 mid-turn cancel 或恢复会话的 RPC：

- `cancel()` 通常使用本 Session 的 `harness.close()`，等待进程结束，其他 Session 不受影响。如果 manager 无法通过 Runtime 接口确认取消成功，会停止该用户整个容器以确保执行终止，此时同用户其他 Session 也会被中断。未来可以只在适配器里换成正式 cancel RPC。
- 为正确回收和防止 Agent 启动的后台进程悄悄阻止空闲判断，每轮结束会关闭该轮 DSH 子进程。需要跨轮长期运行的开发服务器应将来通过平台 keepalive 功能管理。
- 对 SDK JSON-RPC server 提供一份明确、固定版本的 pnpm patch：首先调用 DSH 原生 `agents.resume`，仅当其明确返回 Session 不存在时调用 `agents.create`，并检查持久日志中的 cwd。该补丁随项目版本管理；升级 DSH 时必须复核。
- 此版本 SDK bridge 还缺少内部 `agent/assistant-stream` 转发。相同补丁将官方实时帧通过 `session.assistant-stream` 通知传给适配器；适配器按 Session、attempt、turn/step 处理增量，并抑制最后完整消息的重复文本。未重新实现生成或 Agent loop，前端仍只使用平台 `AgentEvent`。

受当前 DSH sandbox 配置接口限制，Agent 命令的 npm/pnpm/pip/XDG 缓存放在当前 Workspace 内的 `.npm`、`.cache`、`.local` 中，因此同样持久化且无需扩大沙盒写入范围；HOME 中的目录继续供 DSH 宿主及用户配置持久化使用。

默认 provider/model 使用此版本实际名称 `deepseek-official / deepseek-v4-flash`，`DSH_API_KEY` 在子进程中映射为 `DEEPSEEK_API_KEY`。没有 Key 时界面仍可使用鉴权和文件功能，发送消息会显示明确的配置错误。更换 Key 后更新 manager 并重建既有用户 Runtime。

自定义 OpenAI / Anthropic 兼容服务通过 DSH 自带的 `llm-pi-ai` provider 插件接入，继续使用同一个官方 Agent loop、工具和会话；前端不直接连接模型接口。配置示例：

```dotenv
DSH_PROVIDER=openai-compatible
DSH_BASE_URL=https://llm.example.com
DSH_MODEL=your-model-id
DSH_API_KEY=replace-with-your-api-key
DSH_CONTEXT_WINDOW=262144
DSH_MAX_TOKENS=8192
```

`DSH_PROVIDER=anthropic-compatible` 可改用 Anthropic Messages 协议。OpenAI 模式将根地址补为 `/v1`，已经带 `/v1` 的地址保持不变；Anthropic 模式由 SDK 添加 `/v1/messages`，配置末尾的 `/v1` 会被规范化，避免重复路径。自定义模型 ID 显式注册到 DSH provider，不要求在 DSH 内置模型清单中存在。可选 context/output token 上限未设置时使用 131072/8192，output 不能超过 context。

修改 `.env` 后执行 `docker compose up -d --build` 更新 manager；已有用户需从 Runtime 菜单执行 **Remove container**，再 **Start / reconnect** 或重新进入 Workspace，以刷新容器中的模型环境变量。只移除容器，文件及 DSH 历史仍保留。修改 Adapter 代码时还需按前文更新 `RUNTIME_IMAGE` 标签。

Redis 开启 AOF；平台事件流每会话约保留最近 10,000 条、7 天，用于刷新/断线重连。完整 Agent 状态仍由 HOME 内 DSH 日志持久化；超过保留期的历史暂不在 Web 对话中完整展示。

## 配置

| 变量 | 默认/用途 |
| --- | --- |
| USER_DATA_ROOT | `/data/cloud-work/users`，真实宿主数据目录 |
| WEB_PORT / WEB_BIND_ADDRESS | `3000 / 127.0.0.1` |
| BETTER_AUTH_URL | 浏览器访问的完整 origin |
| RUNTIME_CPUS / RUNTIME_MEMORY_MB / RUNTIME_PIDS_LIMIT | `2 / 4096 / 256` |
| RUNTIME_IDLE_MINUTES | `30`，空闲停止时间 |
| RUNTIME_REMOVE_HOURS | `24`，停止后删除容器时间 |
| RUNTIME_REAPER_INTERVAL_MS | `60000`，回收扫描间隔 |
| RUNTIME_IMAGE | `cloud-work-runtime:local` |
| DSH_PROVIDER / DSH_MODEL / DSH_API_KEY | provider、模型、真实 API Key |
| DSH_BASE_URL | 自定义兼容服务根地址；provider 为 `openai-compatible` / `anthropic-compatible` 时必填 |
| DSH_CONTEXT_WINDOW / DSH_MAX_TOKENS | 自定义模型 context/output 上限；默认 `131072 / 8192` |
| MCP_GATEWAY_ADMIN_TOKEN | manager 与 gateway 的独立管理令牌；生成 32 随机字节并编码为十六进制 |
| MCP_ENCRYPTION_KEY | MCP 凭据加密密钥；64 个十六进制字符，须长期保留并备份 |
| MCP_ALLOWED_ORIGINS | 逗号分隔的精确 HTTP(S) origin；空值禁止全部 MCP 服务 |
| MCP_ALLOWED_PRIVATE_IPS | 逗号分隔的精确内网 IP；不接受网段，回环/链路本地地址始终拒绝 |
| MCP_FIXTURE_TOKEN | 可选 `mcp-test` fixture 的测试令牌；默认 `local-mcp-fixture-test-token` |

## 本地开发与验证

源码开发使用 Node 24 与 pnpm 11.21.0；Docker 启动不要求宿主安装它们。

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
docker compose config --quiet
docker compose build
docker compose up -d
pnpm test:integration
```

Drizzle migrations 随项目提交，平台服务启动时使用 PostgreSQL advisory lock 串行应用。修改 schema 后运行 `pnpm db:generate`，应用使用 `DATABASE_URL=... pnpm db:migrate`。开发时不要复用其他项目的数据库或 Redis。

集成测试会创建两个独立测试用户和三个 Workspace，验证鉴权、所有权、容器复用/隔离、文件 CRUD、路径穿越拒绝、Runtime 停止/移除后数据存续、SSE 终态与 Stop 端点。结果保存在被忽略的 `artifacts/integration.json`。测试会留下这些专属测试账号和用户目录，方便检查数据持久性；不会删除其他用户资料。配置真实 Key 后使用 `EXPECT_LLM_SUCCESS=1 pnpm test:integration`，额外要求实际工具执行、文件产物与文字增量成功。

最终实际运行验证结果见 `VERIFICATION.md`；未配置模型凭证时不能声称真实模型调用已成功。
