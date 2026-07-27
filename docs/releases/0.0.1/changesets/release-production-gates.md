---
---

增加固定 SHA 的验证、CodeQL、手动 OIDC 发布与定时 production soak workflow；发布链会绑定审批 SHA、串行执行、
生成 provenance、补齐并推送 Changesets tags，失败时保留 gate artifact。soak 使用固定 digest 的 k6、Node Web host、
真实 LikeGo Client 与 RabbitMQ/Redis Docker 故障门禁生成可重复检查的资源和清理证据。
证据 schema v3 进一步锁定 runner、runtime、Git clean 状态，并分别记录 Bun portable Client/编排进程与承载 Web、
Node-only internal servers 的 Node host 完整资源时间轴；
持续窗口中位数增长、采样密度及 Linux/macOS 文件描述符缺失均 fail-closed；一次 allocator 高水位台阶只有在 late window
内仍继续增长时才按无界趋势拒绝。以 8 个真实并发请求验证停机排空、新请求拒绝及
信号中断后的 owner 清理；HTTP runtime 样本会在 k6 阈值和 provider gates 前单独持久化。
