# 供应商运行时改造与测试报告

测试日期：2026-10-18。基础版本：上游 `Wei-Shaw/sub2api` 的 `b0a02a3304a0a78cdd003ddda1dd23ba02c03084`（v0.2.17）。分支：`feat/magpie-provider-runtime`。

## 已实现范围

新增独立 Bun 供应商运行时，接入固定版本的原始社区插件：

- `@magpie-community/opencode-workbuddy-auth@0.1.24`：WorkBuddy 国内版和 WorkBuddy AI。
- `@magpie-community/opencode-zen-free-auth@0.1.11`：OpenCode Zen 免费模型。

新增中英文管理员页面，可创建供应商账号、打开官方浏览器授权、轮询授权结果、发现模型、查询额度，并按模型的原生协议导入现有 OpenAI 分组。重复导入会保留已有连接并合并新增模型。

Sub2API 继续执行 API Key 鉴权、账号调度、协议转换、流式处理、用量记录和计费。真实供应商凭据由运行时使用 AES-256-GCM 加密保存，主服务只持有账号句柄；浏览器不接收部署密钥或供应商 token。运行时默认关闭，普通账号继续使用原有发送路径。

这是供应商宿主和首批插件的可运行实现。尚未移植整个 Magpie 插件目录、本地桌面登录发现、自动修改 agent 配置或按积分到期窗口主动调度。

## 环境与结果

环境：Windows/PowerShell、Go 1.27.2、Bun 1.3.6、Node 24.12.0、pnpm 9.15.9；Docker Engine 29.5.2，Linux amd64 容器。前端使用原有锁文件，供应商依赖使用新增 `bun.lock`。

| 检查 | 实际结果 |
| --- | --- |
| 前端全量 Vitest | 2,875 通过，0 失败 |
| 新增前端导入与管理页面测试 | 7 通过，0 失败；已包含在上述全量结果中 |
| 前端类型、相关文件 ESLint、生产构建 | 全部通过 |
| Bun 宿主契约及加密存储 | Windows 19 通过；Linux Docker 镜像内 19 通过；各 73 条断言 |
| Go 定向兼容回归 | Windows、Linux 各 84 通过，0 失败、0 跳过；其中运行时相关 31 项，含子用例 |
| Go Windows 全量 `-tags=unit ./...` | 23,290 通过、5 失败、18 跳过，含子用例；失败归因见下文 |
| Linux 扩大回归：config / admin handler / repository | 分别 308 / 715 / 1,056 通过，0 失败、0 跳过 |
| Linux 扩大回归：service 全包 | 16,469 通过、1 失败、4 跳过；内存断言及重试结果见下文 |
| 嵌入前端的主程序 | 编译成功，并实际启动完成数据库迁移、管理员初始化和健康检查 |
| 供应商 Dockerfile | 实际构建成功，使用非 root 的 `bun` 用户 |
| Compose 供应商服务部署 | 实际构建、启动、DNS 连通、鉴权和重启持久化检查全部通过 |
| 真实免费模型完整链路 | Responses、Messages 流式文本及工具调用往返通过，6 笔用量与余额对账一致 |

Go 的计数包含父测试和子用例，各检查之间存在重叠，不应相加作为独立测试总数。定向测试明确设置 `SUB2API_TEST_BUN`，跨进程测试确实执行，没有用跳过替代通过。

## 真实外部请求证据

仅使用 Zen Free 的公开免费访问方式，没有读取桌面账号文件、用户 WorkBuddy 登录、个人 API Key 或付费订阅，也没有发起真实支付。

先通过运行时实际发现 9 个免费模型，使用 `big-pickle` 得到 HTTP 200、`text/event-stream`、`[DONE]` 和 `SUB2API_RUNTIME_OK`。随后在隔离 PostgreSQL 18、Redis 7 和主服务中，通过真实后台 API 创建账号、分组、连接和下游 API Key。

最终完整用例使用 `mimo-v2.6-flash-free`：

| 下游 | 文本流 | 工具往返 |
| --- | --- | --- |
| `/v1/responses` | HTTP 200；`response.completed`；`SUB2API_FULL_STACK_OK` | 返回原生 `function_call`，参数 `{"value":"fixture"}`；回传结果后输出 `SUB2API_REAL_TOOL_ROUNDTRIP_OK` |
| `/v1/messages` | HTTP 200；`message_stop`；`SUB2API_FULL_STACK_OK` | 返回原生 `tool_use`，参数一致；回传 `tool_result` 后输出相同标记 |

数据库最终记录 6 笔请求，全部具有非零 token 用量。用例显式配置本地测试价格：输入每 token 0.000001、输出每 token 0.000002、缓存价格为零。最终复验记录的 `actual_cost` 合计 **0.000968**，与隔离用户从 100 测试余额中的扣减一致。这是本地测试价格，不是供应商积分或真实资金价格。

测试也确认后台未登录请求返回 401，嵌入式前端路由返回 HTML。结束后仅清理本次创建的测试进程和数据库容器，保留用户原有容器。

## WorkBuddy 与宿主的自动化覆盖

Go 测试会启动真正的 Bun HTTP 宿主并加载未修改的 WorkBuddy 插件，拦截所有外部供应商请求。Responses 和 Messages 两种下游，各覆盖 JSON 和 SSE，以及工具调用、回传结果、继续生成和 12 输入/6 输出 token 的用量提取。该部分上游身份与响应是明确的测试夹具，不能当作真实 WorkBuddy 账号验收。

其他契约覆盖：三种原生协议、错误端点、账号/模型不存在、禁止任意包安装、账号隔离、刷新后的持久化、存储失败阻断及恢复、创建/删除失败回滚、并发限制、流式取消、上下游凭据隔离、错误脱敏、额度不足 HTTP 403 和业务码保留、禁止重定向，以及禁用运行时时的封闭失败。加密存储覆盖重启读取、错误密钥和并发写入。

重新授权场景另有竞争测试：旧的进行中刷新不能覆盖新登录凭据，重新授权期间仍占用原账号的并发额度，旧请求结束后新授权能继续请求。授权代次写入加密状态，并发计数按账号共享。

Compose 测试使用随机项目名和临时卷，验证供应商与主服务使用共同网络、无发布端口、未授权健康检查 401、授权检查 200，以及账号重启后仍已连接。测试只启动供应商服务；主服务完整链路使用 Windows 编译程序和容器数据库，没有宣称已经构建并启动根目录 Dockerfile 的整套主服务镜像。

## 失败与修正记录

Windows 全量测试的五个失败，均在未修改的上游基础提交中复现：

1. `TestAliyunCaptchaVerifier_TransportError`：transport error 分类断言失败。
2. `TestPgDumperHoldsMigrationLockThroughReaderClose`。
3. `TestPgDumperReleasesMigrationLockWhenProcessFails`。
4. `TestPgDumperReportsUnlockFailureAndDiscardsConnection`。后三项依赖 `sh`，Windows PATH 中不存在该命令。
5. `TestOllamaProbeCallback_StaleLongDoesNotOverrideNewShort`：CAS 次数预期为 0，实际为 1。

上述五项在 Linux 容器下单独重跑全部通过；没有修改、删除或跳过这些上游测试来制造通过结果。

扩大 Linux 服务层回归时，首次使用 `--network none` 导致既有渠道监控校验矩阵的两个子用例无法解析外部域名；恢复普通 Docker 网络后这些用例通过。第二次完整 service 包运行有一个既有内存上限断言失败：`TestInflightEstimate_AccountMappingNoDBAndBoundedMemory` 测到堆增量 8,562,720 字节，高于 8,388,608 字节阈值。修改版本和未修改基础版本各自单独连续重跑该测试 10 次均通过；没有在基础版本中复现完整包运行时的该次失败。该结果仍作为扩大回归的失败记录保留，没有把定向重跑当作整包通过，也没有更改内存阈值。

完整服务首次在 Windows 上启动因缺少 `Asia/Shanghai` 时区数据退出，隔离测试环境改用 UTC 后启动成功。测试余额须使用专门的余额 API 设置，普通用户编辑接口不会改变余额；测试价格 API 采用每 token 单位。以上已在可复现脚本中处理。

真实 `big-pickle` 工具场景一次遇到 502，另一次在较小输出预算下没有返回工具调用，因此没有把它列为工具场景通过。最终改用免费 MiMo 模型完成两种协议的真实工具往返。免费目录与模型行为可能变化，本报告只证明测试时的具体组合。

部署检查修正了运行时未加入主服务 Compose 网络的问题；随后的真实 Compose 检查通过。

## 复现方式

自动化检查：

```sh
cd provider-runtime
bun install --frozen-lockfile --ignore-scripts
bun test
cd ../backend
SUB2API_TEST_BUN=bun go test -tags=unit ./internal/config ./internal/service ./internal/handler/admin \
  -run 'ProviderRuntime|ForwardResponses_.*Chat|ForwardAsAnthropic_ForceChat|OpenCodeSession' -count=1 -timeout=300s
```

真实免费调用及部署检查为手动执行，不纳入 CI：

```sh
cd provider-runtime
bun scripts/live-free-smoke.mjs --infer
SUB2API_TEST_SERVER=/absolute/path/to/freshly/built/sub2api SUB2API_TEST_BUN=bun \
  PROVIDER_SMOKE_MODEL=mimo-v2.6-flash-free node scripts/full-stack-smoke.mjs
node scripts/docker-compose-smoke.mjs
```

Windows PowerShell 使用 `$env:变量名='值'` 设置上述变量。完整链路脚本需要本地已有 PostgreSQL、Redis 镜像；Compose 脚本会构建运行时镜像。两者使用随机隔离资源并自动清理。

## 仍需按账号验收的边界

- 没有真实 WorkBuddy 账号、积分消费、额度耗尽恢复或付费 OpenCode 账号的本次验收证据。已有付费接入代码继续保留。
- 平台可能限制模型、客户端来源、账号权益或工具能力；协议转换无法保证任意来源和任意模型都可用。
- 未运行完整 Codex/Claude Code CLI 的真实登录与客户端安装流程；已验证的是它们使用的 Responses/Messages API 形态和真实工具交互。
- 仅有三种文本推理端点；没有新增图片、音频、视频或 WebSocket 运行时转发。
- 运行时状态文件要求单写入进程；尚无跨多个运行时实例的刷新锁和状态复制。
- 模型发现不会自动创建下游售价。收费前应明确配置分组模型价格；上游免费和主服务余额校验是不同规则。

部署步骤见 [README](README.md)。
