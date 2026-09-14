# 下一位 AI

继续 `/Users/zhangyuxi/Desktop/项目管理`，分支 `refactor/backend-runtime-portability-20260913`。

先读 `AGENTS.md`、`docs/AI_HANDOFF.md`、`docs/BUSINESS_BASELINE.md`，然后执行：

```sh
git status --short --branch
git log --oneline -8
```

当前有已验证但未提交的附件内容迁移：`p5.ts`、`tests/repository-guards.test.mjs`、`apps/api/src/application/attachment-content.ts`。先复核专项测试，单独 commit + push；不要覆盖、reset、clean。

随后按小 commit 继续后端可移植性重构：先 `AttachmentRepository`，再逐块迁移业务数据访问；保持 Cloudflare Free 为当前基线，同时保留 Node + SQLite + Filesystem 第二运行时。禁止把业务核心重新绑定 D1/R2/Queue。

未经明确授权不要部署、升级远端 D1 或合并 `main`。
