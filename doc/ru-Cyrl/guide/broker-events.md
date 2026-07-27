# Брокер и события

`@likego/broker` задаёт Context-first SPI публикации и подписки через topic и bytes. Каждая delivery сохраняет нативное сообщение провайдера: `ack`, `nak`, `term`, redelivery, durable consumer и dead letter имеют разную семантику в разных брокерах. Универсальная обёртка скрыла бы важные возможности.

`@likego/event` добавляет необязательный типизированный codec. При публикации он кодирует независимые bytes, а при получении ждёт вызова `decode()` перед проверкой schema. Даже после ошибки декодирования нативный NATS `Msg` или JetStream `JsMsg` остаётся доступным, и приложение выбирает правильный settlement.

`Broker.subscribe(ctx, topic, handler)` возвращает provider `Subscriber` с методом `unsubscribe(ctx)`. `newBrokerServer(...)` адаптирует `Broker` к контракту Core `Server`: `start(ctx)` представляет весь период работы, а `stop(ctx)` запрашивает остановку. LikeGo останавливает принятую subscription, но никогда не владеет connection, stream или durable consumer. Отмена запуска освобождает созданную, но ещё не принятую subscription.

Broker нужен для доставки событий и fan-out. Если важна именно модель jobs, retry, backoff, token и Worker из BullMQ, используйте `@likego/bullmq`. Это разные инструменты, и честный API не делает вид, будто различий нет.
