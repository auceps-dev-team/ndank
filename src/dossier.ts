import type { Issue } from "./encaissement/port";
import type { AbonnementLu, Coordonnees } from "./ports";

/**
 * Ndank — lire un abonnement, et réagir à un paiement.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DEUX COUTURES PARTAGÉES PAR LA PAGE ET LES WEBHOOKS
 *
 * Elles vivaient dans `page/port.ts`, et le gestionnaire de webhooks allait les
 * y chercher. Ce n'est pas une dépendance qui a un sens : les webhooks
 * n'affichent aucune page.
 *
 * Le fait qu'elles soient les mêmes des deux côtés, en revanche, en a un — et
 * c'est justement ce que ce fichier rend visible.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI LES DEUX CHEMINS DOIVENT CONCLURE
 *
 * On serait tenté de traiter le webhook comme la seule vérité, et
 * l'interrogation de la page comme un affichage. Ce serait faux.
 *
 * Un webhook se perd : le service redémarre au mauvais moment, un pare-feu
 * bloque, l'hôte répond 500 une fois de trop et le fournisseur abandonne. Les
 * rappels de MTN ne sont même pas signés, donc un hôte prudent ne peut pas leur
 * faire confiance seuls. Flutterwave écrit d'ailleurs l'inverse dans sa
 * documentation : re-vérifier avant de donner la valeur.
 *
 * Les deux chemins concluent donc, souvent pour le même paiement — et c'est
 * `Creances.dejaCompte` qui rend cela inoffensif.
 */

/** Lire un abonnement par son identifiant. */
export interface DossierAbonnement {
  /**
   * L'abonnement, ou `null` s'il n'existe plus.
   *
   * Un port distinct de `Lecture`, et non une méthode de plus : le passage
   * quotidien n'a jamais besoin de lire par identifiant, et lui imposer cette
   * méthode obligerait tous les hôtes du niveau 1 à l'écrire pour rien.
   *
   * L'implémentation doit **cloisonner par projet**. L'identifiant vient du
   * dehors — d'un jeton de lien, d'une référence de webhook — et une lecture
   * qui ne cloisonne pas rendrait la ligne d'un autre projet aussi volontiers
   * que la sienne.
   */
  abonnement(id: string): Promise<AbonnementLu | null>;

  /**
   * De quoi pré-remplir la demande chez le fournisseur. Facultatif.
   *
   * Un nom et une adresse rendent le reçu du fournisseur lisible. Rien n'en
   * dépend : sans cette méthode, la demande part avec le seul numéro saisi sur
   * la page.
   */
  coordonnees?(abonneId: string): Promise<Coordonnees>;
}

/**
 * Ce que Ndank appelle quand un paiement est constaté.
 *
 * L'hôte y fait ce que `reconcilier` lui a dit, dans sa propre transaction.
 * Faire avancer une échéance et noter le versement qui l'a payée doivent tomber
 * ou réussir **ensemble** : si l'un passe et l'autre non, on offre un mois ou
 * l'on encaisse sans rien donner. Seul l'hôte connaît sa base, donc lui seul
 * peut ouvrir cette transaction.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IL DOIT ÊTRE IDEMPOTENT
 *
 * Il sera appelé par la page **et** par le webhook, souvent pour le même
 * paiement, et parfois plusieurs fois — Paystack rejoue pendant
 * soixante-douze heures.
 *
 * Il ne doit pas lever pour signaler un doublon : `Creances.dejaCompte` est
 * fait pour cela. Lever ferait rendre 500 au gestionnaire de webhooks, donc
 * rejouer le fournisseur, indéfiniment, sur un paiement déjà compté.
 */
export type SurIssue = (
  issue: Issue,
  abonnement: AbonnementLu,
) => Promise<void>;
