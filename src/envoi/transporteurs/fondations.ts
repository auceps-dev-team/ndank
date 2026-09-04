import type { Canal } from "../../ports";
import type { Transporteur } from "../port";

/**
 * Les passerelles dont l'intégration reste à finir.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * MÊME RÈGLE QUE POUR LES OPÉRATEURS DE PAIEMENT
 *
 * `encaissement/fournisseurs/directs.ts` pose le principe : on n'écrit pas
 * d'adresse d'API sur la foi d'un paquet communautaire ou d'une page produit.
 * Un adaptateur inventé donne l'illusion d'une intégration, et l'illusion se
 * paie au moment le plus cher — ici, sur la relance de dernier palier, celle
 * qui devait éviter une coupure.
 *
 * Ce fichier applique la même règle à l'envoi, et il y a une tentation
 * supplémentaire à laquelle il faut résister : ces API-là sont plus simples que
 * celles des opérateurs de paiement, donc plus faciles à deviner de mémoire.
 * Facile à deviner ne veut pas dire juste.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QUE CHAQUE ENTRÉE APPORTE QUAND MÊME
 *
 *   — **la surface de configuration**, pour que l'hôte sache dès aujourd'hui
 *     quels comptes ouvrir. C'est la partie longue : un identifiant
 *     d'expéditeur alphanumérique se négocie avec chaque opérateur, et cela
 *     prend des semaines ;
 *
 *   — **un échec qui se lit**, qui nomme la passerelle, ce qui manque, et où
 *     l'obtenir — plutôt qu'un `undefined is not a function` à trois heures du
 *     matin.
 */

export interface FondationEnvoi {
  nom: string;
  canal: Canal;
  /** Ce que l'hôte devra remplir, tel qu'on le connaît aujourd'hui. */
  champs: readonly string[];
  /** Où obtenir les identifiants, et ce qui reste à établir. */
  aObtenir: string;
}

export const FONDATIONS_ENVOI: readonly FondationEnvoi[] = [
  {
    nom: "orange-sms",
    canal: "sms",
    champs: ["identifiantClient", "secretClient", "expediteur"],
    aObtenir:
      "Portail developer.orange.com, produit « SMS API », puis un contrat de " +
      "volume par pays. Le flux est connu dans ses grandes lignes — un jeton " +
      "OAuth obtenu en Basic, puis un envoi vers une adresse qui porte le " +
      "numéro d'expéditeur dans son chemin — mais les chemins exacts et la " +
      "forme de l'enveloppe n'ont pas été lus à la source. " +
      "C'est la passerelle la plus intéressante de la zone : l'envoi vers un " +
      "abonné Orange y est facturé bien moins cher qu'un SMS international, et " +
      "l'identifiant d'expéditeur alphanumérique est inclus au contrat.",
  },
  {
    nom: "africastalking",
    canal: "sms",
    champs: ["utilisateur", "cleApi", "expediteur"],
    aObtenir:
      "Compte africastalking.com, puis une clé d'API et un identifiant " +
      "d'expéditeur validé par pays. Agrégateur panafricain, couvre les " +
      "opérateurs de la zone d'un seul contrat — c'est l'alternative à Twilio " +
      "quand le volume justifie de sortir du tarif international.",
  },
  {
    nom: "fcm",
    canal: "push",
    champs: ["projetId", "courrielCompteService", "clePriveeCompteService"],
    aObtenir:
      "Console Firebase, un compte de service, et son fichier JSON. " +
      "L'API v1 demande de signer un JWT RS256 avec la clé privée, de " +
      "l'échanger contre un jeton OAuth, et de renouveler le tout chaque " +
      "heure — c'est faisable avec `node:crypto` seul, mais ce n'est pas " +
      "écrit sur une supposition. À brancher pour un hôte qui a une " +
      "application Android native ; ceux qui passent par Expo ont déjà leur " +
      "transporteur.",
  },
  {
    nom: "webpush",
    canal: "push",
    champs: ["cleVapidPublique", "cleVapidPrivee", "sujetVapid"],
    aObtenir:
      "Une paire de clés VAPID, générée une fois. La difficulté n'est pas là : " +
      "le Web Push chiffre chaque charge utile pour l'abonnement du navigateur " +
      "(ECDH sur P-256, puis AES-GCM, norme RFC 8291). C'est le seul canal où " +
      "Ndank aurait à manipuler des clés de chiffrement — et `Coordonnees` dit " +
      "déjà que les poignées d'appareil sont opaques et ne doivent pas " +
      "traverser le module qui décide de qui relancer.",
  },
];

export const PAR_NOM_ENVOI: Readonly<Record<string, FondationEnvoi>> =
  Object.fromEntries(FONDATIONS_ENVOI.map((f) => [f.nom, f]));

/** Ce qu'on peut dire, quand on ne peut pas envoyer. */
export function pourquoiPas(fondation: FondationEnvoi): Error {
  return new Error(
    `La passerelle « ${fondation.nom} » n'est pas branchée dans Ndank.\n` +
      `Canal : ${fondation.canal}. ` +
      `Champs prévus : ${fondation.champs.join(", ")}.\n` +
      `${fondation.aObtenir}\n` +
      `En attendant : implémentez « Transporteur » — trois champs et une ` +
      `méthode — et passez-le à « envoiCompose ». Le reste ne change pas.`,
  );
}

/**
 * Un transporteur qui refuse, en disant pourquoi.
 *
 * `disponible` rend `false` : c'est ce qui permet au moteur de descendre au
 * canal suivant du palier au lieu de compter un échec. Le message n'apparaît
 * que si l'hôte force l'envoi — c'est-à-dire au moment où il veut savoir.
 *
 * `envoyer` rend une promesse rejetée, et ne lève PAS de façon synchrone :
 * levée depuis le corps d'une fonction déclarée `async`, l'exception serait
 * enveloppée — mais un appelant qui écrirait `transporteur.envoyer(...)` sans
 * `await`, dans un `try`, la verrait passer à côté de son `catch`.
 */
export function fondationEnvoi<C>(
  fondation: FondationEnvoi,
): Transporteur<C> {
  return {
    nom: fondation.nom,
    canal: fondation.canal,
    disponible: () => false,
    envoyer: () => Promise.reject(pourquoiPas(fondation)),
  };
}
