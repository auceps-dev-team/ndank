import { JOURS_DE_CADENCE, type Cadence } from "./cycle";

/**
 * Ndank — compter de l'argent sans se tromper de question.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DEUX DÉFINITIONS QUI DEMANDENT UN ARBITRAGE, PAS UN CALCUL
 *
 * Un tableau de bord affiche « encaissé ce mois » et « revenu récurrent
 * mensuel ». Les deux paraissent évidents et ne le sont pas : ce sont des
 * conventions, et une convention qu'on n'écrit pas devient une convention que
 * chacun devine autrement.
 *
 * Ce fichier tranche les deux, et dit pourquoi. Un hôte qui préfère l'inverse
 * n'a qu'à ne pas s'en servir — mais il saura ce qu'il change.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ON NE MÉLANGE JAMAIS DEUX DEVISES
 *
 * Le franc CFA et le cedi n'ont ni la même valeur ni le même nombre de
 * décimales. Les additionner produit un nombre qui ressemble à de l'argent et
 * n'en est pas — et personne ne s'en aperçoit, parce qu'un total est toujours
 * plausible.
 *
 * Tout ce qui suit rend donc **une ligne par devise**, jamais un total unique.
 * Un projet qui n'en a qu'une n'y perd rien ; celui qui en a deux évite le seul
 * chiffre faux dont il ne se méfierait pas.
 */

/** Ce qui est entré, sur une période et dans une devise. */
export interface Encaisse {
  devise: string;
  /** En unités mineures ISO, comme partout. */
  total: number;
  /** Combien de versements comptés. « 43 validations », dans la maquette. */
  nombre: number;
}

/** La même chose, ventilée par fournisseur. */
export interface EncaisseParFournisseur extends Encaisse {
  fournisseur: string;
}

/** Ce que rapportent les abonnements en cours, groupé pour être normalisable. */
export interface Recurrent {
  devise: string;
  cadence: string;
  /** Combien d'abonnements dans ce groupe. */
  nombre: number;
  /** La somme de leurs montants, en unités mineures. */
  total: number;
}

/** Le revenu récurrent ramené au mois, par devise. */
export interface Mensuel {
  devise: string;
  /** En unités mineures ISO. */
  total: number;
  nombre: number;
}

/**
 * Un montant d'une cadence donnée, ramené au mois.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TRENTE JOURS, PARCE QUE C'EST LA DÉFINITION DU MOIS ICI
 *
 * `JOURS_DE_CADENCE` dit qu'un cycle mensuel dure trente jours. Ce n'est pas
 * une approximation qu'on corrigerait en prenant 30,44 : c'est **la** durée
 * qu'un abonnement mensuel a chez Ndank, celle qui décide de l'échéance.
 *
 * Prendre une autre valeur ici ferait qu'un abonné mensuel à 2 000 F
 * apparaîtrait à 2 029 F de revenu récurrent — un écart de un et demi pour
 * cent, invisible, et impossible à rapprocher de ce qu'on facture vraiment.
 */
export function parMois(montant: number, cadence: Cadence): number {
  return Math.round((montant * 30) / JOURS_DE_CADENCE[cadence]);
}

/**
 * Le revenu récurrent mensuel, par devise.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * QUELS ABONNEMENTS COMPTENT, ET POURQUOI CE CHOIX-LÀ
 *
 * C'est l'arbitrage, et il change le chiffre du simple au double sur une base
 * qui a vécu.
 *
 * On compte ceux **qui ont accès** : `ACTIVE` et `A_RENOUVELER`. Ce sont ceux
 * qu'on sert aujourd'hui et dont on attend le prochain règlement — donc ceux
 * qui décrivent le revenu que l'on tient.
 *
 * On ne compte pas :
 *
 *   — les **suspendus**, qui ne paient plus et à qui l'on ne fournit rien. Les
 *     inclure gonflerait le chiffre exactement au moment où il devrait baisser,
 *     c'est-à-dire au moment où il servirait ;
 *   — les **résiliés**, même s'ils gardent l'accès jusqu'à la fin du payé : ils
 *     ne renouvelleront pas, et le récurrent parle de ce qui se répète ;
 *   — les **expirés**, évidemment.
 *
 * La conséquence pratique : ce chiffre **baisse** quand la grâce d'un abonné
 * s'épuise, pas quand son échéance passe. C'est voulu — tant qu'il est dans la
 * grâce, on le sert et on le relance.
 *
 * Le calcul se fait par groupe et non par abonnement : arrondir mille fois
 * ferait dériver le total, et l'arrondi une fois par groupe garde un chiffre
 * qu'on peut rapprocher.
 */
export function recurrentMensuel(groupes: readonly Recurrent[]): Mensuel[] {
  const parDevise = new Map<string, Mensuel>();

  for (const groupe of groupes) {
    if (!(groupe.cadence in JOURS_DE_CADENCE)) {
      // Une cadence inconnue ne doit pas devenir « mensuel » par défaut : le
      // total serait faux sans que rien ne le dise. On l'ignore, et le compte
      // d'abonnements le trahira.
      continue;
    }

    const courant = parDevise.get(groupe.devise) ?? {
      devise: groupe.devise,
      total: 0,
      nombre: 0,
    };

    courant.total += parMois(groupe.total, groupe.cadence as Cadence);
    courant.nombre += groupe.nombre;

    parDevise.set(groupe.devise, courant);
  }

  return [...parDevise.values()].sort((a, b) => b.total - a.total);
}

/**
 * L'écart entre deux périodes, en pourcentage.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * `null` QUAND IL N'Y A RIEN À COMPARER
 *
 * La maquette affiche « +8,4 % vs mois dernier ». Le mois où l'on démarre, il
 * n'y a pas de mois dernier — et rendre `+100 %` ou `0 %` serait inventer une
 * histoire. Un tableau de bord qui n'affiche rien dit la vérité ; un qui
 * affiche « +∞ % » fait douter du reste.
 */
export function evolution(courant: number, precedent: number): number | null {
  if (precedent === 0) return null;

  return Math.round(((courant - precedent) / precedent) * 1000) / 10;
}
