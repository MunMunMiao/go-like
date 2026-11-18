# @go-like/protoc-gen-like

Buf 的构建期插件。它不填充插座，也不依赖 `@go-like/core`。公开入口是包根，导出插件对象 `protocGenLike`。二进制名是 `protoc-gen-like`。`engines.node` 是 `>=22`。

生成的 `*_like.ts` 从 `@go-like/core/context` 导入 `Context`，从 `@go-like/connectrpc` 导入 `ServiceRegistrar`、`callOptions` 和 `fromHandlerContext`，并从 `@connectrpc/connect` 导入 `createClient`。

## 依赖

没有 peer，也没有可选 peer。

| 种类 | 包                      | 范围     |
| ---- | ----------------------- | -------- |
| 常规 | `@bufbuild/protoplugin` | `2.17.0` |
| 常规 | `@bufbuild/protobuf`    | `2.17.0` |

## 示例

在 Buf 生成配置里把插件指到本包的 `protoc-gen-like` 二进制。运行时由应用把生成的 registrar 交给 `@go-like/connectrpc` 的 `newHandler`，或把生成的 client 接到 `@go-like/connectrpc/node` 的 `newClient`。

## 错误码

本包不定义运行时错误码。生成失败由 Buf 插件宿主报告。
