# NW-020 公共契约：HTTP 路径路由、unary 信封与 mTLS 对端身份

本文钉死 `NW-020`（findings `MS-020-001` … `MS-020-006`）的公共 API 与可观察行为。标识符、头名、状态码与包名保持英文。实现必须满足下列条款；未列入的行为不得借本票扩大范围。

| 项         | 值                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| ID         | `NW-020`                                                                                                    |
| dest       | `fw-r183` / `MS-020`                                                                                        |
| 生产者 SHA | `cd15313d50e6804cfe34a7e7291cb65a861dec1c`                                                                  |
| 包         | `@go-like/server`、`@go-like/transport-http`、`@go-like/transport`                                          |
| 对照       | 同 dest 上 competitor（Node `http2`/`tls`）六槽返回 HTTP 201 及 `peerIdentity spiffe://ms020/machine/alpha` |
| 本文状态   | 契约钉死；不授权修改 `packages/`、不启动 dest、不提交 git                                                   |

---

## 1. 问题与 dest 证据

`MS-020` 黑盒冻结面是 required-mTLS HTTP/2 上的 REST：

```http
POST /v1/machine-commands
Content-Type: application/json
```

期望 HTTP **201**，成功体含 `peerIdentity` `spiffe://ms020/machine/alpha`。

六条 go-like finding 的 actual 均为：

- HTTP **200** 载体
- body `{"code":"invalid_request","message":"missing Go-Like-Service header","status":400,"metadata":{}}`
- ALPN `h2`、TLS 1.3 已协商

根因不是应用未登记 `handler("machine-gateway", "command", …)`，而是公共传输把 URL 路径当成 unary 信封，并在信封失败时仍回答 HTTP 200。`next-work.md` 将「公共 API 是否应该接受无 `Go-Like-Service` 的原生 REST」「`TransportInfo` 是否应暴露 URI SAN」「`responseMessage` 固定 200 是契约还是缺陷」列为仍未核实。本文关闭这三项：信封 200 保留为契约；无信封头的 REST 不得再落到「200 + missing header」；对端身份走请求头，不新增必选 `TransportInfo` 方法。

Finding workaround 原文（`MS-020-001.json` 等）：public `@go-like/transport-http` unary 成功硬编码 HTTP 200，`receiveRequest` 要求 POST，路由使用 `Go-Like-Service` / `Go-Like-Endpoint` 而不是 URL path，`TransportInfo` 不暴露已验证 URI SAN。go-like 车道上的原生 `http2` 监听器被对照契约禁止。

---

## 2. 必须钉死的条款

### 条款 1 — Unary 信封保持 HTTP 200

带 `Go-Like-Service` 与 `Go-Like-Endpoint` 的 unary 信封 **POST**：

- 成功响应的 HTTP 载体仍为 **200**。
- `ServiceError` 的 unary `carrierStatus` 仍为 **200**；`serviceStatus` 仍在 JSON body 与 `Go-Like-Service-Error-Status` 中。
- 不得把信封成功改成 REST 风格的 201，也不得把 unary `encodeServiceError` / `decodeServiceError` 的载体改成 `serviceStatus`。

现有证据：

- `packages/transport/http/src/socket.ts:167-186`：`responseMessage` 将成功 `Response.status` 固定为 `200`。
- `packages/transport/src/errors.ts:186-208`：`serviceErrorEnvelope` 写入 `carrierStatus: 200`。
- `packages/transport/src/errors.ts:266-276`：unary 解码要求 `carrierStatus === 200`，否则 `TypeError`（「unary ServiceError carrier status must be 200」）。
- `packages/transport/test/errors.test.ts:113-119`：断言 `serviceStatus: 403, carrierStatus: 200`。
- `packages/client/src/index.ts:1324`：客户端以 `decodeServiceError("unary", 200, …)` 识别失败。
- `packages/transport/http/src/client.ts:312-322`：信封客户端把非 200 当成 `HTTPStatusError`，不能当作 unary 成功。
- `packages/server/src/index.ts:575-579`：`failureMessage` 只走 `encodeServiceError("unary", …)`。

信封客户端与 `@go-like/client` 继续只依赖 HTTP 200。本票不得破坏该 ABI。

### 条款 2 — 缺少 `Go-Like-Service` 不得再答成「HTTP 200 + missing header ServiceError」

请求若**没有**可用的 `Go-Like-Service`（调用方未带该头，且条款 3 的 `httpRoute` 也未写入该头），**禁止**再出现 dest 上的失败形状：

- HTTP 200
- unary `ServiceError` body `code: "invalid_request"`、`message: "missing Go-Like-Service header"`、`status: 400`

现有证据：

- `packages/server/src/index.ts:511-528`：`routeHeader` 在头缺失或空时 `throw serviceError("invalid_request", \`missing ${name} header\`, 400)`。
- `packages/server/src/index.ts:598-614`：`dispatch` 在 `socket.recv` 之后立刻 `routeHeader(request.header, serviceHeader)`，catch 后 `failureMessage`，再 `socket.send`。
- `packages/server/src/index.ts:575-579` 加上 `socket.ts:167-186`：该失败被编码为 unary 信封，HTTP 载体仍是 200。
- `packages/server/test/server.test.ts:671-684`：仅有 `Go-Like-Endpoint`、缺少 `Go-Like-Service` 的 Message 期望 `invalid_request`。
- dest actual（`MS-020-001.json` `actual` 字段）正是上述链路在黑盒 REST POST 上的产物。

条款 2 是对「无信封 REST」的否决，不是要求所有 4xx 都改 HTTP 载体。信封请求（已带 `Go-Like-Service`）的缺失/非法 `Go-Like-Endpoint`、未知 `service/endpoint` 等，仍按条款 1 走 unary `ServiceError` carrier 200。

无信封且无 `httpRoute` 匹配时，实现必须使用**非**「200 + `missing Go-Like-Service header`」的失败。推荐可观察默认（不改变 unary encoder）：

| 条件                                                    | HTTP 载体          | body                                                              |
| ------------------------------------------------------- | ------------------ | ----------------------------------------------------------------- |
| pathname 未匹配任何 `httpRoute`，且无 `Go-Like-Service` | 非 200（建议 404） | 不得使用 `missing Go-Like-Service header` 的 unary `ServiceError` |
| pathname 匹配但 method 不匹配                           | 非 200（建议 405） | 同上                                                              |
| 已带信封头                                              | 条款 1             | unary `ServiceError` carrier 200                                  |

### 条款 3 — 公共 `httpRoute(method, path, service, endpoint, successStatus?)`

`@go-like/server` 必须新增公共 `ServerOption`：

```ts
httpRoute(
  method: string,
  path: string,
  service: string,
  endpoint: string,
  successStatus?: number
): ServerOption
```

语义：

1. 在 `routeHeader` **之前**，用 HTTP **method** + URL **pathname**（不含 query、不含 fragment）匹配已登记路由。
2. 命中后，把对应的 `Go-Like-Service` 与 `Go-Like-Endpoint` 写入即将交给 `routeHeader` 的 `Message.header`（大小写不敏感，与现有 `routeHeader` 一致）。
3. 然后走既有 `handler(service, endpoint, …)` 表；不得另建一套 handler ABI。
4. `service` / `endpoint` 必须是现有 `routeToken` 可见 ASCII 路由令牌（`packages/server/src/index.ts:122-133`）。
5. `method` 按 HTTP 方法比较（建议大小写不敏感的 `POST` / `GET` 等 token）。
6. `path` 与 `URL.pathname` **精确**匹配。本票不要求路径参数、前缀树或通配符。`GET /v1/receipts/rcpt-cmd-1001` 是 dest 产品路径，next-work 已标明未作为独立库断言；本票不把参数化 path 列为完成条件。
7. 同一 `method` + `path` 重复登记必须在构造期失败（与重复 `handler` 相同，见 `packages/server/src/index.ts:389-393`）。
8. `ServerOptions` 必须能快照这些路由（今日 `packages/server/src/index.ts:47-55` 与 `177-209` 没有该字段）。
9. 已携带 `Go-Like-Service` 的信封 POST **优先按信封处理**，不得被 pathname 改写到另一个 service/endpoint。这样现有 `@go-like/client` 与 README 信封示例保持不变。

MS-020 健康路径的最低登记（应用代码，不是库硬编码）：

```ts
httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
```

现有缺口：

- `packages/server/src/index.ts` 导出 `handler` / `middleware` / `use` / `listenOption`，**没有** `httpRoute`。
- `packages/transport/http/src/socket.ts:85-91`：`receiveRequest` 在 `method.toUpperCase() !== "POST"` 时抛 `HTTP transport request method must be POST`。路径路由若登记 `GET`，传输层不得在 server 看到 pathname 之前把该请求打成协议错误。
- `packages/transport/http/src/headers.ts:58-68` 与 `socket.ts:147-151`：收包只把 HTTP 头拷进 `Message.header`，**不**拷贝 method 或 pathname。实现必须在 `routeHeader` 之前能读到 method 与 pathname；**禁止**为此给 `TransportInfo` 增加必选方法（条款 5）。可将 method/pathname 作为匹配输入保留在 accept 路径上，或写入已有可选头 `Go-Like-Method` / `Go-Like-Target`（`packages/transport/src/headers.ts:9-22`，当前 HTTP receive 未填充）。不得把「新增 `TransportInfo.peerIdentity()`」当成匹配手段。

信封 unary 仍为 POST-only：未命中 `httpRoute`、仅靠信封头的请求，method 必须是 POST。

### 条款 4 — 路径路由成功用 `successStatus` 作 HTTP 载体

- **路径路由命中**且 handler 成功：HTTP 载体 = 该路由的 `successStatus`。省略时默认 **200**。`POST /v1/machine-commands` 必须能登记 **201**，以便 dest 冻结成功体从 HTTP 201 返回。
- **信封 unary 成功**：仍为 HTTP **200**（条款 1）。`successStatus` 不得作用于已带信封头的 unary POST。
- 路径路由成功体是 handler 返回的 `Message.body`（JSON 等），不是 unary `ServiceError` 信封。
- 不得通过修改 `encodeServiceError` 的 `carrierStatus: 200` 来“实现 201”。201 只出现在路径路由的**成功** HTTP 响应上。

现有证据：

- `packages/transport/http/src/socket.ts:167-186`：成功路径写死 `status: 200`，无法表达 201。
- dest expected：`POST /v1/machine-commands` → HTTP 201。
- dest brief 冻结成功体字段含 `peerIdentity`、`protocol`、`status: "accepted"` 等，由应用 handler 写入 JSON；库负责把已验证 URI SAN 放进请求头（条款 5），并把 HTTP 载体设为 201。

路径路由上的业务失败（400/403/502/504 等）**不是**本票对 unary encoder 的授权。dest brief 的 REST 错误表是产品映射；健康路径 blocker 只要求成功 201。若后续要把路径路由错误改成真实 HTTP 4xx/5xx，必须保持信封 unary `carrierStatus === 200` 不变。

### 条款 5 — `clientAuth("require")` 将 URI SAN 写入 `Go-Like-Peer-Identity`

当 Node HTTP 宿主以 `clientAuth("require")` 运行时，在请求进入 handler 之前，把**已验证**客户端证书的 URI SAN 复制到请求头：

```text
Go-Like-Peer-Identity: spiffe://ms020/machine/alpha
```

约束：

1. **不要**给 `TransportInfo` 增加必选方法。当前接口只有 `kind` / `endpoint` / `operation` / `requestHeaders` / `replyHeaders`（`packages/transport/src/types.ts:21-32`）。新增必选方法会破坏一切既有 `TransportInfo` 实现。handler 从 `Message.header`（及现有 `requestHeaders()`）读取对端身份即可。
2. 头名是 `Go-Like-Peer-Identity`。应在 `@go-like/transport/headers` 增加公共常量；今日 `packages/transport/src/headers.ts` 没有该名。
3. 仅在 `clientAuth === "require"` 且 TLS 已用 `requestCert` + `rejectUnauthorized` 验证对端证书后写入。`clientAuth("none")` 不得伪造该头。
4. dest 冻结身份是单一 URI SAN（SPIFFE）。证书含且仅含一个 URI SAN 时，头值必须等于该 URI。多个 URI SAN 时必须确定性选取；不得拼接、不得写入 DNS/email SAN。
5. 未知 CA / 缺客户端证书：继续在 TLS 握手失败，零应用分发（`packages/transport/http/src/node-host.ts:206-224` 已设置 `requestCert` / `rejectUnauthorized`）。不得为此改成 HTTP 200 信封。
6. 已验证但未授权的身份（如 `spiffe://ms020/machine/bravo`）仍必须到达应用，以便 handler 返回产品层 403；库不得在拷贝 URI SAN 时静默丢弃该请求。
7. `packages/transport/http/src/transport-info.ts:35-64` 与 `23-32` 只从 HTTP 头观察 operation，没有证书 API。UX 把「`TransportInfo` 不暴露 URI SAN」当成缺口；本票的解决是**请求头**，不是扩展 `TransportInfo`。
8. `packages/transport/http/src/node-host.ts:728-755` 的 `standardRequest` 只转发 `rawHeaders` 中非 `:` 伪头（`656-668`）。URI SAN 不在 HTTP 头里，必须在构造 `Request` / `Message` 时显式写入。今日代码没有 `getPeerCertificate` 或 SAN 提取。
9. 应用 handler 把该头放入 JSON 字段 `peerIdentity`。库不解析业务 JSON，不替 handler 写 `peerIdentity`。

`newNodeHTTPTransport(clientAuth("require"), allowHTTP1(false))` 仍是 go-like 车道的公共监听/拨号入口（`packages/transport/http/src/node.ts:70-78`、`packages/transport/http/README.md:36-51`）。

### 条款 6 — 禁止项

下列做法不得作为本票的实现、测试或 dest 回归手段：

1. **把原生 `http2.createSecureServer` 当成 go-like 车道的公共 API。**  
   `packages/transport/http/src/node-host.ts:7-15` 与 `334-347` 内部使用 `createSecureServer` 实现 `newNodeHTTPTransport` 的安全宿主，这是包私有实现，不是应用可依赖的公共面。`packages/transport/http/package.json` 只导出 `.` 与 `./node`；`newNodeHTTPHost` / `newNodeHTTPHostWithSecureFactory` 不是包导出。go-like 应用与 dest 车道必须继续经 `newNodeHTTPTransport`。对照契约禁止用原生 `http2` 监听器绕过公共 transport（`MS-020-001.json` `workaround`；`next-work.md` NW-020「仍未核实」末句）。

2. **应用 bind-first。**  
   不得先绑第二个 HTTP 服务器（原生 `http2`、第二个 `listen`、旁路 health/REST）再启动 `@go-like/server`，以掩盖路径路由或身份缺口。战役已禁止该 workaround（`docs/dogfood-2026-08/ux-summary.md`「禁止 HTTP bind-first」；`findings-catalog.md` 对 MS-011/MS-013 的同类禁令）。MS-020 的 listener 已能协商 TLS 1.3 / `h2`；缺口在 REST 映射与 peer 头，不是“先听一个端口”。

3. **修改 `examples/` 或 `e2e/`，除非某个 unit test 需要 import 它们。**  
   实现与回归放在 `packages/*/src` 与 `packages/*/test`。不得靠改仓库示例或端到端脚本冒充公共能力已存在。unit test 若必须引用 `examples/` 或 `e2e/` 中的夹具，只允许只读 import，不得把 dest 样本改成库的伪实现。

---

## 3. 可观察行为矩阵

| 入站                                                                     | 路由                                  | 成功 HTTP                          | 失败形状                                          |
| ------------------------------------------------------------------------ | ------------------------------------- | ---------------------------------- | ------------------------------------------------- |
| `POST` + `Go-Like-Service` + `Go-Like-Endpoint`                          | 信封 unary                            | 200                                | unary `ServiceError`，`carrierStatus` 200         |
| `POST /v1/machine-commands`，无信封头，已 `httpRoute(..., 201)`          | 路径路由 → 注入信封头后 `routeHeader` | **201**                            | 不得为「200 + missing Go-Like-Service header」    |
| 无信封头，无 `httpRoute` 命中                                            | 不进入「缺头即信封 400」              | 非 200                             | 禁止 `missing Go-Like-Service header` 的 200 载体 |
| `GET` 未登记 `httpRoute`                                                 | 非信封成功                            | 非 200                             | 不得把 GET 偷偷改成信封 POST                      |
| `clientAuth("require")` 且证书 URI SAN 为 `spiffe://ms020/machine/alpha` | 头 `Go-Like-Peer-Identity` 可见       | handler 可写入 JSON `peerIdentity` | 未知 CA 仍为握手失败                              |

`POST /v1/machine-commands` 的冻结成功体仍由应用提供。库验收只需：HTTP 201、请求头含已验证 URI SAN、handler 能把它放进 body。dest 字段级 JSON 相等是样本职责。

---

## 4. 建议改动面（不扩大范围）

| 包                        | 允许的变化                                                                                                                                                                                          | 明确不做                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@go-like/server`         | 导出 `httpRoute`；`ServerOptions` 快照路由表；`dispatch` 在 `routeHeader` 前按 method+pathname 注入 `Go-Like-Service` / `Go-Like-Endpoint`；无匹配且无信封头时不抛 `missing Go-Like-Service header` | 不改 `handler` 签名；不改 unary `failureMessage` 对**信封**请求的 encoder                                   |
| `@go-like/transport-http` | 路径路由成功使用 `successStatus`；信封成功保持 200；`clientAuth("require")` 写入 `Go-Like-Peer-Identity`；允许已登记路径方法进入 `recv`（信封仍 POST-only）                                         | 不把 `createSecureServer` 提升为 `./node` 导出；不新增必选 `TransportInfo` 方法；不修改 `examples/`、`e2e/` |
| `@go-like/transport`      | 可选：导出头常量 `Go-Like-Peer-Identity`                                                                                                                                                            | **禁止**修改 unary `carrierStatus: 200`；**禁止**给 `TransportInfo` 加必选成员                              |

路径路由如何把 `successStatus` 从 server 传到 HTTP `Response`（内部头、accept 元数据、或 listener 可见的路由表）是实现细节，但可观察结果必须是条款 4。

---

## 5. 验收

库侧最低验收（unit，不启动 dest）：

1. 信封 POST（`Go-Like-Service` / `Go-Like-Endpoint`）成功仍 HTTP 200；信封 `ServiceError` 仍 `carrierStatus === 200`，且 `decodeServiceError("unary", 200, …)` 仍能解码。
2. 无信封头、无 `httpRoute` 的 POST **不会**得到 HTTP 200 + `missing Go-Like-Service header`。
3. `newServer(..., handler("machine-gateway", "command", h), httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201))` 对 `POST /v1/machine-commands`（无信封头）调用 `h`，HTTP 201。
4. `clientAuth("require")` 下，已验证客户端证书的 URI SAN 出现在 handler 所见 `Message.header` 的 `Go-Like-Peer-Identity`（大小写不敏感）。
5. 公共导出不包含应用可调用的 `http2.createSecureServer` 包装为 go-like 车道 API。
6. 测试不修改 `examples/` 或 `e2e/`，除非该 unit 文件 import 它们。

dest 回归（本契约不执行）：`go-like-dogfood` `projects/MS-020/findings/MS-020-001.json` 的 `evidencePaths`（`stdout/healthy-path.log`）。通过条件对齐 finding `expected`，而不是本文目录里的综述。

---

## 6. 非目标

- 不在本票实现参数化 path（`GET /v1/receipts/:id`）、HTTP/1.1 兼容、或把 `@go-like/web` 改成 REST 框架。
- 不把 unary `ServiceError` 载体改成 4xx/5xx。
- 不要求 `TransportInfo.peerIdentity()` 或任何新的必选观察方法。
- 不授权应用 bind-first、原生 `http2` 公共监听器、或改 dest 样本来“通过”对照。
- 不处理 `NW-006` / `NW-009` 或其他 backlog 项。

---

## 7. 证据索引

| 主张                                                        | 位置                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| dest 期望 201 + `peerIdentity spiffe://ms020/machine/alpha` | `MS-020-001.json` `expected`（同文案：`MS-020-002` … `006`）                                         |
| dest actual：200 + missing `Go-Like-Service`                | `MS-020-001.json` `actual`                                                                           |
| 禁止原生 `http2` workaround                                 | `MS-020-001.json` `workaround`；`docs/dogfood-2026-08/next-work.md:13-21`                            |
| NW-020 仍未核实项（本文关闭）                               | `docs/dogfood-2026-08/next-work.md:21`                                                               |
| `receiveRequest` 仅 POST                                    | `packages/transport/http/src/socket.ts:85-91`                                                        |
| 成功 HTTP 写死 200                                          | `packages/transport/http/src/socket.ts:167-186`                                                      |
| 缺信封头 → `invalid_request` 400                            | `packages/server/src/index.ts:511-528`、`598-614`                                                    |
| unary `carrierStatus` 200                                   | `packages/transport/src/errors.ts:201`、`276`                                                        |
| `TransportInfo` 五方法、无 SAN                              | `packages/transport/src/types.ts:21-32`；`packages/transport/http/src/transport-info.ts:35-64`       |
| `clientAuth` 只做握手策略                                   | `packages/transport/http/src/node-host.ts:186-195`、`206-224`                                        |
| `standardRequest` 不拷证书                                  | `packages/transport/http/src/node-host.ts:656-668`、`728-755`                                        |
| 无 `httpRoute` / 无 `Go-Like-Peer-Identity`                 | `packages/server/src/index.ts` 导出表；`packages/transport/src/headers.ts:1-36`                      |
| 信封客户端拒绝非 200                                        | `packages/transport/http/src/client.ts:318-322`                                                      |
| 内部 `createSecureServer` 非包导出                          | `packages/transport/http/src/node-host.ts:334-347`；`packages/transport/http/package.json` `exports` |
| 公共入口隐藏 Host SPI                                       | `packages/transport/http/src/node.ts:74-78`、`151-165`                                               |
| 禁止 bind-first                                             | `docs/dogfood-2026-08/ux-summary.md:28-37`                                                           |
