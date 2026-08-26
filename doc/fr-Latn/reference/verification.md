# Vérification

go-like utilise plusieurs evidence lanes ; il ne faut pas réduire tous les résultats à deux catégories de tests. `bun run test:unit` exécute les tests unitaires déterministes sans service externe. `bun run test:e2e` construit les paquets et vérifie localement les fournisseurs réels, plusieurs runtimes, les exemples exécutables et la consommation des tarballs publiés. Les suites Docker démarrent de vrais services et suppriment les ressources qu’elles créent.

Formatage, Lint, types, build, Runtime E2E, Provider E2E, Example E2E, Published, Soak, Documentation build et Audit doivent être consignés séparément. `test:unit:coverage` ne produit qu’un rapport facultatif ; consultez la [Vérification canonique en anglais](/reference/verification) pour les lanes, le baseline historique et le run record documentaire.

```sh
bun run test:unit
bun run test:e2e
bun run test:e2e:soak
```

`test:unit:coverage` ne produit qu’un rapport facultatif. `bun run lint` vérifie les règles statiques d’Oxlint ; il ne remplace ni la vérification des types ni l’exécution du comportement runtime. `fmt`, `lint`, `typecheck`, `build`, `audit` et `doc:build` sont des commandes d’ingénierie, pas d’autres catégories de tests. `doc:build` vérifie les routes VitePress anglaises et localisées configurées ; il ne prouve ni le rendu navigateur ni la parité de traduction. L’existence d’une commande ne prouve pas sa réussite ; vérifiez l’état terminal et les journaux de l’exécution courante. Consultez la [Vérification canonique en anglais](/reference/verification) pour les lanes, le baseline historique et le run record documentaire.
