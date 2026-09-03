/**
 * Ndank — ce qu'un paiement achète, quand il ne fait pas le compte.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * PAYER EN PLUSIEURS FOIS N'EST PAS UN CAS LIMITE, C'EST LE CAS COURANT
 *
 * Une part importante des abonnés vit de revenus irréguliers. Exiger deux mille
 * francs d'un coup le jour de l'échéance, c'est perdre celui qui en a mille
 * deux cents aujourd'hui et huit cents jeudi — alors qu'il veut payer.
 *
 * Le mobile money rend d'ailleurs la chose naturelle : chaque paiement est un
 * geste séparé, autorisé séparément. Rien n'empêche techniquement d'en faire
 * deux. Ce qui manquait, c'est une règle pour dire ce que le premier achète.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DEUX RÈGLES, ET C'EST L'ABONNÉ QUI CHOISIT
 *
 *   — **crédit** : rien ne s'enchaîne tant que le compte n'y est pas. Les mille
 *     deux cents attendent, l'abonné reste relancé pour les huit cents qui
 *     manquent, et l'échéance ne bouge que lorsque la somme est complète ;
 *
 *   — **prorata** : ce qui est payé donne du temps tout de suite. Mille deux
 *     cents sur deux mille achètent dix-huit jours au lieu de trente.
 *
 * Aucune des deux n'est meilleure. La première convient à un service qu'on ne
 * peut pas couper à moitié ; la seconde à un abonné qui préfère savoir que son
 * argent a servi. Ce module les traite à égalité, et le choix se transmet
 * paiement par paiement.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * PUR, ET EN NOMBRES ENTIERS
 *
 * Aucune date, aucun fournisseur, aucune base. Juste des unités mineures et des
 * jours, tous entiers — parce qu'un calcul de prorata en virgule flottante
 * finit toujours par rendre 17,999999 jours, et qu'on ne facture pas cela.
 */

/** Comment traiter un paiement qui ne solde pas l'échéance. */
export type Politique =
  /** Rien ne s'enchaîne tant que le compte n'y est pas. Le reste attend. */
  | "CREDIT"
  /** Ce qui est payé donne du temps immédiatement, au prorata. */
  | "PRORATA";

/**
 * Ce que l'hôte conserve entre deux versements.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DEUX CUMULS, ET SURTOUT PAS UN SOLDE
 *
 * La première version de ce module gardait un simple crédit et arrondissait à
 * chaque versement. C'était faux, et d'une façon qui ne se voit qu'à la
 * longue : trente versements de cent francs achetaient quarante-quatre jours
 * au lieu de quarante-cinq. Chaque arrondi grignotait moins d'un franc, et
 * trente arrondis faisaient perdre un jour à l'abonné.
 *
 * En gardant le **cumul versé** et les **jours déjà accordés**, l'arrondi n'a
 * lieu qu'une fois, contre le total. La dérive devient impossible plutôt
 * qu'improbable.
 */
export interface Reglement {
  politique: Politique;
  /** Ce que coûte un cycle entier, en unités mineures. */
  du: number;
  /** La durée d'un cycle entier, en jours. */
  joursDeCadence: number;
  /** Tout ce qui a été versé depuis le dernier solde exact. */
  verse: number;
  /** Les jours déjà accordés au titre de ces versements. */
  joursAccordes: number;
}

/** L'état à conserver après un versement. */
export interface Etat {
  verse: number;
  joursAccordes: number;
}

/** Ce qu'il faut faire du versement. */
export type Suite =
  /**
   * L'échéance avance de `jours`.
   *
   * `jours` peut dépasser un cycle : verser deux fois le montant avance de deux
   * cycles, dans les deux politiques. C'est le seul point où elles s'accordent
   * toujours.
   */
  | ({ faire: "AVANCER"; jours: number } & Etat)
  /**
   * Rien n'avance. Le cumul grossit, la relance continue.
   *
   * `manque` est ce qu'il reste à verser pour un cycle entier. C'est le nombre
   * à écrire dans la relance suivante — « il te reste 800 F à régler » vaut
   * mieux que de redemander la somme entière à quelqu'un qui a déjà payé.
   */
  | ({ faire: "CREDITER"; manque: number } & Etat)
  /** Rien à faire, et pourquoi. */
  | ({ faire: "RIEN"; motif: string } & Etat);

/**
 * Décide de ce qu'un versement achète.
 *
 * `recu` est le montant de ce versement seul, en unités mineures. Ce qui
 * précède est dans `reglement.verse` et `reglement.joursAccordes` : c'est
 * l'appelant qui les conserve, parce que ce module ne stocke rien.
 */
export function regler(reglement: Reglement, recu: number): Suite {
  const { politique, du, joursDeCadence, verse, joursAccordes } = reglement;
  const inchange: Etat = { verse, joursAccordes };

  if (!Number.isFinite(recu) || recu <= 0) {
    return { faire: "RIEN", ...inchange, motif: "Versement nul ou négatif." };
  }

  if (du <= 0 || joursDeCadence <= 0) {
    // Un abonnement gratuit ou sans durée n'a rien à régler, et diviser par
    // zéro produirait une échéance à l'infini plutôt qu'une erreur lisible.
    return {
      faire: "RIEN",
      ...inchange,
      motif: `Abonnement sans montant ou sans durée (${du}, ${joursDeCadence} j).`,
    };
  }

  const cumul = verse + recu;

  // L'unique arrondi du module, et il porte sur le cumul — jamais sur un
  // versement isolé. C'est ce qui rend la dérive impossible : refaire le calcul
  // depuis le début donnerait le même résultat.
  const joursDus =
    politique === "CREDIT"
      ? Math.floor(cumul / du) * joursDeCadence
      : Math.floor((cumul * joursDeCadence) / du);

  const jours = joursDus - joursAccordes;

  if (jours <= 0) {
    return {
      faire: "CREDITER",
      verse: cumul,
      joursAccordes,
      manque: Math.max(0, du - (cumul % du)),
    };
  }

  // Quand le compte tombe juste, on repart de zéro plutôt que de laisser deux
  // cumuls grossir pendant des années. C'est sans perte : à cet instant précis,
  // les jours accordés valent exactement ce qui a été versé.
  const solde = cumul % du === 0;

  return {
    faire: "AVANCER",
    jours,
    verse: solde ? 0 : cumul,
    joursAccordes: solde ? 0 : joursDus,
  };
}

/**
 * Ce qu'il reste à verser pour compléter le cycle en cours.
 *
 * Sert à écrire la relance : redemander deux mille francs à quelqu'un qui en a
 * déjà versé mille deux cents est la meilleure façon de le décourager, et de
 * lui faire croire que son premier versement s'est perdu.
 */
export function resteADevoir(reglement: Reglement): number {
  if (reglement.du <= 0) return 0;
  return reglement.du - (reglement.verse % reglement.du);
}
