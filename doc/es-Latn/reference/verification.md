# Verificación

Que pasen los tests unitarios es una prueba concreta, no una garantía universal. Los paquetes portables ejecutan TypeScript estricto, políticas de fuente, cobertura del código de producción, build y smoke tests del paquete publicado. Cuando el contrato lo requiere, también hay carriles separados para Bun, Node.js y Deno.

Los proveedores externos se prueban con contenedores reales fijados por digest inmutable. Las suites crean recursos auténticos de Consul, etcd, NATS, OpenTelemetry Collector, Redis/BullMQ, ZooKeeper y Kubernetes/K3s, comprueban el comportamiento y verifican la limpieza. Un fake sirve para casos deterministas, pero nunca sustituye la puerta de protocolo real.

La única puerta raíz completa que bloquea una publicación es:

```sh
bun run verify
```

Cada proveedor guarda sus comandos Docker y verificaciones más estrechas en su propio `package.json`, y emite resultados legibles por máquinas. Son diagnósticos útiles, pero no sustituyen la puerta raíz completa. El estado de publicación lo determina únicamente el resultado terminal de la última ejecución completa de `bun run verify`; también hay que revisar el contenido generado, los manifests del workspace, la retirada de recursos Docker y `git status`. Lanzar un comando no significa que haya terminado bien.
