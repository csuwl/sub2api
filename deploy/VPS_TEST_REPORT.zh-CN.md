# VPS 测试部署记录

日期：2026-10-18（Asia/Shanghai）。入口：`https://test.csuwl.cn`。
目录：`/opt/sub2api-magpie-test`。Compose 项目：`sub2api-magpie-test`。
这是独立测试实例，关闭公开注册；没有替换服务器上原有的 Sub2API、团队版或其它业务。

## 22:27 授权展示与账号测试修复

当前主镜像：`csuwl/sub2api-magpie-test:26ba4e0`，应用输出提交
`26ba4e06ce3a392ad407ad579bad238cc996f9e3`。接入服务镜像未变。
传输包 SHA256：`9cf8bfd69fa2b82189e07f84c70065bea655329ce66ec96b19055654bf0b76de`，服务端校验通过。
更新前完整备份：`/opt/sub2api-magpie-test/backups/20261018T142652Z-authorization-fix`。
现有用户、账号、分组、模型绑定保留，仅重建测试应用容器；四个测试服务和原业务健康检查通过。

### 已复现的问题与修复

- 用户新建的账号 #3 绑定 OpenCode Zen Free 公共通道，邮箱只是名称；此前“已连接”文案没有清楚区分公共访问和个人授权。
- 对该账号执行真实的 `/api/v1/admin/accounts/3/test`，原实现返回 SSE 错误：请求占位地址 `provider-runtime.invalid`，DNS 解析失败。原先的网关推理验收没有覆盖这个管理测试入口。
- 现在账号测试使用与网关一致的供应商传输，按 Chat Completions、Responses、Anthropic 原生协议构造请求；禁用或无效绑定不走普通 HTTP 回退，非成功和中断响应不显示成功。
- 公共通道明确注明无需登录、不关联邮箱/个人订阅/积分，个人 OpenCode Key 引导至原有 OpenCode 平台；WorkBuddy 创建后展示官方登录步骤，完成授权才允许导入，重新打开窗口恢复待授权链接。
- 测试站真实 WorkBuddy 授权接口返回 `pending` 与 `https://www.workbuddy.cn` 官方登录地址，诊断账号随后删除。没有完成任何个人 WorkBuddy 登录或积分调用，因此不将完整个人授权算作已通过。
- 前端全量 2,886 项测试通过，类型检查、相关 ESLint、生产镜像构建通过；Go 供应商及 OpenAI 账号测试回归通过，新增覆盖三种协议、401、429、截断、禁用及不支持的 compact 探测。

### 用户实际导入账号的真实调用

使用现存账号 #3，未替换其配置。下列 9 个模型分别通过真实账号测试入口返回
`SUB2API_ACCOUNT_TEST_OK` 与成功完成事件，各完成一次：

`mimo-v2.6-flash-free`、`beam-free`、`big-pickle`、`deepseek-v4.1-flash-free`、
`glm-5.3-flash-free`、`longcat-2.5-preview-free`、`nemotron-3.5-lightning-free`、
`nemotron-3.5-super-vl-free`、`space-bunny-free`。

再使用 `beam-free` 经公开域名调用 Chat Completions、Responses、Anthropic Messages：
全部 HTTP 200、返回 `SUB2API_IMPORTED_ACCOUNT_OK`、有对应协议完成事件。
3 笔网关用量均归属账号 #3，合计 371 tokens，当前测试计价扣费为 0；临时 API Key 已撤销。

**稳定性边界：** 后续浏览器使用 `glm-5.3-flash-free` 连续两次复测返回真实上游
HTTP 503：`Upstream request failed: Endpoint is unavailable.`。因此上述结果只证明当次真实调用成功，
不能证明免费上游持续可用；没有把 503 改成成功响应。服务器原始验收记录保存在
`/opt/sub2api-magpie-test/authorization-acceptance.jsonl`。
同一浏览器改用 `mimo-v2.6-flash-free`，账号测试返回 `Hi!` 和“测试完成”，
实际验证了账号列表 → 更多 → 测试连接这条完整交互路径。
浏览器还实际创建了临时 WorkBuddy 诊断账号，获得官方登录链接并显示等待授权，
此时加载模型按钮禁用。未登录个人供应商账号，诊断记录随后清理。
后续复查观察到所有现有容器在 `14:54:36 UTC` 重新启动；没有定位此次重启原因。
服务恢复健康、用户账号和模型绑定保留，刷新浏览器后旧会话恢复。

## 构建与隔离

- 根 `Dockerfile` 实际完成前端生产构建、Go Linux amd64 编译和最终镜像打包。
- `provider-runtime/Dockerfile` 构建固定 Bun 1.3.6 和锁定的社区供应商插件。
- 首次部署应用及供应商镜像来自 `8411354a3b21241e78505c4736c30156df1234c6`。
  双镜像传输包 SHA256：`caecb0df8232ff6119a26065c183814e9e7f39a31d064dffe73b6c00e3e211f4`，服务器端校验一致。
- 四个服务全部健康：应用、供应商接入、PostgreSQL 18、Redis 8。
- 应用只映射 `127.0.0.1:4088`；供应商接入和数据库没有宿主机发布端口。
- 非 root 应用/供应商进程，接入服务只读根文件系统，独立数据卷、资源上限和日志轮转。
- Cloudflare Tunnel 只新增测试域名到此端口的路由；原 `record.csuwl.cn` 路由保留。
- 部署密钥与登录信息使用私有文件保存，没有进入镜像或 Git 仓库。

前一次统一入口验收的主镜像为 `csuwl/sub2api-magpie-test:38642a0`，应用自身输出的提交为
`38642a0a53f9cbdd835ca2d419cf78a653dba231`；接入服务仍使用已验证的
`csuwl/sub2api-provider-runtime:8411354`。最终主镜像传输包 SHA256 为
`603d3977d2c382d5a98460c84203f0e1c960a84ced6b38439c96b31c83cf55a9`，服务器校验一致。
后续构建沿用根 Dockerfile 的全部阶段，省略远端 syntax 引导行、使用 Docker 内置构建前端，
并固定当次四个基础镜像摘要，以避开 Docker Hub 元数据解析抖动。

## 统一账号管理后的界面验收

- 已删除“订阅模型接入”侧栏；旧页面地址自动跳转到 `/admin/accounts`。
- “添加账号”直接提供 WorkBuddy、WorkBuddy AI、OpenCode Zen Free 平台选择。
- 浏览器实际验证 WorkBuddy 选择及账号名称保留、返回原表单、原有 OpenAI OAuth / API Key 表单。
- 已有账号行显示供应商名称，可直接管理授权、发现模型和查询额度。
- 实际在已有账号内重新加载模型、只选择 MiMo 再接入，账号列表仍只有原来的一个连接。
- 内部路由占位地址不再成为账号名称的外链。
- 最终代码的前端全量回归为 2,882 通过、0 失败；类型检查、相关 ESLint 和生产构建通过。
- 统一入口提交 `adb54ce` 的 GitHub CI、Provider runtime、Security Scan 三个工作流均成功。
  最后一个仅隐藏占位链接的提交也已完成本地全量前端回归及实际镜像部署。

## 公开域名验收

使用正常 TLS 校验，无跳过证书检查：

| 检查 | 结果 |
| --- | --- |
| `/health` | HTTPS 200 |
| 首页、登录页、管理 SPA 路由 | 200，实际页面可加载 |
| 首页引用的 6 个 JS / CSS 资源 | 全部 200，非空 |
| 公开注册 | `registration_enabled=false` |
| 未登录访问管理 API / 网关模型列表 | 均 401 |
| 管理员登录 | 浏览器与 API 均通过 |
| 上游控制台合规承诺 | 用户当次明确授权后完成确认 |
| Zen Free 模型发现 | 9 个模型；仅 MiMo 完成下述推理验收 |
| 原业务公开健康接口 | `record.csuwl.cn/api/health` 200 |
| 旧 Sub2API / 团队版 | 两者健康，`4000/health`、`4001/health` 均 200，启动时间未变化 |

## VPS 上的真实模型调用

模型为 `mimo-v2.6-flash-free`，使用 Zen Free 公开访问方式，没有消耗个人 WorkBuddy 订阅或积分。

1. 接入服务原生 Chat Completions 测试返回 200、`text/event-stream`、`[DONE]`
   和 `SUB2API_RUNTIME_OK`。上游用量为输入 345、输出 50、总计 395，包含 reasoning 43。
2. 通过公开域名完成 Responses、Chat Completions、Anthropic Messages 三个入口的流式输出。
   三者均返回 200 和正确的协议结束事件，文本为 `SUB2API_FULL_STACK_OK`。
3. Responses 与 Messages 均生成原生 `smoke_echo` 工具调用，参数为 `{"value":"fixture"}`；
   回传工具结果后均得到 `SUB2API_REAL_TOOL_ROUNDTRIP_OK`。
4. 完整成功运行产生 7 笔用量，token 与费用均非零；本地模拟价格合计扣减
   `0.000641`，与余额变化一致。没有发生支付。
5. 临时 API Key 已撤销。测试分组保留为“VPS试用 · MiMo”，账号保留为
   “Zen Free MiMo · VPS试用”，便于后续在账号管理中继续使用。

第一次验收的 SSH 连接中断，仅留下 4 笔调用记录，不算完整通过。
第二次任务在 VPS 本地保存日志后完整通过，退出码为 0。
中断运行留下的临时密钥、接入账号和分组已清理；历史用量保留。
因此重启检查时数据库共有 11 笔用量，管理员模拟余额为 `1.997508`。

最终 `38642a0` 镜像上线后，又通过公开域名重新调用三个协议入口，全部获得
200、SSE 正常完成和 `SUB2API_FINAL_DEPLOY_OK`。其中 Responses / Chat Completions
使用 Bearer，Messages 使用标准 `x-api-key` 及 `anthropic-version` 请求头。
新增 3 笔费用为 `0.000651`，与余额变化一致；撤销测试密钥后再次访问模型列表返回 401。
最终保留 14 笔历史用量，总模拟扣费 `0.003143`，余额 `1.996857`，临时测试密钥均已撤销。

## 持久化与备份

测试实例的数据库、`.env`、Compose 文件与加密账号状态已备份到私有目录
`/opt/sub2api-magpie-test/backups/20261018T082424Z`，备份文件权限为 `0600`。
随后实际重启应用和接入服务，并确认：

- 所有容器重新健康；公开 HTTPS 与访问控制检查再次通过。
- 登录确认状态、分组、账号和 Messages 调度配置保留。
- 账号仍显示已连接，重新发现 9 个模型。
- 11 笔用量、余额及已撤销密钥状态不变。

一次空闲采样的内存为：应用约 24 MiB、接入服务约 50 MiB、数据库约 61 MiB、Redis 约 8 MiB。
这只是空闲采样，不是并发容量或压测结论。

最终镜像和最后 3 笔请求验证结束后，重新备份了当前配置、14 笔用量的数据库与加密账号状态：
`/opt/sub2api-magpie-test/backups/20261018T135158Z-final`，同样使用私有目录和 `0600` 文件权限。

## 兼容边界

- 当前 UI 将这些账号统一放进“账号管理”，保留原有账号添加、分组、密钥和计费流程。
  协议调度依旧使用已有 OpenAI / Anthropic 转换代码。
- 只有明确绑定供应商账号句柄的连接进入新增接入路径；其它账号使用原发送流程。
  既有 Go / 前端回归与基线失败归因见 `provider-runtime/TEST_REPORT.zh-CN.md`。
- 尚未对所有既有功能逐项做人工验收，也没有做完整 Codex / Claude CLI 会话、
  个人 WorkBuddy 授权消费、全部免费模型或多模态能力矩阵验收。
- Cloudflare 原有规则会拒绝 Python urllib 默认 User-Agent，返回 403 / 1010。
  浏览器、curl、Bun 请求及带明确部署测试标识的检查正常；本次没有放宽全域安全设置。
- 普通用户自行接入并持有个人订阅的权限和页面仍未实现；当前接入操作由管理员完成。
