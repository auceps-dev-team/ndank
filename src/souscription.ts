import { cycleApresPaiement, type Cycle, type Reglages } from "./cycle";
import type { Offre } from "./offre";
import type { AbonnementLu, Coordonnees } from "./ports";

/**
 * Ndank — faire naître un abonnement.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL MANQUAIT, ET PERSONNE NE L'AVAIT VU
 *
 * Ndank savait relancer, suspendre, clore, renouveler, encaisser, réconcilier —
 * tout le cycle de vie d'un abonnement **qui existe déjà**. Aucune ligne du code
 * ne savait en créer un. L'hôte devait insérer ses lignes à la main, contre un
 * schéma dont les invariants ne sont écrits nulle part ailleurs que dans le
 * moteur.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ON NE SOUSCRIT QU'APRÈS UN PAIEMENT CONSTATÉ
 *
 * C'est la décision qui donne sa forme à ce fichier, et elle mérite d'être
 * expliquée parce qu'elle refuse quelque chose qu'on aurait pu vouloir.
 *
 * Un abonnement « en attente de premier paiement » ne peut pas s'exprimer dans
 * le modèle de cycle, et ce n'est pas un oubli : un cycle **commence à un
 * paiement**. `cycleApresPaiement` en dérive l'échéance, la grâce, la reprise.
 * Inventer un cycle de durée nulle produirait l'une de deux choses, toutes deux
 * fausses :
 *
 *   — un accès ouvert, puisque `accesOuvert` regarde des dates et non un
 *     règlement — on offrirait le service à qui n'a rien payé ;
 *   — ou un abonné dans le lot du passage quotidien, relancé chaque jour pour
 *     un abonnement qu'il n'a jamais pris.
 *
 * L'ordre est donc : montrer la grille, inviter à payer, **puis** souscrire.
 * `referenceDeSouscription` donne à ce premier paiement une référence qui ne
 * dépend d'aucun abonnement, puisqu'il n'y en a pas encore.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ELLE ÉCRIT, ET C'EST L'EXCEPTION QUI CONFIRME LA RÈGLE
 *
 * Partout ailleurs Ndank décide et l'hôte écrit. Ici on écrit — mais à travers
 * un port, et l'hôte reste maître de sa transaction : `Souscriptions` ne fait
 * que trois choses, et il les implémente comme il veut.
 */

/** Ce qu'il faut savoir écrire pour qu'un abonnement puisse naître. */
export interface Souscriptions {
  /**
   * Trouve l'abonné, ou le crée, et rend son identifiant interne.
   *
   * `reference` est celle de l'hôte — l'identifiant qu'il donne à cette
   * personne chez lui. C'est par elle que les deux bases se réconcilient, et
   * c'est pourquoi elle vient de l'hôte et non de Ndank.
   *
   * Doit être **idempotent** : deux appels avec la même référence rendent le
   * même identifiant, et ne créent pas deux abonnés.
   */
  abonne(reference: string, coordonnees: Coordonnees): Promise<string>;

  /**
   * L'abonnement en cours de cet abonné pour cette offre, s'il y en a un.
   *
   * « En cours » veut dire : ni résilié, ni clos. C'est ce qui empêche un
   * double-clic, ou un abonné qui repaie parce qu'il n'a pas vu la
   * confirmation, de se retrouver avec deux abonnements à la même chose — dont
   * un qu'il ne verra jamais et qui le relancera pourtant.
   */
  enCours(abonneId: string, offreId: string): Promise<AbonnementLu | null>;

  /** Crée l'abonnement et rend ce que le moteur saura lire. */
  ouvrir(nouveau: NouvelAbonnement): Promise<AbonnementLu>;
}

export interface NouvelAbonnement {
  abonneId: string;
  offre: Offre;
  /** Déjà calculé à partir du paiement. L'hôte n'a pas à le refaire. */
  cycle: Cycle;
}

/** Ce que `souscrire` a fait. */
export interface Souscription {
  abonnement: AbonnementLu;
  /**
   * Faux si un abonnement en cours existait déjà.
   *
   * Ce n'est pas une erreur, et il ne faut surtout pas la traiter comme telle :
   * c'est le cas normal d'un abonné qui a cliqué deux fois. On rend
   * l'abonnement existant, et l'appelant sait qu'il n'a rien créé.
   */
  cree: boolean;
}

/**
 * Souscrit, à partir d'un paiement constaté.
 *
 * `paiement` est la date du règlement — `issue.regleLe` quand le fournisseur la
 * donne, l'instant présent sinon. C'est de là que part le cycle : facturer à
 * partir de l'instant de l'écriture ferait perdre à l'abonné les minutes, voire
 * les heures, qu'a mises le webhook à arriver.
 */
export async function souscrire(
  souscriptions: Souscriptions,
  entree: {
    offre: Offre;
    abonne: { reference: string } & Coordonnees;
    paiement: Date;
  },
  reglages?: Reglages,
): Promise<Souscription> {
  const { offre, abonne, paiement } = entree;

  if (offre.actif === false) {
    // Une offre retirée du catalogue peut encore porter des abonnements en
    // cours — mais on n'en ouvre plus de nouveaux. Sans ce refus, un lien de
    // souscription périmé continuerait de vendre ce qu'on ne vend plus.
    throw new Error(
      `L'offre « ${offre.id} » n'est plus proposée. ` +
        `Elle reste valable pour les abonnements en cours.`,
    );
  }

  const abonneId = await souscriptions.abonne(abonne.reference, {
    nom: abonne.nom,
    courriel: abonne.courriel,
    telephone: abonne.telephone,
    appareils: abonne.appareils,
  });

  const existant = await souscriptions.enCours(abonneId, offre.id);
  if (existant !== null) return { abonnement: existant, cree: false };

  const abonnement = await souscriptions.ouvrir({
    abonneId,
    offre,
    cycle: cycleApresPaiement(paiement, offre.cadence, reglages),
  });

  return { abonnement, cree: true };
}

/**
 * La référence d'un **premier** paiement, celui qui n'a pas encore d'abonnement.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI ELLE NE RESSEMBLE PAS À `referenceDeVersement`
 *
 * Celle-là porte l'abonnement et le cycle, parce qu'elle doit être **stable** :
 * un passage quotidien rejoué doit redemander exactement le même versement, et
 * le fournisseur doit le reconnaître.
 *
 * Ici, il n'y a ni abonnement ni cycle — c'est précisément ce qu'on essaie de
 * créer. Et la stabilité n'est plus une qualité : quelqu'un qui abandonne son
 * paiement puis recommence doit obtenir une **nouvelle** demande. Réutiliser la
 * référence ferait répondre au fournisseur qu'il connaît déjà celle-là, et le
 * second essai n'aurait jamais lieu.
 *
 * Ce qui protège du double paiement n'est donc pas la référence, mais
 * `Souscriptions.enCours` : le second règlement rendrait l'abonnement déjà
 * ouvert au lieu d'en créer un autre.
 *
 * `essai` est fourni par l'appelant — un compteur, un horodatage, ce qu'il veut
 * — et c'est délibéré : Ndank ne tire pas de hasard, pour que la même entrée
 * produise toujours la même sortie et reste vérifiable.
 */
export function referenceDeSouscription(
  offreId: string,
  abonneReference: string,
  essai: string,
): string {
  const sur = (valeur: string): string =>
    /^[A-Za-z0-9-]+$/.test(valeur)
      ? valeur
      : Buffer.from(valeur, "utf8").toString("hex");

  // `S-` en tête : c'est ce qui la distingue d'une référence de versement au
  // moment de lire un webhook. Sans ce marqueur, `lireReference` la prendrait
  // pour une référence étrangère — ce qui serait juste, mais muet.
  return `S-${sur(offreId)}-${sur(abonneReference)}-${sur(essai)}`;
}

/** Vrai si cette référence est celle d'une première souscription. */
export function estSouscription(reference: string): boolean {
  return reference.startsWith("S-");
}
