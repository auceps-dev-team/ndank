import { defineConfig } from "tsup";

/**
 * Ndank — de la source au paquet.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI IL A FALLU UNE ÉTAPE DE CONSTRUCTION
 *
 * Jusqu'ici `package.json` pointait sur `./src/moteur.ts` : du TypeScript brut.
 * Cela fonctionne dans le dépôt et nulle part ailleurs. Un hôte qui installe
 * `ndank` reçoit alors des fichiers que ni Node ni la plupart des empaqueteurs
 * ne savent charger sans configuration supplémentaire — et cette configuration,
 * il faut la deviner.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ESM ET CJS, ET LE SECOND N'EST PAS DU ZÈLE
 *
 * Le paquet est `type: module`, donc l'ESM est la forme native. Mais une part
 * considérable des services Node en production tourne encore en CommonJS —
 * Express au premier chef, qui est ce que la plupart des équipes de la zone ont
 * sous la main. `require("ndank")` doit marcher, sans quoi la première minute
 * d'intégration se passe à lire une erreur de module.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CHAQUE FICHIER EST UN POINT D'ENTRÉE, ET NON UN SEUL PAQUET
 *
 * `splitting: false` et une entrée par fichier : un hôte qui n'importe que
 * `ndank/gsm7` ne doit pas emporter les adaptateurs de paiement, ni le rendu
 * HTML de la page.
 *
 * Cela vaut surtout pour `ndank/prisma`, qui décrit la forme d'un client Prisma
 * : le paquet n'en dépend pas, et un hôte du niveau 1 ne doit rien en voir.
 */
export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm", "cjs"],
  // Les types sont la moitié de ce que ce paquet livre : les ports, les
  // contrats, ce qu'un hôte doit implémenter. Sans eux il reste un manuel.
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  // `node:crypto` et `fetch` : ce paquet ne tourne pas dans un navigateur, et
  // viser plus bas que Node 18 reviendrait à empaqueter des replis pour des
  // API qui existent partout où il tournera.
  target: "node18",
  treeshake: true,
});
