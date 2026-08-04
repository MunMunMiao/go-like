# go-like в сравнении с другими инструментами

Честное сравнение начинается с владения и ответственности, а не с таблицы галочек по числу возможностей. NestJS, Fastify, Hono, Elysia, Koa и tRPC решают разные задачи в TypeScript-стеке приложений. go-micro и go-kratos — это ориентиры из мира Go с другими решениями для транспорта и генерации кода. go-like — набор строительных блоков для TypeScript, делающий явными жизненный цикл, внутренние унарные вызовы, контракты провайдеров и композицию между runtime.

На этой странице разделены уровни доказательности:

- **Исходный код** означает, что текущая рабочая копия go-like предоставляет указанное API или границу.
- **Зафиксированный внешний источник** означает, что сравнение опирается на release, commit или официальную документацию, записанные в исследовательском журнале. Это не свежий benchmark и не утверждение, что незафиксированная ветка `main` не изменилась.
- **Заявлено** означает, что в репозитории есть пример или тестовый lane. Это не означает успешный результат.
- **Пробел** означает, что текущий репозиторий не доказывает обещанную совместимость.

Текущая базовая версия исходников go-like для этого трека — commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`. В локальной исследовательской записи есть расхождение по commit go-micro: одна сравнительная запись называет `9d306dcfc1a912a8a9493f31fee0bb983475258d`, а подробная записка по фиксированной версии изучала go-micro `v6.9.0` на `3c39d17fadaa9ec21b671be4afef3e63846406e6`. Считайте эти значения входными данными для повторной проверки, а не гарантией текущего состояния upstream.

## Место в стеке

| Инструмент | Основная задача                                  | Что обычно находится в его ответственности                                                                                                                                        | Что go-like может дополнить, но не заменить                                                                                |
| ---------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| NestJS     | Конвенциональный Node-фреймворк приложения       | Modules, providers, controllers, decorators, application context, lifecycle фреймворка, HTTP- или microservice-adapter                                                            | Структурную границу жизненного цикла или контракт внутреннего вызова вокруг нативного приложения, если написать явный мост |
| Fastify    | Node HTTP-сервер и pipeline запросов             | Таблица маршрутов, hooks, plugins, encapsulation, Node listener, объекты request/reply                                                                                            | Адаптер жизненного цикла или провайдера вокруг ресурса, которым владеет Fastify                                            |
| Hono       | Маршрутизация и middleware на Web Standards      | Routes, middleware, sub-apps, `app.fetch`, выбор runtime-адаптера                                                                                                                 | Core App, явный lifecycle ресурсов, внутренние Client/Transport, discovery                                                 |
| Elysia     | Типизированный Web-фреймворк с фокусом на Bun    | Дерево маршрутов, композиция схем, decorators, hooks, Bun- или Web Standard-адаптер                                                                                               | Блоки Core для жизненного цикла и внутренних сервисов при сохранении нативного поведения Elysia                            |
| Koa        | Минимальное Node-ядро middleware                 | Цепочка middleware и Node listener; роутер обычно внешний                                                                                                                         | Жизненный цикл и внутренние сервисные контракты без добавления ещё одного роутера                                          |
| tRPC       | Типобезопасный слой процедур                     | Пути router/procedure, парсеры input/output, context factory, HTTP/Fetch/WS-адаптеры                                                                                              | Владение провайдерами, политика обнаружения сервисов, явный lifecycle App                                                  |
| go-micro   | Go-экосистема микросервисов и агентов            | Go Context, абстракции service/client/transport/registry/broker, экосистема провайдеров и дополнительная область agent/flow/MCP/A2A                                               | go-like заимствует часть словаря, но не Go ABI, goroutine и совместимость транспортов                                      |
| go-kratos  | Go-фреймворк для cloud-native-сервисов           | Жизненный цикл App, Go Context, HTTP/gRPC-транспорты, middleware, registry, config, генерация кода Protobuf                                                                       | go-like использует похожий словарь явного жизненного цикла, но выбирает TypeScript/Web API и не заявляет gRPC/IDL          |
| go-like    | Явные строительные блоки для TypeScript-сервисов | Context, lifecycle App/Server, стандартный Fetch-край, внутренний unary Message transport, Client/Server, Registry/Discovery/Selector, Config/Store/Cache/Broker/Health, adapters | Приложение по-прежнему владеет маршрутами фреймворка, нативными плоскостями данных, бизнес-политикой, auth и deployment    |

Проект не пытается выиграть сравнение «самый большой фреймворк». Вопрос в том, нужны ли приложению явные и компонуемые границы.

## Матрица ответственности

| Область                   | NestJS                                           | Fastify                            | Hono / Elysia / Koa                                     | tRPC                                          | go-like                                                                          |
| ------------------------- | ------------------------------------------------ | ---------------------------------- | ------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| Внешняя таблица маршрутов | Controllers и decorators                         | Fastify instance                   | Экземпляр фреймворка или внешний роутер                 | Procedure router, а не обычные REST-маршруты  | Внешний фреймворк или приложение                                                 |
| Web handler ABI           | Абстракция request/reply, принадлежащая адаптеру | Node request/reply                 | Стандартный Fetch в центре Hono и Web Standard adapters | Fetch/Node/Express/Fastify adapters           | Стандартный `(Request) => Response \| Promise<Response>`                         |
| Жизненный цикл приложения | Application context и hooks                      | `ready`, `listen`, `close`, hooks  | Зависит от runtime adapter и фреймворка                 | Ответственность host/adapter                  | `newApp`, `App.run`, `App.stop`, hooks, структурные Servers                      |
| Жизненный цикл ресурсов   | Hooks контейнера/фреймворка                      | Hooks плагинов и сервера           | Ответственность приложения/runtime                      | Ответственность приложения/adapter            | Явные контракты `Server.start(ctx)` / `stop(ctx)` и владение адаптера            |
| Композиция зависимостей   | Nest container/providers                         | Plugin decoration и encapsulation  | Context/env и композиция; общего DI-контейнера нет      | Явный context factory и композиция router     | Явные конструкторы и functional options; DI-контейнера нет                       |
| Внутренний transport      | Microservice transports и framework adapters     | Не абстракция обнаружения сервисов | Не абстракция обнаружения сервисов                      | Procedure adapters и необязательный WebSocket | `Transport`, `Client`, `Listener`, `Socket`, `Message`                           |
| Discovery и selection     | Зависит от транспорта или внешний                | Внешний                            | Внешние                                                 | Внешние                                       | `Registry`, `Discovery`, `Watcher`, Filters, пять политик Selector               |
| Retry                     | Зависит от фреймворка или провайдера             | Зависит от приложения/плагина      | Зависит от приложения                                   | Зависит от middleware/adapter                 | По умолчанию одна попытка; `withRetry` требует разрешения и общего числа попыток |
| Streaming                 | Зависит от фреймворка/провайдера                 | Node/Web stream choices            | Нативные Web Streams и API фреймворка                   | Зависит от HTTP/WS adapter                    | Публичный Web streaming нативен; внутренний RPC остаётся unary                   |
| Глобальная инструментация | Интеграция фреймворка/провайдера                 | Plugin ecosystem                   | Middleware ecosystem                                    | Middleware/adapters                           | Явные wrappers; глобальные providers не устанавливаются                          |

Подписи в первых пяти строках описывают архитектурную позицию, а не рейтинг качества. Владение таблицей маршрутов полезно, когда именно композиция маршрутов является задачей. Это просто другой выбор ответственности по сравнению с go-like, который оставляет маршруты приложению.

## Жизненный цикл и Context

Текущий исходный код go-like определяет:

```ts
interface Server {
  start(ctx: Context): Promise<void>
  stop(ctx: Context): Promise<void>
}

interface App {
  run(): Promise<void>
  stop(): Promise<void>
}
```

Контракт `Server` структурный. Нативный worker, listener, scheduler, подписка брокера, место назначения логов или провайдер телеметрии могут присоединиться к Core, если адаптер честно описывает момент допуска и конечное состояние.

Context go-like также структурен и внутри использует `AbortSignal`. Он предоставляет `deadline()`, `done()`, `err()` и `value(key)`, а также конструкторы `background`, `withCancel`, `withCancelCause`, `withTimeout`, `withDeadline`, `withoutCancel` и `withValue`.

Это похоже на явный Context-first стиль Go, но не совместимо на уровне ABI с `context.Context`. Здесь нет goroutine, channel или gRPC. Правильный вопрос при миграции — «где через эту границу проходят отмена и владение?», а не «какое имя типа совпадает?».

Core не обещает остановку соседних Servers в обратном порядке. Он параллельно вызывает `stop(ctx)` у соседей, затем дожидается конечных Promise от `start` и объединяет ошибки. У Nest application context, графа плагинов Fastify, lifecycle Elysia или host adapter могут быть другими: порядок и семантика завершения могут отличаться. Сравнивайте фактического владельца, а не одно слово «graceful».

## Transport и вызовы сервисов

Цепочка внутреннего вызова go-like намеренно разложена на части:

```text
Client
  -> Discovery snapshot, optional
  -> ordered Filter callbacks, optional
  -> Selector.select
  -> opaque ServiceEndpoint URL
  -> Transport.dial or resident logical owner
  -> send(Message)
  -> @go-like/server route and unary handler
  -> recv(Message)
  -> feedback and owner release
```

Типизированный `Endpoint` связывает проверку request и response через `Struct` с существующей границей `Message`. Это не IDL и не сгенерированный протокол. `withAddress(...)` обходит Discovery и Selector, поэтому путь с in-process Memory Transport удобен как первый тест.

Транспортные опции NestJS для microservice, procedure adapters tRPC и транспорты Go-фреймворков не являются взаимозаменяемыми с этим DAG. У них могут отличаться identity маршрута, модель сериализации, пул соединений или слой retry. В сравнении нужно фиксировать эти различия, а не считать все варианты «RPC» одинаковыми.

## Область retry и streaming

Самое важное отрицательное различие касается семантики:

- Вызовы go-like по умолчанию делают ровно одну попытку.
- `withRetry(...)` требует `authorization: "idempotent" | "caller-approved"`, положительный `maxAttempts` и `shouldRetry`.
- Authorization — это заявление вызывающей стороны, а не доказательство идемпотентности.
- Retry может выбрать новый endpoint, поскольку каждая попытка заново проходит discovery и selection.
- Ответ, который уже получен, но за которым последовала ошибка feedback или cleanup, не воспроизводится повторно.

Сравнительное исследование Go фиксирует другие значения по умолчанию и возможности: `DefaultRetries` в go-micro — не простое утверждение «пять запросов всего», поскольку граница цикла может дать шесть итераций, когда разрешение на retry остаётся истинным; публичная форма stream и реализация `CloseSend` по умолчанию также различаются у провайдеров. go-kratos сочетает генерацию Protobuf/gRPC с формами HTTP streaming, где у SSE и WebSocket различаются направления и поведение закрытия. Это выбор провайдера и архитектуры, а не недостающие флаги go-like.

Для go-like:

```text
Web framework or Fetch Handler
  -> Web Streams, SSE, or WebSocket behavior owned by the application/framework

go-like internal Client/Transport
  -> one unary Message request and one unary Message response
  -> no full-duplex RPC Stream SPI
```

Web `ReadableStream` — не канал внутреннего RPC. Не сравнивайте потоковое тело HTTP с многофреймовым transport `send`/`recv`, будто это одна и та же возможность.

## Сравнение runtime

| Вопрос о runtime                                                   | Доказательство go-like                                                                                     | Следствие для сравнения                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Может ли общий код использовать Fetch и `AbortSignal`?             | Root Web и выбранные Config/Transport providers используют стандартные Web API или внедрённый Fetch        | Похожие цели переносимости возможны, но типы не эмулируют поведение runtime |
| Может ли один пакет привязать Node listener и Deno listener?       | Runtime-specific subpaths явны; `@go-like/web/node` и `@go-like/transport-http/node` — пути Node           | Не пишите, что «все пакеты без изменений работают везде»                    |
| Может ли Fetch везде передать custom PEM TLS, mTLS, ALPN и HTTP/2? | Нативное поведение принадлежит Node transport subpath; root Fetch path не даёт всех этих настроек          | Сравнивайте возможности host и import paths, а не только имена пакетов      |
| Сохраняет ли приложение роутер фреймворка?                         | Примеры Hono, Elysia и H3 передают нативные Fetch handlers                                                 | go-like дополняет владение маршрутизацией фреймворка                        |
| Доказывает ли версия пакета его публикацию?                        | Root и packages — private/workspace `0.0.1`; документация репозитория говорит, что они ещё не опубликованы | Нельзя делать вывод о доступности в npm или зрелости экосистемы             |

В текущем репозитории есть прямые исходные примеры для Hono, Elysia, H3 и vanilla Fetch. В нём нет актуального NestJS- или Fastify-моста и набора тестов совместимости. Это аудитория для миграции, а не поддерживаемая прямая интеграция.

## Подробное сравнение по инструментам

### NestJS

NestJS — конвенциональный фреймворк приложения. Его modules, providers, controllers, decorators, interceptors, pipes и application hooks образуют цельный контейнер и модель запросов. go-like не предоставляет совместимый с Nest контейнер модулей или мост для controllers.

Разумная граница интеграции — принадлежащий приложению адаптер, который реализует структурный `Server` go-like вокруг приложения Nest или его host. Такой адаптер должен определить, когда Nest допустил listener к работе, как `stop(ctx)` отображается на закрытие Nest и что происходит после timeout. Текущий репозиторий не доказывает наличие такого моста, поэтому документация не должна показывать прямой вызов вроде `newNodeServer(nestApp, ...)`.

### Fastify

Fastify владеет таблицей маршрутов, encapsulation плагинов, hooks и Node listener. Его граф плагинов полезен для сравнения областей видимости зависимостей, но `decorate` не является общим контейнером providers уровня Nest. go-like автоматически не преобразует ABI Fastify `request`/`reply` в Fetch Handler, и в репозитории нет протестированного актуального Fastify-моста.

Оставьте маршруты и плагины Fastify нативными. Если вы внедряете go-like, напишите явный структурный Server вокруг владельца Fastify или отдельно реализуйте Fetch-границу. Не называйте собственные request injection или native shutdown Fastify контрактом go-like Transport или Client.

### Hono

Hono — наиболее ясно показанный пример дополнения. Текущий пример создаёт маршруты в Hono, передаёт `app.fetch` в `newNodeServer` и помещает этот host в Core App. Маршруты и middleware остаются во владении Hono; go-like владеет границей жизненного цикла host, если приложение выбирает такую композицию.

### Elysia

Elysia предоставляет ориентированную на Bun модель композиции маршрутов и схем, а также Web Standard handler в соответствующем adapter path. Сохраните дерево маршрутов Elysia, decorators, derives, hooks, streams и поведение, специфичное для Bun. go-like может владеть App и явной границей ресурса, но не превращает `.listen()` в межruntime API go-like.

### Koa

Koa — небольшое Node-ядро middleware без встроенного роутера. Это хороший пример фреймворка, который намеренно оставляет больше композиции приложения за пределами core. go-like не должен заполнять этот пробел добавлением роутера. Оставьте middleware Koa и внешний роутер нативными, а границу жизненного цикла или внутреннего вызова добавляйте только там, где она нужна.

### tRPC

tRPC владеет типобезопасным procedure router и middleware процедур. Он может использовать Fetch, Node, Express, Fastify или WebSocket adapters, но не является Registry, Selector, connection pool или менеджером жизненного цикла приложения. Типизированный `Endpoint` go-like — это меньшая runtime-привязка `Struct` к унарным `Message`, а не конкурирующий procedure DSL или сгенерированный IDL.

### go-micro и go-kratos

Эти проекты Go полезны как архитектурные ориентиры для Context-first вызовов, жизненного цикла сервисов, Registry, Discovery, Selector и транспортной терминологии. Они не являются целями совместимости:

- Go `context.Context` и go-like `Context` разделяют намерение явной отмены, но их runtime-представления различаются.
- Модель Registry watcher в go-micro и полные снимки-замены go-like не следует описывать как одинаковые потоки событий.
- Protobuf/gRPC и сгенерированный код go-kratos — архитектурный выбор, который go-like прямо не заявляет.
- Значения по умолчанию провайдеров go-micro и go-kratos, retry loops, half-close streams и default selectors зависят от версии. Используйте таблицу зафиксированных upstream commit в исследовательской записи и проверяйте её заново перед публикацией новой сравнительной версии.

## Что выбрать

| Если основная задача —...                      | Начните с...           | Добавляйте go-like, когда...                                                                         |
| ---------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Controllers, modules, decorators и DI          | NestJS                 | нужна явная граница вокруг существующего ресурса или внутреннего вызова и вы готовы написать адаптер |
| Node HTTP routes, hooks и plugin encapsulation | Fastify                | нужна композиция lifecycle за пределами host или внутренние сервисные контракты                      |
| Web Standards routes между runtime             | Hono                   | нужны lifecycle App/Server, внутренние вызовы или владение провайдерами                              |
| Bun-first schema и route composition           | Elysia                 | нужны явные границы lifecycle и transport при сохранении Elysia                                      |
| Минимальное Node middleware                    | Koa плюс роутер        | нужен недостающий контракт жизненного цикла или внутреннего вызова, а не ещё один роутер             |
| Типобезопасные процедуры                       | tRPC                   | также нужны явные service discovery, владение провайдерами или Core lifecycle                        |
| Go-стек микросервисов                          | go-micro или go-kratos | вы строите отдельную TypeScript-композицию, а не source-совместимый порт                             |
| Межruntime TypeScript building blocks сервисов | go-like                | используйте только те пакеты и провайдеры, которые решают нужную границу                             |

Правильным ответом может быть использование обеих систем. go-like особенно полезен, когда его явная модель владения устраняет реальную неоднозначность; добавление всех пакетов в уже полноценное приложение-фреймворк противоречит цели небольших строительных блоков.

## Опорные точки доказательств

Утверждения о go-like на этой странице можно проследить по текущему дереву и entrypoint пакетов:

- `README.md` — область продукта и явные исключения;
- `packages/core/src/app.ts` — `App`, `Server`, запуск, остановка и поведение timeout;
- `packages/web/src/context.ts` — стандартный Handler и мост Context;
- `packages/client/src/index.ts` — опции Client, pooling, retry и pipeline попытки;
- `packages/server/src/index.ts` — внутренние унарные handlers и dispatch маршрутов;
- `packages/transport/src/types.ts` и `packages/transport/src/endpoint.ts` — границы Message и Endpoint;
- `packages/registry/src/types.ts` и `packages/registry/src/selector.ts` — snapshots, filters, selectors и feedback.

В исследовательской записи также сохранены следующие зафиксированные внешние входные данные для сравнения:

- [зафиксированный в репозитории commit сравнения go-micro](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d);
- [commit сравнения go-kratos v3](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e);
- [commit сравнения go-zlab/go-kratos](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336);
- [документация NestJS о lifecycle](https://docs.nestjs.com/fundamentals/lifecycle-events), [справочник Fastify Server](https://fastify.dev/docs/latest/Reference/Server/), [API Hono](https://hono.dev/docs/api/hono), [lifecycle Elysia](https://elysiajs.com/essential/life-cycle), [Koa](https://koajs.com/) и [routers tRPC](https://trpc.io/docs/server/routers).

URL выше — сравнительные источники, а не утверждение, что в рамках этой фазы документации каждая upstream-страница была загружена или повторно проверена. Перед изменением формулировки, зависящей от версии, заново проверьте release tags или commits.
