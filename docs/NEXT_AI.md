# 下一位 AI：按最终业务基线重构项目全流程模型

项目：`Evolution404/transmission-project-manager`

本地路径：`/Users/zhangyuxi/Desktop/项目管理`

分支：`main`

## 第一优先级

先执行：

```sh
cd /Users/zhangyuxi/Desktop/项目管理
git status --short --branch
git diff
```

**不要 reset / clean / 覆盖当前本地 WIP。** 现在工作区有一批未提交探索性修改，涉及 P2/P3、前端、测试和迁移；其中已有“手工需求来源、空物资项目、导入规则”等有价值代码和回归测试，但不是最终重构方案。先阅读 diff，再决定保留、迁移或重写。

必须完整阅读：

1. `AGENTS.md`
2. `docs/HANDOFF-FINAL-BUSINESS-BASELINE-2026-09-12.md` —— **最高优先级最终业务基线**
3. `docs/TESTING.md`
4. `docs/DESIGN.md`
5. `docs/DATA_MODEL.md`
6. `docs/IMPLEMENTATION_PLAN.md`
7. P2 / P3 / P5 / P6 相关源码与测试

旧 `docs/HANDOFF-PROJECT-MODEL-REFACTOR-2026-09-12.md` 只保留纠偏过程，不得覆盖最终基线。

## 最终业务主线

```text
需求（纯抽象业务事项，可带 0..N 条物资子明细）
  ↓
项目储备（关联需求，并形成项目自己的当前物资明细）
  ↓
项目出库（项目级节点：储备项目正式进入执行阶段）
  ↓
执行任务 1..N
  ├─ 任务物资
  │   └─ 物资供应：已上报 / 已发货 / 已到货
  ├─ 实施：完成情况 / 实际物资使用
  └─ 结算：结算范围 / 金额 / 最终标记

任务层的物资供应 / 实施 / 结算三条线并行推进。
项目层汇总任务事实。
最终再把实施/结算事实反馈回原始项目需求，形成：
已实施已结算 / 已实施未结算 / 未实施已结算 / 未实施未结算。
```

## 不能理解错的关键点

- 需求本体是纯抽象业务事项，不依赖物资才能成立；需求下面可以附带 0..N 条物资子明细。
- Excel 每行即使带物资型号和数量，也不能把数据库设计成“需求 = 物资行”。导入要规范化成“需求本体 + 需求物资子明细”。
- 凡支持批量导入的业务对象，都必须同时支持手工新建。
- 项目储备是关键环节：关联需求，同时形成项目自己的物资明细。项目物资不是原始需求物资的硬上限，可后补、增减、换型，但必须保留修订历史。
- 项目出库是项目级进入执行阶段的节点/快照，不是仓库发货，也不应继续用旧 `release_lines` 作为最终主模型。
- 只有项目出库后才允许建立正式执行任务。
- 一个出库项目可以有多个任务；每个任务都有自己的物资、物资供应、实施、结算。
- 任务内物资供应、实施、结算三条线并行，没有固定先后顺序。
- 物资供应至少按数量追踪已上报/已发货/已到货，并保证 `到货 <= 发货 <= 上报`。
- 任务是执行事实颗粒度，但最终四状态必须反馈回原始项目需求，不能只停留在任务或项目层。
- 实施发生后产生结算提醒，但结算事实仍与实施独立，允许“未实施已结算”。

## 资金线继续保留

```text
框架项目 / 整体框架费用
├─ 执行协议 A
├─ 执行协议 B
└─ 多个子项目
    ├─ 子项目预算
    └─ 预算发生
```

必须保持：预算、预算发生、实际费用、结算、协议预支额度是不同事实；预算发生必须有关联执行协议；月度分析整体预算发生；季度累计目标 25% / 50% / 75% / 100%；协议额度使用达到 90%、框架费用使用达到 80%、子项目预算总和超过框架费用时预警；明显滞后时定位滞后子项目。

“一年工作早知道”文件中的关键事项按时间节点提醒；“项目储备类别”文件用于储备大类映射和当前储备物资金额占比分析。文件导入如实现，也必须保留手工维护入口。

## 建议核心对象

```text
demands
demand_materials
project_demand_links
projects
project_material_requirements
project_material_revisions
project_releases
project_tasks
task_demand_links
task_material_requirements
material_supply_events / material_supply_batches
task_implementation_*
task_settlement_*
```

表名可调整，但职责必须分开。不要继续给旧 `demand_allocations` / `release_lines` 打补丁。

## 执行要求

测试先行。先把最终基线中的业务规则改写成失败测试，再设计 schema/API/shared types，随后重构 P2/P3/P5/P6 和 UI。必须保留现有认证基线：浏览器 Web Worker Argon2id、服务端 HMAC verifier + pepper、7 天 HttpOnly session；禁止恢复 Cloudflare Access、邮箱 OTP、服务端慢 KDF。

完成后跑完整等价门禁：TypeScript、Vite production build、Worker dry-run、全部 Vue/Vitest、全部 Node/workerd+D1、迁移锁、升级测试、重复迁移；禁止 `.skip/.only/todo`。最后更新 `DESIGN.md`、`DATA_MODEL.md`、`IMPLEMENTATION_PLAN.md`、`AI_HANDOFF.md`，提交并 push。业务模型稳定后再继续 P7 正式环境验收。
