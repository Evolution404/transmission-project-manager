# 文档导航

本目录只保留当前仍有执行价值的规范、计划和运行手册。阶段性 WIP、stash 恢复记录、已完成阶段的临时交接不再长期保留；历史过程以 Git 提交记录为准。

## 接手项目先读

1. `../AGENTS.md`：工程约束、测试先行和安全边界。
2. `BUSINESS_BASELINE.md`：当前业务事实与不能回退的业务关系。
3. `DESIGN.md`：产品与界面设计。
4. `DATA_MODEL.md`：数据对象、关系、不变量和 API 约定。
5. `TESTING.md`：自动测试与完整门禁。
6. `IMPLEMENTATION_PLAN.md`：阶段状态、完成项和下一步。
7. `AI_HANDOFF.md`：唯一的当前代码交接真源，记录施工分支、未提交工作区、最近门禁和下一步。

## 运行与上线

- `DEPLOYMENT.md`：Cloudflare、本地运行、构建和部署边界。
- `OPERATIONS_HANDOVER.md`：业务管理员、技术运维、CI/CD 和资产所有者的责任分层。
- `PRODUCTION_ACCEPTANCE.md`：真实业务数据和正式环境验收矩阵。
- `PRODUCTION_RUNBOOK.md`：生产预检、发布、恢复和回退操作手册。

## 文档维护规则

- 业务事实只在 `BUSINESS_BASELINE.md`、`DESIGN.md`、`DATA_MODEL.md` 三处维护；不得再新建按日期命名的“最终业务交接”。
- 当前开发状态只写入 `IMPLEMENTATION_PLAN.md` 和 `AI_HANDOFF.md`；不再维护额外“下一位 AI”短文档，避免双份交接漂移。
- 测试结果写入 `TESTING.md` 和阶段完成记录，不复制完整测试日志。
- 一次性 WIP、恢复记录、临时排障说明在任务完成后应删除或合并到长期文档；需要追溯时使用 Git 历史。
- 文档不得把已完成 WIP 描述成待执行任务，也不得把本地/合成测试写成生产验收。
