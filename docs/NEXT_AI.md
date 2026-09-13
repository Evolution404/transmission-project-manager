# 下一位 AI

继续 `/Users/zhangyuxi/Desktop/项目管理`，先以当前 checkout 为准执行：

```sh
git status --short --branch
git log --oneline -5
```

然后阅读：

1. `AGENTS.md`
2. `docs/README.md`
3. `docs/BUSINESS_BASELINE.md`
4. `docs/AI_HANDOFF.md`
5. `docs/TESTING.md`

当前已验证的基础台账功能基线在 `wip/master-data-refactor-20260913`，提交 `484cbaf`；不要回退“电压等级 → 线路 → 杆塔 → 需求定位”对象模型，也不要修改已应用的 `0009`–`0012` migration。

如果继续功能验收：先基于用户反馈补回归测试，再修改代码，完整门禁全绿后才提交/推送；未经当次授权不要部署、升级远端 D1 或合并 `main`。

如果当前 checkout 是 `chore/docs-audit-20260913`：只做文档审核/清理，不混入业务代码。历史 WIP 和恢复记录已由 Git 历史承载，不要重新创建重复的 dated handoff。
