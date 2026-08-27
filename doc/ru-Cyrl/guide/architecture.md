# Архитектура

go-like состоит из плоских, независимо публикуемых пакетов, а не из одного контейнера «на все случаи жизни». `@go-like/core` собирает приложение и жизненные циклы Server, `@go-like/context` переносит отмену, сроки, причины и значения, а остальные SPI описывают по одной области. Реализации находятся в отдельных пакетах провайдеров.

Систему удобно разделить на плоскости. Application plane отвечает за запуск, допуск, hooks и конечное состояние. Core параллельно вызывает `stop(ctx)` у каждого sibling Server, ждёт terminal result каждого и затем объединяет lifecycle failures; обратный порядок объявления не гарантируется. Компоненты, которым нужна упорядоченная очистка, должны сами скомпоновать этот порядок внутри одного `Server`. Call plane объединяет discovery, selection, Client, проекцию Server и Transport. Event plane содержит Broker и typed codec. Operations plane включает Config, Store, health, метрики, трассировку и логи. Внешний Web-край принимает Fetch handlers и не смешивается с внутренним transport.

Зависимости направлены к переносимым контрактам. Провайдер может использовать официальный SDK или runtime host, но SPI не зависит от конкретной реализации. Поэтому одна композиция подходит для Bun, Node.js, Deno и других серверных сред со стандартными Web API.

Глобального service locator нет. Приложение само создаёт зависимости и передаёт их конструкторам. Несколько строк явной сборки стоят того: владельцы connections, watchers, listeners и процедур остановки сразу видны.

> [!NOTE]
> Это локализованный краткий обзор. Полный lifecycle DAG, карта ownership и ограничения отдельных providers находятся на [канонической английской странице](/guide/architecture); краткий текст не обещает универсальную parity между runtime.

## Карта request и lifecycle

```text
application composition root
  -> Context: отмена / deadline / values
  -> Core App: admission / hooks / результат stop
  -> Web Handler -> runtime host -> listener
  -> внутренний Client -> Discovery -> Selector -> Transport -> Server

App.stop()
  -> deregister принятого экземпляра
  -> отмена runtime Server
  -> параллельные вызовы Server.stop
  -> terminal joins -> один результат
```

`Server.start(ctx)` не означает readiness. Для сигнала admission используйте `endpoint(ctx)` или hook `afterStart`. Core также не обещает обратный порядок остановки соседних Servers; если порядок важен, объедините ресурсы в один `Server` или явный hook.
