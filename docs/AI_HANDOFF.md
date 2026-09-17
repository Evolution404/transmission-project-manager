# AI 交接说明

日期：2026-09-17。此文档只记录当前施工状态；历史 UI 重构、生产发布和排障过程通过 Git / GitHub Actions 追溯。

## 当前任务

全站 UI、第一轮工程化加固和发布链优化已经通过 PR #15 / #16 / #17 合入 `main` 并发布生产。当前继续做**技术债审计与清理**：只处理有明确引用证据的死代码、一次性运维资产、重复基础设施逻辑和清晰职责混杂；禁止为了“文件变小”机械拆分业务模块。

当前施工分支：`refactor/technical-debt-cleanup-20260917`，从已发布 `main@8eb6bb6d475d73a0659d7924cce4e98aebaf58f1` 创建。当前工作区仅有本交接文档/实施计划更新，尚未开始新的生产代码重构。禁止 `git reset` / `git clean`，不得覆盖他人未提交修改。用户本轮要求清理技术债后再发布；下一位 AI 应先完成当前审计、测试和 PR，再按 `main` 精确 CI → `Production promote` 发布，不能跳过门禁。

## 当前生产基线

- PR #17 已合入 `main@8eb6bb6d475d73a0659d7924cce4e98aebaf58f1`。
- 合并后 `main` CI run `35144001547`：`check`、`headless-ui`、`audit` 三项 PASS。
- `Production promote` run `35144244010`：PASS，优化后的正式 promote 总耗时约 45 秒。
- 数据保留评估为 `rebuildRequired=false`，source/target schema fingerprint 完全一致，未重建 D1、未清空生产数据。
- 当前已发布 Worker Version ID：`a0d69abd-a24d-4eba-8c2a-a323d04b63ea`。
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

PR #17 合并后的精确 `main` CI run `35144001547` 已三绿：`check` 1m13s、`headless-ui` 1m47s、`audit` 14s。此前本地完整 `make test` 已 PASS：Node **334/334**、Web **165/165（23 文件）**、Headless Chromium **23/23**；其后新增 production smoke/release gate 测试也已由 PR / main CI 验证。production dependency audit 为 **0 vulnerabilities**。

Shared 拆分过程中完整门禁曾抓到 Node 原生 ESM 不接受无扩展名相对 specifier；现已改为显式 `.ts`，并新增门禁防回归。该失败从未合入 `main`、从未发布生产。

### 2026-09-17 技术债清理进展

- PR #6 `ops: add one-shot Cloudflare auth diagnostic` 已关闭；对应远端分支 `ops/cfdiag-once-20260914` 已删除。该 PR 仅用于 2026-09-14 一次性 Cloudflare Token 诊断，正式发布/inventory/smoke 流程已经完全替代它。
- 另一条历史远端诊断分支 `ops/cloudflare-inventory-diagnostics-20260914` 也已确认只包含旧 inventory/认证诊断提交，且 `main` 中现行 `production-cloudflare-inventory.yml` 更新、更安全；该残留远端分支已删除。
- 当前 GitHub **无开放 PR**，远端只剩 `origin/main`；本轮清理未修改生产代码，也未触发生产发布。
- 下一项优先候选技术债：API 对 `expectedVersion` 的纯解析逻辑仍在 `finance.ts`、`project-lifecycle.ts`、`reserve-planning.ts` 及若干台账模块重复。先区分“纯正整数解析”与各路由自己的错误码/409 语义，只允许抽取无业务语义的 parser，禁止把不同状态码或冲突文案硬统一。
- 第二候选：`transmission-grid.ts` 仍有自定义 `btoa/atob + encodeURIComponent` cursor 编解码，而其他对象分页已统一到 `apps/api/src/http/cursor.ts`。下一位 AI 应先写兼容性测试，确认线路/杆塔 cursor 的既有 wire format 是否允许迁移；不能直接替换导致已有 cursor 链接失效。
- 维护热点继续以职责证据为准；`MasterDataView.vue`、`DemandsView.vue`、`demand-import.ts`、`FinanceView.vue`、`finance.ts`、`project-lifecycle.ts`、`reserve-planning.ts`、`AnalysisView.vue` 仅是候选，不因行数本身拆分。

下一步：从上述候选中选择一个低风险、可测试的技术债 → 测试先行 → 小提交 → `make test` + `make audit` → push/PR → 三 job CI → 合并 `main` → 等精确 main CI 三绿 → `make production` → `make production-smoke`。本轮用户已经明确要求“清理后发布”，但仍必须完成这些门禁后再部署。

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
