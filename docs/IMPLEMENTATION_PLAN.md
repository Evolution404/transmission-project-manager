# 实施计划与验收清单

版本：2026-09-14。长期业务事实见 `BUSINESS_BASELINE.md`。本文件维护当前阶段状态、已完成能力和下一步；详细云端接手状态见 `AI_HANDOFF.md`。

## 1. 阶段总览

| 阶段 | 范围 | 当前状态 |
|---|---|---|
| P0 | 仓库、CI、基础架构、文档 | 已完成 |
| P1 / P1.1 | 身份权限、成员与运维分层 | 已完成；认证方式已由 P1.2 替代 |
| P1.2 | 系统自维护 username/password、Argon2id 客户端派生、服务端会话 | 已完成 |
| P2 | 抽象需求、标准模板/Excel 导入、0..N 需求物资、物资字典 | 已完成 |
| P3 | 项目储备、需求来源关系、独立项目物资与修订历史 | 已完成 |
| P4 | 框架、协议、预算版本、预算发生与实际费用 | 已完成 |
| P5 | 一次项目级出库、多执行任务、供应/实施/结算三线、四状态反馈 | 已完成 |
| P6 | 月报、分析、预警、年度事项、通知 outbox、D1→对象存储逻辑备份 | 已完成 |
| 基础台账重构 | 电压等级 → 线路 → 杆塔 → 需求位置对象化 | 已完成 |
| 后端可移植化 | Database/ObjectStore Ports；Cloudflare D1 + Notion/R2、Node SQLite/Filesystem 可替换运行时 | 已完成基础重构；Notion provider 当前在 `feat/notion-object-storage` 收口 |
| 云端发布流水线 | GitHub Actions → Cloudflare 受控发布、D1 migration 分离 | PR #2 已合入 main；main CI #37 PASS，真实发布未执行 |
| P7 | 真实业务数据、真实 Cloudflare/D1/对象存储/网络、恢复和运维移交 | 未完成，必须真实环境验收 |

## 2. 当前业务主路径

```text
电压等级 → 线路 → 杆塔
          ↓
抽象需求（0..N 需求物资）
          ↓
项目储备（需求来源 + 独立项目物资）
          ↓
一次项目级出库
          ↓
多个执行任务
          ↓
物资供应 / 实施 / 结算三线并行
          ↓
需求四状态与进度回投
```

框架、协议、预算、预算发生、实际费用和任务结算独立核算。旧 `demand_allocations`、`release_lines` 等仅作历史兼容/回归，不得恢复为新 UI 或新 API 的主路径。

## 3. 已完成关键能力

### 认证与权限

- 业务认证完全由系统维护 `username + password`，不使用 Cloudflare Access 或邮箱登录。
- 浏览器 Web Worker 执行 Argon2id；服务端只做 HMAC verifier 和 HttpOnly 会话。
- 支持管理员创建/停用成员、角色、业务范围、重置密码；最后一个启用管理员受保护。
- 生产接口只信任系统会话，前端隐藏按钮不能替代后端授权。

### 需求、基础台账与导入

- `VoltageLevel 1:N TransmissionLine 1:N TransmissionTower` 已落地。
- 需求是抽象事项，可无物资，也可带多条物资子明细。
- 手工新增和标准 `.xlsx`/`.csv` 导入同时存在。
- 手工需求使用电压 → 线路 → 位置类型 → 杆塔级联。
- Excel 多行可归并为一个抽象需求并保留全部来源行。
- Excel 发布前必须解析到已有且启用的台账对象；未知/停用对象阻断发布。
- 完整文件解析在浏览器 Web Worker，服务端只接收小分片。
- migration `0009`–`0012` 已冻结，只能追加后续 migration。

### 项目储备、执行与资金

- 项目需求来源与项目物资分开建模；项目物资可持续修订并保留历史。
- 储备项目允许 0 条物资先建立。
- 项目只做一次项目级出库；出库后可创建多个执行任务。
- 任务物资供应、实施、结算分别使用独立版本推进。
- 实施和结算允许任意先后，四状态由任务范围事实回投需求。
- 框架、协议、预算、预算发生、实际费用、结算分别保存；预算确认不会自动产生预算发生。
- 金额使用整数分，数量使用定点整数；缺价格不等于零价。

### 分析、提醒与备份

- 分析规则/月计划/月报快照版本化。
- 服务端定时任务处理预警、通知 outbox 和备份；关闭浏览器不影响。
- D1→`ObjectStorePort` 逻辑备份按表分片、带 SHA-256/manifest；`auth_sessions` 不恢复。当前正式方案写入 Notion，R2/Filesystem 保持可替换。

### 后端可移植化

以下能力已完成并于 2026-09-14 通过 PR #1 合入 `main`：

- `DatabasePort` / `TransactionPort`、`ObjectStorePort`、Queue/Scheduler/Clock ports；
- Cloudflare D1 adapter、Notion/R2 object-store adapters、Node SQLite/Filesystem adapters；
- `RuntimeBindings.PERSISTENCE` 作为 Hono 应用持久化注入边界；
- P2/P3/P4/P5/P6/P8/P9 与认证层不再直接绑定 D1/R2/Notion；
- Node + SQLite + Filesystem 真实 Hono app E2E；
- `0001_initial_schema.sql` 单一开发基线从空库建库验证；
- 静态 repository guards 防止重新耦合 Cloudflare persistence。

PR #1 合并前 GitHub CI 全绿；合并后的 `main@7a49b44275038dddd3803cb17de9b7e4fe06ba33` CI #31 再次全绿。

## 4. 当前自动门禁

所有新功能和缺陷修复继续执行 test-first，详见 `TESTING.md`。

当前 `npm run check` 覆盖：

- Cloudflare TypeScript；
- Node 完整 app TypeScript；
- Web production build；
- Worker `wrangler deploy --dry-run`；
- Vue/Vitest；
- Node tests；
- Node SQLite + Filesystem application E2E；
- 单一 `0001_initial_schema.sql` 的 SQLite + Wrangler 标准建库验证；
- repository/static guards。

云端发布施工新增 `tests/p7-preflight.test.mjs` 门禁，约束：

- 普通 CI / preflight 不得携带 Cloudflare 凭据或产生远端变更；
- 生产代码发布只能手工触发、绑定 `production` Environment、精确 `main` SHA；
- D1 migration 必须使用独立手工 workflow，禁止混入 Worker deploy；
- production config 必须保持 `workers_dev=false`、`preview_urls=false`、固定同域 API 路由、唯一 D1 binding，并显式选择一个对象存储 provider；当前正式 provider=`notion`，R2 方案不得与 Notion 配置混绑；
- production config 使用 Wrangler `secrets.required` 长期要求 `AUTH_CREDENTIAL_PEPPER`。

自动门禁只证明代码和流程定义，不等于生产环境已经配置或通过 P7。

## 5. 当前施工与发布边界

后端可移植化施工已经结束并合入 `main`。当前生产 workflow 已进入 `main@bc4774767c159068d59e16d6726444c5c1525dd6`。

PR #2 已合并；当前云端配置记录分支为 `ops/production-environment-handoff-20260914`。

PR #2 建立：

- `.github/workflows/production-deploy.yml`：代码发布，发布后真实 `/api/health` 校验；
- `.github/workflows/production-migrate.yml`：独立 D1 migration，并要求人工再次确认目标 D1 UUID；
- `PRODUCTION_DEPLOY_ENABLED` 与 `PRODUCTION_MIGRATION_ENABLED` 两个独立开关；
- `PRODUCTION_CONFIG_JSON` 非敏感配置变量；
- `CLOUDFLARE_API_TOKEN` GitHub Environment Secret；
- 永久 Worker Secret `AUTH_CREDENTIAL_PEPPER` 缺失时 deploy fail-closed。

一次性 `BOOTSTRAP_TOKEN` 不属于永久 `secrets.required`；首次管理员初始化完成后应删除。

2026-09-14 GitHub 云端 UI 已建立 `production` Environment，只允许 `main` 部署，两个 enable variable 均为 `false`。仓库 0 collaborators，尚未配置 required reviewer、阻止自审或禁管理员绕过；main branch protection 尚未保存。Cloudflare Dashboard 在云端浏览器持续安全验证，以下事项**尚未完成且不得伪造已完成状态**：

- GitHub `production` Environment 的审核策略；
- `PRODUCTION_CONFIG_JSON` 的真实配置；
- `CLOUDFLARE_API_TOKEN` 的真实配置；
- Cloudflare 永久/一次性 Worker Secrets 的真实配置；
- 正式 D1/Worker/对象存储资源核对或创建；当前对象存储为 Notion data source，R2 未启用不构成当前生产阻塞；
- 正式 migration；
- 正式 Worker 发布。

后续不得退回 Mac、本地 shell、本地 Wrangler 或本地测试环境解决上述事项。

## 6. P7 剩余工作

P7 重点是证明当前系统在真实环境可正式使用：

- PR #2 与合并后的 main CI #37 已全绿；继续以实际最新 main SHA 为发布输入；
- 在 GitHub 实际配置受保护 `production` Environment、Variables、account-owned Cloudflare token；
- 核对/建立正式 Worker、D1、自定义域名和当前对象存储；Notion 模式配置 `NOTION_STORAGE_DATA_SOURCE_ID` 与 `NOTION_API_TOKEN`，R2 保留为可选替换方案；
- 对正式 D1 做备份/停写/目标 ID 核对后，通过独立 workflow 执行 migration；
- 通过 `Production release` 发布准确 `main` SHA；
- 真实 `/api/health`、登录、首管理员/bootstrap 关闭、核心业务、附件/当前对象存储、Cron、静态资源、自定义域名验收；
- 测真实 Workers CPU/配额、D1/对象存储用量和目标地区网络体验；Notion 模式同时观察 API 429/5xx 与上传下载行为；
- 核对 Cloudflare Logs / Workers Analytics / 错误率和 CPU 指标；
- 使用系统标准模板填报代表性真实需求并抽样核对；
- 执行正式停写备份、隔离恢复、对账、回退演练；
- 完成 Cloudflare/GitHub 运维移交和 CI/CD 服务身份演练；
- 为每项真实验收保留证据，不能用本地或合成结果代替。

详细矩阵见 `P7_ACCEPTANCE.md`，操作步骤见 `P7_RUNBOOK.md`，最新云端状态见 `AI_HANDOFF.md`。

## 7. 完成标准

任何后续阶段或缺陷修复只有同时满足以下条件才算完成：

1. 先有自动测试约束目标行为；
2. 相关定向测试通过；
3. GitHub Actions 完整 `npm run check` 或等价全覆盖门禁通过；
4. migration/共享类型/文档同步；
5. 无密钥/真实业务数据进入 Git；
6. 提交到远端施工分支并通过 PR；
7. 合并后 `main` CI 通过；
8. 需要发布时通过受保护的 GitHub/Cloudflare 云端 workflow 完成，不得把本地电脑作为必要前置条件；
9. 生产相关结论必须有真实云端证据。
