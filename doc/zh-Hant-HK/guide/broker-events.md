# 訊息與事件

`@likego/broker` 定義 Context-first bytes/topic publish 同 subscribe SPI。每筆 delivery 都保留 provider 原生訊息，因為 ack、nak、term、重投、durable consumer 同 dead-letter 係各 broker 真正嘅語意，夾硬壓成一套共用方法只會漏資料。

`@likego/event` 係可選 typed codec 層。發布時編碼成獨立 bytes，收訊息後直到應用呼叫 `decode()` 先做 schema 解析。就算解析失敗，原生 NATS `Msg` 或 JetStream `JsMsg` 仲喺度，應用仍然可以揀正確 settlement。

`Broker.subscribe(ctx, topic, handler)` 會回傳帶有 `unsubscribe(ctx)` 嘅 provider `Subscriber`。`newBrokerServer(...)` 將 `Broker` 接入 Core `Server` 契約：`start(ctx)` 代表完整運行期，`stop(ctx)` 請求停止。LikeGo 負責停止已接納嘅 subscription，但從來唔會擁有 connection、stream 或 durable consumer；啟動取消會回滾已建立但尚未接納嘅 subscription。

要事件投遞同 fan-out 就用 Broker；如果真正要 BullMQ 嘅 job、retry、backoff、token 同 Worker 行為，就用 `@likego/bullmq`。兩種模型根本唔同，冇必要為咗個 API 表面整齊而掩住分別。
