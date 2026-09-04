/**
 * Ndank — le peu du client Prisma dont l'adaptateur a besoin.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI NDANK NE DÉPEND PAS DE `@prisma/client`
 *
 * Parce qu'il n'a pas à en dépendre. Le niveau 1 marche sans base, et un hôte
 * qui implémente ses propres ports n'a aucune raison d'installer Prisma pour
 * autant. Une dépendance de production ici obligerait tout le monde à porter le
 * client généré, sa taille et sa version.
 *
 * L'adaptateur décrit donc la forme dont il a besoin, et l'hôte lui passe son
 * `PrismaClient` — qui la satisfait structurellement. `dependencies` reste vide.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LES LIGNES SONT TYPÉES, LES ARGUMENTS NE LE SONT PAS
 *
 * Et c'est un partage assumé, pas une paresse.
 *
 * Les **lignes** sont ce que l'adaptateur lit et transforme en `AbonnementLu`,
 * en `Coordonnees`, en `Cycle`. Une erreur là — un champ oublié, une date prise
 * pour une autre — se traduit par une échéance fausse. Elles sont donc décrites
 * au champ près, et le compilateur les vérifie.
 *
 * Les **arguments** sont les objets `where` et `data` de Prisma. Leurs types
 * sont générés, génériques, et ne se reproduisent pas à la main sans recopier
 * le client entier — ce qui reviendrait à en dépendre. Les redire
 * approximativement donnerait une fausse sécurité : le compilateur validerait
 * une forme inventée, pas celle que Prisma attend. On les laisse donc ouverts,
 * et ce sont les tests contre un faux client qui vérifient qu'on envoie les
 * bonnes clauses.
 */

/** Une ligne `abonnement`, telle que l'adaptateur la lit. */
export interface LigneAbonnement {
  id: string;
  abonneId: string;
  libelle: string;
  montant: number;
  devise: string;
  cadence: string;
  debut: Date;
  echeance: Date;
  accesJusquA: Date;
  repriseJusquA: Date;
  resilieeLe: Date | null;
  suspenduLe: Date | null;
  closLe: Date | null;
  verse: number;
  joursAccordes: number;
  versements: number;
  /**
   * L'abonné, quand la requête l'a joint.
   *
   * Facultatif : le passage quotidien ne le joint pas — il n'en a pas besoin,
   * et joindre une table pour cinq cents lignes chaque matin coûte pour rien.
   * Le tableau de bord, lui, le demande.
   */
  abonne?: {
    reference: string;
    nom: string | null;
    courriel: string | null;
    telephone: string | null;
  } | null;
}


/** Une ligne `abonne`. */
export interface LigneAbonne {
  id: string;
  nom: string | null;
  courriel: string | null;
  telephone: string | null;
  appareils: string[];
}

/** Une ligne `offre`, telle que la grille la lit. */
export interface LigneOffre {
  id: string;
  libelle: string;
  montant: number;
  devise: string;
  cadence: string;
  actif: boolean;
}

/** Une ligne `relance`, réduite à ce qui sert. */
export interface LigneRelance {
  cle: string;
}

/**
 * Une ligne `versement`, décrite entière.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ELLE EST DÉCRITE ENTIÈRE, MÊME QUAND ON N'EN DEMANDE QU'UN CHAMP
 *
 * `dejaCompte` interroge avec `select: { id: true }` : cette question-là est
 * posée à chaque webhook, et charger la ligne entière pour répondre « oui » ou
 * « non » serait du gâchis à l'échelle d'un rejeu de soixante-douze heures. La
 * ligne qui revient alors n'a qu'un champ.
 *
 * On ne le reflète pas dans le type, et c'est le même partage que pour les
 * arguments : le typer par `select` demanderait de reproduire l'inférence de
 * Prisma, donc d'en dépendre. Les rendre tous facultatifs, à l'inverse,
 * obligerait chaque lecture à composer avec des `undefined` qui n'arrivent
 * jamais.
 */
export interface LigneVersement {
  id: string;
  abonnementId: string;
  fournisseur: string;
  reference: string;
  montant: number;
  devise: string;
  etat: string;
  regleLe: Date | null;
  compteLe: Date | null;
  creeLe: Date;
}

/** Ce que `groupBy` rend quand on compte les versements par état. */
export interface GroupeVersement {
  etat: string;
  _count: { _all: number };
}

/**
 * Le délégué `versement`, qui sait en plus regrouper.
 *
 * `groupBy` ne rentre pas dans `Delegue<Ligne>` : il ne rend pas des lignes,
 * il rend des agrégats. Le décrire à part vaut mieux que d'élargir `Delegue`
 * pour tous les autres, qui n'en ont pas besoin.
 */
export interface DelegueVersement extends Delegue<LigneVersement> {
  groupBy(args: Args): Promise<GroupeVersement[]>;
}

/**
 * Les arguments d'une requête Prisma.
 *
 * Ouverts délibérément — voir l'en-tête. `unknown` conviendrait mieux au style
 * du dépôt, mais empêcherait un vrai `PrismaClient` d'être assignable : ses
 * méthodes attendent des types générés précis, et une méthode qui reçoit
 * `unknown` n'est pas assignable à une méthode qui reçoit `AbonnementWhereInput`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = any;

/** Le sous-ensemble d'un délégué Prisma que l'adaptateur appelle. */
export interface Delegue<Ligne> {
  findMany(args?: Args): Promise<Ligne[]>;
  findFirst(args?: Args): Promise<Ligne | null>;
  findUnique(args: Args): Promise<Ligne | null>;
  /**
   * Compter, et non charger pour mesurer la longueur.
   *
   * Le tableau de bord demande cinq comptes à chaque ouverture — un par état.
   * Les obtenir en chargeant les lignes ferait passer cent mille abonnements
   * par le réseau et par la mémoire du processus, cinq fois, pour rendre cinq
   * nombres.
   */
  count(args?: Args): Promise<number>;
  /**
   * Écrire un lot d'un coup.
   *
   * C'est ce qui rend le tampon des journaux utile : cinq cents insertions
   * lancées une par une sont une rafale sur la base, au moment précis où elle
   * sert à autre chose.
   */
  createMany(args: Args): Promise<unknown>;
  update(args: Args): Promise<unknown>;
  updateMany(args: Args): Promise<unknown>;
  upsert(args: Args): Promise<unknown>;
  create(args: Args): Promise<unknown>;
}

/**
 * Ce que l'hôte passe à `portsPrisma`.
 *
 * Un `PrismaClient` généré depuis `prisma/schema.prisma` le satisfait tel quel.
 */
export interface ClientNdank {
  abonnement: Delegue<LigneAbonnement>;
  abonne: Delegue<LigneAbonne>;
  offre: Delegue<LigneOffre>;
  relance: Delegue<LigneRelance>;
  versement: DelegueVersement;
  evenement: Delegue<{ id: string }>;
  passage: Delegue<LignePassage>;
  /** La trace brute de ce qu'un fournisseur a posté. */
  webhookRecu: Delegue<{ id: string }>;

  /**
   * La transaction interactive de Prisma.
   *
   * ════════════════════════════════════════════════════════════════════════
   * ELLE REND UN AUTRE CLIENT, ET C'EST TOUT L'ENJEU
   *
   * `$transaction(fn)` appelle `fn` avec un client **transactionnel**. Les
   * écritures qui passent par lui sont dans la transaction ; celles qui passent
   * par le client extérieur n'y sont pas — alors même qu'elle est ouverte.
   *
   * D'où le type de retour : `ClientNdank`, et non `void`. Il oblige
   * l'adaptateur à reconstruire ses écritures contre ce client-là, ce qui est
   * exactement ce qu'on veut qu'il fasse. Un `() => Promise<T>` aurait laissé
   * écrire une transaction qui ne transactionne rien, sans qu'aucun type ne
   * proteste.
   *
   * Facultative : un hôte peut passer un client qui ne l'a pas — un faux, une
   * base sans transaction — et Ndank enchaîne alors les écritures, en le
   * disant.
   */
  $transaction?<T>(fn: (tx: ClientNdank) => Promise<T>): Promise<T>;
}

/** Une ligne `passage`, telle que le battement la lit. */
export interface LignePassage {
  id: string;
  commenceLe: Date;
  termineLe: Date | null;
  vus: number;
  relances: number;
  suspendus: number;
  clos: number;
  injoignables: number;
  echecs: number;
  lotPlein: boolean;
  erreur: string | null;
}
