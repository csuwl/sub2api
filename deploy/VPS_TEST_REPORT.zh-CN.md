# VPS 测试部署记录

日期：2026-10-18（Asia/Shanghai）。入口：`https://test.csuwl.cn`。
目录：`/opt/sub2api-magpie-test`。Compose 项目：`sub2api-magpie-test`。
这是独立测试实例，关闭公开注册；没有替换服务器上原有的 Sub2API、团队版或其它业务。

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
