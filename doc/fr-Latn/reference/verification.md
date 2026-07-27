# Vérification

LikeGo ne distingue que deux catégories de tests. `bun run test:unit` exécute les tests unitaires déterministes sans service externe. `bun run test:e2e` construit les paquets et vérifie localement les fournisseurs réels, plusieurs runtimes, les exemples exécutables et la consommation des tarballs publiés. Les suites Docker démarrent de vrais services et suppriment les ressources qu’elles créent.

La CI se limite à l’installation, au formatage, aux types, au build et aux tests unitaires. Les E2E Docker, multi-runtime, exemples et soak s’exécutent localement :

```sh
bun run test:unit
bun run test:e2e
bun run test:e2e:soak
```

`test:unit:coverage` ne produit qu’un rapport facultatif. `fmt`, `typecheck`, `build`, `audit` et `doc:build` sont des commandes d’ingénierie, pas d’autres catégories de tests. L’existence d’une commande ne prouve pas sa réussite ; vérifiez l’état terminal et les journaux de l’exécution courante.
