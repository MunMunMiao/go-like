# 三类契约缺口的研究结论

研究基线：2026-08 的 `cd15313d50e6804cfe34a7e7291cb65a861dec1c` 失败样本，及 `a6d2667` / `43abe749` 的后续对照。原始发现见 [发现分类](findings-catalog.md)，回归证据边界见[对照结论](dest-learn-report.md)。

## Recovering RabbitMQ：资源接纳与初始就绪

MS-006 的六条 finding 记录：公共 recovering constructor 等待 connector 与 initial setup，应用在取得返回值后才绑定 HTTP，导致探针不可达；同阶段对照通过。

设计保留原 constructor 的等待语义，增加显式的立即返回入口，提供 `broker`、`ready(ctx)`、`stop(ctx)`。后台 connector/setup 的生命周期由 handle 拥有，调用方的 ready 等待可以取消，不等于停止底层初始化。停止需要处理迟到创建的原生资源，不能在取消之后泄漏连接。

健康 HTTP 仍由应用决定，不让 Broker 自动启动 listener，也不把先绑旁路 HTTP 当成公共入口已经具备该能力的证据。该取舍保留了“接纳一个 resident owner”与“该 owner 现在可以处理业务”之间的区别。

## 健康探针：协议响应与业务 readiness

MS-009 的六条 finding 记录 fault-worker 默认 `GET /healthz` 为 500；引入 REST 路由后，未匹配 GET 曾变为 404，仍不满足样本接受的 200/503。

原契约选择让 HTTP Server 在没有显式覆盖时回答精确的 `GET` / `HEAD /healthz`，显式 route 优先；其它未匹配路径保持非成功。默认响应不代表依赖健康，也不能为不同工作负载自动判断业务 readiness。Health registry 和管理 HTTP 的装配仍由应用决定。

这个历史决定解决了样本的协议可达性问题；它不支持“只要 200 就可以接业务”的推论，相关区别见[生命周期信号模型](../../designs/lifecycle-readiness.md)。

## REST、内部 RPC 与 mTLS 身份

MS-020 的六条 finding 记录：已建立 required-mTLS HTTP/2，但 `POST /v1/machine-commands` 被旧的 `Go-Like-Service` / `Go-Like-Endpoint` 信封挡住，返回 HTTP 200 载体与 missing-header 错误；原 TransportInfo 还缺少 URI SAN。

原设计保留内部 unary 信封，另用显式 `httpRoute(method, path, service, endpoint, successStatus?)` 将外部路径关联到已注册操作。REST 成功状态和 ServiceError 的 HTTP 状态需要反映真实载体语义；对端身份来自经过验证的客户端证书，应用不能通过自行填写 header 冒充。

这是协议边界的历史阶段。后续内部 RPC 已改用 URL path 和 Fetch Request/Response，旧路由 header 与 `Go-Like-Peer-Identity` 方案不作为当前使用方式；对端身份应读取 TransportInfo，见[内部 RPC 设计](../../designs/internal-rpc-design.md)与[服务调用指南](../../../doc/guide/service-call.md)。

## 共同结论

三种缺口都需要公共契约的可观察行为作为证据，不能靠样本旁路原生 listener、自定义探针或修改测试接受集来宣称库已修复。后续对照只证明对应基线和阶段；协议演变和新运行时需要独立验证。
