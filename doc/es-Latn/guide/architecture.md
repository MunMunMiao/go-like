# Arquitectura

LikeGo se publica como paquetes planos e independientes, no como un contenedor gigante que pretende hacerlo todo. `@likego/core` compone la aplicación y sus ciclos de vida; `@likego/context` transporta cancelación, plazos, causas y valores; cada SPI restante define un solo dominio, con sus implementaciones en paquetes de proveedor separados.

Hay varios planos fáciles de ubicar: aplicación para arranque, admisión, agregación de los resultados del apagado concurrente mediante `Promise.allSettled`, hooks y estado terminal; llamadas para descubrimiento, selección, cliente, proyección del servidor y transporte; eventos para broker y codec tipado; operaciones para configuración, Store, salud, métricas, trazas y logs; y el borde Web para handlers Fetch públicos, separado del transporte interno. Los componentes que necesitan un orden de cierre deben componerlo dentro de un solo `Server`.

Las dependencias apuntan hacia contratos portables. Un proveedor puede usar un SDK oficial o un host de runtime, pero el SPI no depende de vuelta de esa implementación. Por eso la misma composición puede ejecutarse en Bun, Node.js, Deno u otro backend compatible con Web API.

No hay localizador global de servicios. La aplicación construye y pasa cada dependencia. Son unas líneas de montaje de más, sí, pero dejan clarísimo quién posee conexiones, watchers, listeners y tareas de apagado.
