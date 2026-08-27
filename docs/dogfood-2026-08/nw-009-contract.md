# NW-009 公共契约：`newServer` + `transport-http` 的缺省 `GET /healthz`

本文钉死 `NW-009`（findings `MS-009-001` … `MS-009-006`）的公共 API 与可观察行为。标识符、头名、状态码、路径与包名保持英文。实现必须满足下列条款；未列入的行为不得借本票扩大范围。

| 项         | 值                                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| ID         | `NW-009`                                                                                                                                             |
| dest       | `fw-r230` / `MS-009`                                                                                                                                 |
| 生产者 SHA | `cd15313d50e6804cfe34a7e7291cb65a861dec1c`                                                                                                           |
| 包         | `@go-like/server`（配合已落地的 `@go-like/transport-http` GET 无信封接纳）                                                                           |
| 对照       | 同 dest 上 competitor 原生 HTTP `GET\|HEAD /healthz` 写 `HTTP 200` 空 body；六槽 healthy-path / invariants / fault-matrix / cleanup 均通过           |
| 本文状态   | 契约钉死；不授权启动 dest、不 compose、不提交 git。后续实现只改完成本票所必需的 `@go-like/server`（及已有 HTTP 载体路径）；不得借本票实现其他 `NW-*` |

`docs/dogfood-2026-08/next-work.md:41` 将三项列为仍未核实。本文关闭它们：

1. dest 冻结 SHA 上 `GET /healthz` 的 HTTP **500** 来自 unary HTTP **协议 POST-only**，不是缺省 unary handler、不是 `@go-like/health` `ProbeRegistry` 空 ready fail-closed，也不是 dest 应用忘了挂 health 实现。
2. 在公共 `newServer` 上再登记 `@go-like/web` `createHealthHandler` **不是**本票完成条件，也 **不能** 当作库已具备 dest `/healthz` 能力。Web health 默认路径是 `/livez` 与 `/readyz`；空 ready 会 fail-closed **503**。dest 样本探测的是 `/healthz`，对照写的是 **200** 空 body。
3. 与 `MS-006` 同类的 recovering 阻塞 **不存在于本 dest**。finding `actual` 是已听端口上的 HTTP **500**（60s 内反复读到 500），不是 `socket hang up`。recovering broker 是 `NW-006`，禁止并入本票。

不能把「应用自己写 `/healthz`」当成 `@go-like/server` 已具备该能力。dest `ingest-gateway` 的自定义 200 与 competitor 原生 200 只证明对照与旁路可行，不证明 unary `newServer` 缺省面已经合格。

---

## 1. 问题与 dest 证据

`MS-009` 黑盒冻结面是 bootstrap：`APP_ROLES` 先起 `fault-worker`，harness 在 60s 内要求 `GET /healthz` 得到 **200 或 503**。探测端口：

| 车道             | `fault-worker` `/healthz`                                |
| ---------------- | -------------------------------------------------------- |
| `local-go-like`  | `http://127.0.0.1:40901/healthz`（`MS-009-001` … `003`） |
| `docker-go-like` | `http://127.0.0.1:40911/healthz`（`MS-009-004` … `006`） |

六条 finding 的 `actual` 均为：

```text
timed out waiting for http://127.0.0.1:40901/healthz: 500
```

（docker 槽把 `40901` 换成 `40911`。）这不是未 `listen`：进程已回答 HTTP，状态是 **500**，`waitForHttp` 把 5xx 中非 `accept` 的值重试到超时。

dest 角色顺序（`scripts/lane-runtime.mjs:25`）：

```js
;["fault-worker", "signal-correlator", "ingest-gateway"]
```

因此 40901/40911 是 `fault-worker`，不是 `ingest-gateway`。UX `first-service-startup` surprise：`fault-worker published /healthz returns 500 from @go-like/server while ingest-gateway custom /healthz is 200`（`projects/MS-009/ux/golike.json:16-28`）。`first-inter-service-call` 从未 POST `/v1/failure-correlations`，因为 bootstrap 停在 worker `/healthz` 500。

dest go-like `fault-worker` 经 `newServer` + `newNodeHTTPTransport` 发布 unary HTTP，**没有** 自定义 `GET /healthz`（`implementations/go-like/src/worker.ts:26-48`）。`signal-correlator` 同样是无 health 的 `newServer`（`correlator.ts:16-57`）。`ingest-gateway` 走原生 `node:http`，自己写：

```ts
if (pathname === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
  response.writeHead(200).end()
}
```

（`gateway.ts:147-149`。）对照 `fault-worker` 同一形状（`implementations/otel-native/src/fault.ts:13-16`），`signal-correlator` 对照同文（`collector.ts:12-15`）。

Finding `workaround` 原文：fault-worker is composed via `@go-like/server` and `@go-like/transport-http` with no custom `GET /healthz`；Binding HTTP before recovering setup is forbidden。

### 1.1 冻结 SHA：协议 POST-only → HTTP 500

dest vendor 冻结生产者 SHA `cd15313d50e6804cfe34a7e7291cb65a861dec1c`。该闭包里 unary HTTP `receiveRequest` **无条件**要求 method 为 POST：

```js
if (input.request.method.toUpperCase() !== "POST")
  throw newTransportProtocolError("HTTP transport request method must be POST")
```

（dest `node_modules/@go-like/transport-http/transport-CWmmDUXP.js:1052`。）`GET /healthz` 在 `socket.recv` 完成前抛协议错误。`dispatchHTTPHostRequest` 捕获后返回 `internalServerError()`：HTTP **500**、body `Internal Server Error`（工作区等价：`packages/transport/http/src/socket.ts:219-226`、`327-330`）。

冻结 SHA 的 `@go-like/server` dispatcher 在 `recv` 之后立刻 `routeHeader(..., Go-Like-Service)`（dest `node_modules/@go-like/server/index.js:416-421`、`341-349`）。GET 从未走到缺头 `ServiceError`：它在传输层已经 500。

### 1.2 NW-020 之后：无信封未匹配 GET → HTTP 404

当前工作区已落地 `NW-020` 的 GET 无信封接纳：

- `packages/transport/http/src/socket.ts:107-108`：仅当已有非空 `Go-Like-Service` 且 method 不是 POST 时才抛 `HTTP transport request method must be POST`。无信封 GET 进入 `recv`。
- 同文件 `110-111`：写入 `Go-Like-Method` 与 `Go-Like-Target`（pathname）。
- `packages/server/src/index.ts:710-735` `routeHttpRequest`：无 `Go-Like-Service`、无命中 `httpRoute` → `{ kind: "http-failure", status: 404 }`。
- `packages/server/src/index.ts:811-816`：该失败走 HTTP 载体，不是 unary `missing Go-Like-Service header`。
- 回归：`packages/transport/http/test/http-route.test.ts:217-238`（无信封 POST 未匹配 → 404）；`packages/server/test/http-route.test.ts:281-300`。

因此：**冻结 SHA 的 dest 失败形状是 500；仅合并 NW-020 后，同一 `GET /healthz` 变成 404。404 仍不是 dest 成功。**

### 1.3 dest harness 接受集：200 或 503

Finding `expected`：`GET /healthz` 返回 **200 或 503**。角色等待显式传入：

```js
accept: (status) => status === 200 || status === 503
```

（`scripts/lane-runtime.mjs:247-249`、`593-595`、`698-700`。）60s 窗口（`timeoutMs: 60_000`）。

实现细节必须写清，避免把 404 误当成已修复：

| 观察点                                              | 对 `/healthz` 状态的态度                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `waitForHttp` 循环（`lane-runtime.mjs:235`）        | `status < 500` 会直接返回，故 **4xx 也会结束等待**；5xx 只有 `accept` 为真才返回。500 不在 `{200, 503}` 中，故重试到超时 |
| 角色 `accept` 回调                                  | 只额外放行 5xx 中的 **503**；产品文案与 finding expected 点名 **200 或 503**                                             |
| Docker `HEALTHCHECK` `scripts/healthz-probe.mjs:12` | `code >= 200 && code < 300`，只要 **2xx**。404 与 503 都会让探针 exit 1                                                  |
| Compose `healthcheck.test`                          | 三角色均 `node ./scripts/healthz-probe.mjs`（如 `infra/compose.local-go-like.yaml:106-111`）                             |

本票把 dest 可观察成功钉成：**HTTP 200**（对照与 dest 样本的缺省）。503 仍在 finding expected / `waitForHttp` `accept` 里，但是 **应用显式映射 not-ready** 的权利，不是本票给 unary server 发明的缺省。禁止把空 `ProbeRegistry` ready fail-closed 503 当成 dest 缺省。

---

## 2. 必须钉死的条款

### 条款 1 — 三种 HTTP 形状不得混淆

| 世代                           | 无信封 `GET /healthz`、无匹配 `httpRoute` | dest 是否过 bootstrap                   |
| ------------------------------ | ----------------------------------------- | --------------------------------------- |
| 冻结 SHA `cd15313d` unary HTTP | 协议 POST-only → HTTP **500**             | 否（finding `actual`）                  |
| 仅 NW-020                      | 未匹配路径 → HTTP **404**                 | 否（不是 200/503；Docker 探针只要 2xx） |
| 本票完成后                     | HTTP **200**（空 body 允许）              | 是                                      |

禁止：

- 把 404「已不是 500」宣传成本票完成。
- 为了让 dest 过关把 `waitForHttp` 改成接受 404，或改 dest 探针。本票不改 dest。
- 把信封 unary 的 `carrierStatus` 改成 500/404 来“对齐 harness”。信封失败仍走条款 3。

`packages/transport/http/test/wire.test.ts:881-894` 在 **没有** `newServer` dispatcher、accept handler 不 `send` 时，无信封 GET 仍可能落到 `internalServerError()` 500。dest 走的是 `newServer` dispatcher。本票的可观察对象是 `newServer` + `transport-http`，不是「裸 `dispatchHTTPHostRequest` 且不 send」。

### 条款 2 — `newServer` + `transport-http` 缺省回答 `GET` 与 `HEAD` `/healthz` 为 HTTP 200

当应用构造：

```ts
newServer(
  address(...),
  transport(newNodeHTTPTransport()),
  handler(...) // dest 仍至少需要一个 unary handler
)
```

且入站请求同时满足：

1. 没有可用的 `Go-Like-Service` 信封（头缺失或空，与 `routeHttpRequest` 现有 `optionalRouteHeader` 一致，`packages/server/src/index.ts:716-718`）；
2. 没有命中任何已登记 `httpRoute` 的 **精确** `method + pathname`（pathname 规则与 `requestPathname` / `lookupHttpRoute` 相同，`index.ts:667-688`）；
3. HTTP method 为 `GET` 或 `HEAD`（大小写不敏感，比较时与现有 `httpMethod` 一样用大写 token）；
4. URL pathname **精确**为 `/healthz`（无前缀匹配、无 `/healthz/`、不把 `/livez` / `/readyz` / `/health` 算进来）；

则 **必须** 回答 HTTP **200**。

约束：

1. **不要求**应用登记 health handler、`httpRoute("GET", "/healthz", ...)`、`@go-like/web` `createHealthHandler`、或 `@go-like/health` `ProbeRegistry`。dest `worker.ts` / `correlator.ts` 保持今日源码即应在库修复后变为 200。
2. **空 body 允许**，且为本票 dest 对照形状。competitor 与 dest gateway 均为 `response.writeHead(200).end()`（`fault.ts:13-16`、`gateway.ts:147-149`）。不得强制 JSON `{"status":"ok"}` 或 Web health 的 `checks` 数组。
3. 缺省 `/healthz` 是 **HTTP 载体成功**，不是 unary `handler`。不得进入 `routeHeader` → unary middleware → typed handler。dest worker 的 `telemetry.unaryMiddleware` 不得成为探活的前置条件。
4. 实现位置在 `@go-like/server` 的 HTTP 路径分流（今日 `routeHttpRequest` / `dispatcher`，`index.ts:710-835`），以便条款 4 的 `httpRoute` 能覆盖缺省。禁止只在 `@go-like/transport-http` 里无条件对一切 `/healthz` 写 200，否则 server 看不到请求，精确 `httpRoute` 无法覆盖。
5. 本票 **依赖** NW-020 已接纳无信封 GET/HEAD（`socket.ts:107-111`）。不得把 `receiveRequest` 恢复成冻结 SHA 的「一切非 POST 都协议错误」。无信封 GET 必须带着 `Go-Like-Method` / `Go-Like-Target` 到达 server。
6. 仅信封、无 method/target 头的 memory 等传输：缺省 `/healthz` **不适用**，继续走信封 `routeHeader`。可观察义务绑定在 `newServer` + `transport-http`。
7. `newServer` 仍要求至少一个 unary `handler`（`index.ts:849`）。缺省 health **不**取代该约束。
8. `HEAD /healthz` 与 `GET /healthz` 在缺省路径上同为 HTTP 200；body 空即可。

### 条款 3 — 信封 unary 保持 HTTP 200；不得改 `encodeServiceError`

带 `Go-Like-Service`（及既有 `Go-Like-Endpoint` 路由）的 unary **POST**：

- 成功响应的 HTTP 载体仍为 **200**。
- `ServiceError` 的 unary `carrierStatus` 仍为 **200**；`serviceStatus` 仍在 JSON body 与 `Go-Like-Service-Error-Status` 中。
- **禁止**修改 `encodeServiceError` / `serviceErrorEnvelope` 的 `carrierStatus: 200`（`packages/transport/src/errors.ts:186-218`，尤其 `201`、`212-218`）。
- **禁止**修改 unary 解码「carrier 必须是 200」（`errors.ts:266-276`）。
- `packages/server/src/index.ts:783-786` `failureMessage` 继续只走 `encodeServiceError("unary", …)`。信封失败不得改成 HTTP 500/404 载体来“修 healthz”。

已带 `Go-Like-Service` 的请求 **优先按信封处理**（现有 `routeHttpRequest` 首支，`index.ts:716-718`），即使 pathname 是 `/healthz`。信封 GET 仍为协议 POST-only（`socket.ts:107-108`），本票不把信封 GET 合法化。

现有 NW-020 信封回归必须继续绿：`packages/server/test/http-route.test.ts:260-278`；`packages/transport/http/test/http-route.test.ts` 中信封 `ServiceError` HTTP 200。

dest `fault-worker` 的业务面仍是信封 unary `handler(executeFault, …)`（`worker.ts:30-47`）。本票不得破坏该 ABI。

### 条款 4 — 精确 `httpRoute` 覆盖缺省；其它未路由路径保持非 200

1. 若应用登记了精确 `httpRoute("GET", "/healthz", service, endpoint, successStatus?)`，则 **GET `/healthz` 走该路由**：注入信封头、调用已有 `handler(service, endpoint)`、成功 HTTP 载体为该路由的 `successStatus`（省略则 200）。这是 NW-020 已钉死的路径路由，不是第二套 health ABI。
2. 缺省 `/healthz` 只在 **没有** 该精确匹配时生效。覆盖后不再自动写空 body 200。
3. 仅登记 `GET /healthz`、未登记 `HEAD /healthz` 时，`HEAD /healthz` 走现有 `lookupHttpRoute`：pathname 命中、method 不同 → HTTP **405**（`index.ts:725`、`677-688`）。这是路径路由语义，不是 dest 缺省；dest 样本没有 `httpRoute`，GET 与 HEAD 都走条款 2。
4. **`GET /livez`、`GET /readyz`、其它未匹配 pathname** 保持非 200（今日 404 载体，`index.ts:726`、`811-816`），除非应用另有 `httpRoute`。禁止把 `@go-like/web` 的默认 `/livez` `/readyz` 抄进 `@go-like/server`。
5. 无信封且 pathname 不是 `/healthz` 的 `GET`/`HEAD`/`POST` 继续 NW-020：未匹配 404，path 匹配 method 不匹配 405。不得为了 health 把全部未匹配 GET 改成 200。
6. 缺省 `/healthz` 不是 `httpRoute` 表里的隐式行。`ServerOptions.httpRoutes` 快照（`index.ts:67`、`239-252`）不得因为缺省探针而冒出一条应用未登记的 `GET /healthz` 路由。否则应用再 `httpRoute("GET", "/healthz", …)` 会撞上「duplicated method+path」（`index.ts:248`）。

### 条款 5 — 禁止把 `@go-like/health` / `@go-like/web` 做成 server 依赖；禁止空 registry 503 缺省

`@go-like/server` 今日依赖只有 context / core / metadata / resilience / struct / transport（`packages/server/package.json:26-33`）。**禁止**增加 `@go-like/health` 或 `@go-like/web`。

原因（dest 证据，不是口味）：

| 若采用                               | 为何不是 dest 缺省                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@go-like/web` `createHealthHandler` | 默认路径 `/livez`、`/readyz`（`packages/web/src/health.ts:5-6`），dest 探测 `/healthz`                                                                                                  |
| 空 `ProbeRegistry` 当 ready          | `freezeReport`：ready 在 `checks.length === 0` 时 `ok === false`（`packages/health/src/registry.ts:223-231`）；Web handler 映成 JSON 503（`packages/web/src/health.ts:139`、`189-192`） |
| dest Docker 探针                     | 只要 2xx（`healthz-probe.mjs:12`）。空 ready 503 会 fail HEALTHCHECK                                                                                                                    |
| competitor / dest gateway            | HTTP 200、空 body，无 checks JSON                                                                                                                                                       |

dest 应用 `package.json` 虽 vendor 了 `@go-like/health` 与 `@go-like/web`，源码 **零** `createHealthHandler` / `newProbeRegistry` 引用。本票不得要求 dest 去挂它们，也不得在库侧把它们接进 `newServer`。

503 仍是 finding expected 允许值：应用若自行用 `httpRoute` 把 `/healthz` 映到探针，可以返回 503。那是应用选择。**本票缺省是 200 空 body。**

### 条款 6 — 禁止项

下列做法不得作为本票的实现、测试或 dest 回归手段：

1. **dest `start-run`。** 不得对 `MS-009.src` 执行 `scripts/run-lane.mjs` / campaign `start-run`。later-src brief 虽写 live-capable，**本票不授权**（`campaign/brief.md:8-13`、`64-68`；`next-work.md:3`）。
2. **compose。** 不得 `docker compose` 起 Postgres / etcd / otelcol / toxiproxy / 角色容器来「证明」本票。库验收是 unit + typecheck。
3. **Bind-first 第二个 HTTP listener。** 不得在 `newServer` 之外再 `listen` 原生 `node:http`、第二个 `@go-like/web` server、旁路 health 端口，以掩盖 unary listener 缺省 500/404。战役已禁止（`MS-009-001.json` `workaround`；`ux-summary.md:28-37`）。`ingest-gateway` 的原生 `/healthz` 是 dest 样本既有代码，不是本票授权的库 workaround，也不得改它。
4. **把原生 `http2` 监听器提升为公共 API。** 与 `NW-020` 条款 6 相同：`createSecureServer` 仍是 `@go-like/transport-http` 包私有实现。本票不得新增公共 `http2` 面，不得用原生 HTTP/2 旁路 `newNodeHTTPTransport`。
5. **修改 `examples/` 或 `e2e/`，除非某个 unit test 需要 import 它们。** 实现与回归放在 `packages/server/src`、`packages/server/test`；若 HTTP 圆测必须打到已监听的 Node 端口，可放在既有 `packages/transport/http/test/http-route.test.ts` 一类 unit 文件。只读 import 夹具可以，不得把 dest 样本改成库的伪实现。
6. **实现其他 NW id。** 尤其禁止并入 `NW-006`（recovering broker）、`NW-020` 未完成的 REST 201 / SPIFFE 头（路径路由与信封 200 已在工作区，本票只消费「无信封 GET 能进 dispatcher」这一既成事实，不再扩张 REST）。禁止改 dest 应用源码冒充库已有 `/healthz`。

---

## 3. 可观察行为矩阵

| 入站                                            | 路由             | HTTP                   | body / 失败形状                                    |
| ----------------------------------------------- | ---------------- | ---------------------- | -------------------------------------------------- |
| 无信封 `GET /healthz`，无 `httpRoute`           | 缺省探针（本票） | **200**                | 空 body 允许；不跑 unary handler / middleware      |
| 无信封 `HEAD /healthz`，无 `httpRoute`          | 缺省探针         | **200**                | 空 body 允许                                       |
| 无信封 `GET /livez` 或其它未匹配 path           | NW-020 未匹配    | 非 200（今日 404）     | 不得变成缺省 200                                   |
| 精确 `httpRoute("GET", "/healthz", …)`          | 路径路由覆盖缺省 | 该路由 `successStatus` | 调用对应 unary `handler`                           |
| `POST` + `Go-Like-Service` + `Go-Like-Endpoint` | 信封 unary       | **200**                | 成功体或 unary `ServiceError`，`carrierStatus` 200 |
| 信封 `GET`（有 `Go-Like-Service`）              | 协议 POST-only   | 500 协议错误           | 不改 `encodeServiceError`                          |
| 无信封 `POST /healthz`，无 `httpRoute`          | 未匹配           | 404                    | 缺省探针只认 GET/HEAD                              |
| 冻结 SHA dest vendor `GET /healthz`             | 协议 POST-only   | 500                    | finding 现状；本票在生产者树修复                   |

dest `fault-worker` / `signal-correlator` 落在第一行。dest `ingest-gateway` 与 competitor 已是原生 200，本票不改它们。

---

## 4. 建议改动面（不扩大范围）

| 包                                | 允许的变化                                                                                                                                     | 明确不做                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@go-like/server`                 | 在 `routeHttpRequest` / `dispatcher` 对无信封、无 `httpRoute` 的 `GET\|HEAD /healthz` 写 HTTP 200 载体（空 body）；unit 覆盖条款 2–4           | 不新增 public health option；不改 `handler` 签名；不改信封 `failureMessage`；不把 `/livez` `/readyz` 登记进 `httpRoutes`；不增加 `@go-like/health` / `@go-like/web` 依赖 |
| `@go-like/transport-http`         | 仅当缺省 200 的 HTTP 圆测需要：保持无信封 GET/HEAD 进入 `recv`；`Go-Like-HTTP-Status: 200` 空 body 必须能变成 HTTP 200。不得恢复冻结 POST-only | 不在 socket 层无条件劫持 `/healthz`；不改 `encodeServiceError`；不新增公共 `http2` API                                                                                   |
| `@go-like/transport`              | 无                                                                                                                                             | **禁止**修改 `encodeServiceError` / unary `carrierStatus: 200`                                                                                                           |
| `@go-like/health`、`@go-like/web` | 无                                                                                                                                             | **禁止**本票改动或被 server 依赖                                                                                                                                         |
| dest / examples / e2e             | 无                                                                                                                                             | 条款 6                                                                                                                                                                   |

`packages/server/test/public-api.test.ts:5-16` 今日导出名不含 health API。本票 **不得** 新增 `createHealthHandler` / `ProbeRegistry` 到 `@go-like/server` 导出表。

---

## 5. 验收

库侧最低验收（unit，不启动 dest，不 compose，不跑 dest `test:e2e`）：

1. `newServer(transport(newNodeHTTPTransport()), address("127.0.0.1:0"), handler(...任意 unary...))` 对无信封 `GET /healthz` 回答 HTTP **200**；不调用该 unary handler。空 body 合格。
2. 同一 server 对无信封 `HEAD /healthz` 回答 HTTP **200**。
3. 同一 server 对无信封 `GET /livez`（以及另一未登记路径）回答 **非 200**（保持今日 404 即可）。
4. 增加精确 `httpRoute("GET", "/healthz", service, endpoint, successStatus)` 后，`GET /healthz` 调用对应 handler，HTTP 载体为 `successStatus`；不再走缺省空 body（除非 handler 自己返回空 body 且 `successStatus` 为 200）。
5. 信封 POST（`Go-Like-Service` / `Go-Like-Endpoint`）成功仍 HTTP 200；信封 `ServiceError` 仍 `carrierStatus === 200`，且 `decodeServiceError("unary", 200, …)` 仍能解码。`packages/transport/src/errors.ts` 的 `encodeServiceError` 文本与 `carrierStatus: 200` 不得改语义。
6. `@go-like/server` `package.json` `dependencies` 仍不含 `@go-like/health`、`@go-like/web`。公共导出仍无 ProbeRegistry health API。
7. 既有 `packages/server/test/*.test.ts` 与 `packages/transport/http/test/http-route.test.ts` 的 NW-020 路径/信封断言继续通过。
8. 测试不修改 `examples/` 或 `e2e/`，除非该 unit 文件 import 它们。

typecheck：`cd packages/server && bun run typecheck`。unit：同目录 `bun run test:unit`。若圆测写在 `packages/transport/http/test`，同目录再跑 `bun run typecheck` 与 `bun run test:unit`。禁止 `bun --cwd`。

dest 回归（本契约不执行）：`go-like-dogfood` `projects/MS-009/findings/MS-009-001.json` 的 `evidencePaths`（`stdout/healthy-path.log`）。通过条件对齐 finding `expected`（worker `/healthz` 200 或 503，对照为 200），而不是本文目录里的综述。dest 样本 **不** 需要为缺省探针改 `worker.ts`；那是库义务。日后若 dest 要用 `httpRoute` 覆盖 `/healthz`，是样本变更，不是本票授权编辑。

---

## 6. 非目标

- 不实现参数化 health、不把 `/livez` `/readyz` 变成 server 缺省、不把 JSON probe payload 写成 dest 缺省。
- 不要求空 `ProbeRegistry` 在 dest 上 fail-closed 503。
- 不把 unary `ServiceError` 载体改成 4xx/5xx。
- 不诊断、不修复 etcd / Postgres / otelcol / toxiproxy。
- 不处理 recovering broker（`NW-006`）、REST 201 / SPIFFE（`NW-020` 剩余项）、或其它 backlog。
- 不授权应用 bind-first、dest `start-run`、compose、原生 `http2` 公共监听器、或改 dest 样本来“通过”对照。

---

## 7. 证据索引

| 主张                                                       | 位置                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| dest 期望：worker `GET /healthz` 200 或 503；对照原生 200  | `MS-009-001.json` `expected`（同文案：`MS-009-002` … `006`）                                                 |
| dest actual：60s 内持续 HTTP 500                           | `MS-009-001.json` `actual`；artifact `run-ce64498f-…/stdout/healthy-path.log:1`                              |
| 无自定义 GET `/healthz`；禁止 bind-first                   | `MS-009-001.json` `workaround`                                                                               |
| NW-009 仍未核实项（本文关闭）                              | `docs/dogfood-2026-08/next-work.md:33-41`                                                                    |
| first-service-startup：worker 500、gateway 200             | `projects/MS-009/ux/golike.json:16-28`                                                                       |
| 从未 POST `/v1/failure-correlations`                       | 同上 `40`；`next-work.md:40`                                                                                 |
| `APP_ROLES` 先起 fault-worker                              | dest `scripts/lane-runtime.mjs:25`；UX `golike.json:69`                                                      |
| dest worker：`newServer` + `transport-http`，无 health     | `implementations/go-like/src/worker.ts:26-48`                                                                |
| dest correlator：同样无 health 的 `newServer`              | `implementations/go-like/src/correlator.ts:16-57`                                                            |
| dest gateway 自定义 `/healthz` 200 空 body                 | `implementations/go-like/src/gateway.ts:147-149`                                                             |
| dest `startRole` 把 worker server 交给 `newApp`            | `implementations/go-like/src/main.ts:40-54`                                                                  |
| 对照 worker `/healthz` 200 空 body                         | `implementations/otel-native/src/fault.ts:13-16`                                                             |
| 对照 correlator 同文                                       | `implementations/otel-native/src/collector.ts:12-15`                                                         |
| harness 60s、`accept` 200/503                              | dest `scripts/lane-runtime.mjs:247-249`、`593-595`、`698-700`                                                |
| `waitForHttp`：4xx 因 `status < 500` 返回；5xx 走 `accept` | dest `scripts/lane-runtime.mjs:209-240`（判定在 `235`）                                                      |
| Docker 探针只要 2xx                                        | dest `scripts/healthz-probe.mjs:12`；`infra/compose.local-go-like.yaml:106-111`                              |
| 冻结 SHA：非 POST 即协议错误                               | dest `node_modules/@go-like/transport-http/transport-CWmmDUXP.js:1052`                                       |
| 冻结 SHA server：`recv` 后立刻要 `Go-Like-Service`         | dest `node_modules/@go-like/server/index.js:416-421`、`341-349`                                              |
| 当前：无信封 GET 可 `recv`，写入 method/target             | `packages/transport/http/src/socket.ts:107-111`                                                              |
| 协议错误 / 未 send → HTTP 500                              | `packages/transport/http/src/socket.ts:219-226`、`325-330`                                                   |
| 当前：无信封未匹配 → HTTP 404 载体                         | `packages/server/src/index.ts:710-735`、`811-816`                                                            |
| 精确 `httpRoute` 与 duplicated method+path                 | `packages/server/src/index.ts:599-628`、`248`                                                                |
| 信封 `failureMessage` → `encodeServiceError("unary")`      | `packages/server/src/index.ts:783-786`                                                                       |
| unary `carrierStatus` 200；禁止改 encoder                  | `packages/transport/src/errors.ts:201`、`212-218`、`276`                                                     |
| Web health 默认 `/livez` `/readyz`                         | `packages/web/src/health.ts:5-6`                                                                             |
| 空 ready fail-closed → 503 JSON                            | `packages/health/src/registry.ts:223-231`；`packages/web/src/health.ts:139`、`189-192`                       |
| server 不依赖 health/web                                   | `packages/server/package.json:26-33`                                                                         |
| dest 应用未调用 health/web API                             | `implementations/go-like/src` 无 `createHealthHandler` / `newProbeRegistry`                                  |
| 禁止 HTTP bind-first（综述）                               | `docs/dogfood-2026-08/ux-summary.md:28-37`                                                                   |
| 不启动 dest、不改 packages（收获表授权）                   | `docs/dogfood-2026-08/next-work.md:3`                                                                        |
| NW-020 无信封未匹配 404 回归                               | `packages/transport/http/test/http-route.test.ts:217-238`；`packages/server/test/http-route.test.ts:281-300` |
| 信封 ServiceError 仍 200                                   | `packages/server/test/http-route.test.ts:260-278`                                                            |
