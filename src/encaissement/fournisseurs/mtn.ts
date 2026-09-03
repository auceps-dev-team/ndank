import {
  ErreurFournisseur,
  httpParDefaut,
  type Demande,
  type Encaissement,
  type EtatEncaissement,
  type Http,
  type Invitation,
  type Issue,
} from "../port";

/**
 * MTN MoMo Collections — l'opérateur en direct.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * MOINS CHER QU'UN AGRÉGATEUR, ET NETTEMENT PLUS BAVARD
 *
 * Pas de commission d'intermédiaire, mais un compte marchand par pays, une clé
 * d'abonnement par produit, et une danse d'authentification en trois temps que
 * les agrégateurs masquent :
 *
 *   1. créer un utilisateur d'API (une fois, hors ligne) ;
 *   2. générer sa clé (une fois, hors ligne) ;
 *   3. échanger le couple contre un jeton porteur — **valable une heure**.
 *
 * Les deux premiers temps ne sont pas ici : ils se font une fois, à la main ou
 * par un script d'installation, et leur résultat va dans la configuration. Le
 * troisième est fait à la demande et mis en cache, parce qu'un passage
 * quotidien qui relance trois cents abonnés ne doit pas demander trois cents
 * jetons.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * X-REFERENCE-ID EST LA CLÉ D'IDEMPOTENCE, ET C'EST LA NÔTRE
 *
 * MTN impose un UUID par transaction, qu'il traite comme clé d'idempotence et
 * qui sert ensuite à interroger l'état. Notre clé de cycle n'est pas un UUID —
 * c'est une date. On en dérive donc un UUID **déterministe** : rejouer un
 * passage produit le même identifiant, donc la même transaction, et non une
 * seconde demande de paiement au même abonné.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LES RAPPELS NE SONT PAS SIGNÉS
 *
 * MTN poste le résultat sur l'adresse déclarée à la création de l'utilisateur
 * d'API, sans en-tête d'authenticité. On ne peut donc pas croire le corps du
 * rappel : `lireWebhook` ne le lit que pour en extraire une référence, et rend
 * un état `INCONNU` qui oblige l'appelant à passer par `constater` — lequel
 * interroge MTN par un appel authentifié.
 *
 * C'est plus lent, et c'est la seule façon sûre.
 */

export interface ConfigMtn {
  /** L'identifiant de l'utilisateur d'API (un UUID), créé une fois. */
  utilisateurApi: string;
  /** La clé de cet utilisateur, générée une fois. */
  cleApi: string;
  /** La clé d'abonnement au produit Collections. */
  cleAbonnement: string;
  /** `sandbox` ou le nom du marché en production — `mtnivorycoast`, `mtnghana`… */
  environnement: string;
  /** Défaut : le bac à sable. On ne part pas en production par accident. */
  base?: string;
  http?: Http;
}

export const CHAMPS_MTN = [
  "utilisateurApi",
  "cleApi",
  "cleAbonnement",
  "environnement",
] as const;

const BASE_SANDBOX = "https://sandbox.momodeveloper.mtn.com";

/**
 * Un UUID v4 déterministe, dérivé d'une chaîne.
 *
 * MTN veut un UUID ; Ndank a une clé de cycle stable. Les faire correspondre
 * par un hachage garde les deux propriétés : la forme qu'exige MTN, et
 * l'idempotence qu'exige un passage quotidien rejouable.
 *
 * Ce n'est pas de la cryptographie — juste une mise en forme. On ne cherche ni
 * imprévisibilité ni résistance aux collisions au-delà de ce qu'un espace de
 * 128 bits offre naturellement.
 */
export async function uuidDeterministe(graine: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256").update(graine, "utf8").digest("hex");

  const v4 = [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    // Le variant RFC 4122 impose 8, 9, a ou b comme premier chiffre.
    `${"89ab"[parseInt(h[16]!, 16) % 4]}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ];

  return v4.join("-");
}

function etatDepuis(statut: string | undefined): EtatEncaissement {
  switch ((statut ?? "").toUpperCase()) {
    case "SUCCESSFUL":
      return "REUSSI";
    case "PENDING":
      return "EN_ATTENTE";
    case "FAILED":
    case "REJECTED":
      return "ECHOUE";
    case "TIMEOUT":
    case "EXPIRED":
      return "EXPIRE";
    default:
      return "INCONNU";
  }
}

export function mtn(config: ConfigMtn): Encaissement {
  const http = config.http ?? httpParDefaut;
  const base = config.base ?? BASE_SANDBOX;

  /** Le jeton et sa péremption. Une heure annoncée, renouvelé une minute avant. */
  let jeton: { valeur: string; expireLe: number } | null = null;

  async function porteur(): Promise<string> {
    if (jeton && Date.now() < jeton.expireLe) return jeton.valeur;

    const identite = Buffer.from(
      `${config.utilisateurApi}:${config.cleApi}`,
      "utf8",
    ).toString("base64");

    const reponse = await http({
      methode: "POST",
      url: `${base}/collection/token/`,
      entetes: {
        Authorization: `Basic ${identite}`,
        "Ocp-Apim-Subscription-Key": config.cleAbonnement,
      },
      corps: "",
    });

    if (reponse.statut < 200 || reponse.statut >= 300) {
      throw new ErreurFournisseur("mtn", reponse.statut, reponse.corps);
    }

    const lu = JSON.parse(reponse.corps) as { access_token: string; expires_in: number };
    const duree = Number(lu.expires_in ?? 3600);

    jeton = {
      valeur: lu.access_token,
      expireLe: Date.now() + Math.max(0, duree - 60) * 1000,
    };

    return jeton.valeur;
  }

  return {
    nom: "mtn",
    devises: ["XOF", "XAF", "GHS", "UGX", "RWF", "ZMW", "EUR"],

    async inviter(demande: Demande): Promise<Invitation> {
      if (!demande.abonne.telephone) {
        throw new ErreurFournisseur(
          "mtn",
          0,
          "",
          "MTN débite un numéro : cet abonné n'en a pas.",
        );
      }

      const identifiant = await uuidDeterministe(`mtn:${demande.reference}`);

      const reponse = await http({
        methode: "POST",
        url: `${base}/collection/v1_0/requesttopay`,
        entetes: {
          Authorization: `Bearer ${await porteur()}`,
          "Content-Type": "application/json",
          "Ocp-Apim-Subscription-Key": config.cleAbonnement,
          "X-Reference-Id": identifiant,
          "X-Target-Environment": config.environnement,
        },
        corps: JSON.stringify({
          amount: String(demande.montant),
          currency: demande.devise,
          externalId: demande.reference,
          payer: {
            partyIdType: "MSISDN",
            partyId: demande.abonne.telephone.replace(/[^0-9]/g, ""),
          },
          payerMessage: demande.libelle,
          payeeNote: demande.libelle,
        }),
      });

      // MTN accepte par 202 : la demande est prise, rien n'est encore payé.
      if (reponse.statut !== 202) {
        throw new ErreurFournisseur("mtn", reponse.statut, reponse.corps);
      }

      return {
        reference: demande.reference,
        identifiantFournisseur: identifiant,
        // Aucune page : la demande apparaît directement sur le téléphone.
        url: null,
        instruction:
          `Validez la demande de paiement de ${demande.montant} ${demande.devise} ` +
          `reçue sur le ${demande.abonne.telephone}.`,
        etat: "EN_ATTENTE",
        expireLe: null,
      };
    },

    async constater(reference: string): Promise<Issue> {
      const identifiant = await uuidDeterministe(`mtn:${reference}`);

      const reponse = await http({
        methode: "GET",
        url: `${base}/collection/v1_0/requesttopay/${identifiant}`,
        entetes: {
          Authorization: `Bearer ${await porteur()}`,
          "Ocp-Apim-Subscription-Key": config.cleAbonnement,
          "X-Target-Environment": config.environnement,
        },
      });

      if (reponse.statut < 200 || reponse.statut >= 300) {
        throw new ErreurFournisseur("mtn", reponse.statut, reponse.corps);
      }

      const lu = JSON.parse(reponse.corps) as Record<string, unknown>;

      return {
        reference,
        etat: etatDepuis(lu["status"] as string),
        montant: Number(lu["amount"] ?? 0),
        devise: (lu["currency"] as string) ?? "",
        identifiantFournisseur: identifiant,
        regleLe: null,
        brut: lu,
      };
    },

    lireWebhook(corps: string): Issue | null {
      // Non signé : on n'en tire qu'une référence, et surtout pas un état.
      // `INCONNU` force l'appelant à passer par `constater`, qui est authentifié.
      let lu: Record<string, unknown>;
      try {
        lu = JSON.parse(corps) as Record<string, unknown>;
      } catch {
        return null;
      }

      const reference = lu["externalId"];
      if (typeof reference !== "string" || reference === "") return null;

      return {
        reference,
        etat: "INCONNU",
        montant: Number(lu["amount"] ?? 0),
        devise: (lu["currency"] as string) ?? "",
        identifiantFournisseur: (lu["referenceId"] as string) ?? null,
        regleLe: null,
        brut: lu,
      };
    },
  };
}
