# Брокер и события

`@go-like/broker` задаёт Context-first SPI публикации и подписки через topic и bytes. Каждая delivery сохраняет нативное сообщение провайдера: `ack`, `nak`, `term`, redelivery, durable consumer и dead letter имеют разную семантику в разных брокерах. Универсальная обёртка скрыла бы важные возможности.

`@go-like/event` добавляет необязательный типизированный codec. При публикации он кодирует независимые bytes, а при получении ждёт вызова `decode()` перед проверкой schema. Даже после ошибки декодирования нативный NATS `Msg` или JetStream `JsMsg` остаётся доступным, и приложение выбирает правильный settlement.

`Broker.subscribe(ctx, topic, handler)` возвращает provider `Subscriber` с методом `unsubscribe(ctx)`. `newBrokerServer(...)` адаптирует `Broker` к контракту Core `Server`: `start(ctx)` представляет весь период работы, а `stop(ctx)` запрашивает остановку. go-like останавливает принятую subscription, но никогда не владеет connection, stream или durable consumer. Отмена запуска освобождает созданную, но ещё не принятую subscription.

Broker нужен для доставки событий и fan-out. Если важна именно модель jobs, retry, backoff, token и Worker из BullMQ, используйте `@go-like/bullmq`. Это разные инструменты, и честный API не делает вид, будто различий нет.

> [!NOTE]
> Это локализованный краткий обзор. Полный DAG recovery RabbitMQ, settlement NATS Core/JetStream, lifecycle BullMQ/Croner и terminal barrier provider находится на [канонической английской странице](/guide/broker-events).

```text
application-owned native connection / consumer
  -> go-like accepted subscription
  -> Broker bytes/topic delivery
  -> application settlement through native provider object
  -> explicit unsubscribe / provider terminal result
```
