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
  closLe: Date | null;
  verse: number;
  joursAccordes: number;
  versements: number;
}

/** Une ligne `abonne`. */
export interface LigneAbonne {
  nom: string | null;
  courriel: string | null;
  telephone: string | null;
  appareils: string[];
}

/** Une ligne `relance`, réduite à ce qui sert. */
export interface LigneRelance {
  cle: string;
}

/** Une ligne `versement`, réduite à ce qui sert. */
export interface LigneVersement {
  id: string;
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
  relance: Delegue<LigneRelance>;
  versement: Delegue<LigneVersement>;
  evenement: Delegue<{ id: string }>;
}
