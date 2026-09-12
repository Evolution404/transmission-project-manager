# 下一位 AI：简短交接

项目：`/Users/zhangyuxi/Desktop/项目管理`
仓库：`Evolution404/transmission-project-manager`
分支：`main`，开始时以 `origin/main` 最新 HEAD 为准。

P0、P1、P1.1、P1.2、P2、P3、P4 已完成。认证已经定稿为系统自维护 `username + password`：浏览器 Web Worker 做 Argon2id，服务端只保存 HMAC verifier 和 7 天 HttpOnly 会话；禁止恢复 Cloudflare Access、邮箱登录或服务端慢 KDF。

P2 的 Excel/CSV 导入、需求池、来源追溯和物资字典继续作为稳定基线。P3 的储备数量守恒、定点估算、分类金额守恒、不可变储备版本和候选游标分页同样不得弱化。P2 恢复用 stash 已按用户要求删除，后续不依赖任何 stash。

P4 已完成：框架/协议版本、项目框架归属、预算草稿和确认版本、多协议分配、独立 `budget_occurrence` / `actual_cost` 流水、负数冲销、资金汇总以及 90%/80%/超框架警示。确认预算绝不能自动生成预算发生；汇总只计当前确认预算版本。90%/80% 判定使用整数交叉相乘，不能用显示四舍五入结果判定。`/finance` 已懒加载真实 `FinanceView`。

当前进入 P5：出库、实施、结算与四状态反馈。先运行 `git status --short --branch`，再阅读 `AGENTS.md`、`docs/AI_HANDOFF.md`、`docs/IMPLEMENTATION_PLAN.md`、`docs/DESIGN.md`、`docs/DATA_MODEL.md`、`docs/TESTING.md`。严格测试先行，优先建立：分批出库范围守恒、已有出库快照不可被储备修改覆盖、实施部分完成不等于全部完成、先结算后实施可表达、撤销结算后重算、历史实施可无出库且后续关联不重复计数、四种实施/结算状态均可表达、跨项目附件/范围拒绝。

P4 收尾时完整 `npm run check` 全绿：70/70 Node/workerd+D1 + 38/38 Vue/Vitest，共 108 项 PASS；TypeScript、Vite 生产构建和 Worker dry-run 均通过。资金流水最多每页 100 条并使用不透明游标继续读取，框架资金汇总已消除按协议 N+1。P5 完成前同样必须跑完整门禁、更新文档、提交并推送 GitHub。
