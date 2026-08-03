# 验证

LikeGo 只区分两类测试：

- `bun run test:unit` 运行不依赖外部服务的确定性单元测试。
- `bun run test:e2e` 构建包，并在本地验证真实 provider、跨运行时、可执行 example 和发布 tarball consumer；
  Docker suite 会启动真实服务并清理自己创建的资源。

`test:unit:coverage` 只是可选的覆盖率报告。CI 只执行安装、格式检查、类型检查、构建和单元测试，不运行 Docker、
跨运行时、example 或 soak E2E。

```sh
bun install --frozen-lockfile
bun run fmt:check
bun run typecheck
bun run build
bun run test:unit

# 在具备所需 runtime 与 Docker 的本地环境执行
bun run test:e2e
bun run test:e2e:runtimes
bun run test:e2e:soak
```

`fmt`、`typecheck`、`build`、`audit` 和 `doc:build` 是工程命令，不是额外测试类型。命令或脚本存在不代表已经
执行通过；应以当次执行的退出状态和日志为准。
