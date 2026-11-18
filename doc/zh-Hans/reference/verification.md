# 验证

命令可以存在而从未通过。一条绿色的 lane 不能推出每个插头、runtime、示例或打包后的 tarball 都能工作。记录候选树、工具版本、确切命令、退出状态、计数和清理。

## 证据 lane

| Lane                | 它检查什么                                                                      | 外部服务         | 一次通过不能证明什么                |
| ------------------- | ------------------------------------------------------------------------------- | ---------------- | ----------------------------------- |
| Format              | 源码和文档格式                                                                  | 否               | 运行时行为                          |
| Lint                | Oxlint 规则                                                                     | 否               | 类型或运行时行为                    |
| Typecheck           | 根、包、示例和 E2E 的 TypeScript                                                | 否               | 构建产物或 provider 行为            |
| Unit                | 确定性测试                                                                      | 否               | 真实网络、Docker 或打包后的 tarball |
| Build               | 包的 ESM 和声明                                                                 | 否               | 消费者解析                          |
| Runtime E2E         | 已声明处的 Bun 和 Node fixture                                                  | 通常没有         | 每一个插头                          |
| Provider E2E        | Consul、etcd、Kubernetes、ZooKeeper、Redis、RabbitMQ、NATS 以及其他已声明的服务 | 是               | 生产可用性或托管 CI                 |
| Example E2E         | 示例进程、请求、就绪、停止和清理                                                | 有时             | 每个示例的另一份安装                |
| Published           | 被 Node 和 Bun fixture 消费的打包 tarball                                       | 除插头导入外没有 | npm 发布                            |
| Soak                | 长时间的 HTTP 或服务行为                                                        | 通常没有         | 一次短测试，或每一个插头            |
| Documentation build | VitePress                                                                       | 否               | 浏览器布局或翻译质量                |
| Audit               | 依赖漏洞报告                                                                    | 否               | 应用授权                            |

当前公共清单是 20 个包、75 个入口。见[包参考](/zh-Hans/reference/packages)。

## 已声明的命令

在仓库根目录：

```sh
bun install --frozen-lockfile
bun run verify
```

`bun run verify` 按这个顺序运行 `test:protobuf`、`fmt:check`、`lint:check`、`typecheck`、`build` 和 `test:unit:coverage`。覆盖率阶段运行每个根和 workspace 的覆盖率脚本，并以 `coverage:verify` 结束。`examples/payments-ledger` 是单元范围的例外，它的覆盖率脚本还会运行 PostgreSQL 和 NATS 场景，因此需要 Docker。

`fmt` 修复格式。`lint` 应用安全的 Oxlint 修复，格式化结果，并且只有零 warning 时才成功：

```sh
bun run fmt
bun run lint
```

单独的阶段用来缩小失败范围。通过一个阶段不能代替 `verify`：

```sh
bun run test:protobuf
bun run fmt:check
bun run lint:check
bun run typecheck
bun run build
bun run test:unit
bun run test:unit:coverage
bun run test:parallel
bun run test:stability
```

`test:unit:coverage` 检查可执行源码清单，以及按文件的行覆盖和函数覆盖。它不声称分支覆盖。`test:stability` 打乱每次根和 workspace 运行的顺序，把每个测试文件重复两次，并打印 seed。它不重试。`test:parallel` 用两个隔离的 Bun worker 把单元范围跑一次。稳定性和并行都不属于 `verify`。

文档构建和审计保持分开：

```sh
bun run doc:build
bun run audit
```

`test:protobuf` 运行 Buf lint 和生成，检查生成的 fixture 类型，并运行它的 RPC 集成测试。它不是只读的格式检查。

## E2E 范围

根脚本是：

```sh
bun run test:e2e:suites
bun run test:e2e:runtimes
bun run test:e2e:providers
bun run test:e2e:examples
bun run test:e2e:published
bun run test:e2e
bun run test:e2e:soak
bun run test:e2e:grpc-soak
```

范围脚本会先构建，例外是 `test:e2e:grpc-soak`，它生成 protobuf，然后运行 `e2e/grpc-soak.ts`。直接的 `bun e2e/run.ts --scope <name>` 不一定会构建。说明你跑的是哪一个。

Provider E2E 需要它声明的 Docker 服务和清理。Published 检查打包 tarball，并把它们安装进暂存的消费者。Soak 默认 60 分钟：

```sh
bun run test:e2e:soak
```

一次短的 HTTP 运行不是那次 soak。

本页列出根 manifest 里的脚本。它不记录它们的退出状态。逐步的 suite 布局跟 E2E runner 在一起，不在这里。

## 工具链观察

仓库不把 runtime 或工具版本声明为执行要求。一条 lane 检查每个所需工具能否执行，然后记录环境。缺少工具、超时、非零状态或失败的消费者会使这次运行失败。版本字符串不会。

依赖版本、lockfile 和固定 fixture 是可复现性的输入。

## 这条文档轨道的基线证据

所提供的契约审计在 commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675` 上报告了以下内容：

```text
bun run typecheck  -> passed
bun run test:unit  -> passed, 2,736 tests across root and 87 workspaces
bun run fmt:check  -> passed, 1,514 files
source export audit -> 66 declared entries imported without an import error
```

该审计描述的是迁移前的树。当前源码在 20 个包上导出 75 个入口。该审计没有运行 `build`、`doc:build`、`audit`、Docker provider E2E、跨 runtime 执行、已发布 tarball 检查、npm 查询、托管 CI，或 60 分钟 soak。这次文档修改不用一次新的通过结果替换那份记录。

## 一个结果允许说什么

| 结果             | 稳妥的说法                                           |
| ---------------- | ---------------------------------------------------- |
| 源码导出检查     | 「这个包在这棵树上导出了这个符号。」                 |
| 针对性类型检查   | 「这份源码在这条命令下通过了类型检查。」             |
| 针对性单元测试   | 「这些用例在这条命令下通过了。」                     |
| `bun run verify` | 「所记录的 verify 序列在这棵树和这个环境下通过了。」 |
| Provider E2E     | 「这个场景在所记录的服务和清理下通过了。」           |
| Runtime fixture  | 「这个 fixture 在这个 runtime 版本下通过了。」       |
| 已发布的消费者   | 「这个打包产物被所记录的 fixture 消费了。」          |
| 文档构建         | 「VitePress 构建了已配置的路由。」                   |
| Soak             | 「这次时长和工作负载在所记录的残余下完成了。」       |

编辑台账用[声明与证据](/reference/claims)。

## 已知边界

- Manifest 里的 `publishConfig` 不能证明 npm 发布。
- 一个 workflow 文件不能证明托管 CI 结果。
- 一个包脚本可以是已声明的 lane，而最近没有通过。
- Memory provider 不能证明跨进程或厂商协议行为。
- 一个 Web `ReadableStream` 不能证明内部全双工 RPC。
- TLS 选项不能证明应用认证。
- 停止超时不能证明每个原生资源都已经结束。
