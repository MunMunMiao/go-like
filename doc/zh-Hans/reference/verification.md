# 验证

go-like 使用多条 evidence lane，而不是把所有结果压成两类测试。`bun run test:unit` 运行不依赖外部服务的确定性单元测试；`bun run test:e2e` 构建包，并在本地验证真实 provider、跨运行时、可执行 example 和发布 tarball consumer。Docker suite 会启动真实服务并清理自己创建的资源。

还要把 Format、Lint、Typecheck、Build、Runtime E2E、Provider E2E、Example E2E、Published、Soak、Documentation build 和 Audit 分开记录。仓库的标准门禁是 `bun run verify`，它依次执行 `fmt:check`、`lint:check`、`typecheck`、`build` 和 `test:unit:coverage`；覆盖率阶段会执行一次 root 与 workspace 的 coverage 脚本，并强制校验覆盖率。`examples/payments-ledger` 是唯一超出单元测试范围的例外：它还会运行真实 PostgreSQL/NATS 集成场景，因此需要 Docker。完整 lane、baseline 与文档 run record 见[英文 Verification](/reference/verification)。

```sh
bun install --frozen-lockfile
bun run verify
bun run test:parallel
bun run test:stability

# 在具备所需 runtime 与 Docker 的本地环境执行
bun run test:e2e
bun run test:e2e:runtimes
bun run test:e2e:soak
```

`test:parallel` 使用两个隔离的 Bun worker 执行一次相同的单元测试范围，用于检查文件级并行安全。`test:stability` 会随机排列各段测试并把每个测试文件重复两次，输出可复现的 seed，而且不使用 retry。两者都是独立检查，不属于 canonical gate，也不能替代 `verify`；`test:stability` 查找顺序依赖和偶发失败，与验证 60 分钟运行行为的 `test:e2e:soak` 不同。

单独执行某个阶段只用于缩小失败范围，局部通过不能替代 `bun run verify`。`bun run fmt` 会修复格式。`bun run lint` 会应用安全的 Oxlint 修复、重新格式化，并在仍有 warning 时失败。门禁使用不修改文件的 `fmt:check` 与 `lint:check`，其中 `lint:check` 同样要求零 warning。这些命令不等同于类型检查或运行时执行。E2E 与 soak 仍是本地按需执行的独立检查。`fmt`、`lint`、`typecheck`、`build`、`audit` 和 `doc:build` 是工程命令，不是额外测试类型。`doc:build` 会检查英文和已配置 locale 的 VitePress 路由；它不等于浏览器布局或翻译质量通过。命令或脚本存在不代表已经执行通过；应以当次执行的退出状态和日志为准。详细的 evidence lane、历史 baseline 与当前文档 run record 见[英文 Verification](/reference/verification)。
