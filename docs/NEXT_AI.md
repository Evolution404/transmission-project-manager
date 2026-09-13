# 下一位 AI：进入 P7 正式环境验收

项目：`Evolution404/transmission-project-manager`

本地路径：`/Users/zhangyuxi/Desktop/项目管理`

分支：`main`

## 当前基线

2026-09-13 已完成最终业务模型结构性重构。不要再次沿旧 `demand_allocations` / `release_lines` 修补或恢复旧 P3/P5 语义。

开始前仍先执行：

```sh
cd /Users/zhangyuxi/Desktop/项目管理
git status --short --branch
git diff
```

禁止 `reset / clean` 或覆盖本地未提交工作。必须先阅读：

1. `AGENTS.md`
2. `docs/HANDOFF-FINAL-BUSINESS-BASELINE-2026-09-12.md` —— 最高优先级业务口径
3. `docs/AI_HANDOFF.md`
4. `docs/DESIGN.md`
5. `docs/DATA_MODEL.md`
6. `docs/TESTING.md`
7. `docs/P7_RUNBOOK.md`

## 已落地的最终业务主线

```text
抽象需求（0..N 条需求物资子明细）
  ↓ project_demand_links
项目储备
  ├─ 需求来源关系
  └─ 独立项目物资 project_material_requirements
       └─ project_material_revisions
  ↓ 一次 project_releases 项目级出库
执行任务 project_tasks 1..N
  ├─ 任务物资 task_material_requirements
  │   └─ 供应：已上报 / 已发货 / 已到货
  ├─ 实施：任务需求范围完成量 + 实际物资使用
  └─ 结算：任务需求范围覆盖 + 金额 + 最终标记

供应 / 实施 / 结算三条线独立版本、并行推进。
任务事实最终回投原始需求四状态：
已实施已结算 / 已实施未结算 / 未实施已结算 / 未实施未结算。
```

关键实现：

- `0008_final_business_flow.sql`：最终模型新增表；已纳入迁移 checksum 锁。
- `apps/api/src/p8.ts`：最终业务 API；新 UI 不再读写旧 allocation/release-line 模型。
- P2 导入：同一业务事项的多行 Excel 归并为一个抽象需求，多条物资进入 `demand_materials`，所有物理来源行进入 `demand_source_rows`；无物资需求合法。
- P3 储备：需求来源和项目物资完全分离；项目物资可增减/换型并保留修订历史，进入任务后有保护下限。
- 项目出库：项目只做一次业务级出库，冻结需求来源和项目物资快照；不是仓库发货，不生成新的 `release_lines`。
- 多执行任务：只有项目级出库后才能创建；任务需求范围用于四状态回投，任务物资来自项目物资但数量独立。
- 物资供应：`到货 <= 发货 <= 上报 <= 任务需求`；使用独立 `supply_version`，同版本并发只有一个成功。
- 实施/结算：分别使用 `implementation_version` / `settlement_version`；允许先结算后实施；首次实施形成结算提醒。
- P6 储备分析：只统计尚未项目级出库项目的当前项目物资金额，施工/其他费不进入项目物资储备类别。
- schema readiness：`/api/health` 显式返回当前/要求 migration；业务 API 在数据库落后时 `503 SCHEMA_OUTDATED` fail-closed。`npm run dev` 启动前自动迁移并监听 migration 文件变化；`REQUIRED_MIGRATION` 必须始终跟随最新迁移。
- UI 基线：Naive UI 固定 `zhCN/dateZhCN`，禁止 `Please Input/Select` 等英文默认占位；需求新增必须使用模态框，不把大表单常驻需求池主页面。全局应用壳/卡片/表格采用统一视觉层级，正常界面不显示 P2/P6 等开发阶段术语。

旧 `demand_allocations`、`release_batches/release_lines`、旧 implementation/settlement 表和接口继续保留，仅用于历史兼容、旧回归、备份恢复，不得作为新功能主路径。

## 保留不变的并行业务线

P4 框架/协议/资金线继续有效：

- 每个项目只属于一个框架；一个框架可有多个执行协议和多个子项目。
- 子项目预算、预算确认占用、预算发生、实际费用、结算是不同事实，不自动互相生成。
- 预算确认/发生必须满足同框架协议及有效期规则。
- 协议 90%、框架预算发生 80%、项目预算合计超框架时预警，阈值是提醒而不是擅自硬阻断。
- 月度分析、季度累计 25% / 50% / 75% / 100%、明显滞后子项目识别继续保留。
- “一年工作早知道”年度事项提醒、通知 outbox、D1→R2 备份继续保留。

认证基线也不得回退：浏览器 Web Worker Argon2id；服务端仅 HMAC verifier + pepper；7 天 HttpOnly session；禁止恢复 Cloudflare Access、邮箱 OTP、服务端慢 KDF。

## 当前门禁

2026-09-13 最终重构完成后的等价完整门禁：

- Node/workerd+D1：15 个测试文件，`119/119 PASS`
- Vue/Vitest：15 个测试文件，`60/60 PASS`
- 合计：`179 PASS`
- `npm run typecheck`：PASS
- Vite production build：PASS
- Worker `wrangler deploy --dry-run`：PASS，约 512.73 KiB / gzip 94.24 KiB
- 迁移 checksum、空库重复迁移、历史升级：PASS
- 无 `.skip/.only/todo`

单次 `npm run test:node` 会超过当前工具 300 秒执行上限；按 `docs/TESTING.md` 的分组完整跑全部测试文件即可，不能把超时误判为测试失败，也不能漏测。

## 下一步：P7

不要再改业务模型，除非真实验收发现有可复现缺陷并先补失败测试。按 `docs/P7_RUNBOOK.md` 继续：

- 使用标准模板和代表性真实业务数据抽检需求、来源行、需求物资、项目需求关系、项目物资和任务回投；
- 验证真实框架/协议/预算/发生数据；
- 验证真实 Cloudflare Workers/D1/R2 的 CPU、额度、错误率与网络；
- 验证真实通知投递、自定义域名/Cookie；
- 做正式停写备份、隔离恢复和附件对账；
- 完成 account-owned CI Token、Cloudflare/GitHub 权限、旧维护人撤权和运维移交演练。

缺少真实资源或业务资料时明确记录阻塞项，不得用本地合成测试冒充 P7 正式验收。