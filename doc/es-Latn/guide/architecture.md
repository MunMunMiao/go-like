# Arquitectura

go-like se publica como paquetes planos e independientes, no como un contenedor gigante que pretende hacerlo todo. `@go-like/core` compone la aplicación y sus ciclos de vida; `@go-like/context` transporta cancelación, plazos, causas y valores; cada SPI restante define un solo dominio, con sus implementaciones en paquetes de proveedor separados.

Hay varios planos fáciles de ubicar: aplicación para arranque, admisión, hooks y estado terminal; Core llama en paralelo a `stop(ctx)` de cada sibling Server, espera el terminal result de cada uno y después reúne los lifecycle failures; no garantiza detenerlos en el orden inverso a su declaración. Los componentes que necesitan un orden de cierre deben componerlo dentro de un solo `Server`. Las llamadas cubren descubrimiento, selección, cliente, proyección del servidor y transporte; los eventos cubren broker y codec tipado; las operaciones agrupan configuración, Store, salud, métricas, trazas y logs; y el borde Web recibe handlers Fetch públicos, separado del transporte interno.

Las dependencias apuntan hacia contratos portables. Un proveedor puede usar un SDK oficial o un host de runtime, pero el SPI no depende de vuelta de esa implementación. Por eso la misma composición puede ejecutarse en Bun, Node.js, Deno u otro backend compatible con Web API.

No hay localizador global de servicios. La aplicación construye y pasa cada dependencia. Son unas líneas de montaje de más, sí, pero dejan clarísimo quién posee conexiones, watchers, listeners y tareas de apagado.

> [!NOTE]
> Esta página es un resumen localizado para orientarse rápido. La [página canónica en inglés](/guide/architecture) contiene el DAG completo de ciclo de vida, el mapa de ownership y las diferencias por provider; este resumen no promete paridad universal entre runtimes.

## Mapa de request y ciclo de vida

```text
application composition root
  -> Context: cancelación / deadline / valores
  -> Core App: admisión / hooks / resultado de stop
  -> Web Handler -> runtime host -> listener
  -> Client interno -> Discovery -> Selector -> Transport -> Server

App.stop()
  -> deregister de la instancia admitida
  -> cancelación del runtime del Server
  -> llamadas concurrentes a Server.stop
  -> joins terminales -> un resultado
```

`Server.start(ctx)` no equivale a readiness. Usa `endpoint(ctx)` o un hook `afterStart` como señal de admisión. Core tampoco promete apagar los Servers hermanos en orden inverso; si el orden importa, compón esos recursos dentro de un `Server` o hook explícito.
