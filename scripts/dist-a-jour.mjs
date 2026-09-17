import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Ndank — le `dist` est-il plus vieux que la source ?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CE SCRIPT EXISTE : DEUX INCIDENTS EN DEUX JOURS
 *
 * Le 16 puis le 17 septembre 2026, Ndank App a mesuré qu'un champ annoncé livré
 * ne leur parvenait pas. Les deux fois, la cause était la même :
 *
 *     dist/projection.js   11:03:43   ← la reconstruction
 *     src/projection.ts    11:05:32   ← l'édition, deux minutes après
 *
 * On reconstruit, puis on modifie la source, puis on commite. Le paquet livré
 * est en retard, et **rien dans la vérification habituelle ne le dit** :
 *
 *   — `tsc --noEmit` lit la source. Vert ;
 *   — les tests importent par chemins relatifs — `./projection`. Verts ;
 *   — `dist/` est dans `.gitignore`, donc le diff ne montre rien ;
 *   — et chez le consommateur, `file:../ndank` lit le paquet **construit**,
 *     pas la source. Son propre typecheck reste vert lui aussi — il compare son
 *     schéma à un `.d.ts` où le champ n'existe pas encore.
 *
 * Quatre voyants au vert, et un champ qui n'arrive nulle part.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QU'IL NE REMPLACE PAS
 *
 * `epreuve-paquet.mjs` fait `npm pack` et installe dans des projets vides : il
 * vérifie que les chemins d'export résolvent. Mais il emballe le `dist` tel
 * qu'il est — un `dist` périmé s'installe parfaitement.
 *
 * Et `prepack` ne sauve pas non plus le cas qui nous a mordus : un consommateur
 * en `file:` ne passe par aucun emballage.
 *
 * **Seule la comparaison des dates attrape ça.** C'est aussi la méthode par
 * laquelle Ndank App s'en est aperçu, deux fois — comparer les dates, pas les
 * numéros de version.
 */

const IGNORE = new Set(["node_modules", ".git", "dist"]);

/** Le fichier le plus récent sous `racine`, filtré par `garder`. */
function plusRecent(racine, garder) {
  let record = { chemin: null, quand: 0 };

  const parcourir = (dossier) => {
    for (const entree of readdirSync(dossier, { withFileTypes: true })) {
      if (IGNORE.has(entree.name)) continue;
      const chemin = join(dossier, entree.name);

      if (entree.isDirectory()) {
        parcourir(chemin);
        continue;
      }

      if (!garder(entree.name)) continue;

      const quand = statSync(chemin).mtimeMs;
      if (quand > record.quand) record = { chemin, quand };
    }
  };

  parcourir(racine);
  return record;
}

const heure = (ms) =>
  new Date(ms).toISOString().replace("T", " ").slice(0, 19);

// Les tests ne partent pas dans le paquet : les compter ferait échouer sur une
// modification qui ne change rien à ce que reçoit l'hôte.
const source = plusRecent("src", (n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));
const sortie = plusRecent("dist", (n) => n.endsWith(".js") || n.endsWith(".d.ts"));

if (sortie.chemin === null) {
  console.error("Ndank — aucun `dist`. Lancez `npm run build`.");
  process.exit(1);
}

if (source.quand <= sortie.quand) {
  console.log(
    `Ndank — le paquet est à jour.\n` +
      `  source la plus récente : ${relative(".", source.chemin)}  ${heure(source.quand)}\n` +
      `  sortie la plus récente : ${relative(".", sortie.chemin)}  ${heure(sortie.quand)}`,
  );
  process.exit(0);
}

console.error(
  `Ndank — LE PAQUET EST EN RETARD SUR LA SOURCE.\n\n` +
    `  ${relative(".", source.chemin)}\n` +
    `    modifié  ${heure(source.quand)}\n` +
    `  ${relative(".", sortie.chemin)}\n` +
    `    construit ${heure(sortie.quand)}\n\n` +
    `Un consommateur en \`file:../ndank\` lit \`dist/\`, pas \`src/\` — il ne\n` +
    `recevra donc pas ce que vous venez d'écrire. Son typecheck restera vert,\n` +
    `parce qu'il compare son code à un \`.d.ts\` où le champ n'existe pas.\n\n` +
    `  npm run build\n`,
);
process.exit(1);
