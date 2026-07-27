# 验证

LikeGo 不会把“单元测试绿了”说成所有东西都验证完了。可移植包需要跑严格 TypeScript、源码策略、生产源码覆盖率、构建检查和发布包 smoke；契约适用时，还会分别在 Bun、Node.js 和 Deno 的 runtime lane 里执行。

依赖外部服务的 provider 必须连接真实容器，并固定不可变镜像 digest。测试会按需创建真正的 Consul、etcd、NATS、OpenTelemetry Collector、Redis/BullMQ、ZooKeeper 和 Kubernetes/K3s 资源，验证行为后还要检查资源和容器确实清掉。Fake provider 适合稳定复现边界，但绝不能顶替真实协议门禁。

唯一完整、可阻断发布的根门禁是：

```sh
bun run verify
```

各 provider 的 Docker 命令和局部检查放在自己的 package scripts，并输出机器可读结果标记；它们适合诊断，但不能替代完整根门禁。发布状态只取最后一次完整 `bun run verify` 的终态，同时还要核对生成包内容、workspace manifest、Docker 清理状态和 `git status`。命令刚启动不叫成功，日志没报错也不等于真的覆盖了目标行为。

## 生产 soak

定时或手动触发的 soak 与 PR 门禁相互独立。它使用固定 digest 的 k6，以 [k6 默认的 HTTP keep-alive 语义](https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/#no-connection-reuse)请求标准 Fetch Web Server，同时让真实 LikeGo Client 在两个内部 HTTP endpoint 之间切换并复用连接。60 分钟门禁明确不强制制造短连接 churn，因为 [Docker Desktop 的容器到宿主机流量会经过 VM/backend](https://docs.docker.com/desktop/features/networking/)；独立 shutdown 场景仍会验证连接关闭、排空与拒绝新请求。只有持续至少 60 分钟，并继续通过 RabbitMQ publisher confirm 中断恢复与 Redis Sentinel/Cluster 故障转移，结果才有资格标记为 release candidate。

```sh
bun run soak:http
bun run soak:check
```

schema v3 JSON 会记录精确 runner argv、固定的 Bun/Node/k6 版本、Git HEAD 与运行起止两端的 clean 状态，以及请求数、失败数、dropped iteration、p50/p95/p99、Client call/dial 数、场景结果、Server/Client 终态、端口回绑和 Docker 容器、网络、卷清理。`runnerSamples` 采集 Bun 编排进程及其 portable internal Client 负载，`webHostSamples` 独立采集同时承载 Fetch Web 与两个 Node-only internal service server 的 Node 进程；harness 不会在 Bun 中执行 `@likego/transport-http/node`。两组样本均包含 RSS、heap、active handles 与文件描述符。runner 会在执行 HTTP 阈值或 provider gates 前先写入原始 `k6.log` 与 `runtime.json`，因此门禁失败仍会保留诊断证据。发布级运行的两组时间轴都必须严格覆盖声明的负载时长，任意相邻采样间隔不得超过 15 秒。停机验证会压住 8 个并发请求，证明它们全部排空，同时证明 stop 开始后拒绝新请求；SIGINT/SIGTERM 也会先通过共享进程树边界中止 owner 命令，再检查清理。

缺少来源、runner 或固定 runtime 不匹配、采样时间轴缩水或稀疏、Linux/macOS 文件描述符证据缺失、意外错误、未处理 rejection、失败 check、丢弃迭代、非法分位数、steady window 基线持续增长、停机证据无效或任何资源残留都会 fail-closed。FD 或 active handle 的保留增长一旦超过阈值，即使随后形成平台也会失败。RSS 与 heap 在前后窗口中位数增幅超过阈值且 late window 仍继续增长时失败；若保留平台超过两倍增长阈值加 recent-window 噪声余量，也会失败。这样既不会让 GC 回落或多次阶梯增长掩盖上升基线，也不会把一次有界的 allocator 高水位误报为无界增长。`--duration 10s` 等短时运行只证明 harness 可用，永远不能成为 release candidate。脏工作区产生的完整结果可以通过行为检查，但 `releaseCandidate` 必须保持 `false`；只有运行起止两端都 clean 才能标记为 `true`。

Hosted 证据还依赖仓库外部控制：已推送且受保护的 `main`、可用的 GitHub Actions、受保护的 `npm` environment、npm trusted publisher 配置和 workflow artifact 留存。本地通过不能证明这些控制已经存在，也不能代替真实生产 pilot。
