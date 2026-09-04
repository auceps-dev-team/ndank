import { JOURS_DE_CADENCE, type Cadence } from "./cycle";

/**
 * Ndank — la grille tarifaire.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ELLE N'EST PAS UNE TABLE, ELLE EST UNE DÉCLARATION
 *
 * Le schéma du niveau 2 porte bien un modèle `Offre`, mais rien dans le code ne
 * le lisait — c'était une table sans lecteur. Et un hôte du niveau 1, qui n'a
 * pas ce schéma, n'avait aucun endroit où dire ce qu'il vend.
 *
 * Une grille se déclare donc en code, à côté du reste de la configuration :
 *
 *     const GRILLE = grille([
 *       { id: "createur", libelle: "Pass Créateur", montant: 2000,
 *         devise: "XOF", cadence: "MENSUEL" },
 *       { id: "pro", libelle: "Pass Pro", montant: 20000,
 *         devise: "XOF", cadence: "ANNUEL" },
 *     ]);
 *
 * L'hôte qui préfère la tenir en base lit ses lignes et les passe à `grille()`.
 * Dans les deux cas, la vérification est la même — et c'est elle qui compte.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE PIÈGE DES UNITÉS MINEURES, DIT ICI PARCE QUE C'EST ICI QU'ON SE TROMPE
 *
 * Les montants sont en **unités mineures**, en `Int`, partout dans Ndank et
 * chez tous les fournisseurs. Mais « unité mineure » ne veut pas dire
 * « centime » :
 *
 *   — le **franc CFA** (XOF, XAF) n'a pas de subdivision en circulation. Deux
 *     mille francs s'écrivent `2000`. Pas `200000` ;
 *   — le **cedi** (GHS), le **naira** (NGN), le **shilling** (KES) en ont deux.
 *     Vingt cedis s'écrivent `2000`.
 *
 * L'erreur classique vient d'un système à carte qu'on transpose : on y écrivait
 * des centimes, on multiplie par cent par réflexe, et l'abonné est débité de
 * deux cent mille francs. Ce n'est pas une erreur d'affichage — c'est un vrai
 * débit, chez un vrai opérateur, sur le téléphone d'une vraie personne.
 *
 * Aucune vérification ne peut l'attraper : `200000` est un montant valide.
 * D'où ce paragraphe, à l'endroit exact où l'on tape le chiffre.
 */

/** Ce qu'on vend, et à quel rythme. */
export interface Offre {
  /** L'identifiant que l'hôte lui donne. Stable : il voyage dans les références. */
  id: string;
  /** Ce que l'abonné lit, dans la relance et sur la page. */
  libelle: string;
  /** En unités mineures. Voir l'en-tête — c'est là qu'on se trompe. */
  montant: number;
  /** Code ISO 4217, trois lettres majuscules. `XOF`, `XAF`, `GHS`, `NGN`. */
  devise: string;
  cadence: Cadence;
  /**
   * Une offre retirée du catalogue reste ici.
   *
   * On ne supprime pas une offre : des abonnements en cours la référencent, et
   * leur libellé comme leur montant en dépendent. `actif: false` la retire de ce
   * qu'on propose, sans rien casser de ce qui existe.
   */
  actif?: boolean;
}

/** Une grille vérifiée. Le type ne dit rien de plus, la fabrique si. */
export type Grille = readonly Offre[];

/** Un défaut d'une grille, dit en clair. */
export interface DefautGrille {
  offre: string;
  probleme: string;
}

/**
 * Ce que les gens écrivent, et ce qu'il fallait écrire.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * « CFA » PASSE LA RÈGLE DE FORME, ET C'EST CE QUI LE REND DANGEREUX
 *
 * Trois lettres, majuscules : une vérification de forme le laisse passer. Ce
 * n'est pourtant pas un code ISO 4217 — le franc CFA s'écrit `XOF` en Afrique
 * de l'Ouest et `XAF` en Afrique centrale, et les deux ne valent pas la même
 * chose malgré la parité.
 *
 * C'est l'erreur la plus probable dans la zone que Ndank sert, parce que
 * personne n'écrit « XOF » sur une facture. Flutterwave et Paystack la
 * refusent, avec un message qui parle de devise non prise en charge — et l'on
 * cherche du côté du compte marchand, pas du côté de la grille.
 *
 * La liste reste courte à dessein : on ne vérifie pas ce qu'on ne connaît pas.
 * Un code inconnu de cette table et bien formé est accepté, et c'est le
 * fournisseur qui tranchera.
 */
const CONFUSIONS: Readonly<Record<string, string>> = {
  CFA: "XOF (Afrique de l'Ouest) ou XAF (Afrique centrale)",
  XFA: "XOF (Afrique de l'Ouest) ou XAF (Afrique centrale)",
  GHC: "GHS pour le cedi ghanéen",
  NAI: "NGN pour le naira",
  EUR0: "EUR",
};

/**
 * Dit ce qui ne va pas, sans rien construire.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CHACUNE DE CES RÈGLES A UN COÛT RÉEL SI ON LA VIOLE
 *
 * Ce ne sont pas des vérifications de politesse :
 *
 *   — **un montant non entier** traverse `Int` chez le fournisseur et se fait
 *     arrondir, ou refuser, selon lequel. `2000.5` devient `2000` ou une
 *     erreur 400 dont le message parle de format ;
 *   — **un montant nul ou négatif** produit une demande de paiement que le
 *     fournisseur rejette — et la relance qui l'accompagnait est perdue ;
 *   — **une devise mal écrite** (`xof`, `CFA`, `FCFA`) est refusée par
 *     Flutterwave et Paystack, qui attendent l'ISO 4217 en majuscules ;
 *   — **deux offres au même identifiant** font que `offreDe()` en rend une
 *     seule, arbitrairement. L'abonné paie l'une et reçoit l'autre ;
 *   — **une cadence inconnue** ne se rattrape nulle part : `cycleApresPaiement`
 *     lèverait, mais au moment de renouveler, c'est-à-dire un mois plus tard.
 */
export function verifierGrille(offres: readonly Offre[]): DefautGrille[] {
  const defauts: DefautGrille[] = [];
  const vus = new Set<string>();

  for (const offre of offres) {
    const nom = offre.id || "(sans identifiant)";

    if (!offre.id || offre.id.trim() === "") {
      defauts.push({ offre: nom, probleme: "identifiant vide" });
    } else if (vus.has(offre.id)) {
      defauts.push({ offre: nom, probleme: "identifiant en double" });
    } else {
      vus.add(offre.id);
    }

    if (!offre.libelle || offre.libelle.trim() === "") {
      // Il part dans le SMS et dans le courriel. Vide, l'abonné reçoit une
      // demande de paiement sans savoir pour quoi.
      defauts.push({ offre: nom, probleme: "libellé vide" });
    }

    if (!Number.isInteger(offre.montant)) {
      defauts.push({
        offre: nom,
        probleme: `montant non entier (${offre.montant}) — les unités mineures sont des entiers`,
      });
    } else if (offre.montant <= 0) {
      defauts.push({ offre: nom, probleme: `montant nul ou négatif (${offre.montant})` });
    }

    const bonne = CONFUSIONS[offre.devise?.toUpperCase() ?? ""];

    if (bonne !== undefined) {
      // Celle-ci passe la règle de forme — trois lettres majuscules — et c'est
      // précisément ce qui la rend dangereuse.
      defauts.push({
        offre: nom,
        probleme: `devise « ${offre.devise} » n'est pas un code ISO 4217 : ${bonne}`,
      });
    } else if (!/^[A-Z]{3}$/.test(offre.devise)) {
      defauts.push({
        offre: nom,
        probleme: `devise « ${offre.devise} » — attendu un code ISO 4217 en majuscules, par exemple XOF`,
      });
    }

    if (!(offre.cadence in JOURS_DE_CADENCE)) {
      defauts.push({
        offre: nom,
        probleme: `cadence « ${offre.cadence} » inconnue — attendu ${Object.keys(JOURS_DE_CADENCE).join(", ")}`,
      });
    }
  }

  return defauts;
}

/** Ce qu'une grille refusée porte, pour que le message dise tout. */
export class GrilleInvalide extends Error {
  constructor(readonly defauts: readonly DefautGrille[]) {
    super(
      `Grille tarifaire invalide :\n` +
        defauts.map((d) => `  — ${d.offre} : ${d.probleme}`).join("\n"),
    );
    this.name = "GrilleInvalide";
  }
}

/**
 * Construit la grille, ou refuse en disant tout ce qui cloche.
 *
 * Elle lève au **démarrage**, pas au premier abonné. C'est la même règle que
 * pour le registre des fournisseurs et pour `verifierEnvoi` : une configuration
 * fausse doit empêcher de démarrer, parce que découverte plus tard elle est
 * découverte sur quelqu'un.
 *
 * Et elle rend **tous** les défauts, pas le premier : corriger une grille en
 * cinq redémarrages successifs est une façon de perdre un quart d'heure.
 */
export function grille(offres: readonly Offre[]): Grille {
  const defauts = verifierGrille(offres);
  if (defauts.length > 0) throw new GrilleInvalide(defauts);

  return offres.map((o) => ({ actif: true, ...o }));
}

/** Une offre par son identifiant, `null` si elle n'existe pas. */
export function offreDe(grille: Grille, id: string): Offre | null {
  return grille.find((o) => o.id === id) ?? null;
}

/** Ce qu'on propose aujourd'hui. Les offres retirées n'y sont pas. */
export function offresActives(grille: Grille): Offre[] {
  return grille.filter((o) => o.actif !== false);
}

/**
 * Le prix ramené au jour, pour comparer deux cadences.
 *
 * Un tableau de bord qui affiche « 2 000 F/mois » et « 20 000 F/an » côte à côte
 * ne dit pas laquelle est la moins chère. Rendu au jour, l'annuelle vaut 54,79
 * contre 66,67 — et la comparaison se fait d'un coup d'œil.
 *
 * En unités mineures et **non arrondi** : arrondir ici ferait afficher le même
 * prix à deux offres qui diffèrent, ce qui est exactement ce qu'on cherche à
 * éviter. C'est à l'affichage d'arrondir.
 */
export function prixParJour(offre: Offre): number {
  return offre.montant / JOURS_DE_CADENCE[offre.cadence];
}
