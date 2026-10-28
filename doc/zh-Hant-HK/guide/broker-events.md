# 訊息與事件

`@go-like/broker` 定義 Context-first bytes/topic publish 同 subscribe SPI。每筆 delivery 都保留 provider 原生訊息，因為 ack、nak、term、重投、durable consumer 同 dead-letter 係各 broker 真正嘅語意，夾硬壓成一套共用方法只會漏資料。

`@go-like/event` 係可選 typed codec 層。發布時編碼成獨立 bytes，收訊息後直到應用呼叫 `decode()` 先做 schema 解析。就算解析失敗，原生 NATS `Msg` 或 JetStream `JsMsg` 仲喺度，應用仍然可以揀正確 settlement。

`newBrokerServer(...)` 只擁有一個訂閱。owner 要呼叫 `stop(ctx)`；如果接納仍未完成，adapter 會等訂閱返回之後再呼叫 `unsubscribe`。只取消 Context 唔代表晚到資源已釋放。

要事件投遞同 fan-out 就用 Broker；如果真正要 BullMQ 嘅 job、retry、backoff、token 同 Worker 行為，就用 `@go-like/bullmq`。兩種模型根本唔同，冇必要為咗個 API 表面整齊而掩住分別。

> [!NOTE]
> 呢頁係本地化摘要。RabbitMQ recovery、NATS Core/JetStream settlement、BullMQ/Croner lifecycle 同 provider terminal barrier 嘅完整 DAG，請睇[英文 canonical 頁面](/guide/broker-events)。

```text
application-owned native connection / consumer
  -> go-like accepted subscription
  -> Broker bytes/topic delivery
  -> application settlement through native provider object
  -> explicit unsubscribe / provider terminal result
```
