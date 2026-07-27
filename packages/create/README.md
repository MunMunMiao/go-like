# @likego/create

用于创建最小 LikeGo 内部 unary 微服务的 Node CLI。

> [!IMPORTANT]
> `@likego/create` 及生成项目依赖的 `@likego/*` 包尚未发布到 npm；下面的 `bunx` 流程描述首发后的用法。
> 当前请在仓库根目录执行以下命令验证并运行 CLI：
>
> ```sh
> bun install --frozen-lockfile
> bun run --filter @likego/create test
> bun run --filter @likego/create typecheck
> bun packages/create/src/cli.ts --help
> ```

```sh
bunx @likego/create my-service
cd my-service
bun install
bun run start
```

CLI 只接受一个目标目录，并提供 `--help` 与 `--version`。目标目录必须不存在，目录名必须是严格的小写
kebab-case。生成过程通过原子 `mkdir` 独占目标目录，绝不覆盖已有路径。后续写入失败会原样报告主错误，并保留
可能只写入了一部分文件的目标目录供人工检查；CLI 不会递归删除该路径，避免误删并发创建的后来者内容。

生成项目按职责拆分：

```text
src/
├── contract.ts  # @likego/transport unary contract 与 JSON codec
├── service.ts   # 业务逻辑
└── main.ts      # @likego/core、@likego/server 与 @likego/transport-http/node 组装
test/
└── service.test.ts
```

它生成的是内部微服务 Transport endpoint，不是 `@likego/web` 页面。服务启动后会输出：

```text
LIKEGO_READY={"service":"my-service.greeter","endpoint":"http://127.0.0.1:8080/"}
CURL=curl ...
```

生成项目要求 Node 24.18.0 或更新版本，可直接执行：

```sh
bun run test
bun run typecheck
bun run start
```

仓库内的 scaffold 类型门禁会在 `packages/create/.artifacts` 下生成项目，并使用当前 workspace 的
`node_modules` 执行根 TypeScript 编译器；这证明模板与当前包类型相容，但不冒充独立 registry install。
发布门禁另从真实 tarball 安装 `@likego/create`，在 Node 24/26 执行 dist bin、启动服务并完成 HTTP 调用。

当前范围刻意不包含交互 prompt、模板引擎、远程模板、`git init`、Docker、CI 与 proto。
