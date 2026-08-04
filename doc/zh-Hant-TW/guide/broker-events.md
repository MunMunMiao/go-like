# 訊息代理與事件

`@go-like/broker` 定義 Context-first 的 bytes/topic publish、subscribe SPI。每筆 delivery 都保留 provider 原生訊息，因為 ack、nak、term、重新投遞、durable consumer 與 dead-letter 是各家 broker 的真實語意，硬塞進共用介面反而會少掉重要資訊。

`@go-like/event` 是可選的 typed codec 層。發布時先編碼成獨立 bytes，收到訊息後直到應用呼叫 `decode()` 才做 schema 解析。即使解析失敗，原生 NATS `Msg` 或 JetStream `JsMsg` 仍然保留，應用可以自行決定要怎麼 settlement。

`Broker.subscribe(ctx, topic, handler)` 會回傳帶有 `unsubscribe(ctx)` 的 provider `Subscriber`。`newBrokerServer(...)` 將 `Broker` 接入 Core `Server` 契約：`start(ctx)` 代表完整執行期，`stop(ctx)` 要求停止。go-like 負責停止已接納的 subscription，但從不擁有 connection、stream 或 durable consumer；啟動取消會回滾已建立但尚未接納的 subscription。

需要事件投遞和 fan-out 時選 Broker；如果真正需要的是 BullMQ 的 job、retry、backoff、token 和 Worker 行為，就使用 `@go-like/bullmq`。兩種模型不同，沒必要為了表面一致而把差別遮起來。

> [!NOTE]
> 這頁是本地化摘要。RabbitMQ recovery、NATS Core/JetStream settlement、BullMQ/Croner lifecycle 與 provider terminal barrier 的完整 DAG，請看[英文 canonical 頁面](/guide/broker-events)。

```text
application-owned native connection / consumer
  -> go-like accepted subscription
  -> Broker bytes/topic delivery
  -> application settlement through native provider object
  -> explicit unsubscribe / provider terminal result
```
