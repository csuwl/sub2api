# 隔离的 VPS 测试部署

使用仓库根目录的多阶段 `Dockerfile` 构建主服务，使用
`provider-runtime/Dockerfile` 构建 Bun 接入服务。
`docker-compose.test.yml` 为独立项目，包含 PostgreSQL、Redis 和持久化数据卷。
只发布 `127.0.0.1:4088`，由 Cloudflare Tunnel 或已有 HTTPS 反向代理接入。
接入服务和数据库没有宿主机公开端口。

## 构建及传输

在源码根目录执行，`TAG` 使用实际提交号：

```sh
TAG=$(git rev-parse --short=7 HEAD)
docker build --build-arg COMMIT="$(git rev-parse HEAD)" \
  --build-arg VERSION=0.2.17-magpie-test -t "csuwl/sub2api-magpie-test:$TAG" .
docker build -t "csuwl/sub2api-provider-runtime:$TAG" provider-runtime
docker save -o images.tar "csuwl/sub2api-magpie-test:$TAG" "csuwl/sub2api-provider-runtime:$TAG"
gzip images.tar
sha256sum images.tar.gz
```

通过 SSH 把镜像、此 Compose 文件和私有 `.env` 放到专用目录。
在服务器核对 SHA256，再 `docker load -i images.tar.gz`。
也可以在服务器构建；不要把凭据放入构建上下文或镜像。

## 生成一次性的部署配置

目录建议为 `/opt/sub2api-magpie-test`，权限 `0700`。
把 `docker-compose.test.yml` 保存为该目录内的 `compose.yml`，以下代码在该目录执行。
把两个镜像标签替换为刚构建的标签。配置存在时不会覆盖：

```sh
umask 077
python3 - <<'PY'
import base64, pathlib, secrets
p = pathlib.Path('.env')
if p.exists():
    raise SystemExit('.env already exists; retain existing keys')
values = {
    'SUB2API_IMAGE': 'csuwl/sub2api-magpie-test:YOUR_BUILD_TAG',
    'PROVIDER_RUNTIME_IMAGE': 'csuwl/sub2api-provider-runtime:YOUR_BUILD_TAG',
    'TEST_DOMAIN': 'test.csuwl.cn', 'TEST_HTTP_PORT': '4088',
    'ADMIN_EMAIL': 'admin@test.csuwl.cn', 'ADMIN_PASSWORD': secrets.token_urlsafe(24),
}
for key in ('POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'JWT_SECRET',
            'TOTP_ENCRYPTION_KEY', 'PROVIDER_RUNTIME_TOKEN'):
    values[key] = secrets.token_hex(32)
values['PROVIDER_RUNTIME_STATE_KEY'] = base64.b64encode(secrets.token_bytes(32)).decode()
p.write_text(''.join(f'{k}={v}\n' for k, v in values.items()))
p.chmod(0o600)
print('Created private .env; retain and back it up securely')
PY
docker compose -p sub2api-magpie-test --env-file .env -f compose.yml config --quiet
docker compose -p sub2api-magpie-test --env-file .env -f compose.yml up -d --wait
```

## 发布前关闭注册

上游首次安装默认开放注册。本测试部署只供受控验收，必须在设置公网入口前关闭。
首次启动后、域名尚未路由时执行以下初始化 SQL，并重启应用使设置缓存失效：

```sh
docker compose -p sub2api-magpie-test -f compose.yml exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U sub2api -d sub2api <<'SQL'
INSERT INTO settings (key, value, updated_at) VALUES
 ('registration_enabled', 'false', NOW()),
 ('frontend_url', 'https://test.csuwl.cn', NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
SQL
docker compose -p sub2api-magpie-test -f compose.yml restart app
docker compose -p sub2api-magpie-test -f compose.yml up -d --wait
curl -fsS http://127.0.0.1:4088/health
```

检查 `/api/v1/settings/public` 的 `registration_enabled` 为 `false`。
然后为 `test.csuwl.cn` 添加 HTTPS 入口，转发到 `http://127.0.0.1:4088`。
本次使用宿主机已有 Cloudflare Tunnel，仅新增该主机名，不改其它入口。
如果 Tunnel 在桥接网络容器内运行，应改为两个容器可达的地址；容器自身的
`127.0.0.1` 不能访问宿主机服务。

## 验收

先用 `.env` 中的管理员登录。管理员应自行阅读并确认控制台的合规承诺。
在“账号管理 → 添加账号”中选择 OpenCode Zen Free，加载模型并导入到 OpenAI 分组；
需要 Anthropic Messages 入口时，为该分组开启 Messages dispatch。
WorkBuddy 也在添加账号弹窗内发起授权，在其官方页面完成登录；已有账号可从
列表中的“管理授权与模型”操作进入。未完成的授权会话在
runtime 重启后需要重开，已完成的授权加密保存在数据卷。

仓库提供显式启用的部署验收脚本。在有 Node 的可信环境设置
`ADMIN_EMAIL`、`ADMIN_PASSWORD`，并执行：

```sh
SUB2API_TEST_BASE_URL=https://test.csuwl.cn \
SUB2API_TEST_ALLOW_EXISTING=true PROVIDER_SMOKE_MODEL=mimo-v2.6-flash-free \
node provider-runtime/scripts/full-stack-smoke.mjs
```

脚本创建测试分组、接入账号，并给测试管理员增加 1 个本地模拟余额单位；
不发生支付。只在专用测试实例运行，验收期间避免该管理员同时使用其它 API Key。
测试包括 Responses / Chat Completions / Messages 的流式完成，
以及 Responses / Messages 的原生工具调用和工具结果回传，
以及 token 记录、用量费用与余额核对。临时 API Key 最后撤销，测试分组和账号保留。
脚本不会替部署管理员接受合规承诺，也不会使用个人 WorkBuddy 额度。

## 运维与回退

- 四个容器均设置资源上限和日志轮转，使用独立的 Compose 项目名和卷。
- 保留 `.env`、四个数据卷及旧镜像。更换状态密钥会导致已有授权无法解密。
- 备份数据库并在停写时备份接入服务状态；数据库和状态备份同样按凭据保护。
- 更新时只更换两个镜像标签，再执行 `up -d --wait`；数据库迁移后的回退还需匹配数据库备份。
- 暂停测试入口可先撤销该域名的 Tunnel 路由，再对本项目执行 `docker compose stop`。
  不要使用 `down -v`，它会删除测试数据库及授权状态。
- 这不是所有供应商、所有模型和完整 Codex / Claude 客户端的验收证明；
  WorkBuddy 实际账号、额度及模型功能仍需独立测试。
