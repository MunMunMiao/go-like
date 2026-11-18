# go-like

go-like — набор явных строительных блоков TypeScript для backend-сервисов на Bun и Node.js. `@go-like/core` — панель socket без runtime-зависимостей: Context, жизненный цикл приложения, внутренние вызовы, конфигурация, discovery, записи, кеш, сообщения, задания, health и основа телеметрии. Остальные девятнадцать пакетов — plugs. Plug заполняет один или несколько socket клиентом экосистемы, который создаёт приложение. `@go-like/protoc-gen-like` — генератор Protobuf на этапе сборки и от core не зависит.

Приложение остаётся корнем композиции. Оно создаёт нативные объекты, передаёт их конструкторам plug и устанавливает результат в `newApp`. Глобального реестра серверов, логгеров и провайдеров телеметрии нет.

> [!IMPORTANT]
> Эта рабочая копия — приватный workspace `0.0.1`. Версия в манифесте не доказывает доступность в npm. Примеры используют пакеты workspace и рассчитаны на запуск из рабочей копии, пока опубликованный релиз не подтверждён отдельно.

> [!NOTE]
> Английское дерево `doc/` — канонический источник этого трека документации. Исходный код пакетов, манифесты и узкие тесты задают API. Тест или E2E-скрипт, который есть в репозитории, объявляет покрытие; это не успешный результат, пока команда не выполнена и её код выхода не записан.

## Выберите маршрут

| Читатель                   | Начните здесь                                         | Затем                                                                                    | Признак готовности                                                                          |
| -------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Новичок в go-like          | [Начало работы](/ru-Cyrl/guide/getting-started)       | [Архитектура](/ru-Cyrl/guide/architecture), [проект клиники](/ru-Cyrl/guide/zero-to-one) | Можно запустить один Web-сервис, передать Context, открыть health и остановить его          |
| Опытный инженер TypeScript | [Архитектура](/ru-Cyrl/guide/architecture)            | [Вызовы сервисов](/ru-Cyrl/guide/service-call), [Сравнение](/ru-Cyrl/guide/comparison)   | Можно назвать владельца, ярус и границу конечного состояния каждого ресурса                 |
| Читатель Go или Kratos     | [Начало работы](/ru-Cyrl/guide/getting-started)       | [Терминология](/reference/terminology), [Вызовы сервисов](/ru-Cyrl/guide/service-call)   | Можно сопоставить понятия Context и Server, не предполагая совместимости с gRPC или Go ABI  |
| Пользователь фреймворка    | [Сравнение](/ru-Cyrl/guide/comparison)                | [Миграция](/ru-Cyrl/guide/migration), [Архитектура](/ru-Cyrl/guide/architecture)         | Можно оставить нативный роутер и добавить только нужную границу жизненного цикла или вызова |
| Автор plug                 | [Указатель провайдеров](/ru-Cyrl/reference/providers) | [Проверка](/ru-Cyrl/reference/verification), [Утверждения](/reference/claims)            | Можно указать socket, runtime, владение и пределы доказательств для plug                    |

## Канонический путь обучения

Четыре страницы канонического пути в `doc/guide/` выстроены последовательно:

1. [Начало работы](/ru-Cyrl/guide/getting-started) запускает стандартный Fetch Handler, Node-host, сигнал допуска и один App.
2. [Запись на приём в клинике](/ru-Cyrl/guide/zero-to-one) превращает жизненный цикл в конкретную предметную область, внутренний унарный вызов, кеш, health, тест и остановку.
3. [Сравнение](/ru-Cyrl/guide/comparison) объясняет, чем go-like намеренно отличается от NestJS, Fastify, Hono, Elysia, Koa, tRPC, go-micro и go-kratos.
4. [Миграция](/ru-Cyrl/guide/migration) сопоставляет пакеты до миграции с раскладкой из 20 пакетов.

[Пакеты](/ru-Cyrl/reference/packages) — инвентарь 20 пакетов и 75 публичных точек входа. [Провайдеры](/ru-Cyrl/reference/providers) указывают на README каждого plug экосистемы.

## Мысленная модель

Через библиотеку проходят три правила:

1. **Сначала Context.** Каждая операция ввода-вывода принимает `ctx: Context` первым аргументом. Context несёт отмену, deadline, AppInfo, metadata запроса и текущее состояние телеметрии.
2. **Явная композиция.** Приложение создаёт каждую реализацию и передаёт её внутрь. Plug не регистрирует себя глобально.
3. **Один путь для каждой задачи.** Подписка идёт через `newBrokerServer`, расписание — через `newScheduleServer`, очередь — через `JobQueue.worker`, нативный ресурс — через `newResourceServer`, а готовность публикуют `readyProbe` и `createHealthHandler`.

```text
Application main.ts
  construct plugs from native objects the application created
  newTelemetry({...})  newConfig(...)  newServer(...)  newClient(...)
        |
        v
@go-like/core  newApp(...)
  telemetry(tel)     admitted first, drained last
  resources(...)     started in order, each start awaited, stopped in reverse
  server(...)        started together, stopped together
  registrar(r)       after the server tier is admitted
  readyProbe(...)    ready only between startup completion and stop
```

Пяти существительных достаточно, чтобы читать остальной сайт:

- **Socket** — структурный контракт, который объявляет core (`Server`, `LogHandler`, `Registry`, `Broker`, `Store` и остальные). Plug реализует socket. Он не оборачивает место вызова core.
- **Context** — явная область для отменяемой работы.
- **Server** — это `start(ctx)` и `stop(ctx)`. В `resources(...)` start завершается, когда ресурс пригоден к использованию. В `server(...)` start может оставаться незавершённым, пока не закончится нативный объект.
- **App** допускает эти ярусы, hooks, регистрацию и остановку. Это не контейнер внедрения зависимостей.
- **Handler** — стандартная Web-функция `(Request) => Response | Promise<Response>`. Сам по себе Handler не является слушающим сервером.

Внешние Web-вызовы и внутренние вызовы сервисов остаются раздельными. Сгенерированный Protobuf RPC — ещё один необязательный путь: `@go-like/protoc-gen-like` порождает связку с Context первым аргументом, `@go-like/connectrpc` адаптирует Connect и gRPC-Web к Fetch, а `@go-like/connectrpc/node` размещает стандартный gRPC. См. [Потоки](/ru-Cyrl/guide/streaming).

## Что по-прежнему принадлежит приложению

Текущая граница продукта оставляет приложению или нативной библиотеке следующее:

- маршруты, middleware фреймворка, Web Streams и апгрейды WebSocket;
- бизнес-политику, учётные данные и авторизацию;
- нативные подтверждения, lease, retry и детали протокола;
- сборку OpenTelemetry SDK, настройку логгера и выбор экспортёра;
- долговечность, транзакции и любой межпроцессный смысл эталонной реализации в памяти;
- публикацию в npm, статус размещённого CI или вывод о готовности к production по манифесту.

## Публичный инвентарь

Workspace публикует **20** пакетов `@go-like/*`. В этой рабочей копии все они имеют версию `0.0.1`. Публичных точек входа **75**. `@go-like/core` даёт 41. Остальные 34 принадлежат plugs и генератору. Сгенерированные экспорты метаданных `dist/package.json` не являются дополнительными исходными API.

[Справочник пакетов](/ru-Cyrl/reference/packages) нужен, чтобы выбрать точку входа, а [указатель провайдеров](/ru-Cyrl/reference/providers) — чтобы открыть README plug. [Журнал утверждений](/reference/claims) фиксирует уровень доказательств за публичными формулировками.

## Граница проверки

Исторический аудит контракта репозитория сообщил локальные результаты на commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`: `bun run typecheck`, `bun run test:unit` и `bun run fmt:check` прошли. В том отчёте было 2 736 модульных тестов, 1 514 отформатированных файлов и успешный аудит импорта 66 исходных точек экспорта. Этот счёт описывает дерево до миграции. Текущий инвентарь — 75 точек входа. Аудит не устанавливал `build`, `doc:build`, Docker E2E провайдеров, потребителей опубликованных tarball, публикацию в npm, размещённый CI и 60-минутный soak.

Прочитайте [Проверку](/ru-Cyrl/reference/verification), прежде чем превращать утверждение об исходнике или скрипте в утверждение о релизе.

## Дальше

- [Начало работы](/ru-Cyrl/guide/getting-started): Web Handler и первая контрольная точка жизненного цикла.
- [Архитектура](/ru-Cyrl/guide/architecture): ярусы, области Context, порядок start и stop, readiness и бюджеты.
- [Запись на приём в клинике](/ru-Cyrl/guide/zero-to-one): один бизнес-инвариант от HTTP до внутреннего вызова политики, health и остановки.
- [Вызовы сервисов](/ru-Cyrl/guide/service-call): типизированный Memory Transport, затем discovery, selection и retry.
- [Конфигурация, реестр, хранилище и кеш](/ru-Cyrl/guide/config-registry-store): четыре контракта, один общий клиент на экосистему.
- [Брокер, события и задания](/ru-Cyrl/guide/broker-events): байты, кодеки, расписания и очереди.
- [Проверки и наблюдаемость](/ru-Cyrl/guide/health-observability): пробы, `newTelemetry` и четыре plug телеметрии.
- [Сравнение](/ru-Cyrl/guide/comparison) и [Миграция](/ru-Cyrl/guide/migration): владение на фоне других инструментов и codemod импортов.
- [Пакеты](/ru-Cyrl/reference/packages), [Провайдеры](/ru-Cyrl/reference/providers), [Ошибки](/reference/errors), [Терминология](/reference/terminology) и [Проверка](/ru-Cyrl/reference/verification).

Управляемый drain gRPC при медленном потребителе на Node 26.12.1 и Bun 1.4.4 записан в [матрице drain нативного gRPC](/reference/claims#native-grpc-drain-status). Более ранние наблюдения отмены Fetch в Connect 2.1.2 и Bun 1.4.2 остаются в [журнале утверждений](/reference/claims#stream-cancellation-limits).
