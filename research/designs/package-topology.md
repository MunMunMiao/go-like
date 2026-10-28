# 包拓扑与协议边界的设计取舍

研究时间：2026-07-17 至 2026-08-30。早期方案中的框架专用转发包、`ServerHandle`、Message 路由头和“排除 Protobuf”已被后续设计替代；本文保留影响分层的理由。当前包清单见[包参考](../../doc/reference/packages.md)。

## 研究问题

微服务工具包需要共享 Context、生命周期与服务发现，同时允许调用方独立选择 Web 框架、传输协议和供应商 SDK。关键问题是公共接口应在哪一层共享，以及 npm 包是否需要按供应商或能力域聚合。

## 采用与放弃的方案

| 方案                                      | 判断             | 理由                                                                                                  |
| ----------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| 能力域契约包 + 独立 provider workspace    | 采用             | Transport、Registry、Config 等分别定义职责；实现可独立发布和按需引入依赖                              |
| 保留 `adapters/`，仅重命名 npm 包         | 放弃             | 物理目录与产品能力表达两套分类，第三方原生服务被当成次级实现                                          |
| 单一 Core/Micro 总管门面                  | 放弃             | 隐式聚合 router、client、日志和供应商配置，容易形成默认实现依赖环                                     |
| 一个 Consul 包同时提供 Config 与 Registry | 放弃             | 同一供应商不意味着相同应用契约，故障和生命周期边界也不同                                              |
| Hono/H3/Elysia 专用 Fetch 转发包          | 早期采用，后撤销 | 原生 `app.fetch` 或官方 Fetch 适配已足够，不需要第二层框架包装                                        |
| 所有 RPC 共享一套 wire Transport          | 不采用           | Struct HTTP 与 Protobuf/gRPC 的流、trailers、registrar 和连接所有权不同；共享工作流不要求共享协议接口 |

## 依赖与所有权

- Context 是显式首参，Core 接受结构式 Server；业务对象不必继承框架类。
- 外部 Web 负责标准 `Request → Response` Handler 的托管，路由与 middleware 继续归 Web 框架。
- 内部 Transport 负责服务调用的数据面，Registry 提供服务快照，Selector 负责节点选择，三者不互相猜测协议和拓扑。
- 原生库已提供的调度、队列、日志、Redis 拓扑和协议能力继续由原生库拥有；适配层只连接生命周期与必要的 Context 语义。
- portable 根入口只使用 ECMAScript 和标准 Web API。UDP、文件系统、进程信号与原生 HTTP/2 放入明确的 runtime/provider 边界。
- 发布后的独立包不能依赖 workspace 源码解析才能运行，验证必须覆盖实际 tarball consumer。

## 历史可实施性实验

2026-07-19 的原记录报告：Bun 1.3.14、Node 26.5.0、Deno 2.9.3 均完成 `CompressionStream("deflate")` 往返，跨运行时的压缩产物能够互相解压。

同次研究在 Docker 29.6.1 的独立容器和自定义 bridge 中观察到 `224.0.0.251:5353` 的 IPv4 multicast。该结果仅证明 codec 和 UDP host 路径可实施，不能代替 DNS packet、TTL、watch、崩溃过期或完整 Registry 验证。

## 设计演变

1. 早期将 `@go-like/fetch` 与各类 adapter 并列，后来按 Web、Transport 和能力域重新划分。
2. 框架转发包被直接使用原生 Fetch Handler 的方式取代，避免为每个框架维护一层无业务价值的 wrapper。
3. 初期不纳入 gRPC；后续选择 Buf/Connect runtime，在复用 Context、Metadata、Core Server 和服务发现的同时保持协议所有权独立，见 [HTTP/gRPC 设计](http-grpc-transport.md)。
4. Message 与路由请求头被 Fetch `Request`/`Response` 和 URL path 替代，理由与流式协议见[内部 RPC 设计](internal-rpc-design.md)。

## 上游依据

本设计在 2026-07-19 通过 Git 默认分支 HEAD 重新核实，所有源码链接均固定到提交，避免默认分支后续漂移。

| 项目                                                                                                    | 默认分支与提交                                        | 本设计采用的事实                                                            |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| [micro/go-micro](https://github.com/micro/go-micro/tree/db4401d306039be2614e0e3657c6a5c6473feb3b)       | `master` / `db4401d306039be2614e0e3657c6a5c6473feb3b` | 根级能力域、`transport` 公共 SPI、HTTP/memory/NATS 实现、独立 `web.Service` |
| [go-kratos/kratos](https://github.com/go-kratos/kratos/tree/668db92c2c001e9552594ba5a8aede8456af6d7e)   | `main` / `668db92c2c001e9552594ba5a8aede8456af6d7e`   | 小接口、结构式 Server、核心包与 contrib/provider 分离                       |
| [go-zlab/go-kratos](https://github.com/go-zlab/go-kratos/tree/ecd00dd24491d09642c76542f94e392c6d639336) | `main` / `ecd00dd24491d09642c76542f94e392c6d639336`   | 应用可自行组合任意 Server，Cron/Gin/Asynq 等只适配生命周期                  |

该基线的 go-micro公共 transport 契约以
[transport.go](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/transport/transport.go)、
[options.go](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/transport/options.go) 和
[headers](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/transport/headers/headers.go)
为准。默认 HTTP 实现并非普通 Fetch handler：HTTP/1 会 hijack 原始连接，HTTP/2/H2C 会把 request body
和 response writer 当双向流，并直接控制 TCP deadline、TLS、ALPN 与连接复用。相关事实见
[HTTP listener](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/transport/http_listener.go)、
[HTTP client](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/transport/http_client.go) 和
[HTTP socket](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/transport/http_socket.go)。

go-micro 的 Registry 公共面以
[registry.go](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/registry/registry.go)、
[options.go](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/registry/options.go)、
[watcher.go](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/registry/watcher.go) 和
[mDNS implementation](https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/registry/mdns_registry.go)
为准。其默认 mDNS 实现存在 TTL option 未兑现、watch 丢事件、崩溃后不产生 delete、Service metadata
未上 wire 等行为；go-like 对齐公共角色，不把这些缺陷升级成自身契约。

该基线的 go-kratos HTTP transport 同时具有
[HTTP Server](https://github.com/go-kratos/kratos/blob/668db92c2c001e9552594ba5a8aede8456af6d7e/transport/http/server.go)
与
[HTTP Client](https://github.com/go-kratos/kratos/blob/668db92c2c001e9552594ba5a8aede8456af6d7e/transport/http/client.go)，
其 Server 实现公共 transport lifecycle。go-like 因此同时保留 go-micro 的 `dial/listen/accept` 低层形状与
go-kratos 的可编排 HTTP Server 角色，不复制 Kratos router、middleware、codec 或 Protobuf 调用层。
