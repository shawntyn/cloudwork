# 实际验证记录

验证日期：2026-09-20。环境：macOS + Docker Desktop，Linux 用户 Runtime，服务地址 `http://localhost:3000`。

## 离线工作区更新（当前运行版本）

当前用户镜像为 **`cloud-work-runtime:offline-v1`**。6 个已有用户 Runtime 均已通过 manager 的 remove/ensure 接口更新；原本停止的容器恢复为停止状态。逐文件 SHA-256 比较确认原有 HOME、Workspace 和 DSH 会话文件完整保留，结果见 `artifacts/offline-runtime-refresh.json`。四个 Compose 服务健康，当前浏览器 Workspace 文件接口返回 200。

用户命令现在经过官方文件沙箱（本机为 Landlock/full）与静态 seccomp launcher。IPv4/IPv6 TCP/UDP、UNIX socket、DNS、回环地址及 exec 后代的联网均被拒绝；DSH 父进程仍可请求配置的模型网关。镜像启动会探测两种约束，无法执行时拒绝就绪。模型工具目录关闭 web、workflow、ralph 和父进程原生文件修改入口，读写经受限 Bash/Python 执行；Web 文件 API 保持可用。

Python 3.11 环境预装 **NumPy 2.4.6、pandas 3.0.6、python-docx 1.2.0、PyYAML 6.0.3**，直接及传递依赖均固定版本与 wheel SHA-256。非 root、完全断网容器中的导入与 DataFrame 运算通过。Node.js 为 **24.20.0**，提供内置标准库。

本轮验证：

- 全仓库类型检查和 Compose 配置检查通过；27 项通用测试通过。
- 新增 Linux 官方 sandbox 边界测试在部署镜像内通过（macOS 主机跳过）：工作区内写入允许，工作区外 HOME 写入拒绝，父进程监听仍有效，Python/Node 子进程联网拒绝。报告：`artifacts/offline-linux-test.txt`。
- 真实 SDK 向受控模型端点发送的工具目录不包含 web、write/edit、workflow、run_code、ralph；实时流测试通过。
- 真实 `aimax-latest` 网关经 DSH 两次 Bash 调用执行 `offline-workspace-smoke.ts`：四个 Python 库完成 NumPy/DataFrame 运算，CSV/YAML/DOCX 写入与读回成功；Python 4 类 IP socket 和子进程 Node 4 次 TCP/UDP 请求全部拒绝。模型返回 **214 个文字增量**，正常结束。报告：`artifacts/offline-workspace.jsonl`。

后续章节保留早期版本的验证历史。管理员直接 `docker exec` 的网络能力不代表受限用户工具的能力；断网测试必须经过 DSH SandboxProvider 或真实工具调用。

## 兼容网关接入更新

已配置本地 `.env` 指定的兼容网关，默认协议 `openai-compatible`，模型 `aimax-latest`，context/output 设置为 262144/8192。实际地址与凭证仅写入被忽略的本地 `.env`。宿主与真实用户容器都能访问该网关；OpenAI Chat Completions 和 Anthropic Messages 两个端点均返回真实文字。

本轮类型检查通过，**27 项测试通过**（2 个文件边界、11 个 manager、14 个 DSH adapter/SDK 测试）。更新 manager 与用户镜像到 `cloud-work-runtime:gateway-v2`，已有测试用户容器已重建，持久文件保留。

`EXPECT_LLM_SUCCESS=1 pnpm test:integration` 已通过全部 14 项检查：真实模型调用 `read → write → read`，生成的 `agent-proof.txt` 内容正确，SSE 返回工具开始、工具结果及 **58 个文字增量**，最终正常结束。报告见 `artifacts/gateway-openai-integration.json`。

Anthropic 兼容路径也在更新后的用户 Runtime 中通过真实 DSH 读写验证：生成文件与输入逐字节一致，Landlock/full 保持开启，共 **52 个文字增量**；首段约在 48.16 秒到达，50.04 秒执行结束，证明文字在结束前持续到达。报告见 `artifacts/gateway-anthropic.json`。可重复运行：

```sh
docker exec -e GATEWAY_SMOKE_PROVIDER=anthropic-compatible \
  cloud-work-runtime-<test-user-id> \
  node --import /app/node_modules/tsx/dist/loader.mjs \
  /app/docker/runtime/src/gateway-smoke.ts
```

浏览器页面以当前默认 OpenAI 协议实际发送中文任务，看到 `write`、`read` 完成和中文回复；打开模型创建的 `gateway-ui.txt`，内容确认为 `AIMAX_UI_VERIFIED`。检查时无浏览器 warning/error，最终页面保留供查看。

首次真实生成发现 DSH SDK bridge 没有转发内部实时文字帧。现已将转发加入原有 SDK server 补丁，适配器按会话与 attempt/turn/step 转换并去重；真实 SDK + 本地受控 SSE 测试证明首段在模型响应结束前到达、完整消息不会重复追加。上述 58 段输出来自修复后的真实网关运行。

## 构建与启动

以下命令已实际执行成功：

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
docker compose config --quiet
docker compose build
docker compose up -d
pnpm test:integration
```

`web`、`runtime-manager`、`postgres`、`redis` 均通过健康检查。Web/API 在 Docker 内运行；只有 Web 发布 `127.0.0.1:3000`。manager 自动从自身不可变镜像创建用户 Runtime 镜像，无需宿主 Node.js。数据库 migration 在两服务启动时实际应用。

## 自动化与 Docker 实测

- **15 个测试通过**：2 个 POSIX 路径/文件测试、7 个 manager 测试、6 个 DSH adapter/事件测试。包含真实 SDK 子进程启动期间的取消，并非仅用替身测试取消。
- **14 项 HTTP 集成检查通过**：真实注册两个 Better Auth 用户；邮箱密码登录；同用户两个 Workspace 复用容器；跨用户独立容器；Workspace/文件/Session/SSE/Stop 的越权拒绝；服务端路径生成与穿越拒绝；文件创建、读取、重命名、删除；stop 后恢复；remove 后重建并保留文件；平台 SSE 事件与终态。
- **4 项 BullMQ 回收实测通过**：registered keepalive、foreground command 阻止回收；释放租约并模拟超过空闲阈值后真实 stop；将 stoppedAt 调整到 25 小时前后真实 remove。没有等待整整 30 分钟或 24 小时，也没有伪造 Docker 调用。
- **Docker 检查通过**：UID/GID 1000；非 privileged；drop ALL capabilities；no-new-privileges；2 CPU / 4 GiB / 256 PIDs；HOME/Workspace 为 bind mount；用户容器没有 Docker socket、平台数据库/Redis/manager 凭证或宿主端口。仅 manager 有 Docker socket。
- **网络实测通过**：从用户 A 容器访问用户 B 的共享、control、egress 三个网络 IP 均被阻断；访问 manager 控制 API 无凭证返回 401；用户 Runtime HTTP 同样必须鉴权。平台数据库网络没有附加到用户 Runtime。
- **回收后数据存续**：自动 remove 后 HOME 与 Workspace 宿主目录仍在；重新进入 Workspace 成功创建容器。

可重复执行的检查：

```sh
pnpm test:integration
# 使用 artifacts/integration.json 中第二个专属测试用户 ID：
docker compose exec -T -e VERIFY_USER_ID=<test-user-id> runtime-manager \
  node --import tsx scripts/reaper-check.ts
node scripts/docker-check.mjs
```

报告位于 `artifacts/integration.json`、`artifacts/docker-security.json`（均被 Git 忽略）。专属测试账号凭证在 `.cache/integration-account.json`，权限 0600；测试数据保留供检查，未操作其他项目或用户数据。

## DSH 实际执行证据

使用安装后的官方 `DeepSeekHarness` 0.1.5-rc.2，通过实际 `run()` 和 JSON-RPC 通道启动 DSH。Linux Runtime 的沙盒功能探测结果为 **Landlock / full**；实际命令可以写当前 Workspace，写同样由 UID 1000 拥有的 Workspace 外 HOME 文件被拒绝。

在真实用户容器内使用故意无效的测试 API Key 连续运行两个 turn：两个 turn 均完成 SDK 初始化、进入 running，然后收到真实 DeepSeek 服务的凭证拒绝。第二轮使用同一 `sess_<uuid>`，从 HOME 中的原生 DSH 持久会话恢复。每轮都关闭 SDK 子进程，第二轮不是继续使用内存中的 Agent。恢复通过项目内固定版本的 SDK server 补丁调用原生 `agents.resume`；不存在时才 `agents.create`。

进一步通过平台 remove/ensure API 删除并重新创建该测试用户容器：确认新容器 ID 不同，原生压缩 Session 日志的 SHA-256 在重建前后相同，然后在新容器内使用原 Session ID 与 cwd 执行两个真实 SDK turn，原日志继续追加。`artifacts/runtime-persistence.json` 保存结果。该检查还在非 root、Landlock 沙盒内完成 `pnpm 11.21.0` 离线安装本地依赖，并成功加载该依赖。

```sh
docker exec cloud-work-runtime-<test-user-id> \
  node --import /app/node_modules/tsx/dist/loader.mjs \
  /app/docker/runtime/src/smoke.ts
# 使用第一次 smoke 输出的 Session ID 与 Workspace 路径：
SMOKE_SESSION_ID=sess_<uuid> \
SMOKE_WORKSPACE_PATH=/home/work/workspaces/ws_smoke_<uuid> \
  node scripts/runtime-persistence-check.mjs
```

首次基础验收尚未配置有效 `DSH_API_KEY`，当时 HTTP/SSE 与浏览器只验证配置缺失错误及预期认证失败。后续已通过上方兼容网关的真实模型、工具和增量输出链路。重跑完整模型验收可执行：

```sh
EXPECT_LLM_SUCCESS=1 pnpm test:integration
```

该模式会额外要求多个真实 `text-delta`、`tool-start`、`tool-result`、没有错误事件，以及 Agent 实际生成含校验内容的文件，不能仅凭 200 响应或启动状态通过。

## 页面实际操作

在 `http://localhost:3000` 的生产容器页面中完成：测试账号登录、Workspace 列表、新建 Workspace 并进入、文件创建、编辑和保存、刷新后重新读取保存的原文、新建会话、发送 prompt、实时看到 API Key 配置错误。会话历史刷新后重新载入。

视觉检查覆盖桌面 1280×720 和窄屏 390×844；窄屏文件抽屉能打开和关闭，对话、状态与输入区正常显示。浏览器检查时没有 console warning/error。登录页另经过桌面和窄屏检查。这是实际页面操作与检查，不代表用户已作最终视觉验收。

已修正并在最终生产镜像复查：关闭的手机文件抽屉使用 `inert` / `aria-hidden`，从可访问性树与键盘顺序中移除；打开后焦点进入 Close files，关闭后回到 Show files。桌面文件栏保持可访问。

## MVP 边界

- Stop 抽象已实现；当前 SDK 无正式 mid-turn cancel RPC，使用会话 DSH 子进程终止，必要时 manager 使用用户 Runtime 终止恢复。完整限制见 README。
- 单个 Docker host；未实现跨主机调度、用户磁盘配额、邀请/邮件验证/密码找回或完整运维后台。
- DSH sandbox 约束写入当前 Workspace；同用户不同 Workspace 不声明为保密边界。不同用户使用独立容器、目录和网络。
- 事件流约保留最近 10,000 条、7 天；完整 DSH 持久会话保留在用户 HOME，较老的 Web 历史尚未从原生日志回填。
- 原生 DeepSeek 与自定义 OpenAI/Anthropic 兼容 provider 已接线。第三方网关的协议、工具调用和模型能力仍取决于其实际实现；任意其他 provider 未自动适配。
