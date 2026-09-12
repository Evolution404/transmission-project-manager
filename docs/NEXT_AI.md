# 下一位 AI：重构需求 / 项目 / 物资模型

项目：`Evolution404/transmission-project-manager`

本地路径：`/Users/zhangyuxi/Desktop/项目管理`

分支：`main`

## 第一优先级

先完整阅读：

1. `AGENTS.md`
2. `docs/HANDOFF-PROJECT-MODEL-REFACTOR-2026-09-12.md` —— **本轮最高优先级业务基线**
3. `docs/DESIGN.md`
4. `docs/DATA_MODEL.md`
5. `docs/IMPLEMENTATION_PLAN.md`
6. `docs/TESTING.md`
7. P2/P3/P5 相关源码和测试

开始后先执行：

```sh
cd /Users/zhangyuxi/Desktop/项目管理
git status --short --branch
git diff
```

**不要要求工作区必须 clean。** 当前本地有一批未提交探索性 WIP，是用户连续纠正业务模型过程中形成的；不要 `reset` / `clean` / 覆盖。先阅读 diff，从中提取已经有价值的测试和 `manual/import` 来源实现，但不要把这些 WIP 当作最终方案。

远端最后稳定提交：

```text
f4f666c fix: handle non-json API failures
```

## 用户最新明确业务规则

旧模型“需求物资先完整确定 → 按数量分配到项目”不再成立。

新的主线：

```text
业务需求
→ 项目储备
→ 项目物资需求（可为空、可后补、持续修订）
→ 物资供应/履约（已上报 / 已发货 / 已到货……）
→ 项目出库
→ 实施 / 实际物资使用
→ 结算
```

必须遵守：

- 需求是业务/隐患台账，可以包含当时已知的物资型号和数量，但这些信息允许为空或不完整，也不能作为最终项目物资硬上限；
- 项目储备允许没有任何物资；
- 最终项目物资可以比最初需求增加、减少、换型，必须保留修订历史；
- 需求和项目用独立多对多关系表达，不要再靠物资数量分配承担立项关系；
- 项目物资需求应成为后续供应、出库、实施数量保护的主对象；
- 标准 `materials` 字典不保存项目状态；
- “已上报 / 已发货 / 已到货”属于项目物资需求/供应批次；
- 状态必须按数量追踪，不能只放一个单值 `status`。例如项目需要 100，可以同时是：上报100、发货60、到货20；
- 至少保证 `到货 <= 发货 <= 上报`；需求减少到已发生供应事实以下必须走显式调整/取消，不得抹历史；
- 供应状态、项目出库、实施、实际使用、结算是不同事实，不能自动互相生成；
- 所有支持批量导入的数据必须同时支持手工新建。

## 建议目标对象

优先重构出：

```text
demands                       业务需求
project_demand_links          需求 ↔ 项目关系
project_material_requirements 项目当前物资需求
project material revisions    项目物资修订/版本
material_supply_batches
  或 material_supply_events   上报/发货/到货等供应事实
```

旧 `demand_materials` 可以保留为“需求阶段物资估算”，但不能再成为项目物资硬上限。

旧 `demand_allocations` 不要继续打补丁；需要拆掉它同时承担的两种职责：

1. 项目为什么产生；
2. 项目真正需要什么物资。

## 测试先行

先写/调整失败测试，再改生产代码。至少覆盖：

- 手工需求创建，来源是真实 `manual`；
- 导入需求仍保留文件/工作表/物理行来源；
- 0 条物资也可以建立储备项目；
- 项目可独立关联需求；
- 项目物资后补、增加、减少、换型并保留历史；
- 100 项目需求能同时投影为上报100、发货60、到货20；
- 到货不得超过发货，发货不得超过上报；
- 幂等重试不重复累计供应数量；
- 并发状态推进不超量；
- 已发生供应/出库/实施/有效结算后不能直接删除历史事实；
- 所有批量导入入口都有手工创建入口。

## UI 目标

`项目需求`：

```text
[新建需求] [批量导入] [下载模板]
```

`项目储备`：

```text
[新建储备项目]
关联需求
项目物资需求
  [新增物资] [从需求估算复制]
物资供应进度
  已上报 / 已发货 / 已到货（显示数量）
物资变更记录
```

不要再把 `/reserves` 菜单叫“储备出库”；“项目储备”和“项目出库”要分开。

## 不能破坏的既有基线

认证永久锁定：系统 username/password；浏览器 Web Worker Argon2id；服务端 HMAC verifier + pepper；7天 HttpOnly 会话。禁止恢复 Cloudflare Access、邮箱 OTP、服务端慢 KDF。

P4/P5/P6 仍保持：

- 预算 / 预算发生 / 实际费用 / 结算 / 协议额度分别保存；
- 金额整数分、数量定点；
- 实施与结算独立；
- 历史事实不可静默覆盖；
- 服务端版本、幂等、并发、权限、审计；
- 本地/合成测试不得冒充正式 P7 验收。

## 当前 WIP 验证情况

现有探索性 WIP 已做过：P2/P3 定向后端测试、DemandsView/ReservesView 定向测试、TypeScript、Vite build、Worker dry-run，前端完整 61/61 Vue/Vitest PASS。

但这是**旧模型向新模型过渡中的临时 WIP**，尚未完成最终模型的全量 Node/workerd+D1 回归。不要把当前状态标为完成。

## 完成要求

重构完成后必须跑完整等价门禁：TypeScript、Vite build、Worker dry-run、全部 Vue/Vitest、全部 Node/workerd+D1、迁移锁/升级/重复迁移测试；禁止 `.skip/.only/todo`。

最后更新 `DESIGN.md`、`DATA_MODEL.md`、`IMPLEMENTATION_PLAN.md`、`AI_HANDOFF.md`，提交并 push。P7 正式环境验收在本次业务模型重构稳定后再继续。
