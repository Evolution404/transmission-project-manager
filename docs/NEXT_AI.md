# 下一位 AI：继续 P6

项目：`Evolution404/transmission-project-manager`，本地路径 `/Users/zhangyuxi/Desktop/项目管理`，分支 `main`。先 fetch 并以远端最新 HEAD 为准。

P0、P1、P1.1、P1.2、P2、P3、P4、P5 已完成。认证已经定稿为系统自维护 `username + password`：浏览器 Web Worker 做 Argon2id，服务端只保存 HMAC verifier 和 7 天 HttpOnly 会话；禁止恢复 Cloudflare Access、邮箱登录或服务端慢 KDF。

P2–P5 的核心不变量都必须保留：P2 导入的 chunk/validate/publish 继续使用 `expectedVersion` 与同一 D1 batch；P3 数量分配不能超原需求、金额只用定点整数、缺价不等于零价、分类金额必须守恒；P4 预算确认不自动生成预算发生，预算发生/实际发生独立，90%/80% 阈值用精确整数判断；P5 出库/实施/结算继续推进同一个 `projects.version`，项目需求分配不能缩小到已出库/已实施/有效结算事实以下。

P5 已完成：分批出库快照、正常实施、历史实施补录与关联、独立结算/撤销、四状态投影、默认 30 天结算待办和私有 R2 附件。`/delivery` 已懒加载真实 `DeliveryView`。只有“全部有效范围覆盖完整 + 有效最终结算”才算已结算；非最终结算即使覆盖 100% 也仍是未结算，已有覆盖完整时允许 0 元、空新增覆盖的最终确认收口。附件单文件最大 10 MiB，下载必须重新做项目范围授权。

当前进入 P6：分析、提醒与备份。先阅读 `AGENTS.md`、`docs/AI_HANDOFF.md`、`docs/IMPLEMENTATION_PLAN.md`、`docs/DESIGN.md`、`docs/DATA_MODEL.md`、`docs/TESTING.md`。严格测试先行，优先建立：月末/季度末/跨年边界；月计划与季度累计目标；按同期计划 80% 和落后百分点两种滞后规则；年度目标为 0 时显示未配置；规则改变不覆盖历史月报；事项仅有月份时不能捏造具体日期；提醒的幂等、领取租约、超时恢复、失败退避和发送结果未知；关闭浏览器仍由服务端调度；D1 导出到 R2 的备份清单及至少一次恢复演练合同。

P5 收尾时完整 `npm run check` 全绿：80/80 Node/workerd+D1 + 43/43 Vue/Vitest，共 123 项 PASS；TypeScript、Vite 生产构建和 Worker dry-run 均通过。P6 完成前同样必须跑完整门禁、更新文档、提交并推送 GitHub。真实业务文件、真实邮件投递、真实 Cloudflare 配额/网络和正式恢复演练仍留 P7，不能用本地合成结果宣称上线。
