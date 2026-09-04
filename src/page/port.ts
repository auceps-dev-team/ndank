import type { Reglages } from "../cycle";
import type { Encaissement, Issue } from "../encaissement/port";
import type { Creances } from "../encaissement/reconciliation";
import type { AbonnementLu, Coordonnees } from "../ports";
import type { Politique } from "../reglement";

/**
 * Ndank — ce qu'il faut pour héberger la page de validation.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI NDANK HÉBERGE CETTE PAGE PLUTÔT QUE DE RENVOYER CELLE DU FOURNISSEUR
 *
 * Parce qu'un hôte qui branche deux fournisseurs a sinon deux expériences, deux
 * mises en page, deux façons de dire « ça a marché », et aucune des deux ne
 * ressemble à son produit. L'abonné, lui, ne sait pas ce qu'est un agrégateur :
 * il voit un site qu'il ne connaît pas lui demander de l'argent.
 *
 * Et c'est le seul endroit où l'on puisse **mesurer**. Un lien qui part chez le
 * fournisseur ne dit jamais combien de gens ont ouvert la page et ne sont pas
 * allés au bout — qui est exactement ce qu'il faut savoir pour comprendre un
 * taux de renouvellement.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ELLE N'ÉCRIT RIEN, ELLE NON PLUS
 *
 * Même partage que dans tout le reste : la page invite, constate, et rapporte.
 * Faire avancer une échéance et noter le versement qui l'a payée doivent tomber
 * ou réussir **ensemble**, et seul l'hôte peut ouvrir la transaction qui le
 * garantit.
 *
 * D'où `surIssue` : Ndank appelle, l'hôte écrit. C'est le même crochet que le
 * gestionnaire de webhooks utilisera, et ce n'est pas un hasard — voir plus bas.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * L'INTERROGATION N'EST PAS UN REPLI DU WEBHOOK
 *
 * On serait tenté de traiter la page comme un affichage, et le webhook comme la
 * seule vérité. Ce serait faux, et coûteux.
 *
 * Un webhook se perd : le service redémarre au mauvais moment, un pare-feu
 * bloque, l'hôte répond 500 et le fournisseur abandonne au bout de trois
 * essais. Les rappels de MTN ne sont même pas signés, donc un hôte prudent ne
 * peut pas leur faire confiance seul. Flutterwave écrit d'ailleurs l'inverse
 * dans sa documentation : re-vérifier avant de donner la valeur.
 *
 * Les deux chemins doivent donc pouvoir conclure, et c'est `dejaCompte` qui
 * rend inoffensif le fait qu'ils concluent tous les deux.
 */

/** Lire un abonnement par son identifiant. */
export interface DossierAbonnement {
  /**
   * L'abonnement, ou `null` s'il n'existe plus.
   *
   * Un port distinct de `Lecture`, et non une méthode de plus : le passage
   * quotidien n'a jamais besoin de lire par identifiant, et lui imposer cette
   * méthode obligerait tous les hôtes du niveau 1 à l'écrire pour rien.
   */
  abonnement(id: string): Promise<AbonnementLu | null>;

  /**
   * De quoi pré-remplir la demande chez le fournisseur. Facultatif.
   *
   * Un nom et une adresse rendent le reçu du fournisseur lisible et améliorent
   * la reconnaissance de l'abonné quand il revient. Rien n'en dépend : sans
   * cette méthode, la demande part avec le seul numéro saisi sur la page.
   */
  coordonnees?(abonneId: string): Promise<Coordonnees>;
}

/** Un moyen de paiement, tel que l'abonné le voit. */
export interface ChoixFournisseur {
  /** La clé technique, celle du formulaire et des journaux. */
  nom: string;
  /** Ce que l'abonné lit : « Orange Money », « Wave », « Carte bancaire ». */
  libelle: string;
  encaissement: Encaissement;
  /**
   * Vrai si ce fournisseur a besoin du numéro avant de pouvoir inviter.
   *
   * Le mobile money en direct, oui — il faut savoir sur quel téléphone pousser
   * la demande. Une page hébergée d'agrégateur, non : elle le demandera
   * elle-même. Demander deux fois le même numéro est le genre de détail qui
   * fait abandonner un paiement.
   */
  telephone?: boolean;
}

/**
 * Ce que Ndank appelle quand un paiement est constaté.
 *
 * L'hôte y fait ce que `reconcilier` lui a dit, dans sa propre transaction. Ce
 * crochet doit être **idempotent** : il sera appelé par la page ET par le
 * webhook, souvent pour le même paiement, et parfois plusieurs fois.
 *
 * Il ne doit pas lever pour signaler un doublon — `Creances.dejaCompte` est
 * fait pour cela.
 */
export type SurIssue = (
  issue: Issue,
  abonnement: AbonnementLu,
) => Promise<void>;

export interface ReglagesPage {
  /**
   * L'adresse publique où la page est montée, sans barre oblique finale.
   *
   * `https://p.baobart.ci/v`. Elle sert à fabriquer les liens de retour du
   * fournisseur, donc elle doit être celle que voit l'abonné — pas celle du
   * conteneur.
   */
  base: string;

  /** Le secret qui signe les liens. Le même que celui qui les fabrique. */
  secret: string;

  dossier: DossierAbonnement;

  /**
   * L'état de règlement, quand l'hôte accepte le paiement en plusieurs fois.
   *
   * Absent, la page demande le montant entier à chaque fois — ce qui est le
   * comportement correct pour un hôte qui n'a pas câblé les créances, et non
   * une dégradation silencieuse.
   */
  creances?: Creances;

  /** Les moyens proposés, dans l'ordre d'affichage. */
  fournisseurs: readonly ChoixFournisseur[];

  /** Comment écrire un montant. L'hôte seul connaît sa devise et ses usages. */
  montant: (mineures: number, devise: string) => string;

  /** Le nom affiché en haut de la page. */
  marque?: string;

  politique?: Politique;
  reglages?: Reglages;
  surIssue?: SurIssue;

  /**
   * Où proposer à l'abonné de retourner une fois qu'il a fini.
   *
   * Facultatif : sans lui, la page de confirmation ne propose pas de lien. Elle
   * ne devine pas l'adresse du produit de l'hôte, et un lien vers nulle part
   * est pire que pas de lien.
   */
  retour?: string;
}

// ─────────────────────────────────────────────────────────────────── http ──

/**
 * Une requête, réduite à ce dont le routeur a besoin.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NDANK NE LIVRE PAS DE SERVEUR
 *
 * `dependencies` est vide et doit le rester. Le routeur est donc une fonction
 * pure de cette forme vers la suivante, et l'hôte la monte où il veut : une
 * route Next, un gestionnaire Hono, un `http.createServer`, une fonction
 * déployée au bord.
 *
 * `montage.ts` fournit les deux adaptateurs qui couvrent presque tout.
 */
export interface RequeteWeb {
  methode: string;
  /** Le chemin **relatif au point de montage**, sans la base. */
  chemin: string;
  /** Les paramètres de requête, déjà décodés. */
  parametres: Readonly<Record<string, string>>;
  /** Le corps brut. Vide pour un `GET`. */
  corps: string;
  /** Les en-têtes, en minuscules. */
  entetes: Readonly<Record<string, string | undefined>>;
}

export interface ReponseWeb {
  statut: number;
  entetes: Record<string, string>;
  corps: string;
}
