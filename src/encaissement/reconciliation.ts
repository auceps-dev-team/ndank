import { cleDeCycle, cycleAvance, JOURS_DE_CADENCE, type Cycle, type Reglages } from "../cycle";
import { regler, type Etat, type Politique } from "../reglement";
import type { AbonnementLu } from "../ports";
import type { Issue } from "./port";

/**
 * Ndank — ce qu'on fait d'un paiement constaté.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ELLE DÉCIDE, ELLE N'ÉCRIT PAS
 *
 * Même partage que dans le cœur : `gesteDuJour` dit ce qu'il faut faire,
 * `passer` le fait. Ici `reconcilier` lit un état, applique la règle, et rend
 * une décision. C'est l'hôte qui écrit.
 *
 * Ce n'est pas une coquetterie d'architecture. Faire avancer une échéance et
 * noter le versement qui l'a payée doivent tomber ou réussir **ensemble** : si
 * l'un passe et l'autre non, on offre un mois ou on encaisse sans rien donner.
 * Seul l'hôte connaît sa base, donc lui seul peut ouvrir la transaction qui
 * garantit cela. Rendre une décision plutôt que d'écrire à sa place, c'est lui
 * laisser cette possibilité.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LA RÉFÉRENCE PORTE LE NUMÉRO DU VERSEMENT
 *
 * Payer en plusieurs fois oblige à demander plusieurs paiements pour une même
 * échéance. Or la référence sert de clé d'idempotence chez les fournisseurs :
 * réutiliser la clé du cycle pour le second versement ferait reconnaître le
 * premier, et le second n'aurait jamais lieu.
 *
 * D'où `20260209-1-ab-1`, `20260209-2-ab-1`. Le numéro ne bouge que lorsqu'un
 * versement a été **compté** — pas à chaque passage. Un passage quotidien
 * rejoué dix fois redemande donc toujours le même versement, et le fournisseur
 * le reconnaît comme il doit.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ET ELLE PORTE L'ABONNEMENT, DEPUIS LA 0.7.0
 *
 * Elle ne le portait pas. `2026-02-09#1` ne dépendait que de l'échéance : deux
 * abonnés dont l'échéance tombe le même jour recevaient la même référence — et
 * sur de la facturation mensuelle, les échéances se concentrent forcément.
 *
 * Voir `referenceDeVersement` pour ce que cela cassait exactement.
 */

/** L'état de règlement d'un abonnement, tel que l'hôte le conserve. */
export interface EtatCreance extends Etat {
  /** Combien de versements ont déjà été comptés depuis le dernier solde. */
  versements: number;
}

export const CREANCE_VIERGE: EtatCreance = {
  verse: 0,
  joursAccordes: 0,
  versements: 0,
};

/** Ce que l'hôte doit savoir lire pour que la réconciliation fonctionne. */
export interface Creances {
  /** L'état de règlement. `CREANCE_VIERGE` quand on n'en a jamais eu. */
  etat(abonnementId: string): Promise<EtatCreance>;

  /**
   * Vrai si ce versement a déjà été compté.
   *
   * Indispensable, et pas seulement prudent. Paystack rejoue ses webhooks
   * toutes les trois minutes puis chaque heure pendant soixante-douze heures ;
   * Flutterwave trois fois à trente minutes. Et le même paiement arrive
   * souvent deux fois — une par le webhook, une par l'interrogation d'état.
   * Sans cette question, un abonné qui paie une fois verrait son échéance
   * avancer de trois mois.
   */
  dejaCompte(versementId: string): Promise<boolean>;
}

/** Ce qu'il faut écrire, ou pourquoi il n'y a rien à écrire. */
export type Decision =
  /**
   * L'échéance avance. Écrire le cycle **et** l'état, dans la même transaction.
   */
  | {
      faire: "RENOUVELER";
      cycle: Cycle;
      jours: number;
      etat: EtatCreance;
      versementId: string;
    }
  /**
   * Le versement compte, mais n'achète pas encore de temps.
   *
   * `manque` est ce qu'il reste à verser : c'est le nombre à mettre dans la
   * relance suivante.
   */
  | {
      faire: "CREDITER";
      manque: number;
      etat: EtatCreance;
      versementId: string;
    }
  /** Rien à faire. Le cas le plus fréquent : un webhook rejoué. */
  | { faire: "RIEN"; motif: string }
  /**
   * Quelque chose ne concorde pas. Ne rien écrire, et le faire remonter.
   *
   * Ce n'est pas « rien à faire » : c'est un paiement réel dont on ne sait pas
   * quoi faire. Le confondre avec du bruit ferait disparaître de l'argent.
   */
  | { faire: "INCIDENT"; motif: string };

/**
 * L'identifiant de l'abonnement, ramené à ce qu'un fournisseur accepte.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LE JEU DE CARACTÈRES EST CELUI DU PLUS STRICT
 *
 * Paystack n'accepte dans une référence que des caractères alphanumériques et
 * `-`, `.`, `=`, `_`. Flutterwave est plus permissif, mais on ne construit pas
 * deux références selon le fournisseur : ce serait deux clés d'idempotence pour
 * un même versement, donc deux paiements possibles.
 *
 * Un identifiant qui sort de `[A-Za-z0-9-]` est donc transcrit en hexadécimal.
 * C'est deux fois plus long et parfaitement illisible — mais cela n'arrive
 * qu'aux hôtes dont les identifiants contiennent autre chose, et une référence
 * illisible vaut mieux qu'une référence refusée.
 */
function idSur(abonnementId: string): string {
  return /^[A-Za-z0-9-]+$/.test(abonnementId)
    ? abonnementId
    : Buffer.from(abonnementId, "utf8").toString("hex");
}

/**
 * La référence à transmettre au fournisseur pour le prochain versement.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ELLE PORTE L'ABONNEMENT, ET C'EST INDISPENSABLE
 *
 * Elle ne le portait pas : `2026-02-09#1` ne dépendait que de l'échéance et du
 * numéro de versement. Deux abonnés dont l'échéance tombe le même jour
 * recevaient donc **la même référence** — et sur de la facturation mensuelle,
 * les échéances se concentrent forcément.
 *
 * Ce n'est pas une gêne, c'est un défaut de correction. La référence est la clé
 * d'idempotence chez le fournisseur :
 *
 *   — Paystack refuse une référence déjà vue. Le second abonné à payer ce
 *     jour-là se voyait donc rejeter, avec un message parlant de doublon ;
 *   — `constater(reference)` interroge le fournisseur **par** cette clé. Elle
 *     aurait rendu la transaction de quelqu'un d'autre, et `reconcilier`
 *     aurait prolongé le mauvais abonnement.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LA FORME SE RELIT SANS AMBIGUÏTÉ
 *
 * `20260209-1-ab-1` : huit chiffres de date, le numéro de versement, puis
 * l'identifiant — qui peut lui-même contenir des tirets, d'où le fait qu'il
 * vienne en dernier. Le `#` d'avant ne figure pas dans le jeu de caractères
 * accepté par Paystack, ce qui était le second défaut de la même ligne.
 *
 * Elle reste stable tant que le versement en cours n'a pas été compté : c'est
 * ce qui rend un passage quotidien rejouable sans redemander deux fois le même
 * paiement.
 */
export function referenceDeVersement(
  abonnementId: string,
  echeance: Date,
  versements: number,
): string {
  const compact = cleDeCycle(echeance).replace(/-/g, "");

  return `${compact}-${versements + 1}-${idSur(abonnementId)}`;
}

/** Ce qu'on peut relire d'une référence de versement. */
export interface ReferenceLue {
  /** La clé de cycle, au format de `cleDeCycle`. */
  cycle: string;
  /** L'identifiant tel qu'il a été transcrit. Comparer via `idSur`. */
  abonnement: string;
  /** Le numéro du versement, à partir de 1. */
  numero: number;
}

/**
 * Relit une référence, ou rend `null` si elle n'en est pas une.
 *
 * Rendre `null` plutôt que de lever : une référence illisible arrive par un
 * webhook, c'est-à-dire depuis l'extérieur, et lever y ferait répondre 500 —
 * donc réessayer le fournisseur, indéfiniment, sur un événement qui ne nous
 * concerne pas.
 */
export function lireReference(reference: string): ReferenceLue | null {
  const trouve = /^(\d{8})-(\d+)-(.+)$/.exec(reference);
  if (!trouve) return null;

  const [, date, numero, abonnement] = trouve as unknown as [
    string,
    string,
    string,
    string,
  ];

  return {
    cycle: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
    abonnement,
    numero: Number.parseInt(numero, 10),
  };
}

/**
 * La clé de cycle contenue dans une référence de versement.
 *
 * Rend la référence entière quand elle n'a pas la forme attendue : c'est ce qui
 * fait qu'une référence étrangère — un autre système qui poste sur le même
 * webhook — sera vue comme portant un autre cycle, donc écartée par
 * `reconcilier` au lieu d'être prise pour le cycle courant.
 */
export function cycleDeReference(reference: string): string {
  return lireReference(reference)?.cycle ?? reference;
}

/** Vrai si cette référence a bien été fabriquée pour cet abonnement. */
export function referencePour(reference: string, abonnementId: string): boolean {
  return lireReference(reference)?.abonnement === idSur(abonnementId);
}

/**
 * Décide de ce qu'un paiement constaté produit.
 *
 * `issue` doit venir de `constater()` ou de `lireWebhook()`. Dans les deux cas
 * elle a été relue auprès du fournisseur : c'est le temps n°5 de la
 * chorégraphie, et il n'est pas facultatif.
 */
export async function reconcilier(
  creances: Creances,
  abonnement: AbonnementLu,
  issue: Issue,
  politique: Politique,
  reglages?: Reglages,
): Promise<Decision> {
  // Seul un succès donne droit à quelque chose. `INCONNU` en particulier n'est
  // pas un échec — c'est un état qu'on ne sait pas lire, et il ne faut surtout
  // pas en conclure que l'abonné n'a pas payé.
  if (issue.etat !== "REUSSI") {
    return { faire: "RIEN", motif: `Versement ${issue.etat.toLowerCase()}.` };
  }

  const versementId = issue.identifiantFournisseur ?? issue.reference;

  if (await creances.dejaCompte(versementId)) {
    return { faire: "RIEN", motif: `Versement ${versementId} déjà compté.` };
  }

  // « Confirm the transaction's final status **and amount** », écrit
  // Flutterwave. Une devise qui ne correspond pas n'est pas une nuance : mille
  // deux cents cedis ne sont pas mille deux cents francs, et les compter comme
  // tels offrirait deux ans d'abonnement.
  if (issue.devise !== abonnement.devise) {
    return {
      faire: "INCIDENT",
      motif:
        `Devise inattendue sur ${issue.reference} : ${issue.devise} reçu, ` +
        `${abonnement.devise} attendu.`,
    };
  }

  if (issue.montant <= 0) {
    return {
      faire: "INCIDENT",
      motif: `Montant nul ou négatif sur ${issue.reference} : ${issue.montant}.`,
    };
  }

  // Un versement fabriqué pour un autre abonnement ne doit surtout pas
  // prolonger celui-ci. Le cas n'est pas théorique : la page de validation et
  // le gestionnaire de webhooks reçoivent tous deux la référence depuis
  // l'extérieur, et rien d'autre ne dit à qui elle appartient.
  //
  // On ne se prononce que sur une référence qu'on sait lire : une référence
  // étrangère — un autre système qui poste sur le même webhook — tombera dans
  // le contrôle de cycle juste en dessous, qui l'écartera.
  const lue = lireReference(issue.reference);

  if (lue !== null && lue.abonnement !== idSur(abonnement.id)) {
    return {
      faire: "INCIDENT",
      motif:
        `Versement ${issue.reference} fabriqué pour l'abonnement ` +
        `${lue.abonnement}, présenté sur ${abonnement.id}.`,
    };
  }

  // Un versement qui porte la clé d'un autre cycle est un paiement en retard
  // sur une échéance déjà soldée. Il ne doit pas faire avancer le cycle
  // courant — mais il ne doit pas non plus disparaître.
  const cycleVise = cycleDeReference(issue.reference);
  const cycleCourant = cleDeCycle(abonnement.cycle.echeance);

  if (cycleVise !== cycleCourant) {
    return {
      faire: "INCIDENT",
      motif:
        `Versement sur le cycle ${cycleVise} alors que l'abonnement est ` +
        `au cycle ${cycleCourant}.`,
    };
  }

  const etat = await creances.etat(abonnement.id);

  const suite = regler(
    {
      politique,
      du: abonnement.montant,
      joursDeCadence: JOURS_DE_CADENCE[abonnement.cadence],
      verse: etat.verse,
      joursAccordes: etat.joursAccordes,
    },
    issue.montant,
  );

  if (suite.faire === "RIEN") {
    return { faire: "INCIDENT", motif: suite.motif };
  }

  const versements = etat.versements + 1;

  if (suite.faire === "CREDITER") {
    return {
      faire: "CREDITER",
      manque: suite.manque,
      etat: { verse: suite.verse, joursAccordes: suite.joursAccordes, versements },
      versementId,
    };
  }

  // Le cycle avance du nombre de jours que la règle a accordés — trente pour un
  // compte rond, dix-huit pour mille deux cents francs sur deux mille.
  const cycle = cycleAvance(
    abonnement.cycle,
    issue.regleLe ?? new Date(),
    suite.jours,
    reglages,
  );

  return {
    faire: "RENOUVELER",
    cycle,
    jours: suite.jours,
    // Un cycle soldé remet le compteur de versements à zéro en même temps que
    // le reste : le prochain paiement repart de `#1`.
    etat: {
      verse: suite.verse,
      joursAccordes: suite.joursAccordes,
      versements: suite.verse === 0 ? 0 : versements,
    },
    versementId,
  };
}
