# Cloudflare 运行、成本与部署说明

核对日期：2026-09-14。

## 1. 当前部署状态

后端可移植化已通过 GitHub PR #1 合入 `main`，合并 commit：

`7a49b44275038dddd3803cb17de9b7e4fe06ba33`

PR #1 合并前 CI 与合并后的 `main` CI #31 均通过。Cloudflare Workers + D1 + R2 仍是当前生产部署基线；Node + SQLite + Filesystem 仅作为第二运行时和未来普通服务器迁移能力。

生产 workflow 已通过 PR #2 合入 `main@bc4774767c159068d59e16d6726444c5c1525dd6`，合并后的 CI #37 PASS。仓库现有四类 Actions：

- `CI`：push `main` / PR / 手工，仅执行完整代码门禁；
- `Production preflight (no deployment)`：手工，仅校验 production config + dry-run，不携带云凭据；
- `Production D1 migration`：手工、`production` Environment 绑定，只执行正式 D1 migration；
- `Production release`：手工、`production` Environment 绑定，只发布 Worker/Static Assets/已审核绑定，并在发布后验证真实 `/api/health`。

**代码中存在 workflow 不等于生产已经配置或发布。** 2026-09-14 已在 GitHub UI 创建 `production` Environment，限制仅 `main` 部署，并设置两个生产开关为 `false`；Environment 审核者和 main branch protection 尚未配置。`PRODUCTION_CONFIG_JSON`、Cloudflare CI Token、生产 Worker Secret 和正式资源均未核实/配置。Cloudflare Dashboard 在云端浏览器持续显示安全验证，正式 migration、release 和验收未执行。

## 2. 云上开发与发布原则

后续 GitHub + Cloudflare 是唯一必需环境：

- 禁止把用户 Mac、本地 shell、本地 Wrangler、本地 SQLite 或其他个人电脑作为开发、测试或发布前置条件；
- 代码通过远端分支 → PR → GitHub Actions → 合并 `main`；
- 生产变更只通过受保护的 GitHub Actions / Cloudflare 云端流程；
- Cloudflare API Token、认证 Secret、bootstrap Secret 不进入 Git、PR、前端或 Actions 日志；
- 普通 push/PR 不允许自动执行 D1 migration 或正式 Worker deploy；
- D1 migration 与 Worker deploy 分离，分别显式批准；
- `0009`–`0012` 已冻结，正式/共享环境只追加新 migration，不修改历史 migration。

## 3. 生产拓扑

```text
浏览器
  → 自定义域名 / Cloudflare
  → Workers Static Assets（Vue）
  → /api/*（Hono）
      → D1：业务数据、会话、任务、快照
      → 私有 R2：附件、逻辑备份分片
  → Cron：预警、通知 outbox、备份任务
```

生产保持 API 与 Web 同域。`/api` 和 `/api/*` 必须优先进入 Worker，未知 API 不能回退为 SPA HTML。

## 4. GitHub production Environment

正式发布前必须在 GitHub 实际建立并检查 `production` Environment。按当前仓库和套餐可用能力，至少配置：

### Environment protection

- Deployment branch policy：只允许 `main`；
- Required reviewer：如当前套餐支持则启用；
- 禁止自批和管理员绕过：如当前套餐支持则启用；
- 不允许 feature branch 直接拿 production Secret 运行生产 workflow。

YAML 中写 `environment: production` 不能替代真实 Environment protection 配置。

### Environment Variables

`PRODUCTION_CONFIG_JSON`
: 真实、非敏感、经过 `npm run p7 -- config` 验证的严格 JSON。包含 Worker 名称、Account ID、自定义域名、D1 名称/ID、R2 bucket、静态资源和 Cron 配置；不包含任何 Secret 值。

`PRODUCTION_DEPLOY_ENABLED`
: 平时建议 `false`。只有批准准确 commit 的发布窗口才改为 `true`。

`PRODUCTION_MIGRATION_ENABLED`
: 平时必须 `false`。只有完成备份、停写和目标 D1 核对后，批准 migration 窗口才临时设为 `true`。

### Environment Secret

`CLOUDFLARE_API_TOKEN`
: 使用 Cloudflare account-owned API token，按 Worker/D1/R2/路由实际操作配置最小权限。禁止使用 Global API Key、个人浏览器登录态或个人长期 Token 作为 CI/CD 依赖。

## 5. Wrangler production config

模板：`apps/api/wrangler.production.example.json`。

生产配置必须保持：

- `APP_ENV=production`；
- `workers_dev=false`；
- `preview_urls=false`；
- 一个自定义域名；
- 唯一 `DB` D1 binding；
- 唯一 `FILES` R2 binding；
- `ASSETS` 静态资源 binding；
- `/api`、`/api/*` 使用 `run_worker_first`；
- Cron `*/5 * * * *`；
- 不包含认证 Secret 值。

生产配置长期声明：

```json
"secrets": {
  "required": ["AUTH_CREDENTIAL_PEPPER"]
}
```

Wrangler 会在正式 deploy 时检查永久认证 pepper 是否已经配置；缺失时发布必须失败。

`BOOTSTRAP_TOKEN` 是一次性 Worker Secret，不放进长期 `secrets.required`。首次管理员创建成功、再次 bootstrap 已确认关闭后删除该 Secret，否则会把一次性初始化凭据变成长久发布依赖。

## 6. 正式发布顺序

### 6.1 代码门禁

1. 所有修改先进入远端施工分支和 PR；
2. PR 最新 HEAD 的 GitHub Actions `npm run check` 必须全绿；
3. 通过 GitHub 合入 `main`；
4. 合并后的 `main` CI 再次通过；
5. 后续生产 workflow 输入的 `release_sha` 必须等于当前准确 `main` SHA。

### 6.2 资源与身份核对

在 Cloudflare 真实核对：

- Account / Zone 归属；
- Worker 名称；
- D1 database 名称和 UUID；
- R2 bucket 名称且保持私有；
- 自定义域名；
- 计费方案与 R2 开通状态；
- `AUTH_CREDENTIAL_PEPPER` 是否已安全配置；
- 首次初始化阶段是否需要临时 `BOOTSTRAP_TOKEN`。

仓库里的 `wrangler.acceptance.jsonc` 只代表历史 acceptance 配置，不能直接当成新的正式 production config。

### 6.3 预检

运行 GitHub Actions `Production preflight (no deployment)`：

- 完整 `npm run check`；
- materialize `PRODUCTION_CONFIG_JSON`；
- `npm run p7 -- config`；
- Wrangler production dry-run；
- 不携带 Cloudflare Token，不产生云端变更。

### 6.4 D1 migration

如正式 D1 尚未达到代码要求的 schema：

1. 核对当前 `d1 migrations list`；
2. 已有正式数据时先停写、暂停会写库的 Cron/任务并完成可恢复备份；空库也记录“空库无业务数据”证据；
3. 手工触发 `Production D1 migration`；
4. 输入准确 `main` SHA、migration evidence reference、目标正式 D1 UUID；
5. workflow 会要求输入 UUID 与 `PRODUCTION_CONFIG_JSON` 的 `database_id` 完全相同；
6. 执行前后分别 `wrangler d1 migrations list DB --remote`；
7. 执行 `wrangler d1 migrations apply DB --remote`；
8. migration 失败立即停止，不继续 Worker 发布，也不修改历史 migration 规避失败。

### 6.5 Worker 发布

migration/schema ready 后手工触发 `Production release`：

1. 输入准确当前 `main` SHA；
2. 输入已审核的发布/备份/schema 证据引用；
3. workflow 再执行完整 `npm run check`；
4. validation + dry-run；
5. 再次确认 `origin/main` 仍等于批准 SHA；
6. `wrangler deploy --config wrangler.production.jsonc`；
7. GitHub runner 从 production config 提取真实自定义域名；
8. 请求 `https://<domain>/api/health`；
9. 只有 `ok=true`、service 正确、`schema.ready=true` 才判定发布后的基础健康检查通过。

代码 deploy **不自动执行 migration**。

## 7. 首管理员与登录验收

首次上线时：

1. 临时配置 Worker Secret `BOOTSTRAP_TOKEN`；
2. 通过 HTTPS 页面使用 token 创建明确的首管理员 username；
3. 验证第二次 bootstrap 被拒绝；
4. 删除 `BOOTSTRAP_TOKEN`；
5. 应用内创建第二管理员；
6. 验证 username/password 登录、浏览器 Argon2id、HttpOnly/Secure/SameSite Cookie、7 天会话、首次改密、停用成员撤销旧会话；
7. 匿名受保护 API 必须拒绝，未知 API 必须返回 JSON 404。

密码、派生 credential、bootstrap token 和 Cookie 不写入 Actions 日志、GitHub issue/PR 或部署记录。

## 8. 核心生产验收

发布后仍需真实完成：

- `/api/health` 与 schema ready；
- 登录与权限范围；
- 电压等级 → 线路 → 杆塔基础台账；
- 手工需求和标准模板导入；
- 项目储备 / 项目物资；
- 项目级出库；
- 多执行任务；
- 物资供应 / 实施 / 结算；
- 四状态回投；
- 框架 / 协议 / 预算 / 发生 / 实际费用；
- 附件上传、下载、权限与 R2 私有性；
- Cron / 预警 / 通知 outbox / 备份；
- 自定义域名、HTTPS、静态资源和移动端访问。

详细证据矩阵见 `P7_ACCEPTANCE.md`。

## 9. Logs、Metrics 与免费额度

真实 Cloudflare 环境必须观察：

- Workers Logs / 错误日志；
- Workers Analytics：请求量、错误率、CPU time；
- D1 读取/写入行和容量；
- R2 存储量、A/B 类操作；
- Cron 执行成功率；
- 备份周期耗时和失败状态；
- 目标地区实际网络体验。

不要用本地 wall-clock、workerd 或合成数据替代 Cloudflare Free CPU/额度结论。

当前文档核对的免费基线仍为：Workers 10 万请求/天、普通请求和 Cron 10ms CPU；D1 500 万读取行/天、10 万写入行/天；R2 免费层包含 10GB-month、100 万 A 类和 1000 万 B 类操作。正式使用前必须再次以 Cloudflare 官方页面为准。

## 10. 回退与恢复

- 代码回退不等于数据回退；
- 回退 Worker 前先确认旧代码兼容当前 schema；
- D1 数据恢复只先恢复到隔离库并对账，不能直接覆盖有新写入的正式库；
- R2/附件需要独立核对，不以 D1 manifest checksum 代替附件本体完整性；
- `auth_sessions` 不恢复；
- 首次正式/共享环境使用后 migration 历史冻结，只追加；
- 保留前一 Worker version/deployment ID、准确 schema 状态、备份引用和回退证据。

详细步骤见 `P7_RUNBOOK.md`。

## 11. 官方依据

- Workers 配置：https://developers.cloudflare.com/workers/wrangler/configuration/
- Workers Secrets：https://developers.cloudflare.com/workers/configuration/secrets/
- Workers 价格：https://developers.cloudflare.com/workers/platform/pricing/
- Workers 限制：https://developers.cloudflare.com/workers/platform/limits/
- D1 migrations：https://developers.cloudflare.com/d1/reference/migrations/
- D1 价格：https://developers.cloudflare.com/d1/platform/pricing/
- D1 限制：https://developers.cloudflare.com/d1/platform/limits/
- R2 文档：https://developers.cloudflare.com/r2/
- R2 价格：https://developers.cloudflare.com/r2/pricing/
- Cloudflare Account Members：https://developers.cloudflare.com/fundamentals/manage-members/
- Account-owned API Tokens：https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/

所有价格、限制和 GitHub/Cloudflare 权限能力在正式上线前再次核对；“免费”不等于无限额或可用性保证。
