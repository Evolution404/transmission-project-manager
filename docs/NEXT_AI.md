# 下一位 AI：简短交接

项目：`/Users/zhangyuxi/Desktop/项目管理`
仓库：`Evolution404/transmission-project-manager`
分支：`main`
当前远端 HEAD：`ea72d8c`

P0、P1、P1.1、P1.2 已完成。认证已经定稿为系统自维护 `username + password`，浏览器 Web Worker 做 Argon2id，服务端只保存 HMAC verifier 和 7 天 HttpOnly 会话；不要恢复 Cloudflare Access、邮箱登录或服务端慢 KDF。

现在继续 P2（Excel 导入、需求池、物资字典）。P2 WIP 已从 `stash@{0}` apply 到工作区，stash 本身仍保留作备份；三处合并冲突已解决并标记 resolved。当前 `npm run typecheck` 只剩 `apps/web/tests/DemandsView.test.ts` 两个旧认证测试夹具错误：`authSource: 'development'` 应改为 `'session'`，并删除 `CurrentUser.email`。

先运行 `git status --short --branch`，再阅读 `AGENTS.md`、`docs/P2_RECOVERY_STATUS.md`、`docs/IMPLEMENTATION_PLAN.md`、`docs/TESTING.md`。修完上述测试夹具后继续按测试先行完成 P2，最终必须 `npm run check` 全绿，再更新文档、提交并推送 GitHub。
