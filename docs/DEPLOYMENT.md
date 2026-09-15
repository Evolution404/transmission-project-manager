# Cloudflare 运行、成本与部署说明

核对日期：2026-09-14。

## 1. 当前部署状态

后端可移植化已通过 GitHub PR #1 合入 `main`，合并 commit：

`7a49b44275038dddd3803cb17de9b7e4fe06ba33`

PR #1 合并前 CI 与合并后的 `main` CI #31 均通过。Cloudflare Workers + D1 仍是当前计算/数据库部署基线；对象存储统一经 `ObjectStorePort`。当前正式方案选择 Notion，保留 Cloudflare R2 与 Node Filesystem 可替换后端；Node + SQLite + Filesystem 仍作为普通服务器第二运行时。

生产 workflow 已通过 PR #2 合入 `main@bc4774767c159068d59e16d6726444c5c1525dd6`，合并后的 CI #37 PASS。仓库现有四类 Actions：

- `CI`：push `main` / PR / 手工，仅执行完整代码门禁；
- `Production preflight (no deployment)`：手工，仅校验 production config + dry-run，不携带云凭据；
- `Production D1 migration`：手工、`production` Environment 绑定，只执行正式 D1 migration；
- `Production release`：手工、`production` Environment 绑定，只发布 Worker/Static Assets/已审核绑定，并在发布后验证真实 `/api/health`。

**代码中存在 workflow 不等于生产已经发布。** 2026-09-14 已建立 GitHub `production` Environment，并限制生产 workflow 仅从 `main` 运行。生产非敏感配置现在直接受 Git 管理于 `apps/api/wrangler.production.jsonc`；GitHub 不再保存重复的 production Variables。正式发布长期只依赖 3 个 Environment Secrets：`CLOUDFLARE_API_TOKEN`、`AUTH_CREDENTIAL_PEPPER`、`NOTION_API_TOKEN`。`BOOTSTRAP_TOKEN` 仅在首次管理员初始化时临时使用，不属于长期配置。

## 2. 云上开发与发布原则

正式发布与持续门禁仍以 GitHub + Cloudflare 为准；本地 Mac 可按用户当次明确授权用于开发和排障，但不能成为生产运行依赖：

- 本地修改必须进入分支并由 GitHub CI 复现，不能以本地通过替代远端门禁；
- 代码通过施工分支 → PR → GitHub Actions → 合并 `main`；
- 生产变更只通过受保护的 GitHub Actions / Cloudflare 云端流程；
- Cloudflare API Token、认证 Secret、bootstrap Secret 不进入 Git、PR、前端或 Actions 日志；
- 普通 push/PR 不允许自动执行 D1 migration 或正式 Worker deploy；
- D1 migration 与 Worker deploy 分离，分别显式批准；
- 当前仍处开发阶段，D1 只允许 `0001_initial_schema.sql` 单一可重建基线；除非用户明确要求兼容已有数据/保留升级路径，否则禁止新增 `0002+` migration 或兼容补丁，schema 变化直接修改 `0001` 并重建开发/测试数据库。

## 3. 生产拓扑

```text
浏览器
  → 自定义域名 / Cloudflare
  → Workers Static Assets（Vue）
  → /api/*（Hono）
      → D1：业务数据、会话、任务、快照
      → ObjectStorePort：附件、逻辑备份分片
          → 当前 production：Notion
          → 可替换：Cloudflare R2 / 普通服务器 Filesystem
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

**长期数量：0。**

生产非敏感配置直接提交到 `apps/api/wrangler.production.jsonc`，由 PR/CI 审核并通过 `npm run production:check -- config` 校验。不要在 GitHub Environment 再维护 `PRODUCTION_CONFIG_JSON`、部署开关或迁移开关，避免同一配置出现两份来源。

### Environment Secrets

长期只保留 3 个：

- `CLOUDFLARE_API_TOKEN`：Cloudflare account-owned API token，仅供 Wrangler/API 自动化认证；
- `AUTH_CREDENTIAL_PEPPER`：服务端 HMAC verifier 的长期认证 pepper；
- `NOTION_API_TOKEN`：当前 production=`notion` 时的对象存储 Integration Token。

`BOOTSTRAP_TOKEN` 不属于长期 Secret。首次管理员初始化时如需要，可临时增加，完成 bootstrap 并确认再次调用被拒绝后立即删除。

## 5. Wrangler production config

唯一正式非敏感配置文件：`apps/api/wrangler.production.jsonc`。该文件受 Git、PR 和 CI 审核，是 production bindings/vars/resource IDs 的唯一来源。

生产配置必须保持：

- `APP_ENV=production`；
- `workers_dev=false`；
- `preview_urls=false`；
- 一个自定义域名；
- 唯一 `DB` D1 binding；
- 显式 `OBJECT_STORAGE_PROVIDER`；当前为 `notion`；
- Notion 模式不配置 `FILES` R2 binding，改为非敏感 `NOTION_API_VERSION=2026-03-11`、`NOTION_STORAGE_DATA_SOURCE_ID`；
- R2 模式才配置唯一 `FILES` binding，且不得混入 Notion 配置；
- `ASSETS` 静态资源 binding；
- `/api`、`/api/*` 使用 `run_worker_first`；
- Cron `*/5 * * * *`；
- 不包含认证 Secret 值。

生产配置长期声明：

```json
"secrets": {
  "required": ["AUTH_CREDENTIAL_PEPPER", "NOTION_API_TOKEN"]
}
```

当前 Notion production 会在正式 deploy 时同时要求永久认证 pepper 与 `NOTION_API_TOKEN`；任一缺失都必须 fail-closed。若以后切换 R2，则 required secrets 恢复为仅 `AUTH_CREDENTIAL_PEPPER`。

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
- 对象存储 provider；当前为 Notion，并核对专用根页面、Database/Data Source ID 与 Integration 授权；
- R2 仅在 provider=`r2` 时核对 bucket 与开通状态；
- 自定义域名；
- `AUTH_CREDENTIAL_PEPPER` 与当前 provider 所需 Secret 是否已安全配置；
- 首次初始化阶段是否需要临时 `BOOTSTRAP_TOKEN`。

仓库里的 `wrangler.acceptance.jsonc` 只代表历史 acceptance 配置，不能直接当成新的正式 production config。

### 6.3 预检

运行 GitHub Actions `Production preflight (no deployment)`：

- 完整 `npm run check`；
- 直接校验仓库中的 `apps/api/wrangler.production.jsonc`；
- `npm run production:check -- config`；
- Wrangler production dry-run；
- 不携带 Cloudflare Token，不产生云端变更。

### 6.4 D1 migration

如正式 D1 尚未达到代码要求的 schema：

1. 核对当前 `d1 migrations list`；
2. 已有正式数据时先停写、暂停会写库的 Cron/任务并完成可恢复备份；空库也记录“空库无业务数据”证据；
3. 手工触发 `Production D1 migration`；
4. 输入准确 `main` SHA、migration evidence reference、目标正式 D1 UUID；
5. workflow 会要求输入 UUID 与受审 `apps/api/wrangler.production.jsonc` 中的 `database_id` 完全相同；
6. 执行前后分别 `wrangler d1 migrations list DB --remote`；
7. 执行 `wrangler d1 migrations apply DB --remote`；
8. migration 失败立即停止，不继续 Worker 发布，也不修改历史 migration 规避失败。

### 6.5 Worker 发布

migration/schema ready 后手工触发 `Production release`：

1. 输入准确当前 `main` SHA；
2. 输入已审核的发布/备份/schema 证据引用；
3. workflow 再执行完整 `npm run check`；
4. validation + dry-run；
5. runner 将 `AUTH_CREDENTIAL_PEPPER` 与 `NOTION_API_TOKEN` 写入仅存在于 `$RUNNER_TEMP` 的 0600 临时 secret 文件；
6. 再次确认 `origin/main` 仍等于批准 SHA；
7. `wrangler deploy --config wrangler.production.jsonc --secrets-file <runner-temp>`，代码、bindings 与 Worker Secrets 同一版本发布；
8. GitHub runner 从 production config 提取真实自定义域名；
9. 请求 `https://<domain>/api/health`；
10. 只有 `ok=true`、service 正确、`schema.ready=true` 才判定发布后的基础健康检查通过；
11. 无论成功失败都删除 runner 临时 secret 文件。

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
- 附件上传、下载、权限与当前对象存储隔离；Notion 模式验证 Integration 只能访问专用存储页面，删除后应用层不得再读到对象；
- Cron / 预警 / 通知 outbox / 备份；
- 自定义域名、HTTPS、静态资源和移动端访问。

详细证据矩阵见 `PRODUCTION_ACCEPTANCE.md`。

## 9. Logs、Metrics 与免费额度

真实 Cloudflare 环境必须观察：

- Workers Logs / 错误日志；
- Workers Analytics：请求量、错误率、CPU time；
- D1 读取/写入行和容量；
- 对象存储指标；Notion 模式观察 API 429/5xx、上传/下载失败和使用量，R2 模式观察存储量与 A/B 类操作；
- Cron 执行成功率；
- 备份周期耗时和失败状态；
- 目标地区实际网络体验。

不要用本地 wall-clock、workerd 或合成数据替代 Cloudflare Free CPU/额度结论。

Workers/D1 配额与价格必须在正式上线前再次按 Cloudflare 官方页面核对。当前生产对象存储是用户已有付费 Notion Workspace，不依赖 R2 subscription；若以后切换 R2，再单独核对 R2 免费额度、计费和开通状态。

## 10. 回退与恢复

- 代码回退不等于数据回退；
- 回退 Worker 前先确认旧代码兼容当前 schema；
- D1 数据恢复只先恢复到隔离库并对账，不能直接覆盖有新写入的正式库；
- 对象存储中的附件需要独立核对，不以 D1 manifest checksum 代替附件本体完整性；Notion 的应用删除是逻辑删除，底层 FileUpload 当前无法通过 API 物理撤销，敏感数据治理必须单独考虑这一边界；
- `auth_sessions` 不恢复；
- 只有用户明确宣布进入“兼容已有数据/保留升级路径”阶段后，才冻结当前基线并开始追加 migration；在此之前仍执行单基线重建策略；
- 保留前一 Worker version/deployment ID、准确 schema 状态、备份引用和回退证据。

详细步骤见 `PRODUCTION_RUNBOOK.md`。

## 11. 官方依据

- Workers 配置：https://developers.cloudflare.com/workers/wrangler/configuration/
- Workers Secrets：https://developers.cloudflare.com/workers/configuration/secrets/
- Workers 价格：https://developers.cloudflare.com/workers/platform/pricing/
- Workers 限制：https://developers.cloudflare.com/workers/platform/limits/
- D1 migrations：https://developers.cloudflare.com/d1/reference/migrations/
- D1 价格：https://developers.cloudflare.com/d1/platform/pricing/
- D1 限制：https://developers.cloudflare.com/d1/platform/limits/
- Notion API：https://developers.notion.com/
- Notion File Upload：https://developers.notion.com/guides/data-apis/working-with-files-and-media
- R2 文档（备用 provider）：https://developers.cloudflare.com/r2/
- R2 价格（备用 provider）：https://developers.cloudflare.com/r2/pricing/
- Cloudflare Account Members：https://developers.cloudflare.com/fundamentals/manage-members/
- Account-owned API Tokens：https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/

所有价格、限制和 GitHub/Cloudflare 权限能力在正式上线前再次核对；“免费”不等于无限额或可用性保证。
