# 端到端测试

本目录包含仓库级真实进程、打包安装和外部服务 E2E；包级 E2E 位于对应 workspace 的 `test/e2e/`。
其余确定性测试由 `bun run test:unit` 执行。

## 运行

```sh
# 完整本地 E2E：先构建，再运行 suites、跨 runtime、examples 与发布包 consumer
bun run test:e2e

# 只运行 suite 集合
bun run test:e2e:suites

# 只运行需要 Docker 的 provider suites
bun run test:e2e:providers

# 通过 Bun workspace 只运行各 package 的跨 runtime E2E
bun run test:e2e:runtimes

# 运行一个或多个 suite
bun run test:e2e:suites -- --suite runner-process --suite transport-http-node

# 长时间稳定性检查
bun run test:e2e:soak
```

`run.ts` 按 `suites.ts` 的定义顺序执行测试，非零退出或超时都会失败。每个 E2E 脚本在进程内断言自身业务结果；
runner 不再解析 stdout 作为第二套判定协议。Docker suite 在运行后检查并
清理本次创建的容器、网络和 volume。`published.ts` 在临时目录安装真实 tarball，并用静态 consumer 验证
公开 runtime 与类型入口；通用 example E2E 只验证程序启动、HTTP 生命周期、停止和端口释放，业务路由由各示例的
单元测试或专用 Docker E2E 断言。

CI 不运行 E2E。托管 CI 只执行格式检查、类型检查、构建和单元测试；真实 provider、跨运行时、example 与
soak 必须在具备对应 runtime 和 Docker 的本地环境执行。
