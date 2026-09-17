# AI 交接说明

日期：2026-09-17。此文档只记录当前施工状态；历史 UI 重构、生产发布和排障过程通过 Git / GitHub Actions 追溯。

## 当前任务

全站 UI、第一轮工程化加固、发布链优化和技术债清理已经通过 PR #15 / #16 / #17 / #18 合入 `main` 并发布生产。当前施工转为**空状态垂直留白专项**：修复项目页“暂无项目”图标/文字贴近上下边界的问题，同时审计并统一其他主数据区域的同类空状态，增加静态契约与真实浏览器几何门禁。

当前施工分支：`fix/empty-state-spacing-20260917`，从已发布 `main@398e65adbe11e653bf20bc7b8cf3e0cfc7796cd1` 创建。实现提交 `a4d28db fix(web): standardize spacious empty states` 已 push；禁止 `git reset` / `git clean`，不得覆盖他人未提交修改。用户已明确要求“完成任务，发布”，因此完成 PR 三项 CI、合并 `main`、精确 main push CI 三绿后，按受控流程执行 `make production` 与 `make production-smoke`。

## 当前生产基线

- PR #18 已合入 `main@398e65adbe11e653bf20bc7b8cf3e0cfc7796cd1`。
- 合并后精确 `main` CI run `35168605524`：`check`、`headless-ui`、`audit` 三项 PASS。
- `Production promote` run `35172379250`：PASS。
- 数据保留评估为 `rebuildRequired=false`，source/target schema fingerprint 完全一致，未重建 D1、未清空生产数据。
- 当前已发布 Worker Version ID：`bf567d9a-7d37-48e8-a97d-b27ddfcaacac`。
- workflow 内置公网 smoke 与发布后独立 `make production-smoke` 均 PASS：`/api/health` 正常、`schema.ready=true`、current/required migration 均为 `0001_initial_schema.sql`；`/api/auth/status initialized=true`；匿名 `/api/me` 返回 401。

生产仍处开发阶段 schema 策略：只允许单一 `0001_initial_schema.sql`；只有用户明确宣布进入运行阶段/正式维护升级链后，才允许追加 `0002+`。

## 当前工程化加固完成项

### 统一工程入口

根目录 `Makefile` 已成为日常工程入口：

- `make dev`：本地 API + Web；
- `make check`：TypeScript + production build/dry-run + Node/Web 全量测试；
- `make test`：完整 `check` 后复用该 Web build 执行 Headless Chromium，不再重复构建；
- `make test-ui`：独立运行时仍自行构建 Web；
- `make ci`：触发并等待当前分支 CI；
- `make production-preflight` / `make production` / `make production-inventory`：只编排受保护 GitHub workflow，不直接执行 production Wrangler mutation；
- `make audit`：工程卫生 + production dependency security audit。

生产一键发布强制要求 clean `main` 且 `HEAD == origin/main`；精确 SHA 二次绑定、Secrets、数据保留、正式 deploy、health 和 rollback 仍由 `Production promote` 负责。

### 可重复工程审计

- `scripts/engineering/repository-audit.mjs` 只扫描 `git ls-files` 真源，避免 `.wrangler/tmp`、旧 sourcemap、历史 dry-run 产物制造假阳性。
- 拦截被 Git 跟踪的 dist/coverage/playwright-report/test-results/.wrangler/.DS_Store。
- 生产源码/脚本出现 TODO/FIXME/HACK/XXX 会失败。
- >=600 行文件仅作为维护热点报告，不因行数机械失败。
- `npm run security:audit` 显式使用 `https://registry.npmjs.org` advisory API，避免本机 npmmirror 不实现 audit endpoint；最近一次 production dependency audit 为 **0 vulnerabilities**。
- 曾实验 Vitest `vmThreads` 以减少 23 次 happy-dom 初始化，但实际明显慢于约 9.65s 基线，因此已完全撤回，不保留无收益配置。

相关提交：

- `08f3a67` `build: add reproducible engineering audit`
- `a525db2` `fix(build): avoid audit self-matches`
- `64c6ad1` `build: avoid duplicate web build in full test`

### Shared 公共契约拆分

原 `packages/shared/src/index.ts` 约 1479 行，已按业务域拆为：

- `api.ts`
- `account.ts`
- `imports.ts`
- `master-data.ts`
- `project-execution.ts`
- `reserve-planning.ts`
- `finance.ts`
- `analysis.ts`
- `legacy-lifecycle.ts`

`index.ts` 只保留 re-export barrel，123 个既有 `@tpm/shared` 根入口消费者无需改动。repository guard 锁定该结构，避免公共契约重新堆回单一巨型文件。

提交：`67e9671 refactor(shared): split public contracts by domain`。

### API 分页游标去重

需求、项目储备、资金、项目执行和任务队列原先分别复制 Base64URL JSON cursor 编解码。现统一到 `apps/api/src/http/cursor.ts`；路由层仍保留各自字段校验、权限和错误语义，不把业务规则下沉到通用 codec。新增 `tests/cursor-codec.test.mjs` 与 repository guard 防止重复实现回流。

提交：`def862a refactor(api): share pagination cursor codec`。

### 发布链优化（已通过 PR #17 合入并发布）

- CI 新增独立 `audit` job，工程卫生与 production dependency security audit 成为发布关键证据；
- `Production preflight` / `Production promote` 不再把同一 SHA 的完整测试重复执行，而由 `verify-release-ci.mjs` 严格复用精确 `main` push CI 的 `check / headless-ui / audit` 三项成功证据；
- `Production preflight` 已解除 `production` Environment 绑定：它无云凭据、无 remote mutation，不再占用生产审批/Secret 边界；
- production workflow 仍在 fresh runner 重新安装锁定依赖、build Web、校验 production config 并做 Worker dry-run，不能只靠历史构建产物；
- `public-smoke.mjs` 自动验证 health/schema migration、认证初始化和匿名 401；
- `make production-smoke` 从受控 production config 解析正式域名，可随时只读复核当前线上基础状态；
- code-only `rebuildRequired=false` 发布也在 deploy 前记录旧 Worker version 并安装 rollback trap，smoke 失败时自动回滚；发布摘要直接记录新 Worker Version ID；
- 旧 `main@10274d5` CI 因尚无 `audit` job，被新 release gate 正确拒绝复用，证明门禁不会拿旧弱证据冒充新发布证据。

相关提交包括 `368ab75 build: reuse exact CI evidence for releases`、`789e2d6 build: streamline production preflight and smoke`；最终由 PR #17 合入 `main`。

### 储备分类配置职责拆分

`reserve-planning.ts` 原先同时承载项目储备和储备大类/需求类别映射配置。当前将 `/reserve-categories` 与 `/category-mappings` 原路径迁入 `reserve-category-config.ts`，项目成本分类分摊仍留在项目储备域；权限、幂等、版本和错误合同不变。repository guard 防止两类职责再次混回同一模块。

提交：`f790db5 refactor(api): isolate reserve category configuration`。

## 当前维护热点

工程审计当前仍报告以下 >=600 行真源；它们是审查候选，不是“必须按行数拆分”的失败项：

- `apps/web/src/views/MasterDataView.vue`
- `apps/web/src/views/DemandsView.vue`
- `apps/api/src/reserve-planning.ts`
- `apps/api/src/demand-import.ts`
- `apps/web/src/views/FinanceView.vue`
- `apps/api/src/finance.ts`
- `apps/api/src/project-lifecycle.ts`
- `apps/web/src/views/AnalysisView.vue`

后续只在发现清晰职责边界、重复逻辑、性能风险或测试困难时拆分。

## 当前验证状态与下一步

PR #18 合并后的精确 `main` CI run `35168605524` 已三绿。当前空状态专项分支最新完整本地 `make test` 已 PASS：Node **340/340**、Web **165/165（23 文件）**、Headless Chromium **24/24**；TypeScript、Web production build、Worker dry-run、Node + SQLite + Filesystem 第二运行时均通过。`make audit` 也已 PASS：仓库工程卫生通过，production dependency audit **0 vulnerabilities**。

Shared 拆分过程中完整门禁曾抓到 Node 原生 ESM 不接受无扩展名相对 specifier；现已改为显式 `.ts`，并新增门禁防回归。该失败从未合入 `main`、从未发布生产。

### 2026-09-17 技术债清理进展

- PR #6 `ops: add one-shot Cloudflare auth diagnostic` 已关闭；对应远端分支 `ops/cfdiag-once-20260914` 已删除。该 PR 仅用于 2026-09-14 一次性 Cloudflare Token 诊断，正式发布/inventory/smoke 流程已经完全替代它。
- 另一条历史远端诊断分支 `ops/cloudflare-inventory-diagnostics-20260914` 也已确认只包含旧 inventory/认证诊断提交，且 `main` 中现行 `production-cloudflare-inventory.yml` 更新、更安全；该残留远端分支已删除。
- `expectedVersion` 纯解析重复已在提交 `95d5ccb` 收口。公共层只提供两类无业务语义 parser：严格 JSON 数字的安全正整数解析，以及为 `demand-import` / `reserve-planning` / `reserve-category-config` 保留既有 `Number(...)` coercion 的兼容解析；各路由原有 400/409/422、错误码和冲突文案未被合并。新增纯函数测试与 repository guard，防止同类 parser 再复制回业务模块。
- `transmission-grid.ts` 旧 cursor codec 已在提交 `9b2ff2b` 收口到 `apps/api/src/http/cursor.ts`。测试先证明旧 `btoa(encodeURIComponent(JSON))` wire format 不能被原共享 codec 读取，再扩展共享 decoder 同时兼容旧台账 cursor 与现有 Base64URL JSON；encoder 对 ASCII 保持现有格式，对中文线路名等 Unicode 状态安全回退到 URI 编码后再 Base64URL。线路/杆塔分页加入真实旧 cursor 回归，repository guard 也已覆盖 `transmission-grid.ts`。
- 两个小包均已独立提交并 push 到 `refactor/technical-debt-cleanup-20260917`；完整 `make test` 为 Node **339/339**、Web **165/165（23 文件）**、Headless Chromium **23/23**。当前尚未触发生产发布，不得把本地全绿描述成线上已升级。
- 维护热点继续以职责证据为准；`MasterDataView.vue`、`DemandsView.vue`、`demand-import.ts`、`FinanceView.vue`、`finance.ts`、`project-lifecycle.ts`、`reserve-planning.ts`、`AnalysisView.vue` 仅是候选，不因行数本身拆分。

### 2026-09-17 空状态留白专项

- 项目页“暂无项目”原本没有任何专用垂直留白，Naive UI 空状态内容贴近列表上下边界；审计同时发现需求池、物资字典、资金三处、任务队列、线路台账和杆塔台账各自存在无样式或 `30/32/56px` 私有实现。
- 当前 9 个主数据区域统一使用全局 `.surface-empty-state { width: 100%; padding: 48px 20px; }`；抽屉、详情卡片等紧凑型小空状态没有机械放大。
- repository guard 明确锁定上述主区域必须使用共享契约，并禁止 Finance/Demands/TaskQueue 重新出现页面私有 `n-empty` padding。
- Playwright 新增真实几何门禁：项目列表制造“搜索无结果”后，直接测量空状态图标/说明到区域上下边界的实际净距，要求均 `>= 40px`。该测试已在桌面真实渲染中 PASS。
- 实现提交：`a4d28db fix(web): standardize spacious empty states`；完整 `make test` 为 Node **340/340**、Web **165/165**、Headless **24/24**；`make audit` PASS，0 vulnerabilities。

下一步：提交并 push 文档 → 创建 PR → 等 `check / headless-ui / audit` 三 job 全绿 → 合并 `main` → 等精确 main push CI 三绿 → `make production` → `make production-smoke`。本轮用户已明确授权发布，但仍不得跳过上述门禁。

## 必须保持的业务/工程边界

- 需求可无物资；项目可 0 需求、0 物资建立。
- 需求来源与项目物资是不同事实，不得相互推导数量上限。
- 项目出库是一次项目级节点，不是仓库发货。
- 任务供应、实施、结算三线并行；四状态来自事实聚合。
- 框架总额、协议额度、项目预算、预算确认占用、预算发生、实际费用、任务结算始终分开。
- 金额/数量使用定点整数；写操作保持角色/范围校验、版本冲突、幂等和审计。
- 线路位置与物理杆塔保持独立稳定身份；更名和 rebind 不得破坏历史需求定位。
- 禁止假数据、当前页统计冒充总量、前端 N+1 聚合、隐藏权限替代服务端鉴权。
- Headless E2E 继续使用隔离 D1/R2 与页面真实认证；不得操作用户真实浏览器、复制真实 Cookie 或使用真实账号密码。
