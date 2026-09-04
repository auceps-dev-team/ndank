import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * Ndank — l'épreuve d'installation.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI LES TESTS NE SUFFISENT PAS ICI
 *
 * Les 347 tests du dépôt importent par des chemins relatifs : `./cycle`,
 * `../ports`. Ils ne passent jamais par `package.json`, donc ils ne peuvent
 * rien dire de ce qu'un hôte recevra.
 *
 * Trois défauts leur échappent entièrement, et les trois se manifestent chez
 * quelqu'un d'autre, après publication :
 *
 *   — un chemin d'export qui pointe à côté ;
 *   — un format que l'hôte ne sait pas charger — `require("ndank")` dans un
 *     projet CommonJS, ce qui décrit une bonne part des services Node en
 *     production ;
 *   — un fichier oublié dans `files`, comme le schéma Prisma, que le README
 *     dit pourtant d'aller chercher.
 *
 * Ce script fait ce que fera l'hôte : `npm pack`, puis `npm install` du
 * paquet dans deux projets vides, puis un import de chaque chemin public.
 */

const racine = process.cwd();

function courir(commande, args, dossier) {
  return execFileSync(commande, args, {
    cwd: dossier,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
}

console.log("→ empaquetage");

// Aucun argument ne porte de chemin absolu, et ce n'est pas de la coquetterie :
// sous Windows, `npm` est un `.cmd`, donc il faut passer par un shell — et le
// shell découpe un chemin qui contient une espace. « C:\Users\Ecrabet Joas »
// devient deux arguments, et l'erreur qui remonte parle d'un `package.json`
// introuvable dans un dossier inventé de toutes pièces.
//
// On travaille donc en chemins relatifs, avec le bon dossier en `cwd`.
courir("npm", ["pack"], racine);

const archive = readdirSync(racine).find(
  (f) => f.startsWith("ndank-") && f.endsWith(".tgz"),
);

if (!archive) throw new Error("aucune archive produite par `npm pack`");

/** Les chemins publics, écrits ici plutôt que lus : c'est le contrat, pas son reflet. */
const CHEMINS = [
  "ndank",
  "ndank/cycle",
  "ndank/etats",
  "ndank/ports",
  "ndank/http",
  "ndank/web",
  "ndank/dossier",
  "ndank/html",
  "ndank/gsm7",
  "ndank/reglement",
  "ndank/encaissement",
  "ndank/encaissement/registre",
  "ndank/encaissement/reconciliation",
  "ndank/envoi",
  "ndank/envoi/port",
  "ndank/envoi/redaction",
  "ndank/envoi/registre",
  "ndank/page",
  "ndank/page/lien",
  "ndank/page/port",
  "ndank/page/montage",
  "ndank/webhook",
  "ndank/api",
  "ndank/api/tableau",
  "ndank/prisma",
];

function eprouver(forme) {
  const esm = forme === "esm";
  const dossier = mkdtempSync(join(tmpdir(), `ndank-${forme}-`));

  writeFileSync(
    join(dossier, "package.json"),
    JSON.stringify({
      name: `hote-${forme}`,
      private: true,
      ...(esm ? { type: "module" } : {}),
    }),
  );

  copyFileSync(join(racine, archive), join(dossier, archive));

  console.log(`→ ${forme} : installation`);
  courir("npm", ["install", `./${archive}`, "--no-audit", "--no-fund"], dossier);

  const lignes = esm
    ? CHEMINS.map((c, i) => `import * as m${i} from "${c}";`)
    : CHEMINS.map((c, i) => `const m${i} = require("${c}");`);

  // On ne se contente pas d'importer : on appelle. Un module qui se charge
  // mais dont l'export est `undefined` passerait un simple import.
  const verification = esm
    ? `
import { cycleApresPaiement, ajouterJours } from "ndank/cycle";
import { etatDe } from "ndank/etats";
import { referenceDeVersement } from "ndank/encaissement/reconciliation";
import { lienDe, lireLien } from "ndank/page/lien";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
`
    : `
const { cycleApresPaiement, ajouterJours } = require("ndank/cycle");
const { etatDe } = require("ndank/etats");
const { referenceDeVersement } = require("ndank/encaissement/reconciliation");
const { lienDe, lireLien } = require("ndank/page/lien");
`;

  const essai = `${lignes.join("\n")}
${verification}
const cycle = cycleApresPaiement(ajouterJours(new Date(), -32), "MENSUEL");
const etat = etatDe({ cycle, resilieeLe: null }, new Date());
if (etat !== "A_RENOUVELER") throw new Error("état inattendu : " + etat);

const ref = referenceDeVersement("ab-1", cycle.echeance, 0);
if (!/^\\d{8}-\\d+-ab-1$/.test(ref)) throw new Error("référence inattendue : " + ref);

const lien = lienDe("https://p.test/v", "un-secret", "ab-1");
if (!lireLien("un-secret", lien.split("/v/")[1]).valide) throw new Error("lien illisible");

// Le schéma du niveau 2 doit être dans le paquet : le README dit d'aller le
// chercher, et il n'y était pas jusqu'à la 0.8.0.
require.resolve("ndank/schema.prisma");

console.log("  ✓ ${CHEMINS.length} chemins, ${forme}");
`;

  const fichier = join(dossier, esm ? "essai.mjs" : "essai.cjs");
  writeFileSync(fichier, essai);

  process.stdout.write(courir("node", [basename(fichier)], dossier));
}

eprouver("esm");
eprouver("cjs");

console.log("→ le paquet s'installe et se charge dans les deux formes");
