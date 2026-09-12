# 下一位 AI：简短交接

项目：`/Users/zhangyuxi/Desktop/项目管理`
仓库：`Evolution404/transmission-project-manager`
分支：`main`，开始时以 `origin/main` 最新 HEAD 为准。

P0、P1、P1.1、P1.2、P2、P3 已完成。认证已经定稿为系统自维护 `username + password`：浏览器 Web Worker 做 Argon2id，服务端只保存 HMAC verifier 和 7 天 HttpOnly 会话；禁止恢复 Cloudflare Access、邮箱登录或服务端慢 KDF。

P2 的 Excel/CSV 导入、需求池、来源追溯和物资字典继续作为稳定基线。P3 已完成储备候选/归并建议、需求物资数量拆分与守恒、项目估算、缺价/零价区分、储备大类与类别映射、分类金额守恒、不可变储备版本和真实 `/reserves` 四步工作流。候选池最多每页 100 条并支持不透明游标继续读取，归并建议聚合完整剩余池。数量使用万分之一缩放，金额使用整数分，物资金额使用 BigInt 定点乘算；禁止改回浮点累计。P2 恢复用 stash 仍保留在本机作备份，但后续开发不依赖它。

当前进入 P4：框架、协议、预算与费用流水。先运行 `git status --short --branch`，再阅读 `AGENTS.md`、`docs/AI_HANDOFF.md`、`docs/IMPLEMENTATION_PLAN.md`、`docs/DESIGN.md`、`docs/DATA_MODEL.md`、`docs/TESTING.md`。严格测试先行，优先建立：框架/协议同源归属、子项目预算与预算发生严格分离、预算确认分配金额守恒、同一协议多项目/同一项目多协议不重复、无有效协议不能确认发生、90%/80%边界、超框架仅预警、0 分母显示未配置、并发/幂等/冲销原子性。

P3 收尾时完整 `npm run check` 全绿：58/58 Node/workerd+D1 + 32/32 Vue/Vitest，共 90 项 PASS；TypeScript、Vite 生产构建和 Worker dry-run 均通过。P4 完成前同样必须跑完整门禁、更新文档、提交并推送 GitHub。
