# Go 框架实证对齐：实验与判定

研究日期：2026-07-26。下述结果属于原调查环境，未在本次文档整理中重新执行，不代表当前仍有这些缺陷。保留实验方法、通过与失败范围及判定依据。

## 1. 目标与结论

原调查针对当时审计发现的问题，对照下表固定版本的 Go、go-micro、go-kratos 和
go-zlab/go-kratos 的真实源码与运行行为，区分以下三类情况：

1. go-like 有意采用了更适合 TypeScript、Promise、标准 Web API 或结构式 Server 的设计；
2. 设计本身合理，但某条实现路径没有贯彻既有契约；
3. 与 Go 框架无直接产品语义关系的本地测试、Docker、构建或文档缺陷。

原调查识别出 9 组问题，其中高优先级 2 组、中优先级 2 组、低优先级 5 组。没有发现需要推翻
当时的 go-like 分层、Server 接口、Context 公共 API、Registry provider 范围或 examples 目录模型的证据。

核心判断如下：

- 内部 HTTP Transport 不应让 3xx 绕过 Discovery/Selector 重新选择目的端；当时 portable Fetch 默认跟随
  307 是实现缺陷。
- `@go-like/context` 让自定义 `StopFunc` 异常向外传播，与 Go 一致；Core waiter 保留已胜出的 Promise
  结果是有意增强，Client 私有旧副本才是缺陷。
- Croner one-shot/factory ownership 是合理增强；factory 内重入 `stop()` 后任务仍被恢复运行，违反 go-like
  自身 Server 契约。
- Client/Server operation middleware 的 exact、最长前缀和 `*` fallback 设计正确；只缺少与 canonical
  `service/endpoint` 一致的构造期校验。
- Consul/etcd 的 per-identity FIFO 和 replacement rollback 应保留；空 identity state 永久留在 Map 中没有
  产品价值，应安全回收。
- go-like 在 examples 数量、跨 runtime 与显式 Docker cleanup 证据上覆盖更细；这不等于整体成熟度强于
  多年运行的上游。发现的 false-green、漏跑和 owner 协议缺口需要由行为证据验证，额外的 source-inventory 不能证明这些边界。

## 2. 调研基线（2026-07-26）

| 项目              | 调查基线                                                                                                                                                                                                           | 研究用途                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Go                | [`go1.26.5`](https://go.dev/doc/devel/release)，提交 [`c19862e5f8415b4f24b189d065ed739517c548ba`](https://github.com/golang/go/commit/c19862e5f8415b4f24b189d065ed739517c548ba)                                    | `context.AfterFunc`、`net/http.Client` 与 `httptest` 实验            |
| go-micro          | 当时正式版 [`v6.8.0`](https://github.com/micro/go-micro/releases/tag/v6.8.0)，提交 [`db4401d306039be2614e0e3657c6a5c6473feb3b`](https://github.com/micro/go-micro/commit/db4401d306039be2614e0e3657c6a5c6473feb3b) | HTTP Transport、Service lifecycle、Registry 清理和 examples          |
| go-micro 默认分支 | [`9d306dcfc1a912a8a9493f31fee0bb983475258d`](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d)                                                                                    | 复核相关实现自当时正式版后没有语义变化                               |
| go-kratos         | 当时正式版 `v3.0.0`，同时为 `main` HEAD：[`668db92c2c001e9552594ba5a8aede8456af6d7e`](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e)                                         | App/Server lifecycle、HTTP Client、middleware matcher、Registry 清理 |
| go-zlab/go-kratos | 根 release `v1.0.0`、`transport/cron/v1.0.0`：[`2a47dd8baf53b79023005781d456ef8e1e4abfb1`](https://github.com/go-zlab/go-kratos/commit/2a47dd8baf53b79023005781d456ef8e1e4abfb1)                                   | Cron Server 实现与第三方 Server 适配方式                             |
| go-zlab 默认分支  | [`ecd00dd24491d09642c76542f94e392c6d639336`](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336)                                                                                 | 确认 Cron 相关文件与正式 module tag 相同                             |
| go-like           | 原调查工作区，Git 基线 `078e24c3b6ebc9228968acf3489cddc7e552b0c4` 加未提交实现                                                                                                                                     | 比较当时真实代码，不把未发布状态描述成 release                       |

Kratos 官方 examples 已迁移到独立仓库；其当前 HEAD 为
[`61daed1ec4d5a94d689bc8fab9bc960c6af73ead`](https://github.com/go-kratos/examples/commit/61daed1ec4d5a94d689bc8fab9bc960c6af73ead)，
但仍主要依赖 Kratos v2，因此仅用于观察示例组织，不作为 Kratos v3 行为依据。

## 3. 调查与实验方法

调查分别检查 Transport/Client、Context/Core/Croner 和 Registry/examples/Docker，以源码与独立复现区分有意的语言适配、实现缺陷和测试环境问题。

1. 将上述精确提交 shallow checkout 到 `/tmp`，逐段核对实现和测试，而不是只阅读 README。
2. 使用本机 Go `1.26.5`、Bun `1.3.14`、Node.js 和真实 Croner `10.0.1` 编写最小复现。
3. HTTP redirect 使用两个真实本地监听端点；Registry 行为使用真实 etcd `3.7.1` Docker。
4. 对上游运行定向 Go tests；遇到上游自身的环境或交互式测试限制时单独记录，不把失败伪装成通过。
5. 对 go-like 先运行现有测试，再运行当前测试未覆盖的独立复现，用于证明门禁盲区。

关键实验结果：

- Go 默认 HTTP Client 对 307 保留 POST body、自定义 header 和同 hostname 不同 port 的 Authorization；第二
  端点收到请求。go-micro raw `net.Conn` Transport 返回 307 error，第二端点零请求；Kratos 继承
  `http.Client` 默认行为，第二端点收到请求。
- go-like 高层 Client 经过真实 `newClient`、HTTP Transport 和双端点 307 后，第二端点收到 POST body、
  自定义 metadata、`Go-Like-Service` 与 `Go-Like-Endpoint`，并把第二端点的 200 当成成功。
- Go 自定义 `context.AfterFunc` stopper 抛出时会 panic；go-like Client 当前复现结果为 waiter 超时且出现
  `unhandled: stop boom`。
- Croner factory 内同步调用同一 Server 的 `stop()` 后，当前结果为 `start` 已 resolve，但 native Cron 仍
  `running=true`、`stopped=false`。
- go-micro Consul/etcd 定向测试通过；真实 etcd Docker 上 go-micro keepalive 与 Kratos Registry 测试通过，
  两轮实验清理后容器残留为零。
- `enterprise-platform-runtime` coverage 命令退出 0，但真实结果只有 85.42% functions、97.83% lines；
  当前 `line`/`function` 配置没有执行预期的 100% 阈值。
- 原调查前的完整 `bun run verify` 基线退出 0，耗时 925.69 秒；它覆盖 44 个 examples、81 个 E2E
  用例、28 个 suite 和 15 个 Docker suite，但仍未覆盖本计划列出的缺口。

上游验证边界：

- go-micro `transport`、`registry/consul`、`registry/etcd` 定向测试通过。
- Kratos `internal/matcher`、`middleware/selector` 与 HTTP Client 定向测试通过；完整
  `transport/http` suite 在选用本机局域网接口后由 `TestServer` 稳定得到 EOF，因此不将该 suite 写成通过，
  也不使用这个无关失败支撑本计划结论。
- go-zlab Cron 的 `TestServer` 会等待真实 OS signal；`TestTransport_Kind` 又因用 `reflect.DeepEqual`
  比较 `string` 与 Kratos `transport.Kind` 而报告 `expect cron, got cron`。只有
  `go test -run '^$' ./...` 的 compile-only 检查通过。原调查使用独立最小程序验证其 Start/Stop 行为，
  不把现有交互测试或类型断言失败当成 go-like 的质量 oracle。

## 4. 逐项判定矩阵

| 优先级 | 问题                                             | Go / 上游事实                                              | go-like 设计判定                                                  | 原调查提出的改进            |
| ------ | ------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------- |
| P1     | portable Fetch 跟随 307                          | go-micro 不跟随；Kratos 继承 Go 默认跟随                   | 内部节点已由 Selector 决定，portable 与 Node native 语义不一致    | 修复为 `redirect: "manual"` |
| P1     | Client waiter 遇 throwing `StopFunc` 悬挂        | Go custom stopper 可 panic；上游没有 Promise waiter        | Context 正确；Core 增强正确；Client 私有副本无意偏离              | 删除副本并复用 Core         |
| P3     | Croner factory 内 stop 后任务复活                | 上游不承诺 factory 自同步重入安全                          | go-like one-shot 设计正确；这是防御性实现缺口                     | 封闭 factory 自重入路径     |
| P2     | operation selector 接受永不匹配值                | Kratos matcher 宽松并 silent miss；go-micro 无同层 matcher | go-like canonical operation 与对称 Client/Server `use` 是有意设计 | 只补构造期校验              |
| P3     | Consul/etcd identity Map 不回收                  | go-micro、Kratos 注销时清理本地状态                        | FIFO/rollback 正确；永久空状态不是有意缓存                        | 引用计数后安全删除          |
| P2     | example coverage false-green、默认可运行案例漏跑 | 上游没有 go-like 同等级门禁                                | 严格门禁是有意设计；配置和筛选实现有缺口                          | 修阈值和外部服务声明        |
| P3     | 三个 provider Docker harness 忽略 owner          | 上游多依赖 job-scoped service，无同类协议                  | go-like owner 协议是有意增强，但执行不完整                        | 接入现有 owner label        |
| P3     | 完整 verify 重复 build 三次                      | Go build cache 可复用，不能直接类比 tsdown                 | 独立命令自包含正确；组合命令重复无价值                            | 只优化组合 `verify`         |
| P3     | locale 文档漏 Store Memory；`tsc-alias` 未使用   | 与 Go 产品语义无直接关系                                   | 本地文档遗漏和死依赖                                              | 补文档、删依赖              |
