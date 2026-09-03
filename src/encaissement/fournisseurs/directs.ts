import {
  type Encaissement,
  type Http,
  type Issue,
} from "../port";

/**
 * Les opérateurs en direct dont l'intégration reste à finir.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CE FICHIER EXISTE ALORS QU'IL N'APPELLE RIEN
 *
 * Il ne s'agit pas de remplir le tableau des fournisseurs pris en charge. Il
 * s'agit de deux choses utiles tout de suite :
 *
 *   — **fixer la surface de configuration.** Un hôte qui prévoit de brancher
 *     Wave dans trois mois sait dès aujourd'hui quels champs il devra obtenir
 *     de son opérateur, et peut ouvrir les comptes en conséquence. C'est la
 *     partie longue — un compte marchand met des semaines, pas des heures ;
 *
 *   — **échouer en le disant.** Un adaptateur absent lève un message qui nomme
 *     l'opérateur, ce qui manque et où le trouver. Un adaptateur inventé, lui,
 *     échouerait au premier vrai paiement, en production, sur un abonné réel.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QU'ON N'A PAS FAIT, ET POURQUOI
 *
 * Aucune adresse d'API n'est écrite ici sur la foi d'un paquet communautaire ou
 * d'une page produit. La documentation technique d'Orange Money est derrière un
 * abonnement développeur ; celle de Moov et de Djamo se négocie avec
 * l'opérateur. Écrire des endpoints plausibles aurait donné l'illusion d'une
 * intégration, et l'illusion se paie au moment le plus cher.
 *
 * Chaque entrée porte donc ce qu'on sait vraiment, et ce qu'il reste à obtenir.
 */

/** Ce qu'il manque pour finir un adaptateur, dit à qui devra le finir. */
export interface Fondation {
  /** Le nom sous lequel on le demandera au registre. */
  nom: string;
  /** Les pays où cet opérateur sert, en ISO 3166-1 alpha-2. */
  pays: readonly string[];
  devises: readonly string[];
  /** Les champs que l'hôte devra remplir, tels qu'on les connaît aujourd'hui. */
  champs: readonly string[];
  /** Où obtenir les identifiants, et ce qui reste à établir. */
  aObtenir: string;
}

export const FONDATIONS: readonly Fondation[] = [
  {
    nom: "orange",
    pays: ["CI", "SN", "ML", "BF", "CM", "MG"],
    devises: ["XOF", "XAF"],
    champs: ["cleMarchand", "identifiantClient", "secretClient", "codeMarchand"],
    aObtenir:
      "Portail developer.orange.com, produit « Orange Money Web Payment ». " +
      "Le flux est connu dans ses grandes lignes — jeton OAuth, puis une " +
      "demande de paiement web qui rend une URL et deux jetons, l'un pour le " +
      "paiement et l'autre pour la notification — mais la documentation exacte " +
      "est derrière un abonnement développeur et n'a pas été lue à la source. " +
      "Particularité à ne pas oublier : l'abonné doit d'abord composer un code " +
      "USSD pour obtenir un mot de passe à usage unique, à chaque paiement.",
  },
  {
    nom: "wave",
    pays: ["SN", "CI", "ML", "BF"],
    devises: ["XOF"],
    champs: ["cleApi", "secretWebhook"],
    aObtenir:
      "Compte marchand Wave Business, puis clé d'API. Wave expose une API de " +
      "sessions de paiement qui rend une URL de lancement, et signe ses " +
      "webhooks — c'est l'opérateur direct le plus proche d'un agrégateur dans " +
      "son ergonomie. Les chemins exacts et la forme de la signature restent à " +
      "confirmer auprès de leur documentation marchande.",
  },
  {
    nom: "moov",
    pays: ["CI", "BJ", "TG", "BF", "ML", "NE"],
    devises: ["XOF"],
    champs: ["identifiantMarchand", "motDePasse", "codeMarchand"],
    aObtenir:
      "Contrat Moov Africa Money, par pays. L'API n'est pas publique : les " +
      "spécifications sont remises par l'opérateur à la signature. En pratique, " +
      "beaucoup d'hôtes passent par un agrégateur pour Moov plutôt que par une " +
      "intégration directe — c'est l'arbitrage à faire avant d'écrire ce fichier.",
  },
  {
    nom: "djamo",
    pays: ["CI", "SN"],
    devises: ["XOF"],
    champs: ["cleApi", "secretWebhook"],
    aObtenir:
      "Djamo Business. L'offre marchande existe mais son API n'est pas " +
      "documentée publiquement ; l'accès se demande à leur équipe. À traiter " +
      "en dernier des cinq, faute de spécification disponible.",
  },
];

/**
 * Fabrique un adaptateur qui refuse de faire semblant.
 *
 * Il implémente `Encaissement` en entier — donc le registre et le typage le
 * traitent comme les autres — mais chacun de ses verbes lève un message qui
 * dit l'opérateur, ce qui manque, et où le chercher.
 */
export function fondation(f: Fondation, _config?: { http?: Http }): Encaissement {
  const pourquoi = (verbe: string): Error =>
    new Error(
      `L'adaptateur « ${f.nom} » n'est pas encore branché : ${verbe} n'existe pas.\n` +
        `Pays : ${f.pays.join(", ")}. Devises : ${f.devises.join(", ")}.\n` +
        `Champs attendus : ${f.champs.join(", ")}.\n` +
        `${f.aObtenir}\n` +
        `En attendant, « flutterwave » ou « paystack » couvrent ce marché.`,
    );

  return {
    nom: f.nom,
    devises: f.devises,

    // Rejet plutôt que jet synchrone : ces deux méthodes sont déclarées
    // asynchrones, et une méthode asynchrone qui lève avant de rendre sa
    // promesse échappe au `.catch()` de l'appelant. Le passage quotidien
    // rattrape ses erreurs par `try/catch` autour d'un `await` — ce qui
    // marcherait — mais un hôte qui enchaîne des promesses verrait l'erreur
    // lui filer entre les doigts.
    inviter: () => Promise.reject(pourquoi("inviter")),
    constater: () => Promise.reject(pourquoi("constater")),

    // Celle-ci est synchrone dans le port : elle lève, et c'est cohérent.
    lireWebhook: (): Issue | null => {
      throw pourquoi("lireWebhook");
    },
  };
}

/** Les fondations, indexées par nom, pour le registre. */
export const PAR_NOM: Readonly<Record<string, Fondation>> = Object.fromEntries(
  FONDATIONS.map((f) => [f.nom, f]),
);
