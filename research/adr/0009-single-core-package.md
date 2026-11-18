# ADR 0009：单一 core 包

> 决策记录快照：保留背景、取舍与验证边界；状态和 API 描述属于原记录，当前用法以[用户文档](../../doc/index.md)为准。

日期：2026-11-17

状态：已接受

## 背景

2026-07 的[包拓扑](../designs/package-topology.md)按能力域发布契约包，并把供应商实现放在独立
workspace。该文放弃把 router、client、日志和供应商配置收进一个总管门面。

2026-11 的维护者要求是：框架先自研生命周期、传输、配置、服务发现、日志、元数据、追踪、指标、存储、
缓存和消息；具体外部系统放在其他包。`@go-like/core` 不含第三方运行时库。OpenTelemetry 是插头。入口
清单、插头规则和刻意排除项写在[插座与插头架构（2026-11）](../designs/socket-plug-architecture/README.md)
与[决策记录](../designs/socket-plug-architecture/decisions.md)。OQ1 与 OQ3 已于 2026-11-16 按推荐默认值
批准。本次迁移实现的是这一包拓扑。

## 决策

仓库发布 20 个包、75 个公开入口。`@go-like/core` 占 41 个，与 `packages/core/package.json` 的
`exports` 逐项一致。其余 19 个包是生态插头和构建期工具 `@go-like/protoc-gen-like`。包名、入口和角色见
设计第 3.3 节与第 3.4 节，对应
[D41](../designs/socket-plug-architecture/decisions.md) 与
[D42](../designs/socket-plug-architecture/decisions.md)。

core 只包含四类代码：

1. 插座：概念或扩展点的接口、类型与契约。
2. 机制：只基于插座运行的逻辑。
3. 不需要外部系统的参考实现。路径是 `/<concept>/memory`，或按 D41 折入概念入口的纯函数与默认实现。
4. core 自身机制需要的运行时绑定，只放在 `.../node` 与 `.../bun`。

`packages/core/src` 的导入只有相对路径，以及 Node 绑定源文件中的 `node:`。根入口导出 App API。内存实现
从 `/<concept>/memory` 等显式子路径导入。供应商客户端从插头包导入。

其余代码是插头。每个外部生态一个包；填充的每个插座一个子路径，名称与 core 的概念子路径一致。consul、
etcd、vault、kubernetes 的根入口只放该插头唯一的共享协议客户端与错误族
（[D26](../designs/socket-plug-architecture/decisions.md)）。本仓库的一方插头以精确版本 `0.0.1` 对等依赖
`@go-like/core`，开发依赖为 `workspace:*`
（[D44](../designs/socket-plug-architecture/decisions.md)）。`protoc-gen-like` 不依赖 core。第三方依赖按
模块身份是否必须一致，分为 peer、可选 peer 和精确版本的常规依赖
（[D43](../designs/socket-plug-architecture/decisions.md)，OQ4 已批准）。

下列概念留在 core 之外（[D52](../designs/socket-plug-architecture/decisions.md)）：鉴权；错误 `reason` 与
gRPC 状态映射（OQ11 仍待确认）；断路器工厂与分布式限流；自适应过载保护；隐式的默认信号处理；RPC 编解码
插座；路由器（[ADR 0001](0001-kernel-public-api.md)）。

### 未采用的方案

1. **继续按能力域拆成多个发布包，再加独立的 provider workspace。** 插座、机制、参考实现和 core 自己的
   绑定收进同一个包。能力域边界改为子路径。见设计第 2.3 节与第 11.1 节第 2 条。
2. **单一 Core/Micro 总管门面。** 包拓扑已经放弃它。本决定保持该结果：根入口是 App API，默认实现位于
   显式子路径。见包拓扑决策表与设计第 11.1 节第 2 条。
3. **把六个 `/memory` 参考实现折进各自的概念入口。** 跨领域评审提出过。参考实现保持
   `/<concept>/<impl>`。折进概念入口会让只导入该入口的插头，在不打包的运行时里加载内存实现。见 D41 与
   设计第 3.4 节。
4. **把生态适配器放进 core。** 第三方库会随之进入 core。插头留在 core 之外，每个生态一个 npm 包。见设计
   第 2.4 节。
5. **把 HTTP 传输做成插头。** 它的客户端是标准 Fetch，监听器是运行时绑定，线协议由 core 的 server 与
   client 定义。`newServer` 要求传入 `transport(...)`，`newClient` 要求传入 `withTransport(...)`。见设计
   第 2.3 节。
6. **把已解散的 `@go-like/fetch` 恢复成包含 Web 处理器或 RPC 的包。** `@go-like/core/fetch` 只表示后端
   插头注入的 `Fetch` 插座，以及调用它的客户端机制。见设计第 11.1 节第 50 条。
7. **插头的其他 npm 名称与绑定路径。** 候选名称 `@go-like/grpc`、`@go-like/fs`、`@go-like/js-yaml` 和绑定
   路径 `./native` 没有采用。采用的名称是 `@go-like/connectrpc` 与 `./node`、`@go-like/file`、
   `@go-like/yaml`。见 D42 与 OQ3。

OQ5 至 OQ14 在设计第 12 章仍待确认。其中与本包拓扑直接相关的是 OQ5：第三方插头对 core 的版本范围。本仓库
的一方插头按 D44 使用精确对等依赖。

## 后果

- 调用方从 `@go-like/core` 和 `@go-like/core/<concept>` 使用原先分散在多个契约包中的 API。插头从各自的
  生态包导入。
- ADR 0001 至 0008 保留当时的措辞。设计第 11.1 节点名的变更写在对应记录的修订说明中，并指向本 ADR 与相关
  决定编号。
- `packages/core/package.json` 的 `dependencies` 列出 `@types/node`。`distPackageManifest` 会把该字段写入
  发布清单。[D46](../designs/socket-plug-architecture/decisions.md) 要求这个类型包只放在
  `devDependencies`，并且 core 的使用者可见字段不声明它。源码导入与这一清单字段不一致：实现没有第三方
  运行时模块。
