import { JOURS_DE_CADENCE, joursEntre } from "../cycle";
import { CREANCE_VIERGE } from "../encaissement/reconciliation";
import { etatDe, type Etat as EtatAbonnement } from "../etats";
import type { AbonnementLu } from "../ports";
import { resteADevoir } from "../reglement";
import { lireLien, type Refus } from "./lien";
import type { ReglagesPage } from "./port";

/**
 * Ndank — ce que la page a le droit de montrer.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SÉPARÉ DU RENDU, ET SÉPARÉ DU HTTP
 *
 * Trois choses arrivent quand quelqu'un ouvre un lien de relance : on relit le
 * jeton, on lit l'abonnement, on calcule ce qui reste dû. Aucune des trois n'a
 * besoin d'une requête HTTP ni d'une balise, et toutes les trois peuvent se
 * tromper d'une façon qui coûte cher.
 *
 * Les isoler ici permet d'éprouver « un lien expiré ne montre pas le montant »
 * ou « un abonné qui a déjà versé la moitié ne se voit pas redemander le tout »
 * sans monter de serveur.
 */

/** Ce que la page affiche, une fois le jeton relu et l'abonnement lu. */
export type Vue =
  /** Le jeton ne vaut rien. `refus` sert au journal, pas à l'écran. */
  | { quoi: "INVALIDE"; refus: Refus }
  /** Le jeton est bon, l'abonnement n'existe plus. */
  | { quoi: "INTROUVABLE" }
  /** Résilié ou expiré : il n'y a plus rien à régler ici. */
  | { quoi: "CLOS"; abonnement: AbonnementLu; etat: EtatAbonnement }
  /**
   * Rien à payer : l'échéance est encore loin.
   *
   * ───────────────────────────────────────────────────────────────────────
   * C'EST LE CAS QUI ÉVITE LE DOUBLE PAIEMENT
   *
   * Le lien vient d'une relance. S'il mène à un abonnement à jour, c'est
   * presque toujours que l'abonné vient de payer — soit le webhook est arrivé
   * entre-temps, soit la relance a croisé son règlement, ce que le courriel
   * l'avertissait de pouvoir faire.
   *
   * Lui présenter quand même un bouton de paiement, c'est lui faire payer deux
   * fois. Et Ndank ne rembourse pas : il n'a jamais touché l'argent, donc il ne
   * peut pas le rendre. Son seul recours serait d'écrire au marchand.
   */
  | { quoi: "A_JOUR"; abonnement: AbonnementLu; joursRestants: number }
  /** Le cas courant. */
  | {
      quoi: "A_REGLER";
      abonnement: AbonnementLu;
      etat: EtatAbonnement;
      /** Ce que coûte un cycle entier, en unités mineures. */
      du: number;
      /** Ce qui a déjà été versé sans solder le cycle. */
      verse: number;
      /** Ce qu'il reste à verser pour solder. C'est le montant proposé. */
      reste: number;
      /** Combien de versements ont déjà été comptés. Sert à la référence. */
      versements: number;
      /** Jours d'accès restants. Négatif si l'accès est déjà coupé. */
      joursRestants: number;
    };

/**
 * Assemble ce que la page peut montrer, à partir d'un jeton.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ON NE REDEMANDE PAS CE QUI A DÉJÀ ÉTÉ VERSÉ
 *
 * C'est la raison d'être de `creances` ici. Redemander deux mille francs à
 * quelqu'un qui en a déjà versé mille deux cents est la meilleure façon de le
 * décourager — et de lui faire croire que son premier versement s'est perdu,
 * ce qui est bien pire qu'un simple abandon.
 *
 * Sans `creances`, la page demande le montant entier. Ce n'est pas une
 * dégradation silencieuse : un hôte qui n'a pas câblé les créances n'accepte
 * pas les versements partiels, donc le montant entier est le bon montant.
 */
export async function vueDe(
  reglages: ReglagesPage,
  jeton: string,
  maintenant: Date = new Date(),
): Promise<Vue> {
  const lu = lireLien(reglages.secret, jeton, maintenant);
  if (!lu.valide) return { quoi: "INVALIDE", refus: lu.refus };

  const abonnement = await reglages.dossier.abonnement(lu.contenu.abonnementId);
  if (abonnement === null) return { quoi: "INTROUVABLE" };

  const etat = etatDe(
    { cycle: abonnement.cycle, resilieeLe: abonnement.resilieeLe },
    maintenant,
  );

  // `RESILIEE` : l'abonné a dit non, et lui présenter un bouton de paiement
  // serait au mieux un malentendu. `EXPIREE` : la reprise est passée, se
  // réabonner recommence à zéro — et Ndank ne sait pas vendre, seulement
  // renouveler.
  if (etat === "RESILIEE" || etat === "EXPIREE") {
    return { quoi: "CLOS", abonnement, etat };
  }

  if (etat === "ACTIVE") {
    return {
      quoi: "A_JOUR",
      abonnement,
      joursRestants: joursEntre(maintenant, abonnement.cycle.echeance),
    };
  }

  const creance = reglages.creances
    ? await reglages.creances.etat(abonnement.id)
    : CREANCE_VIERGE;

  const reste = resteADevoir({
    politique: reglages.politique ?? "CREDIT",
    du: abonnement.montant,
    joursDeCadence: JOURS_DE_CADENCE[abonnement.cadence],
    verse: creance.verse,
    joursAccordes: creance.joursAccordes,
  });

  return {
    quoi: "A_REGLER",
    abonnement,
    etat,
    du: abonnement.montant,
    verse: creance.verse,
    reste,
    versements: creance.versements,
    joursRestants: joursEntre(maintenant, abonnement.cycle.accesJusquA),
  };
}

/**
 * Le montant que la page acceptera, borné.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ON N'ACCEPTE PAS PLUS QUE CE QUI EST DÛ
 *
 * La règle de règlement, elle, l'accepterait : un versement plus grand que le
 * cycle avance simplement de plusieurs cycles. Ce n'est donc pas une contrainte
 * technique, c'est un choix.
 *
 * Un montant se saisit sur le clavier numérique d'un téléphone, souvent debout,
 * souvent vite. Un zéro de trop transforme deux mille francs en vingt mille, et
 * Ndank ne fait pas de remboursement — il n'a jamais touché l'argent, donc il
 * ne peut pas le rendre. Le seul recours de l'abonné serait d'écrire au
 * marchand.
 *
 * Un hôte qui veut vraiment vendre plusieurs cycles d'avance ne passe pas par
 * une relance : il vend une offre annuelle, ce qui est une autre cadence.
 */
export function montantAccepte(demande: number, reste: number): number | null {
  if (!Number.isInteger(demande)) return null;
  if (demande < 1) return null;
  if (demande > reste) return null;

  return demande;
}
