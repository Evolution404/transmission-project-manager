# 下一位 AI：简短交接

项目：`/Users/zhangyuxi/Desktop/项目管理`
仓库：`Evolution404/transmission-project-manager`
分支：`main`，开始时以 `origin/main` 最新 HEAD 为准。

P0、P1、P1.1、P1.2、P2 已完成。认证已经定稿为系统自维护 `username + password`：浏览器 Web Worker 做 Argon2id，服务端只保存 HMAC verifier 和 7 天 HttpOnly 会话；禁止恢复 Cloudflare Access、邮箱登录或服务端慢 KDF。

P2 已完成 Excel/CSV 浏览器解析、映射模板、分片上传/校验/发布、需求池、来源追溯和物资字典。chunk/validate/publish 必须携带 `expectedVersion`，版本守卫、业务写入和幂等记录在同一个 D1 batch；不要弱化这些并发/原子性约束。`/demands` 已懒加载真实 `DemandsView`。P2 恢复用 stash 仍保留在本机作备份，但后续开发不依赖它。

当前进入 P3：储备归并、数量分配、估算及分类。先运行 `git status --short --branch`，再阅读 `AGENTS.md`、`docs/AI_HANDOFF.md`、`docs/IMPLEMENTATION_PLAN.md`、`docs/DATA_MODEL.md`、`docs/TESTING.md`。严格测试先行：先写数量守恒、并发超分配、相同型号不同单位、缺价与零价区分、分类金额守恒等失败测试，再实现 P3。

P2 收尾时完整 `npm run check` 全绿：43/43 Node/workerd+D1 + 26/26 Vue/Vitest，共 69 项 PASS；TypeScript、Vite 生产构建和 Worker dry-run 均通过。P3 完成前同样必须跑完整门禁、更新文档、提交并推送 GitHub。
