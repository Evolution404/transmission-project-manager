# P7 预检、发布与恢复操作手册

核对日期：2026-09-14。

本手册描述真实 P7 环境的云端预检、migration、发布、验收和恢复。后续禁止把用户 Mac、本地 shell、本地 Wrangler 或其他个人电脑作为正式操作前提；GitHub Actions + Cloudflare 是默认执行面。

任何本地/合成历史结果都不能替代 P7 真实证据。

## 1. 当前云端执行入口

PR #2 合入后使用以下 Actions：

| Workflow | 作用 | 允许远端变更 |
|---|---|---|
| `CI` | PR / `main` 完整 `npm run check` | 否 |
| `Production preflight (no deployment)` | production config validation + dry-run | 否 |
| `Production D1 migration` | 正式 D1 migration | 是，仅 D1 migration |
| `Production release` | Worker / Static Assets / 绑定发布 | 是，不执行 D1 migration |

`Production D1 migration` 与 `Production release` 都只能手工触发、绑定 `production` Environment，并要求精确当前 `main` SHA。

## 2. GitHub production Environment

正式操作前真实配置并核对：

### Protection

- deployment branch policy 只允许 `main`；
- Required reviewer / 禁止自批 / 禁止管理员绕过：按当前 GitHub 套餐实际可用能力启用；
- feature branch 不得取得 production Secret。

当前 ChatGPT GitHub 连接不能管理 Environment / Secrets，也不能触发 `workflow_dispatch`，所以这些状态必须在 GitHub 实际 UI/管理员接口确认；不能因为 YAML 中写了 `environment: production` 就宣称完成。

### Variables

长期数量：**0**。生产非敏感配置直接受 Git 管理于 `apps/api/wrangler.production.jsonc`，不得再复制到 GitHub Environment Variables。

### Secrets

长期数量：**3**：

- `CLOUDFLARE_API_TOKEN`：account-owned、最小权限，仅供 Wrangler/API 自动化认证；
- `AUTH_CREDENTIAL_PEPPER`：认证 verifier 的长期 Worker Secret；
- `NOTION_API_TOKEN`：当前 Notion 对象存储的长期 Worker Secret。

禁止 Global API Key、个人浏览器登录态或个人长期 Token。`BOOTSTRAP_TOKEN` 只在首次初始化期间临时存在，用完删除。

## 3. Cloudflare 正式资源和 Worker Secrets

必须真实核对：

- Cloudflare Account / Zone；
- Worker 名称；
- D1 database 名称与 UUID；
- 对象存储 provider 及其资源；当前为 Notion 专用 Database/Data Source；
- R2 只有在 provider=`r2` 时才要求 bucket 与 subscription；
- 自定义域名和 HTTPS；
- Cron；
- Worker Secret。

生产 config 必须保持：

- `APP_ENV=production`；
- `workers_dev=false`；
- `preview_urls=false`；
- 唯一 `DB` D1 binding；
- 显式 `OBJECT_STORAGE_PROVIDER`；当前 production=`notion`；
- Notion 模式配置 `NOTION_API_VERSION=2026-03-11` 与 `NOTION_STORAGE_DATA_SOURCE_ID`，不配置 `FILES`；
- R2 模式才配置唯一 `FILES` binding，且不得混入 Notion 配置；
- `/api` 和 `/api/*` `run_worker_first`；
- 自定义域名；
- 当前 Notion production 的 `secrets.required = ["AUTH_CREDENTIAL_PEPPER", "NOTION_API_TOKEN"]`。

### Secret 生命周期

`AUTH_CREDENTIAL_PEPPER`
: 永久 Worker Secret。Wrangler production config 将其列为 required；缺失时正式 deploy 必须 fail-closed。丢失会导致现有 HMAC verifier 无法正常验证，不能当普通无损轮换 Secret。

`NOTION_API_TOKEN`
: 当前 production 对象存储的永久 Worker Secret，只授予专用 Notion 存储页面所需能力；不得出现在 vars、Git、日志或前端。若以后切换 R2，可从 required secrets 中移除。

`BOOTSTRAP_TOKEN`
: 一次性 Worker Secret。仅首次创建管理员期间配置；创建成功并验证再次 bootstrap 已关闭后删除。禁止长期写进 `secrets.required`。

`NOTIFICATION_DELIVERY_URL` / `NOTIFICATION_DELIVERY_TOKEN`
: 可选，只有启用真实通知适配器时配置；不得把 Token 嵌入 URL 或日志。

## 4. 发布前业务与数据证据

### 4.1 真实业务资料

P7-01～05 必须使用真实业务资料或明确的真实环境抽样：

- 真实电压等级 / 线路 / 杆塔清单；
- 系统标准需求模板回导；
- 0..N 需求物资；
- 项目储备和独立项目物资；
- 框架 / 协议 / 预算 / 发生 / 实际费用；
- 一次项目级出库、多执行任务；
- 供应 / 实施 / 结算三线；
- 四状态回投；
- 年度事项 / 分类 / 分析规则。

标准模板是默认入口；不要求业务人员故意制作异常旧格式。历史自定义 Excel 只有明确兼容需求时才单独抽检。

### 4.2 已有 D1 的迁移前保护

如果目标 D1 已有正式/共享数据：

1. 明确维护窗口；
2. 停止业务写入；
3. 暂停会写库的 Cron / 后台任务；
4. 记录当前 Worker version/deployment ID；
5. 记录当前 `d1 migrations list`；
6. 完成逻辑备份并校验 manifest/chunks；
7. 独立保存附件本体清单/大小/hash；
8. 在隔离 D1 做恢复演练并对账；
9. 记录恢复时间点、回退版本和负责人。

首个空库也必须保留“空库、无业务账号/业务数据”的核对证据，不能省略资源确认。

现有 P6 分片备份不是跨表一致快照；正式迁移窗口必须可靠停写，或采用另行验证的一致性方案。

## 5. 正式执行顺序

### 5.1 PR / main 门禁

1. 远端施工分支提交；
2. PR 最新 HEAD 的 GitHub CI 全绿；
3. GitHub 合入 `main`；
4. 合并后的 `main` CI 再次全绿；
5. 记录准确 40 位 `main` SHA。

禁止使用本地测试替代 GitHub Actions。

### 5.2 Production preflight

手工运行 `Production preflight (no deployment)`：

- `npm ci`；
- `npm run check`；
- 直接读取并校验受审的 `apps/api/wrangler.production.jsonc`；
- `npm run p7 -- config`；
- production Wrangler dry-run；
- 不加载 `CLOUDFLARE_API_TOKEN`；
- 不执行 remote migration 或 deploy。

preflight 通过只证明配置结构和构建，不证明真实资源/Secret 存在。

### 5.3 Production D1 migration

仅在 schema 不满足当前代码要求时执行：

1. 手工触发 `Production D1 migration`；
2. 输入准确 `release_sha`；
3. 输入 migration/backup evidence reference；
4. 人工再次输入目标 D1 UUID；
5. workflow 校验输入 UUID 与受审 `apps/api/wrangler.production.jsonc` 中 `database_id` 完全一致；
6. 执行迁移前 `wrangler d1 migrations list DB --remote`；
7. 执行 `wrangler d1 migrations apply DB --remote`；
8. 再次 `list`；
9. 核对关键表、金额、数量、状态和错误。

任何 migration 失败都立即停止；不得盲目重跑。当前仍处开发阶段，只允许单一 `0001_initial_schema.sql` 基线；除非用户明确要求兼容已有数据/保留升级路径，否则不得新增补丁 migration。

### 5.4 Production release

确认 schema ready 后：

1. 手工触发 `Production release`；
2. 输入准确当前 `main` SHA；
3. 输入 release/backup/schema evidence reference；
4. workflow 重新执行完整 `npm run check`；
5. production config validator；
6. runner 从 GitHub Environment Secrets 生成 0600 的临时 `worker-secrets.json`；
7. Wrangler dry-run 使用同一 `--secrets-file`；
8. 再次 fetch `origin/main` 并要求仍等于批准 SHA；
9. `wrangler deploy --config wrangler.production.jsonc --secrets-file <runner-temp>`，代码、bindings 与 Worker Secrets 同一版本发布；
10. 从 production config 提取真实自定义域名；
11. GitHub runner 请求 `https://<domain>/api/health`；Cloudflare 新 deployment 可能存在短暂传播窗口，因此不能只对网络错误做 `curl --retry`，必须在有限窗口内重复执行“HTTP 请求 + JSON 语义校验”；
12. 只有实际响应满足 `ok=true`、service=`transmission-project-manager`、`schema.ready=true` 才通过基础发布验收；如果首次 HTTP 200 仍返回旧 deployment 的业务语义，应继续等待并重试，而不是立即把已经成功的 Worker 发布误判为失败；
13. 无论成功失败都删除 runner 临时 secret 文件。

代码发布不会自动执行 migration。

### 2026-09-14 首次正式 release 记录

`main@9102a17f7795ef85254845c6dea0b156a2d2b05b` 的 `Production release`
run `34843761479` 中，完整检查、配置校验、dry-run、精确 SHA 二次绑定和正式
Wrangler publish 均 PASS；唯一失败步骤是紧随发布后的 health 验证。约 2 分钟后人工从公网复核
`https://project.980923.xyz/api/health` 已为 HTTP 200，且满足 `ok=true`、
`service=transmission-project-manager`、`schema.ready=true`、
`currentMigration=requiredMigration=0001_initial_schema.sql`。

因此该 run 应记录为“**Worker 发布成功，自动 health 验收因传播窗口误判失败**”，不能记录为
“Worker 发布失败”。后续 workflow 已在施工分支改为最多 30 次 `curl + JSON 语义校验`；
修复合入 `main` 后必须再跑一次精确 SHA 绑定的 `Production release`，以取得最终全绿的发布证据。

该修复随后经 PR #9 合入 `main`。合并后的 `main` CI run `34844921647` PASS；
正式 `Production release` run `34845107626` 绑定
`a907dbee2dfddb0a4f266ed25cf2f18a18d9df51` 再次执行，完整检查、配置校验、
Worker publish、语义 health 验证和临时 Secret 清理全部 PASS，最终 conclusion=`success`。
发布后独立公网复核 `/api/health` 仍满足 schema ready；`/api/auth/status` 为
`initialized=false`，因此下一步已从“修发布流水线”转为“首管理员 bootstrap 与后续认证/业务验收”。

## 6. 首次管理员和认证验收

首次上线：

1. 临时配置 `BOOTSTRAP_TOKEN`；
2. HTTPS 页面创建首管理员；
3. 再次调用 bootstrap 必须被拒绝；
4. 删除 `BOOTSTRAP_TOKEN`；
5. 应用内创建第二管理员；
6. 验证浏览器 Web Worker Argon2id；
7. 验证 username/password 登录；
8. 验证 HttpOnly / Secure / SameSite Cookie 和 7 天会话；
9. 验证首次改密、重置密码、停用成员撤销旧会话；
10. 验证角色和 framework/project 范围；
11. 匿名受保护 API 必须拒绝；
12. 未知 `/api/*` 必须返回 JSON 404。

不得把密码、派生 credential、Cookie 或 bootstrap token 写入 Actions 日志、GitHub PR/Issue、release note 或 P7 evidence。

## 7. 核心业务 smoke

生产至少实测：

- health / schema readiness；
- 基础台账：电压等级 → 线路 → 杆塔；
- 手工需求；
- 标准模板导入与来源行反查；
- 项目储备；
- 项目物资修订；
- 项目级出库；
- 多执行任务；
- 任务物资供应；
- 实施；
- 结算；
- 已实已结 / 已实未结 / 未实已结 / 未实未结四状态；
- 框架 / 协议 / 预算 / 预算发生 / 实际费用；
- 附件上传、下载、鉴权和当前对象存储；Notion 模式验证逻辑删除后应用层不可读取，并记录底层 FileUpload 无物理删除 API 的治理边界；
- 月报 / 分析 / 预警；
- Cron / notification outbox / backup；
- 手机和桌面自定义域名访问。

P7-01～13 的具体证据矩阵以 `P7_ACCEPTANCE.md` 为准。

## 8. Logs、Metrics 与网络验收

正式发布后观察至少一个完整后台/备份周期：

- Workers Logs：异常堆栈、5xx、鉴权失败模式；
- Workers Analytics：请求量、错误率、CPU time；
- D1：read/write rows、容量、错误；
- 对象存储：Notion 模式观察 429/5xx、上传/下载失败和容量；R2 模式观察存储量、Class A/B 操作与失败；
- Cron：执行成功率和耗时；
- backup run/chunk 状态；
- 目标地区实际网络体验。

本地 wall-clock、workerd 或 GitHub runner 性能不等于 Cloudflare Free CPU 结论。

## 9. 备份完整性边界

P6 v1 manifest verifier 能证明 chunk SHA-256、表名/行数、chunk index 连续、对象路径安全和 manifest 中列出的附件 key 存在。

它不能单独证明跨表一致快照、未被同时删掉的对象完整性、附件内容 hash、附件枚举完整性或数据已经成功恢复并可被应用读取。

因此正式恢复必须进入隔离 D1 + 隔离对象存储环境，对关键行数、金额、数量、状态、外键、附件和应用行为复核；`auth_sessions` 不恢复。Notion 模式需用测试专用存储区域演练，不能把正式对象索引当恢复沙箱。

## 10. 回退

### Worker 代码回退

1. 停止新写入/后台任务；
2. 保存故障日志、部署 ID、schema 状态和数据备份引用；
3. 核对旧 Worker 与当前 schema 兼容；
4. 使用 Cloudflare 受控回退到明确的前一 Worker version；
5. 重复 health、认证、核心业务和附件 smoke；
6. 再恢复后台任务和业务写入。

Worker 回退不会自动回退 D1、对象存储、Secrets、Cron 或路由。

### 数据回退

- 只能先恢复到隔离 D1；
- 完成逐表/金额/数量/状态/附件对账后再受控切换；
- 禁止把旧备份直接覆盖仍有新写入的正式库；
- 正式使用后的 migration 历史只追加；
- Git 历史使用 revert，不 reset/force-push `main` 抹除审计。

## 11. 运维移交

P7 完成前，至少由非资产所有者个人登录态的 CI/CD 服务身份完成一次受控 migration 演练、受控代码发布、回退演练、Cloudflare token 轮换和旧维护人撤权后继续运行验证。

应用管理员只管理业务账号和权限，不需要 Cloudflare 权限。Cloudflare 技术运维使用自己的 Account Member 身份；CI 使用 account-owned token。资产所有者可保留 Super Administrator 作为紧急兜底，但日常发布不依赖其个人登录。

## 12. 证据记录

每次正式变更至少记录：GitHub PR、`main` SHA、Actions run URL/run id、release/migration evidence reference、Worker version/deployment ID、D1 UUID/migration 状态、对象存储 provider 与非敏感资源 ID、自定义域名、health/smoke 结果、Logs/Analytics/CPU 摘要、备份/恢复证据、操作者/reviewer/observedAt。

真实敏感值、密码、Token、Cookie、业务原始数据不得写入公开 Actions artifact、PR 或仓库。
