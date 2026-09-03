/**
 * L'alphabet dans lequel un SMS coûte le moins cher.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UN CARACTÈRE INVISIBLE PEUT DOUBLER LA FACTURE
 *
 * Un SMS écrit dans l'alphabet GSM 03.38 tient 160 caractères par segment. Dès
 * qu'UN SEUL caractère en sort, l'opérateur bascule le message entier en UCS-2
 * et le segment tombe à 70. Le message n'est ni refusé ni tronqué : il est
 * facturé deux ou trois fois plus, sans que rien ne le signale.
 *
 * Les coupables, chez nous, sont typographiques et invisibles à la relecture :
 *
 *   — `formatMoney` insère une espace fine insécable (U+202F) entre le montant
 *     et la devise. Elle seule suffit à faire passer chaque relance en UCS-2 ;
 *   — l'apostrophe courbe « ’ », les guillemets « … », le tiret cadratin « — »,
 *     qu'on écrit partout ailleurs dans Baobart parce que c'est plus beau ;
 *   — les accents circonflexes, et le `ç` minuscule — présent en français,
 *     absent de l'alphabet GSM, qui ne connaît que le `Ç` majuscule.
 *
 * D'où ce module : il replie le texte sur ce que l'alphabet accepte, avant
 * l'envoi, sans que l'appelant ait à y penser.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * REPLIER, PAS TRONQUER
 *
 * On ne coupe jamais. Un message trop long part en plusieurs segments — c'est
 * cher mais lisible ; un message tronqué perd son lien de paiement, donc sa
 * raison d'être. `segments()` sert à mesurer, pas à censurer.
 */

/**
 * L'alphabet par défaut de la recommandation GSM 03.38.
 *
 * Recopié depuis la norme. Les lettres grecques et les symboles nordiques n'y
 * servent à rien chez nous, mais les retirer ferait replier un texte que
 * l'opérateur aurait accepté tel quel.
 */
const BASE =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ" +
  " !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§" +
  "¿abcdefghijklmnopqrstuvwxyzäöñüà";

/**
 * Les caractères de la table d'extension.
 *
 * Ils passent, mais comptent **double** : chacun est précédé d'un caractère
 * d'échappement. Un texte truffé d'euros tient donc moins que sa longueur ne le
 * laisse croire.
 *
 * L'antislash est doublé parce qu'il en faut un vrai : écrit `"\["`, il ne
 * s'échappait pas lui-même mais le crochet, et disparaissait du jeu. Il était
 * alors supprimé des messages, et `segments()` comptait en UCS-2 un texte que
 * l'opérateur aurait facturé en GSM-7 — soit exactement l'erreur de mesure que
 * ce module existe pour éviter.
 */
const ETENDUS = "^{}\\[~]|€";

const DANS_BASE = new Set(BASE.split(""));
const DANS_ETENDUS = new Set(ETENDUS.split(""));

/**
 * Ce par quoi remplacer ce que l'alphabet ne connaît pas.
 *
 * Un repli est une perte assumée : « â » devient « a ». C'est moins bien
 * qu'« â », et infiniment mieux qu'un message facturé trois fois ou rendu en
 * points d'interrogation par une passerelle.
 */
const REPLIS: Record<string, string> = {
  // Les espaces qui n'en ont pas l'air. La fine insécable de `formatMoney` est
  // la plus coûteuse de toutes : elle est dans chaque relance.
  "\u00a0": " ",
  "\u202f": " ",
  "\u2009": " ",
  "\u2007": " ",

  // La ponctuation soignée de Baobart.
  "’": "'",
  "‘": "'",
  "“": '"',
  "”": '"',
  "«": '"',
  "»": '"',
  "…": "...",
  "—": "-",
  "–": "-",
  "‑": "-",
  "•": "*",

  // Les accents que le français emploie et que la norme ignore.
  "â": "a",
  "ê": "e",
  "î": "i",
  "ô": "o",
  "û": "u",
  "ë": "e",
  "ï": "i",
  "ÿ": "y",
  "ç": "c",
  "œ": "oe",
  "Œ": "OE",
  "Â": "A",
  "Ê": "E",
  "Î": "I",
  "Ô": "O",
  "Û": "U",
  "À": "A",
  "È": "E",
  "Ù": "U",
};

/** Un texte replié, et ce que le repli a coûté. */
export interface Repli {
  texte: string;
  /**
   * Les caractères qu'aucun repli ne savait rendre, et qui ont donc disparu.
   * Sans doublon, dans l'ordre de rencontre.
   */
  perdus: string[];
}

/**
 * Replie, et dit ce qui s'est perdu en route.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI LA PERTE DOIT POUVOIR SE VOIR
 *
 * Le repli de dernier recours décompose puis filtre sur l'alphabet. Pour une
 * écriture qui n'a aucun équivalent latin, le filtre ne laisse rien : « مرحبا »
 * et « Привет » rendent une chaîne vide. Un émoji effacé n'est pas grave — un
 * nom d'abonné effacé l'est, et dans la zone où Ndank tourne, ce n'est pas un
 * cas d'école.
 *
 * `replier` continue de rendre une simple chaîne, parce que c'est ce dont
 * l'appelant a besoin la plupart du temps. Celui qui veut savoir ce qu'il vient
 * de perdre passe par ici.
 */
export function replierAvecPertes(texte: string): Repli {
  let sortie = "";
  const perdus: string[] = [];

  for (const c of texte) {
    if (DANS_BASE.has(c) || DANS_ETENDUS.has(c)) {
      sortie += c;
      continue;
    }

    const repli = REPLIS[c];
    if (repli !== undefined) {
      sortie += repli;
      continue;
    }

    // Dernière chance : décomposer et retirer les diacritiques rattrape les
    // accents qu'on n'a pas listés, sans avoir à tous les prévoir.
    const nu = c
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .split("")
      .filter((x) => DANS_BASE.has(x))
      .join("");

    if (nu === "" && !perdus.includes(c)) perdus.push(c);

    sortie += nu;
  }

  return { texte: sortie, perdus };
}

/**
 * Rend un texte que l'opérateur enverra en GSM-7.
 *
 * Ce qui n'est ni dans l'alphabet, ni dans la table de replis, disparaît —
 * émoji compris. Un émoji dans une relance ferait basculer les 160 caractères
 * en 70 à lui tout seul, et il n'apporte rien à « ton abonnement expire ».
 *
 * Quand la perte compte — un nom d'abonné, un libellé d'offre — passer par
 * `replierAvecPertes`, qui dit ce qu'il a supprimé.
 */
export function replier(texte: string): string {
  return replierAvecPertes(texte).texte;
}

/** Vrai si le texte partira en GSM-7, sans repli préalable. */
export function tientEnGsm7(texte: string): boolean {
  return [...texte].every((c) => DANS_BASE.has(c) || DANS_ETENDUS.has(c));
}

/**
 * Le nombre de segments facturés.
 *
 * Un message seul tient 160 septets ; dès qu'il en faut deux, l'en-tête de
 * concaténation en mange six et chaque segment tombe à 153. C'est pourquoi un
 * texte de 161 caractères coûte deux segments et non « un et des poussières ».
 */
export function segments(texte: string): number {
  if (texte.length === 0) return 0;

  if (!tientEnGsm7(texte)) {
    // UCS-2 : 70 caractères, 67 en concaténé. On compte en unités UTF-16,
    // parce que c'est ce que l'opérateur compte — un émoji vaut deux.
    const n = texte.length;
    return n <= 70 ? 1 : Math.ceil(n / 67);
  }

  const septets = [...texte].reduce(
    (n, c) => n + (DANS_ETENDUS.has(c) ? 2 : 1),
    0,
  );

  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}
