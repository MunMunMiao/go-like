# 验证

go-like 使用多条 evidence lane，而不是把所有结果压成两类测试。`bun run test:unit` 运行不依赖外部服务的确定性单元测试；`bun run test:e2e` 构建包，并在本地验证真实 provider、跨运行时、可执行 example 和发布 tarball consumer。Docker suite 会启动真实服务并清理自己创建的资源。

还要把 Format、Lint、Typecheck、Build、Runtime E2E、Provider E2E、Example E2E、Published、Soak、Documentation build 和 Audit 分开记录。仓库的标准门禁是 `bun run verify`，它依次执行 `fmt:check`、`lint`、`typecheck`、`build`、`test:unit` 和 `test:unit:coverage`，并强制校验覆盖率。完整 lane、baseline 与文档 run record 见[英文 Verification](/reference/verification)。

```sh
bun install --frozen-lockfile
bun run verify

# 在具备所需 runtime 与 Docker 的本地环境执行
bun run test:e2e
bun run test:e2e:runtimes
bun run test:e2e:soak
```

单独执行某个阶段只用于缩小失败范围，局部通过不能替代 `bun run verify`。`bun run lint` 检查 Oxlint 静态规则，不等同于类型检查或运行时执行。E2E 与 soak 仍是本地按需执行的独立检查。`fmt`、`lint`、`typecheck`、`build`、`audit` 和 `doc:build` 是工程命令，不是额外测试类型。`doc:build` 会检查英文和已配置 locale 的 VitePress 路由；它不等于浏览器布局或翻译质量通过。命令或脚本存在不代表已经执行通过；应以当次执行的退出状态和日志为准。详细的 evidence lane、历史 baseline 与当前文档 run record 见[英文 Verification](/reference/verification)。
