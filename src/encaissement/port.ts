/**
 * Ndank — la couche d'encaissement.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NDANK NE TOUCHE PAS L'ARGENT
 *
 * Il faut le dire ici, en haut du fichier qui parle aux fournisseurs de
 * paiement, parce que c'est là qu'on pourrait croire le contraire.
 *
 * L'argent va du portefeuille de l'abonné au compte marchand de l'hôte. Il ne
 * transite par aucun compte de Ndank, et Ndank n'en garde ni la trace
 * comptable ni la responsabilité. Ce module fait exactement deux choses :
 *
 *   — **inviter** : demander au fournisseur de faire apparaître, sur le
 *     téléphone de l'abonné, l'écran où il saisira son code ;
 *   — **constater** : relire auprès du fournisseur ce qui s'est passé.
 *
 * Rien d'autre. Pas de solde, pas de reversement, pas de remboursement.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CES DEUX VERBES, ET PAS TROIS
 *
 * Quatre documentations d'opérateurs — Flutterwave, Paystack, MTN MoMo, Orange
 * Money — décrivent la même chorégraphie en cinq temps : s'authentifier,
 * initier avec une clé d'idempotence, laisser l'abonné autoriser sur son
 * téléphone, recevoir le résultat plus tard, re-vérifier avant de donner la
 * valeur.
 *
 * Les temps 1, 3 et 4 ne sont pas à nous : le premier appartient à
 * l'adaptateur, le troisième à l'abonné, le quatrième arrive quand il arrive.
 * Restent le 2 et le 5. Ce sont `inviter` et `constater`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * AUCUN APPEL RÉSEAU N'EST FAIT ICI
 *
 * `Http` est un port, comme `Lecture` ou `Envoi` dans le cœur. Les adaptateurs
 * le reçoivent, ils ne l'inventent pas. C'est ce qui permet d'éprouver un flux
 * Flutterwave complet — invitation, attente, webhook, constat — sans réseau,
 * sans compte marchand, et en une milliseconde.
 */

/**
 * Où en est un encaissement, du point de vue du fournisseur.
 *
 * Volontairement plus pauvre que ce que rendent les fournisseurs. Chacun a ses
 * codes — `02`, `pending`, `PENDING`, `successful`, `succeeded`, `success` — et
 * les traduire tôt évite que la nuance d'un opérateur devienne une branche de
 * plus dans le reste du code.
 */
export type EtatEncaissement =
  /** Le fournisseur a accepté la demande. L'abonné n'a pas encore répondu. */
  | "EN_ATTENTE"
  /** L'argent est arrivé. C'est le seul état qui donne droit à quelque chose. */
  | "REUSSI"
  /** L'abonné a refusé, ou le paiement a été rejeté. */
  | "ECHOUE"
  /** Personne n'a répondu à temps. Un nouveau cycle de relance reprendra. */
  | "EXPIRE"
  /**
   * Le fournisseur a répondu quelque chose qu'on ne sait pas lire.
   *
   * Ce n'est pas `ECHOUE` : traiter un état inconnu comme un échec couperait
   * l'accès de quelqu'un qui a peut-être payé. On ne conclut pas.
   */
  | "INCONNU";

/** Ce qu'il faut savoir pour demander un paiement. */
export interface Demande {
  /**
   * La référence transmise au fournisseur.
   *
   * C'est la clé de cycle de Ndank — `cleDeCycle(echeance)`. Heureuse
   * coïncidence : les quatre fournisseurs réclament une clé fabriquée par
   * l'appelant et stable dans le temps, ce qui est exactement la définition de
   * cette clé. Un passage rejoué produit donc la même référence, et le
   * fournisseur reconnaît la demande au lieu d'en créer une seconde.
   */
  reference: string;

  /** En unités mineures. 2 000 F CFA se transmet `2000` — le XOF n'a pas de décimale. */
  montant: number;

  /** Code ISO 4217. `XOF`, `XAF`, `GHS`, `NGN`. */
  devise: string;

  /** De quoi le fournisseur remplira son écran, et son relevé. */
  libelle: string;

  abonne: {
    nom: string | null;
    courriel: string | null;
    /** Au format international, indicatif compris : `+2250700000000`. */
    telephone: string | null;
  };

  /**
   * Où renvoyer l'abonné une fois qu'il a validé.
   *
   * C'est une page de Ndank, pas une page du fournisseur : l'expérience reste
   * la même quel que soit l'opérateur derrière, et c'est le seul endroit où
   * l'on puisse mesurer ce qui se passe réellement à cet instant.
   */
  retour: string;
}

/** Ce que le fournisseur répond quand on lui demande d'inviter quelqu'un à payer. */
export interface Invitation {
  /** Celle de la demande, renvoyée pour que l'appelant n'ait pas à la retenir. */
  reference: string;

  /** L'identifiant de la charge chez le fournisseur, quand il en donne un. */
  identifiantFournisseur: string | null;

  /**
   * Où envoyer l'abonné.
   *
   * `null` quand le fournisseur pousse directement sur le téléphone sans page
   * intermédiaire — c'est le cas du mobile money Flutterwave par défaut, et du
   * `RequestToPay` de MTN. Il faut alors afficher `instruction`.
   */
  url: string | null;

  /**
   * Ce qu'il faut dire à l'abonné quand il n'y a pas d'URL.
   *
   * « Validez sur le 07 00 00 00 00 », « composez #144# ». Le texte vient du
   * fournisseur quand il en fournit un, parce que lui seul sait ce qu'il vient
   * réellement d'envoyer.
   */
  instruction: string | null;

  etat: EtatEncaissement;

  /** Quand l'invitation cesse d'être valable, si le fournisseur le dit. */
  expireLe: Date | null;
}

/**
 * Ce qu'on a constaté auprès du fournisseur.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LE MONTANT ET LA DEVISE EN FONT PARTIE, ET CE N'EST PAS DÉCORATIF
 *
 * Flutterwave l'écrit comme une consigne : « before you provide value to the
 * customer, confirm the transaction's final status and amount ». Un statut
 * `REUSSI` sur un montant de 100 quand on en attendait 2 000 n'est pas un
 * succès, c'est un incident — et personne ne le verra si le constat ne
 * rapporte que l'état.
 */
export interface Issue {
  reference: string;
  etat: EtatEncaissement;
  /** En unités mineures, tel que le fournisseur le rend. */
  montant: number;
  devise: string;
  /** L'identifiant de la charge chez le fournisseur, quand il en donne un. */
  identifiantFournisseur: string | null;
  /** L'horodatage du règlement, quand le fournisseur le donne. */
  regleLe: Date | null;
  /**
   * La réponse brute du fournisseur.
   *
   * Conservée pour être journalisée telle quelle. Le jour où un opérateur
   * changera un code sans prévenir, c'est ce champ qui permettra de comprendre
   * — et non une reconstitution à partir des cinq états ci-dessus.
   */
  brut: unknown;
}

/**
 * Un fournisseur d'encaissement, vu par Ndank.
 *
 * Sept intégrations parcourues avant d'écrire cette interface. La plus aboutie
 * — `Nafezly/payments`, trente fournisseurs derrière une fabrique — tient sur
 * deux verbes : `pay()` et `verify()`. Celle-ci en a trois, et le troisième
 * n'existe que parce que Ndank vit du côté serveur, là où les webhooks
 * arrivent.
 */
export interface Encaissement {
  /** Le nom sous lequel l'hôte l'a demandé. Sert aux journaux et aux erreurs. */
  readonly nom: string;

  /** Les devises que cet adaptateur accepte. Vide = il ne se prononce pas. */
  readonly devises: readonly string[];

  /** Temps 2 : faire apparaître l'écran de validation chez l'abonné. */
  inviter(demande: Demande): Promise<Invitation>;

  /** Temps 5 : relire l'issue auprès du fournisseur, avant de donner la valeur. */
  constater(reference: string): Promise<Issue>;

  /**
   * Lire un webhook et le normaliser.
   *
   * Rend `null` quand l'événement ne concerne pas un encaissement — les
   * fournisseurs en émettent beaucoup d'autres, et les ignorer poliment vaut
   * mieux que de lever.
   *
   * Lève quand la signature est invalide : là, il ne s'agit plus d'un
   * événement qui ne nous concerne pas, mais de quelqu'un qui se fait passer
   * pour le fournisseur.
   */
  lireWebhook(corps: string, entetes: Entetes): Issue | null;
}

/** En-têtes HTTP, en minuscules. */
export type Entetes = Readonly<Record<string, string | undefined>>;

// ─────────────────────────────────────────────────────────────────── http ──

/**
 * Le transport vit désormais à la racine, dans `src/http.ts`.
 *
 * Il est réexporté ici parce que c'est par ce chemin que les hôtes l'importent
 * depuis la première version, et qu'un déplacement interne n'a pas à casser
 * leur code. La couche d'envoi, elle, va le chercher à la source — elle n'a
 * aucune raison de traverser la couche des paiements pour envoyer un SMS.
 */
export type { Http, Reponse, Requete } from "../http";
export { httpParDefaut } from "../http";

/**
 * Ce qu'un fournisseur a refusé de faire.
 *
 * Porte de quoi comprendre sans avoir à rejouer l'appel : qui, quoi, et ce que
 * le fournisseur a répondu mot pour mot.
 */
export class ErreurFournisseur extends Error {
  constructor(
    readonly fournisseur: string,
    readonly statut: number,
    readonly reponse: string,
    message?: string,
  ) {
    super(
      message ??
        `${fournisseur} a répondu ${statut} : ${reponse.slice(0, 300)}`,
    );
    this.name = "ErreurFournisseur";
  }
}

/**
 * Une signature de webhook qui ne correspond pas.
 *
 * Distincte d'`ErreurFournisseur` parce qu'elle ne veut pas dire la même
 * chose : ce n'est pas le fournisseur qui a un problème, c'est que l'appel ne
 * vient probablement pas de lui.
 */
export class SignatureInvalide extends Error {
  constructor(readonly fournisseur: string) {
    super(`Signature de webhook invalide pour ${fournisseur}`);
    this.name = "SignatureInvalide";
  }
}
