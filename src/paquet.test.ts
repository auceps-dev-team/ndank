import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ce que le paquet promet, vérifié depuis le dépôt.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CES TROIS DÉFAUTS-LÀ NE SE VOIENT QU'À L'INSTALLATION
 *
 * Et « à l'installation » veut dire : chez quelqu'un d'autre, après publication.
 * C'est trop tard, et une version partie sur un registre se reprend mal.
 *
 *   — **un module ajouté et jamais exporté.** Il est écrit, il est testé, il
 *     compile — et personne ne peut l'importer. Rien dans le dépôt ne le dit,
 *     parce que les tests, eux, l'importent par un chemin relatif ;
 *
 *   — **un fichier renommé, l'export laissé derrière.** `npm install` réussit,
 *     l'import échoue à l'exécution ;
 *
 *   — **une dépendance de production qui s'installe par mégarde.** C'est la
 *     promesse centrale de Ndank : le cœur ne dépend de rien. Un
 *     `npm install --save` distrait la brise sans que rien ne proteste.
 */

// `fileURLToPath` et non un découpage à la main : le chemin du dépôt contient
// une espace, qu'une URL encode en `%20`. Le lire comme un chemin le rendait
// introuvable — sur cette machine-ci, et sur toute autre dont le dossier a un
// nom composé.
const racine = fileURLToPath(new URL("..", import.meta.url));
const paquet = JSON.parse(
  readFileSync(join(racine, "package.json"), "utf8"),
) as {
  exports: Record<string, unknown>;
  dependencies?: Record<string, string>;
  files: string[];
};

/** Le chemin source correspondant à une cible de `dist`. */
function source(cible: string): string {
  return join(
    racine,
    cible.replace(/^\.\/dist\//, "src/").replace(/\.(js|cjs|d\.ts|d\.cts)$/, ".ts"),
  );
}

/** Tous les fichiers de `src`, hors tests. */
function modules(dossier = join(racine, "src"), prefixe = ""): string[] {
  const trouves: string[] = [];

  for (const entree of readdirSync(dossier)) {
    const chemin = join(dossier, entree);

    if (statSync(chemin).isDirectory()) {
      trouves.push(...modules(chemin, `${prefixe}${entree}/`));
      continue;
    }

    if (entree.endsWith(".test.ts")) continue;
    if (!entree.endsWith(".ts")) continue;

    trouves.push(`${prefixe}${entree}`);
  }

  return trouves;
}

/**
 * Les modules qui n'ont volontairement pas de chemin d'import.
 *
 * Un hôte n'a aucune raison de les atteindre : ils sont des détails de leurs
 * couches, et les exporter figerait leur forme.
 */
const INTERNES = new Set([
  "encaissement/fournisseurs/directs.ts",
  "encaissement/fournisseurs/flutterwave.ts",
  "encaissement/fournisseurs/mtn.ts",
  "encaissement/fournisseurs/paystack.ts",
  "encaissement/signature.ts",
  "envoi/transporteurs/appel.ts",
  "envoi/transporteurs/brevo.ts",
  "envoi/transporteurs/expo.ts",
  "envoi/transporteurs/fondations.ts",
  "envoi/transporteurs/resend.ts",
  "envoi/transporteurs/twilio.ts",
  "page/rendu.ts",
  "page/vue.ts",
  "prisma/client.ts",
]);

describe("ce que le paquet expose", () => {
  it("ne pointe que sur des fichiers qui existent", () => {
    // Le défaut du fichier renommé : `npm install` réussit, l'import échoue à
    // l'exécution, chez quelqu'un d'autre.
    for (const [nom, valeur] of Object.entries(paquet.exports)) {
      if (typeof valeur === "string") {
        expect(existsSync(join(racine, valeur)), `${nom} → ${valeur}`).toBe(true);
        continue;
      }

      const conditions = valeur as Record<string, Record<string, string>>;

      for (const forme of Object.values(conditions)) {
        for (const cible of Object.values(forme)) {
          expect(existsSync(source(cible)), `${nom} → ${cible}`).toBe(true);
        }
      }
    }
  });

  it("donne un chemin à tout module qui n'est pas déclaré interne", () => {
    // Le défaut du module ajouté et jamais exporté : il est écrit, testé, il
    // compile — et personne ne peut l'importer. Les tests ne le voient pas,
    // puisqu'ils l'importent par un chemin relatif.
    const exportes = new Set<string>();

    for (const valeur of Object.values(paquet.exports)) {
      if (typeof valeur === "string") continue;

      const conditions = valeur as Record<string, Record<string, string>>;
      const premier = Object.values(conditions)[0]?.["default"];
      if (!premier) continue;

      exportes.add(premier.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts"));
    }

    const orphelins = modules().filter(
      (m) => !exportes.has(m) && !INTERNES.has(m),
    );

    expect(orphelins).toEqual([]);
  });

  it("livre le schéma du niveau 2, que le README dit d'aller chercher", () => {
    // Il était absent de `files` : le README annonçait `prisma/schema.prisma`,
    // et le paquet ne le contenait pas.
    expect(paquet.files).toContain("prisma/schema.prisma");
    expect(paquet.exports["./schema.prisma"]).toBe("./prisma/schema.prisma");
  });
});

describe("ce dont le paquet dépend", () => {
  it("ne dépend de rien, et c'est la promesse centrale", () => {
    // Un `npm install --save` distrait la brise sans que rien ne proteste. Ce
    // test est le seul garde-fou : il n'y a pas d'autre endroit où cela se
    // verrait avant que quelqu'un ne l'installe.
    expect(paquet.dependencies ?? {}).toEqual({});
  });

  it("n'emporte pas la source ni les tests", () => {
    expect(paquet.files).not.toContain("src");
    expect(paquet.files.some((f) => f.includes("test"))).toBe(false);
  });
});
