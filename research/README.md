# LikeGo 研究资料

这里保存技术调研、方案取舍、架构决策和实验结论。使用与配置说明从[用户文档](../doc/index.md)开始。

研究结论受文中的日期、源码版本、运行环境和样本范围约束。历史缺陷不代表当前版本仍有缺陷，设计稿中的 API 不代表当前公共接口；已被替代的方案仍保留其选择理由。实验报告区分实际通过、失败与证据缺口，保留公开技术来源，实验材料以经过整理的摘要呈现，不收录个人路径、会话记录和原始运行产物。

## 对照研究

- [Go 微服务工具包能力对比](comparisons/capability-comparison.md)：固定源码基线的能力矩阵与范围判断。
- [服务契约与开发者体验](comparisons/service-contracts.md)：Kratos、go-micro 的服务声明、注册、调用和中间件范式。
- [Go 框架范式与 TypeScript 适配](comparisons/developer-experience.md)：共同原则与语言、平台差异。

## 设计与取舍

- [包拓扑与协议边界](designs/package-topology.md)：能力域拆分、原生所有权及方案演变。
- [内部端到端 RPC](designs/internal-rpc-design.md)：值契约、Fetch/SSE、取消、背压及备选方案。
- [HTTP 与 gRPC](designs/http-grpc-transport.md)：共享工作流、独立协议、连接与流的终态边界。
- [生命周期、就绪与错误语义](designs/lifecycle-readiness.md)：地址发现、健康、工作接纳与结果的区别。

## 架构决策

- [0001：内核公共 API](adr/0001-kernel-public-api.md)
- [0002：构建、运行时与测试](adr/0002-build-runtime-and-coverage.md)
- [0003：常驻适配器所有权](adr/0003-resident-adapter-ownership.md)
- [0004：注册、发现与端点选择](adr/0004-service-registry-and-selection.md)
- [0005：操作级韧性](adr/0005-operation-resilience.md)
- [0006：Store 与 Provider](adr/0006-store-contract-and-providers.md)
- [0007：Broker、Event 与原生消息语义](adr/0007-broker-event-native-semantics.md)
- [0008：服务声明、分派与自动注册](adr/0008-service-declaration-and-registration.md)

## 验证方法与实验

- [Go 框架实证对齐（2026-07）](validation/framework-audit-2026-07.md)：源码、独立复现与根因判定。
- [生产故障边界](validation/production-failure-analysis.md)：取消、终态、资源释放与确认语义。
- [测试模型与证据边界](validation/test-model.md)：行为测试、真实运行和清理证据的分工。
- [工具链版本与能力验证](validation/toolchain-policy.md)：版本观察、能力检查和可复现输入的区别。
- [File Store 与外部重启对照实验（2026-08）](reports/framework-evidence-2026-08.md)：局部通过结果及未闭合的证据。
- [Dogfood 对照实验（2026-08）](reports/dogfood-2026-08/README.md)：实验发现、后续归因、体验观察及公开样本摘要。
