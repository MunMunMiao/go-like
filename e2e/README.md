# 有来源依据的端到端验证体系

本目录包含 LikeGo v1 以官方来源为依据的端到端证据体系。默认运行执行全部 `releaseBlocking=true` 的
发布门禁。

- `cases/*.case.ts` 每个模块只包含一个规范化用例。各模块记录官方来源、检索日期、仅链接引用边界、
  运行时与服务要求、断言、清理证据，以及实际证明该能力的 suite 场景。
- `scripts/kernel-native.ts` 使用真实定时器、`AbortSignal`、Fetch 对象和生命周期 handle，测试 Context、
  结构化 App/Server、优雅排空与健康检查行为。
- `suites.ts` 对每个唯一的原生或 Docker suite 只执行一次，验证机器可读结果，固定预期版本和镜像 digest，
  并把实际 runtime、服务、场景与清理字段的 proof 映射回每个有来源依据的用例。
- `contracts.ts` 为每个发布阻断 suite 声明逐场景、逐服务和清理契约。契约必须校验具体的
  `details.*` 域值，或由中央 runner 独立观测的 `runner.*` 事实；场景 slug、`valid=true` 和
  `*.asserted=true` 不能单独构成证据。
- `run.ts` 验证完整清单，并输出一行 `LIKEGO_SOURCED_E2E_RESULT` JSON。

发布阻断 suite 的服务声明必须与契约中的服务集合完全一致。清理结论同时要求 suite 输出结构化
`details.cleanup.*` 终态，并要求中央 runner 确认子进程树已退出；Docker suite 还必须通过运行前后资源
快照确认容器、网络和 volume 已恢复。省略服务证据、只打印预期场景名，或伪造清理布尔值都会使门禁失败。

外部协议 suite 使用固定 digest 的适配器门禁，覆盖 Redis、启用 JetStream 的 NATS、Consul、etcd、K3s、
ZooKeeper 和 OpenTelemetry Collector。任一 suite 失败、场景缺失、版本漂移、子进程超时，或新泄漏的
`likego-*` Docker 容器、网络、volume 都会使门禁失败。紧急清理只删除对应 suite 基线快照之后出现的
资源；一旦发现此类泄漏，本次运行仍判定失败。

```sh
bun run test:e2e:inventory
bun run typecheck:e2e
bun run test:e2e
```

若要执行范围受控的诊断，可为选定的 suite 标识符重复传入 `--suite`：

```sh
bun run build
bun run test:e2e:prepared -- --suite kernel-native --suite web-node-native
```

Croner 是第一版正式 Server，因此其真实 lifecycle/failure-recovery suite 参与发布阻断。Croner 没有可观察的
被动 callback terminal，manifest 仍如实声明 `terminalObservability=unobservable`；门禁只验证显式
`stop/done`、Context 取消、失败恢复与应用释放，不声称 callback drain：

```sh
bun run test:e2e:prepared -- --suite cron-native
```

所有请求的 suite 标识符都会在任一 suite 启动前完成验证。未知标识符，或同时使用 `--inventory` 与
`--suite`，都会直接失败，不会只执行所选范围的一部分。

清单验证要求至少 40 个去重用例，覆盖所有必需能力域，包含至少 12 个官方来源，并覆盖当前声明的全部
真实服务 Docker suite。用例数、suite 数和来源数均从当前模块实时生成，文档不复制易漂移的旧计数。
