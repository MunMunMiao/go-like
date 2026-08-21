# NW-006 公共契约：recovering RabbitMQ 在 initial setup 完成前可接纳

本文钉死 `NW-006`（findings `MS-006-001` … `MS-006-006`）的公共 API 与可观察行为。标识符、错误文案、状态码与包名保持英文。实现必须满足下列条款；未列入的行为不得借本票扩大范围。

| 项 | 值 |
| --- | --- |
| ID | `NW-006` |
| dest | `fw-r214` / `MS-006` |
| 生产者 SHA | `cd15313d50e6804cfe34a7e7291cb65a861dec1c` |
| 包 | `@go-like/broker-rabbitmq` |
| 对照 | 同 dest 上 competitor（`amqplib` 2.0.1）`openBus` 后 `serveHttp`，`/healthz` 为 200；healthy-path / invariants / fault-matrix 均通过 |
| 本文状态 | 契约钉死；不授权启动 dest、不 compose、不提交 git。后续实现只改 `@go-like/broker-rabbitmq` |

`docs/dogfood-2026-08/next-work.md:31` 将三项列为仍未核实。本文关闭它们：

1. 健康网内 RabbitMQ 上 `setupCompleted` 是否终能完成、或 `maxRetries: Infinity` 会永久挡住——**本票不依赖该诊断**。无论 setup 何时完成，HTTP 必须能在 connector 返回前绑定。
2. 根因是 broker initial setup、AMQP/toxiproxy URL，还是 recovering 包装——可观察缺口是公共构造函数等待 `setupCompleted`；本票用 admit-before-setup 关闭缺口，**不** fork `amqplib` recovery。
3. 库是否应在 setup 完成前提供可探测的 not-ready（200/503）而不要求应用先 `bindHttp`——**否**。库不发明 health 端点；dest `lending-desk` 在 HTTP 绑定后静态 200。先绑第二个 HTTP 的应用 workaround 已被战役禁止。

---

## 1. 问题与 dest 证据

`MS-006` 黑盒冻结面是 bootstrap：`ensureSchema` 之后，角色必须在 60s 内让 `GET /healthz` 返回 **200 或 503**。探测端口：

| 车道 | `lending-desk` `/healthz` |
| --- | --- |
| `docker-go-like` | `http://127.0.0.1:40611/healthz`（`MS-006-001` … `003`） |
| `local-go-like` | `http://127.0.0.1:40601/healthz`（`MS-006-004` … `006`） |

六条 finding 的 `actual` 均为：

```text
timed out waiting for http://127.0.0.1:40611/healthz: socket hang up
```

（local 槽把 `40611` 换成 `40601`。）`socket hang up` 来自 harness `waitForHttp` 在 60s 内从未读到 HTTP 状态（`lane-runtime.mjs:216-247`，角色启动 `timeoutMs: 60_000` 且 `accept` 为 `200 || 503`，见 `lane-runtime.mjs:574-577`）。这不是 500/503，而是进程从未 `listen`。

dest `startRole` 的源顺序（`implementations/go-like/src/main.ts:12-19`）：

```ts
await ensureSchema(pool)
const provider = await openRecoveringBroker(ownerContext(), selected.amqpUrl)
bindHttp(...)   // lending-desk / fulfillment-worker 走 newHealthHandler
```

`openRecoveringBroker` 直接 `return newRecoveringRabbitMqBroker(ctx, connector)`（`rabbit.ts:17-30`）。战役测试把「先绑 HTTP」判为非法：

```ts
assert.ok(startRole.indexOf("openRecoveringBroker") < startRole.indexOf("bindHttp"))
```

（`MS-006.src/test/run-lane.test.mjs:156-157`。）Finding `workaround` 原文：Public `RecoveringRabbitMqBroker` does not return until `setupCompleted`；Binding HTTP before `openRecoveringBroker` is forbidden。

对照侧同一拓扑：`bootRole` `await openBus` 后 `await serveHttp`（`implementations/amqplib/src/boot.ts:10-19`）。`openBus` 是一次性 `connect` + `createConfirmChannel` + assert topology，**没有** recovery / `waitForConnect`（`bus.ts:13-21`）。`serveHttp` 对 `/healthz` 写死 200（`listen.ts:41-43`）。competitor UX `first-service-startup`：`/healthz returned 200`。

go-like UX：

- `first-service-startup` surprise：`startRole awaits openRecoveringBroker before bindHttp, so published /healthz hangs until setupCompleted`。
- `first-failure-and-diagnosis` surprise：`RecoveringRabbitMqBroker blocks startRole until setupCompleted with Infinity retries`。Binding HTTP before `openRecoveringBroker` was not applied。
- `first-inter-service-call`：healthy-path 从未 POST ILL，因为 `lending-desk` `/healthz` 从未返回 200 或 503。

缺口发生在 first-service-startup；借贷路径从未发出。本票的库修复是：**在不改变 wait-for-setup ABI、也不允许 bind-first 的前提下，提供可立即返回的 recovering 入口。**

---

## 2. 必须钉死的条款

### 条款 1 — `newRecoveringRabbitMqBroker(ctx, connector)` 仍等待 RecoveringChannelModel **且** initial setup 完成

签名与今日相同（`packages/broker/rabbitmq/src/index.ts:665-668`）：

```ts
export async function newRecoveringRabbitMqBroker(
  ctx: Context,
  connector: RabbitMqRecoveryConnector
): Promise<RecoveringRabbitMqBroker>
```

必须继续：

1. 等待 `connector(setup)` 返回对象，且该对象是 `RecoveringChannelModel`（现有检查：`typeof connection.on === "function"` 且 `typeof connection.close === "function"`，`index.ts:840-848`）。
2. 等待 connector 在返回前已经跑完 initial `setup`，使得 `setupCompleted === true` 且 `activeBroker !== null`（`index.ts:681`、`811`、`849-852`）。
3. 跳过 `setup` 的 connector **必须拒绝**，错误文案仍为 `RabbitMQ recovery connector must complete its initial setup`，并 `discardConnection`（关闭返回的 connection 与已接纳 generation channel）。现有单测 `packages/broker/rabbitmq/test/broker.test.ts:995-1008` 必须继续有效。
4. 构造期 `ctx` 已取消、connector 非函数、返回值不是 `RecoveringChannelModel`、connector 在 setup 之后拒绝——继续按现有单测回滚（`broker.test.ts:891-993`：关闭已 setup 的 channel / 迟到 connection）。
5. 实现上，本入口 **就是** 条款 2 的 `startRecoveringRabbitMqBroker(ctx, connector).ready(ctx)`。不得另造第二套 setup 状态机。

`RecoveringRabbitMqBroker` 仍为 `{ broker, connection }`（`index.ts:93-96`、`1017`）。`connection` 仍由应用拥有；go-like 不关闭 recovering connection，除非本入口因构造失败走 `discardConnection`（`index.ts:693-700`）。

现有 `packages/broker/rabbitmq/test/*.test.ts` 对 `newRecoveringRabbitMqBroker` 的断言全部保持有效。禁止为了 admit-before-setup 放宽 skip-setup、放宽 malformed model、或让该入口在 `setupCompleted` 之前 resolve。

### 条款 2 — 新增 `startRecoveringRabbitMqBroker(ctx, connector)`：立即返回，后台跑 connector

dest `startRole` 在 `bindHttp` 前 `await openRecoveringBroker`。战役禁止在 `openRecoveringBroker` 之前再绑一个 HTTP listener。因此 **库** 必须提供不阻塞 HTTP 绑定的公共入口。

```ts
export function startRecoveringRabbitMqBroker(
  ctx: Context,
  connector: RabbitMqRecoveryConnector
): RecoveringRabbitMqHandle
```

约束：

1. **不是** `async function`。返回类型是 handle，**不是** `Promise<RecoveringRabbitMqHandle>`。
2. 在调用方当前同步栈返回。不得 `await connector`，不得 `await waitForConnect`，不得等待 amqplib `maxRetries: Infinity` 的首次成功。
3. 在返回之后、handle 被观察之前，于后台启动 `connector(setup)`（与今日 `connectRecovery` 相同的 setup 回调，`index.ts:817-826`）。
4. 同步校验可保留：`ctx` 已失败则立刻抛出；`connector` 非函数则 `TypeError("RabbitMQ recovery connector must be callable")`（`index.ts:669-673`）。除此之外不得做阻塞 I/O。
5. dest 的 connector **本身** 就是 `amqplib.connect(url, { recovery: { setup } })`（`rabbit.ts:17-30`）。官方 `connect` 在 recovery 开启时返回 `connectWithRecoveryPromise` → `recovering.waitForConnect()`（dest `node_modules/amqplib/channel_api.js:6-11`；`lib/recovery.js:453-456`、`386-388`、`131-133`）。`waitForConnect` 只在 `_connect` 成功执行 `runSetup` 之后 resolve（`recovery.js:256-274`）。默认 `maxRetries: Infinity`（`recovery.js:8`、`51-58`）；dest **没有**覆盖 `maxRetries`。因此把 connector 放到后台，是让 dest 在 Infinity retry / 首次 setup 完成前就能 `bindHttp` 的唯一库侧手段。
6. **禁止** fork / patch `amqplib`，禁止改 `waitForConnect`、禁止把 `connectWithRecoveryPromise` 改成先返回 model。应用继续传入官方 `RecoveringChannelModel` connector。

`RabbitMqRecoveryConnector` 类型不变（`index.ts:88-90`）。

### 条款 3 — 立即返回的 handle：`broker` + `ready(ctx)` + `stop(ctx)`

```ts
export interface RecoveringRabbitMqHandle {
  readonly broker: RabbitMqBroker
  ready(ctx: Context): Promise<RecoveringRabbitMqBroker>
  stop(ctx: Context): Promise<void>
}
```

#### `broker`

与日后 `ready()` 解析出的 `RecoveringRabbitMqBroker.broker` **是同一个对象**。dest `lendingServer` / `fulfillmentServer` 经 `newBrokerServer(provider.broker, …)` 订阅（`lending.ts:11-13`）；admit-before-setup 后应用必须能在 `ready()` 之前把该 `broker` 交给 worker。

- **`publish` fail-closed，直到存在 generation。** `activeBroker === null` 时继续 `Promise.reject(new Error("RabbitMQ recovering broker is disconnected"))`（`index.ts:904-913`）。不得发明离线缓冲、不得排队到 setup 完成再发。
- **`subscribe` 可以接纳 descriptor**，并在第一次成功的 setup generation 上 `attach`。这是现有 rebuild 循环，不是新语义：descriptor 先入 `subscriptions`；若当时没有 generation 且没有正在跑的 `setupRunning`，admission 在不 `attach` 的情况下完成；`rebuild` 再对全部活跃订阅 `attach`（`index.ts:784-803`、`916-958`）。setup 失败不得把已接纳但未 attach 的 descriptor 丢掉，除非调用方 `unsubscribe` / `stop`。
- `ack` / `nack` / `reject` 仍按 generation fence 路由；无当前 generation 的 native delivery 继续 fail-closed（`index.ts:894-900`、`999-1009`）。

#### `ready(ctx)`

这就是条款 1 的 wait-for-setup ABI，也是 `newRecoveringRabbitMqBroker` 的实现：

```ts
startRecoveringRabbitMqBroker(ctx, connector).ready(ctx)
```

`ready(waitCtx)` 必须：

1. 使用现有 `waitForContext`（`packages/core/src/lifecycle.ts:27`）等待后台 connector。
2. connector 返回后执行与今日构造函数相同的 model / `setupCompleted` 检查（`index.ts:840-852`）。
3. 跳过 setup → 拒绝 `must complete its initial setup` 并 `discardConnection`。
4. 成功时 resolve 为 `Object.freeze({ broker, connection })`，其中 `connection` 是 connector 返回的那个 `RecoveringChannelModel`。
5. 多次 `ready` 共享同一次 setup；成功后再次 `ready` 得到同一 `RecoveringRabbitMqBroker`（同一 `broker`、同一 `connection`）。
6. `waitCtx` 取消只放弃这次等待；若构造 `ctx` 仍活着，后台 connector / 已接纳 generation 继续（与今日 `waitForContext`「只取消自己的等待」一致）。构造 `ctx` 取消则按现有迟到 connection `discardConnection`（`index.ts:832-838`）。

#### `stop(ctx)`

后台 connector 在 `ready()` 之前没有公共 `connection` 可关。dest 今日只在 `afterStop` 里 `provider.connection.close()`（`main.ts:32-35`），那是 `await openRecoveringBroker` 成功之后。handle 必须能在从未 `ready` 的情况下拆掉：

1. 永久停止后台 connector 与后续 setup generation。
2. 已得到的 `RecoveringChannelModel` 走现有 `discardConnection`（`index.ts:694-700`）。尚未返回的迟到 connection 按构造取消路径丢弃（`index.ts:832-838`）。
3. 之后 `publish` 仍 fail-closed；`ready(ctx)` 拒绝（构造取消 / `Connection closed` / 调用方 `stop` 的错误，择一稳定错误即可，但不得再在 setup 成功后 resolve）。
4. `stop` 可重入；第二次是 no-op 成功。
5. 已 `ready` 之后的 `stop` 同样关闭应用尚未自己 `connection.close()` 的 recovering connection，并使 `broker` 进入 disconnected。不要求同时保留「应用 `connection.close()`」与「handle.stop()」两套成功语义之外的新生命周期；两者都必须导致 generation 失效。

`discard` / `discardSubscription` / `discardConnection` 的职责不变（`index.ts:694-713`）：丢弃过期 generation 或 admission 失败的 descriptor，不影响「应用拥有 connection」这一原则——**除了** 本条款明确的构造失败与 `stop`。

### 条款 4 — Health 200/503 是应用职责；库不发明 health，不改 `@go-like/server` / `@go-like/web`

Finding `expected` 允许 `GET /healthz` 为 200 或 503。这是 **harness 接受集**，不是要求 broker 包提供探针。

dest `lending-desk`（以及 `fulfillment-worker`）在 `bindHttp(newHealthHandler(selected.role), …)` 之后，对 `GET|HEAD /healthz` **静态 200**（`http.ts:52-59`）。`loan-request-gateway` 的 `/healthz` 同样静态 200（`http.ts:19-21`）。handler **不**读取 broker generation，不在 not-ready 时改 503。

因此：

1. `@go-like/broker-rabbitmq` **不得**新增 `/healthz`、不得导出 HTTP handler、不得在 recovering 包装里绑端口。
2. **不得**修改 `@go-like/server`、`@go-like/web`、`@go-like/health`。`@go-like/web/health` 的默认路径是 `/livez` 与 `/readyz`（`packages/web/src/health.ts:5-6`），与 dest `/healthz` 无关。
3. 应用若要把 not-ready 映射成 503，用 `handle.broker.publish` 的 disconnected 错误或自行观察 `ready()`；那是应用选择，**不是**本票完成条件。
4. dest 样本一旦能在 connector 返回前调用 `bindHttp`，现有静态 200 即满足 harness。本票不改 dest 应用源码。

### 条款 5 — 禁止项

下列做法不得作为本票的实现、测试或 dest 回归手段：

1. **Bind-first 第二个 HTTP server。** 不得在 `openRecoveringBroker` / `startRecoveringRabbitMqBroker` 之前 `listen` 原生 `node:http`、第二个 `@go-like/web` server、旁路 health 端口，以掩盖 recovering 阻塞。战役已禁止（`MS-006-001.json` `workaround`；`run-lane.test.mjs:156-157`；`ux-summary.md:28-34`）。条款 2 的立即返回 handle 是唯一合法解法：先拿到 `broker`，再 `bindHttp`，connector 在后台。
2. **dest `start-run`。** 不得对 `MS-006.src` 执行 `scripts/run-lane.mjs` / campaign `start-run`。later-src brief 虽写明可跑 recovery dest，**本票不授权**（`campaign/brief.md:8-10`；`next-work.md:3`）。
3. **compose。** 不得 `docker compose` 起 RabbitMQ / toxiproxy / 角色容器来「证明」本票。库验收是 unit + typecheck。
4. **fork / 修改 `amqplib`。** 不得改 `lib/recovery.js` 的 `waitForConnect`、`maxRetries` 默认 Infinity、`_connect`、`runSetup`，也不得 vendoring 一份私有 amqplib。dest 继续依赖官方 `amqplib@2.0.1`。
5. **修改 `examples/` 或 `test/e2e`，除非某个 unit test 需要 import 它们。** 实现与回归放在 `packages/broker/rabbitmq/src` 与 `packages/broker/rabbitmq/test/*.test.ts`。`packages/broker/rabbitmq/test/e2e/rabbitmq-docker-e2e.ts` 不得作为本票验收，也不得为本票改它。unit 若只读 import 夹具可以，不得把 dest 样本改成库的伪实现。
6. **实现 `NW-009`。** 不得借本票改 `@go-like/server` 缺省 `/healthz` 500（`next-work.md:33-41`）。那是另一张票、另一个包。

---

## 3. 可观察行为矩阵

| 调用 | 返回时机 | `broker.publish` | `broker.subscribe` | HTTP（dest 应用） |
| --- | --- | --- | --- | --- |
| `newRecoveringRabbitMqBroker(ctx, connector)` | connector 返回 **且** `setupCompleted` | 当前 generation；无 generation 则 disconnected | 立即 attach 到当前 generation | dest 今日会一直等到这里才 `bindHttp`（缺口） |
| 同上，connector 从不调用 `setup` | 拒绝 `must complete its initial setup`，关闭 connection | 不返回 broker | 不保留 descriptor | 不适用 |
| `startRecoveringRabbitMqBroker(ctx, hangingConnector)` | **同步立即** | disconnected 错误 | 接纳 descriptor，等首次成功 setup 再 `attach` | 应用现在就可以 `bindHttp`；dest health 静态 200 |
| hanging connector 稍后 `setup` + 返回 model，再 `ready(ctx)` | `ready` resolve `{ broker, connection }` | 走当前 generation | rebuild 挂上已接纳订阅 | 已在听的 `/healthz` 不受影响 |
| `ready(ctx)` 在 skip-setup connector 上 | 与 `newRecoveringRabbitMqBroker` 相同拒绝 + `discardConnection` | disconnected | 回滚未成功 admission | 若应用已 `bindHttp`，health 仍是应用静态 200 |
| `stop(ctx)` 发生在 `ready` 前 | `stop` 完成；迟到 connection discard | disconnected | 停止 replay | 应用自行关 HTTP；库不管端口 |

dest 对照：competitor `openBus` 完成后才 `serveHttp`，但 `openBus` 无 Infinity recovery wait，故 60s 内能听。go-like 不得靠「把 dest 改成 bind-first」追平，必须靠条款 2。

---

## 4. 建议改动面（不扩大范围）

| 包 | 允许的变化 | 明确不做 |
| --- | --- | --- |
| `@go-like/broker-rabbitmq` | 导出 `startRecoveringRabbitMqBroker` 与 `RecoveringRabbitMqHandle`；`newRecoveringRabbitMqBroker` 改为 `start(…).ready(ctx)`；README 增加 admit-before-setup 入口说明；`public-api.test.ts` / `public-types.ts` 登记新导出 | 不改 `newConfirmRabbitMqBroker` / `newRabbitMqBroker`；不改 publish disconnected 文案；不改 skip-setup 文案；不把 `waitForConnect` 搬进本包；不新增 HTTP |
| `@go-like/broker` | 无 | 不改 `Broker` / `newBrokerServer` |
| `@go-like/server`、`@go-like/web`、`@go-like/health` | 无 | **禁止**本票改动（条款 4、条款 5.6） |
| dest / examples / e2e / amqplib | 无 | 条款 5 |

`packages/broker/rabbitmq/test/public-api.test.ts:6-10` 今日只导出三个 runtime 名。实现本票时必须把 `startRecoveringRabbitMqBroker` 列入；可与实现同一 PR 更新期望列表。

---

## 5. 验收

库侧最低验收（unit，不启动 dest，不跑 `test:e2e`）：

1. `startRecoveringRabbitMqBroker` 在故意挂起的 connector（永不 resolve 的 `Promise`）上，于 connector resolve 之前就把 handle 返回给调用方。
2. 该 handle 上、generation 出现前，`broker.publish` 以现有错误 `RabbitMQ recovering broker is disconnected` 拒绝。
3. connector 稍后调用 `setup` 并返回带 `on`/`close` 的 `RecoveringChannelModel` 之后：`ready(ctx)` resolve；`publish` 成功；`ready` 给出的 `connection` 就是该 model。
4. `newRecoveringRabbitMqBroker` 对从不调用 `setup` 的 connector 仍然拒绝 `must complete its initial setup`，并关闭 connection（`broker.test.ts:995-1008` 继续绿）。
5. 既有 `packages/broker/rabbitmq/test/*.test.ts`（含构造 Context 取消、malformed model、connector 在 setup 后拒绝）继续通过。
6. 公共导出名含 `startRecoveringRabbitMqBroker`；不导出原生 HTTP listen 包装。
7. 测试不修改 `examples/` 或 `packages/broker/rabbitmq/test/e2e`，除非该 unit 文件 import 它们。

typecheck：`cd packages/broker/rabbitmq && bun run typecheck`。unit：同目录 `bun run test:unit`。禁止 `bun --cwd`。

dest 回归（本契约不执行）：`go-like-dogfood` `projects/MS-006/findings/MS-006-001.json` 的 `evidencePaths`（`stdout/healthy-path.log`）。通过条件对齐 finding `expected`，而不是本文目录里的综述。dest 应用日后要把 `await openRecoveringBroker` 换成 `startRecoveringRabbitMqBroker` 再 `bindHttp`；**那是 dest 样本变更，不是本票的授权编辑。**

---

## 6. 非目标

- 不诊断、不修复 toxiproxy / Docker Desktop 发布端口 AMQP 握手（UX `first-real-infrastructure-integration` 已记录；战役控制条件是网内 DNS）。
- 不把 `maxRetries` 从 Infinity 改成有限次数，也不在 dest `rabbit.ts` 里加 `maxRetries`。
- 不要求 `ready()` 之前 `publish` 缓冲。
- 不要求 handle 在 setup 前暴露 `connection`。
- 不实现参数化 health、不把 200/503 写进 broker。
- 不授权应用 bind-first、dest `start-run`、compose、fork amqplib、或改 dest 样本来“通过”对照。
- 不处理 `NW-009` / `NW-020` 或其他 backlog 项。

---

## 7. 证据索引

| 主张 | 位置 |
| --- | --- |
| dest 期望：setup 完成后 bind HTTP，`/healthz` 200 或 503；对照 `openBus` 后 `serveHttp` | `MS-006-001.json` `expected`（同文案：`MS-006-002` … `006`） |
| dest actual：`socket hang up` | `MS-006-001.json` `actual`；artifact `run-91956233-…/stdout/healthy-path.log:1` |
| 禁止 bind-first；构造函数等到 `setupCompleted` | `MS-006-001.json` `workaround` |
| NW-006 仍未核实项（本文关闭） | `docs/dogfood-2026-08/next-work.md:23-31` |
| first-service-startup：`/healthz` 挂到 `setupCompleted` | `projects/MS-006/ux/golike.json:17-31` |
| first-failure-and-diagnosis：Infinity retries 挡住 `startRole` | `projects/MS-006/ux/golike.json:61-73` |
| dest `startRole`：`await openRecoveringBroker` 后才 `bindHttp` | `implementations/go-like/src/main.ts:12-19` |
| dest connector = `newRecoveringRabbitMqBroker` + `connect(..., { recovery })`，无 `maxRetries` | `implementations/go-like/src/rabbit.ts:17-30` |
| dest lending-desk health 静态 200 | `implementations/go-like/src/http.ts:52-59` |
| 战役断言源码顺序：`openRecoveringBroker` 在 `bindHttp` 前 | `MS-006.src/test/run-lane.test.mjs:156-157` |
| 对照 `openBus` 无 recovery | `implementations/amqplib/src/bus.ts:13-21` |
| 对照 `bootRole`：`openBus` 后 `serveHttp` | `implementations/amqplib/src/boot.ts:10-19` |
| 对照 `/healthz` 静态 200 | `implementations/amqplib/src/listen.ts:41-43` |
| harness 60s、接受 200/503 | `scripts/lane-runtime.mjs:574-577`、`216-247` |
| `newRecoveringRabbitMqBroker` 等待 connector + `setupCompleted` | `packages/broker/rabbitmq/src/index.ts:665-668`、`828-852` |
| `setupCompleted` 只在 `rebuild` 成功后置位 | `index.ts:681`、`784-815` |
| skip-setup 拒绝并 `discardConnection` | `index.ts:849-852`、`694-700`；`test/broker.test.ts:995-1008` |
| `publish` disconnected fail-closed | `index.ts:904-913` |
| `subscribe` 无 generation 时仍接纳，setup 时 `attach` | `index.ts:784-803`、`953-958` |
| `waitForConnect` / Infinity / `_connect` / `runSetup` | dest `amqplib/lib/recovery.js:8`、`75-98`、`131-133`、`256-306`、`386-388`、`453-456` |
| recovery `connect` 只返回 `waitForConnect()` | dest `amqplib/channel_api.js:6-11` |
| 禁止 HTTP bind-first（综述） | `docs/dogfood-2026-08/ux-summary.md:28-34` |
| 不启动 dest、不改 packages（收获表） | `docs/dogfood-2026-08/next-work.md:3` |
| NW-009 不得并入本票 | `docs/dogfood-2026-08/next-work.md:33-41` |
| 公共导出仅三个 runtime 名（实现时追加第四个） | `packages/broker/rabbitmq/test/public-api.test.ts:6-10` |
