import type { Encaissement, Http } from "./port";
import { CHAMPS_FLUTTERWAVE, flutterwave } from "./fournisseurs/flutterwave";
import { CHAMPS_MTN, mtn } from "./fournisseurs/mtn";
import { CHAMPS_PAYSTACK, paystack } from "./fournisseurs/paystack";
import { PAR_NOM, fondation } from "./fournisseurs/directs";

/**
 * Le registre des fournisseurs.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * REMPLIR DES CHAMPS, ET RIEN D'AUTRE
 *
 * C'est la promesse de la couche : l'hôte pose ses clés dans sa configuration,
 * nomme un fournisseur, et obtient un `Encaissement`. Il n'écrit ni requête, ni
 * vérification de signature, ni traduction de statut.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UNE CONFIGURATION INCOMPLÈTE ÉCHOUE ICI, PAS EN PRODUCTION
 *
 * C'est le vrai travail de ce fichier, et il est plus utile qu'il n'en a l'air.
 * Une clé absente d'un fichier d'environnement ne se voit pas : la variable
 * vaut `undefined`, la requête part avec un en-tête vide, le fournisseur répond
 * 401, et le message qui remonte parle d'autorisation — jamais de la ligne
 * manquante dans le fichier de configuration.
 *
 * `fournisseur()` refuse donc de construire un adaptateur dont il manque un
 * champ, et le dit en nommant le champ. C'est la différence entre une demi-heure
 * de recherche et dix secondes.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DEUX AGRÉGATEURS, CINQ OPÉRATEURS, ET UN ARBITRAGE
 *
 * Flutterwave et Paystack couvrent le plus de terrain d'un seul contrat, contre
 * une commission. Les cinq opérateurs en direct coûtent moins cher et demandent
 * un compte marchand par pays et par opérateur.
 *
 * Le registre ne tranche pas : il expose les deux et laisse l'hôte choisir, y
 * compris fournisseur par fournisseur — Flutterwave pour le Ghana, MTN en
 * direct en Côte d'Ivoire, si c'est ce qui l'arrange.
 */

export type NomFournisseur =
  | "flutterwave"
  | "paystack"
  | "mtn"
  | "orange"
  | "wave"
  | "moov"
  | "djamo";

/** Ce qu'un hôte pose dans sa configuration, tel quel. */
export type Identifiants = Readonly<Record<string, string | boolean | undefined>>;

/** Les champs requis par fournisseur, pour la validation et pour l'affichage. */
export const CHAMPS_REQUIS: Readonly<Record<NomFournisseur, readonly string[]>> = {
  flutterwave: CHAMPS_FLUTTERWAVE,
  paystack: CHAMPS_PAYSTACK,
  mtn: CHAMPS_MTN,
  orange: PAR_NOM["orange"]!.champs,
  wave: PAR_NOM["wave"]!.champs,
  moov: PAR_NOM["moov"]!.champs,
  djamo: PAR_NOM["djamo"]!.champs,
};

/** Ce qui manque pour qu'une configuration soit utilisable. */
export class ConfigurationIncomplete extends Error {
  constructor(
    readonly fournisseur: string,
    readonly manquants: readonly string[],
  ) {
    super(
      `Configuration incomplète pour « ${fournisseur} » : ` +
        `${manquants.join(", ")} ${manquants.length > 1 ? "manquent" : "manque"}.\n` +
        `Champs attendus : ${(CHAMPS_REQUIS[fournisseur as NomFournisseur] ?? []).join(", ")}.`,
    );
    this.name = "ConfigurationIncomplete";
  }
}

/** Un nom qu'on ne connaît pas. */
export class FournisseurInconnu extends Error {
  constructor(nom: string) {
    super(
      `Fournisseur inconnu : « ${nom} ». ` +
        `Connus : ${Object.keys(CHAMPS_REQUIS).join(", ")}.`,
    );
    this.name = "FournisseurInconnu";
  }
}

/**
 * Dit ce qui manque, sans rien construire.
 *
 * Séparé de `fournisseur()` pour qu'un hôte puisse vérifier toute sa
 * configuration au démarrage — et refuser de démarrer — plutôt que de découvrir
 * le trou au premier abonné à relancer, un matin, dans un passage quotidien.
 */
export function champsManquants(
  nom: NomFournisseur,
  identifiants: Identifiants,
): readonly string[] {
  const requis = CHAMPS_REQUIS[nom];
  if (!requis) throw new FournisseurInconnu(nom);

  return requis.filter((champ) => {
    const valeur = identifiants[champ];
    return typeof valeur !== "string" || valeur.trim() === "";
  });
}

/**
 * Construit l'adaptateur, ou refuse en disant pourquoi.
 *
 * `http` est injectable pour tous : c'est ce qui permet d'éprouver un flux
 * complet — invitation, webhook, constat — sans compte marchand ni réseau.
 */
export function fournisseur(
  nom: NomFournisseur,
  identifiants: Identifiants,
  http?: Http,
): Encaissement {
  if (!(nom in CHAMPS_REQUIS)) throw new FournisseurInconnu(nom);

  const manquants = champsManquants(nom, identifiants);
  if (manquants.length > 0) throw new ConfigurationIncomplete(nom, manquants);

  const s = (champ: string): string => identifiants[champ] as string;

  switch (nom) {
    case "flutterwave":
      return flutterwave({
        cleSecrete: s("cleSecrete"),
        secretWebhook: s("secretWebhook"),
        production: identifiants["production"] === true,
        http,
      });

    case "paystack":
      return paystack({
        cleSecrete: s("cleSecrete"),
        http,
      });

    case "mtn":
      return mtn({
        utilisateurApi: s("utilisateurApi"),
        cleApi: s("cleApi"),
        cleAbonnement: s("cleAbonnement"),
        environnement: s("environnement"),
        base: typeof identifiants["base"] === "string" ? identifiants["base"] : undefined,
        http,
      });

    default:
      // Les quatre autres ne sont pas branchés. La fondation lève un message
      // qui nomme l'opérateur et ce qu'il reste à obtenir.
      return fondation(PAR_NOM[nom]!, { http });
  }
}

/**
 * Ce qu'un tableau de bord peut afficher pour aider à la configuration.
 *
 * Dérivé du registre plutôt que recopié : ajouter un fournisseur ajoute sa
 * ligne à l'écran. C'est la même règle que `relancesAnnoncees` dans le cœur, et
 * pour la même raison — un écran qui décrit le code doit être fabriqué à partir
 * du code.
 */
export function catalogue(): {
  nom: NomFournisseur;
  branche: boolean;
  champs: readonly string[];
  devises: readonly string[];
}[] {
  const branches = new Set<NomFournisseur>(["flutterwave", "paystack", "mtn"]);

  return (Object.keys(CHAMPS_REQUIS) as NomFournisseur[]).map((nom) => ({
    nom,
    branche: branches.has(nom),
    champs: CHAMPS_REQUIS[nom],
    devises: PAR_NOM[nom]?.devises ?? [],
  }));
}
