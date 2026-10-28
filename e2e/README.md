# 端到端测试

本目录包含仓库级真实进程、跨 runtime、examples aggregate、发布包 consumer 和外部服务 E2E；包级场景仍位于对应 workspace 的 `test/e2e/`。其余确定性测试由 `bun run test:unit` 执行。go-like 只有 unit 与 E2E 两类测试；scope、目录和命令入口只表示执行范围，不代表质量等级。

## 公共入口

```sh
# 完整有限时长本地 E2E：root workspace package build 只执行一次
bun run test:e2e

# 分别运行 root/package suites、provider、registered runtime、examples 或 published
bun run test:e2e:suites
bun run test:e2e:providers
bun run test:e2e:runtimes
bun run test:e2e:examples
bun run test:e2e:published

# 长时间稳定性检查，独立于有限时长完整入口
bun run test:e2e:soak
```

上述公共 lane 先执行一次 `bun run build`，再调用内部 TypeScript CLI。独立的 `test:e2e:grpc-soak` 则先运行 `proto:generate`，不走完整 package build。`e2e/run.ts` 本身不会隐式构建；直接调用它时，调用者必须先准备好 package dist。

## 内部 CLI

```sh
bun e2e/run.ts --scope all
bun e2e/run.ts --scope suites
bun e2e/run.ts --scope providers
bun e2e/run.ts --scope runtimes
bun e2e/run.ts --scope examples
bun e2e/run.ts --scope published
bun e2e/run.ts --suite runner-process --suite transport-http-node
bun e2e/run.ts --help
```

`--scope` 与 `--suite` 互斥；无参数、未知参数、缺失或重复 scope 都会失败。显式 suite 按用户首次出现顺序去重。`providers` 是显式 provider tag，不从 Docker requirement 推导；`all` 按 `suites → runtimes → examples → published` 执行，provider 已包含在 suites 中，不会重复。

Examples lane 每次从当前 immediate `examples/*/package.json` 动态生成 execution input，要求每个 package 提供非空 `test:e2e` wrapper，并按稳定顺序逐个运行；不再使用会静默跳过脚本的 workspace aggregate。Root 为每个 input 预分配 child owner，worker 在 durable participant registration 获得 authenticated ACK 后才启动 scenario。完成时对 execution inputs、participants、results 与 completed commands 做集合差，缺失、重复或意外 artifact 都会失败。

直接运行 example workspace 的 `test:e2e` 时，wrapper 会创建 invocation-local root、capability 与 ACK，不会绕过同一注册和 cleanup 协议。直接入口不会构建 package dist；先从仓库根目录执行 `bun run build`，并准备该场景要求的精确 runtime 与 Docker。cwd、script、runtime、registration、scenario 或 cleanup 任一失败都会使命令非零；primary 与 cleanup failures 按发生顺序聚合，已回收残留不会把失败改成通过。

Specialized scenario 的 container/network/volume create 必须通过共享 `OwnedDocker` API 注入 owner+invocation 双标签并先持久发布 resource event。Worker 正常清理 exact pair，root 只对当前 invocation 与已注册 child owners 执行 backstop；label collision 和 foreign resource 不会被 inspect、读取 logs 或删除。Docker logs 默认关闭，仅 authenticated `safe-redacted-logs` 测试权限可读取同一 context 创建的 container，并且只返回固定行数、字符上限且经过 known-secret redaction 的 tail。

Web 的 package-owned `web-node-native` 与 built-dist `web-bridge-dist` 进入默认 suites/all。`vanilla-node`、`hono-node`、`h3-node` 与 `elysia-node` 是显式可选的原生 Fetch Handler 兼容性测试，不对应 go-like 框架桥接包；其中 `h3-node` 使用私有 H3 example 固定的依赖版本，不在运行时追踪 npm `latest`。Framework vendor dependency staging 使用 invocation-scoped secure temp，不写入仓库内 `e2e/node_modules`。

## Registered runtimes 与工具观察

runtime scope 使用静态 registered plan。每个 entry 在任何 consumer 启动前验证：

- registered cwd 存在且是目录；
- `package.json` 可解析；
- `scripts.test:e2e:runtimes` 是非空字符串；
- 实际执行固定 argv `bun run test:e2e:runtimes`，不解析或执行 manifest 中的 script 文本。

当前选择计划所需的工具必须成功执行，runner 会记录实际输出；任何版本值都不决定准入。runner 只探测当前选择计划需要的工具；Docker 当前只做可用性和 server version 探测，不固定 daemon 版本。

## Published、k6 与 soak

Published lane 动态发现实际 non-private publishable packages，生成并安装真实 npm tarball。Root authoring config 只检查 committed fixture 的语法与控制流，不是 package contract；staged checks 才从安装后的 `node_modules` 验证 DTS 与 package-name resolution。Node 使用 committed TypeScript 的 NodeNext 实际 emit 后在 clean environment 执行，Bun 使用 `--no-install` 防止隐藏依赖，Deno 先 `check` 再以 `--no-prompt` 和最小权限运行。

当前已知限制：Deno 2.9.5/2.9.7 的原生 HTTP/2 慢消费者 graceful drain 在独立重现中失败，因而不能宣称完整 `test:e2e:published` 已通过。Bun 1.4.2 的真实 HTTP Fetch 流取消另有底层复现：`reader.cancel()` 或 AbortController 取消后，服务端 quiet response/socket 未在 500ms 内关闭；这与原生 gRPC HTTP/2 流测试是不同边界。失败后尚未执行的后续协议分支不算通过。证据与支持边界见 [grpc-buf README](../packages/transport/grpc-buf/README.md) 和 [能力声明](../doc/reference/claims.md)。这些是既有故障记录，不能替代当前环境的重跑结果。

gRPC 的可选本地检查由 `bun run test:e2e:grpc-soak` 执行，默认使用独立 Bun server/load 进程、30 秒、8 并发和 256 字节业务载荷，结果默认写入 `.artifacts/soak/grpc-bun.json`（Node 为 `grpc-node.json`）。使用 `bun run test:e2e:grpc-soak --runtime node` 可切换两个子进程的 runtime；`--duration 60s --concurrency 16 --payload-bytes 1024 --output .artifacts/soak/grpc.json` 可覆盖负载与结果路径。结果记录 runtime 版本、请求数、错误率、有界直方图的延迟分位数上界、RSS、HTTP/2 session 数和进程清理结果，并要求零错误、单连接复用及关闭后零活动 session。该检查使用 workspace 源码和生成代码，覆盖 loopback unary h2c，不替代 published lane、TLS、故障回归或目标部署环境的容量验证；默认不进入 CI。

k6 workload 是独立 typecheck、未 bundle 的 committed TypeScript，并由固定 digest 的 k6 `2.1.0` image 直接执行；该 image 是可复现的 soak fixture，不是支持范围。10 秒运行只证明 short lifecycle、result marker 与 cleanup path；只有真实测满至少 60 分钟的单独运行才能支持 long-duration claim。k6/soak 不属于默认有限时长 `test:e2e`。

## Runtime 与宿主机边界

go-like 的产品平台支持由所选 JavaScript runtime 对相应标准 Web API 和显式 runtime adapter 的支持决定。E2E runner 的进程启动、超时和 cleanup 是测试基础设施，不定义发布包的平台支持范围。

默认 `managed` 模式只报告本次测试运行实际观察到的退出与残留结果。内部 `--require-platform-containment` 仅用于维护 supervisor；它不产生产品兼容性声明，也不是 PR、release 或 tag 的门禁。

## 所有权与 CI 边界

场景脚本继续持有业务、协议、readiness、权限和恢复断言；root 只负责 selection、required-tool preflight、timeout/abort、Docker suite owner backstop、cleanup 和当前运行 summary。普通 Docker suite 的 backstop 按 exact `io.go-like.e2e.owner` 标签清理容器、网络和 volume；Examples 的 `OwnedDocker` 则校验 owner+invocation 标签对；观察到 owned leak 即使被代清理也仍判失败。

Committed E2E TypeScript 的 owner 为：root tests 使用 `tsconfig.test.json`，ordinary root E2E 使用 `e2e/tsconfig.json`，k6 使用 `e2e/load/tsconfig.json`，published fixture authoring 使用独立 `tsconfig.authoring.json`，package 与 example E2E 使用 owning workspace 的 `tsconfig.test.json`、必要 `tsconfig.e2e.json` 或 example `tsconfig.json`。常规检查均为 `noEmit`；published C8 的 staged NodeNext config 仍必须实际 emit。该归属由配置与贡献审查维护，不增加全仓 source scanner。

新增或修改 E2E 时，同一 PR 必须：

- 把文件纳入明确的 tsconfig owner，且不把 k6、Node、Bun、Deno 专用 globals 混入无关配置；
- 新增 runtime support 时同步更新 package `test:e2e:runtimes`、`e2e/definitions.ts`、fixture 与文档；registered plan 对已登记项 fail-closed，但不会推断未登记 support；
- 新增 example 时提供非空 `test:e2e` wrapper；specialized Docker scenario 继续使用 shared ownership/ACK API；
- 在具备 prerequisite 的真实环境运行对应 scoped 或 full E2E，并只记录实际平台与模式的 claim。

Hosted Verify 不调用完整 E2E lanes。托管 CI 先执行 frozen install，再运行 `bun run verify`，依次完成 protobuf 生成一致性与回归、格式、lint、typecheck、build、unit coverage 和覆盖率强制校验。
但 `examples/payments-ledger` 的 `test:unit:coverage` 会执行真实 PostgreSQL/NATS Docker 场景，因此该标准门禁也需要 Docker；不能称为完全无外部依赖的 unit-only 流程。
CI green 不是 full E2E green。完整 provider、runtime、examples、published 与 soak 仍须分别运行并记录结果。
