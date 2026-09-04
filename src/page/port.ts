import type { Reglages } from "../cycle";
import type { Encaissement, Issue } from "../encaissement/port";
import type { Creances } from "../encaissement/reconciliation";
import type { DossierAbonnement, SurIssue } from "../dossier";
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

export type { DossierAbonnement, SurIssue } from "../dossier";


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

// ─────────────────────────────────────────────────────────────────── web ──

/**
 * Les formes d'une requête et d'une réponse vivent à la racine, dans
 * `src/web.ts`.
 *
 * Elles sont réexportées ici parce que c'est par ce chemin que les hôtes les
 * importent depuis la 0.7.0. Les webhooks et l'API, eux, vont les chercher à la
 * source — un gestionnaire de webhooks n'a aucune raison d'importer depuis
 * « la page ».
 */
export type { RequeteWeb, ReponseWeb } from "../web";
