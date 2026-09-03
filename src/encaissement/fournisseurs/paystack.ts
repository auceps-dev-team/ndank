import {
  ErreurFournisseur,
  SignatureInvalide,
  httpParDefaut,
  type Demande,
  type Encaissement,
  type Entetes,
  type EtatEncaissement,
  type Http,
  type Invitation,
  type Issue,
} from "../port";
import { verifierPaystack } from "../signature";

/**
 * Paystack — l'agrégateur le plus simple à câbler, et le plus explicite sur ses
 * limites.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UNE SEULE INITIALISATION, ET UNE URL
 *
 * Là où Flutterwave demande trois appels, Paystack en demande un :
 * `/transaction/initialize` rend une `authorization_url` vers laquelle on
 * envoie l'abonné. C'est lui qui choisit son moyen sur la page — sauf si on
 * restreint `channels`, ce qu'on fait ici pour ne proposer que le mobile money.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QUE PAYSTACK NE PEUT PAS FAIRE, ET QUI JUSTIFIE NDANK
 *
 * Paystack sait tenir des abonnements. Sa documentation précise que
 * l'autorisation stockée n'est réutilisable que pour la **carte**, sur tous ses
 * marchés, et pour le **prélèvement direct au Nigeria**. Elle expose même un
 * booléen `reusable` et recommande de ne tenter une charge différée que s'il
 * vaut `true`.
 *
 * Sur du mobile money, il ne vaut jamais `true`.
 *
 * Deuxième limite, moins connue : les abonnements Paystack **ne réessaient
 * pas**. Un prélèvement qui échoue n'est pas retenté, et leur documentation
 * renvoie le commerçant vers un paiement ponctuel. Même là où le récurrent
 * existe, la relance reste à écrire — c'est-à-dire que `passer()` a sa place y
 * compris pour un hôte qui encaisse par carte.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE MONTANT EST EN UNITÉS MINEURES, ET LE XOF N'EN A PAS
 *
 * Paystack compte en kobo pour le naira, en pesewas pour le cedi. Le franc CFA
 * n'a pas de subdivision en circulation : 2 000 F se transmet `2000` et non
 * `200000`. Se tromper d'un facteur cent sur un débit réel est le genre
 * d'erreur qu'on ne fait qu'une fois — d'où ce paragraphe plutôt qu'une
 * conversion silencieuse ici.
 */

const BASE = "https://api.paystack.co";

export interface ConfigPaystack {
  /** Clé secrète `sk_...`. Sert aussi à vérifier la signature des webhooks. */
  cleSecrete: string;
  /**
   * Les moyens proposés sur la page de paiement.
   *
   * `mobile_money` par défaut, parce que c'est la raison d'être de Ndank. Un
   * hôte qui veut aussi accepter la carte l'ajoute — et gagne alors le
   * récurrent natif de Paystack pour ces abonnés-là.
   */
  canaux?: string[];
  http?: Http;
}

export const CHAMPS_PAYSTACK = ["cleSecrete"] as const;

function etatDepuis(statut: string | undefined): EtatEncaissement {
  switch ((statut ?? "").toLowerCase()) {
    case "success":
      return "REUSSI";
    case "pending":
    case "ongoing":
    case "processing":
    case "send_otp":
    case "send_pin":
    case "pay_offline":
      return "EN_ATTENTE";
    case "failed":
    case "reversed":
      return "ECHOUE";
    case "abandoned":
      return "EXPIRE";
    default:
      return "INCONNU";
  }
}

export function paystack(config: ConfigPaystack): Encaissement {
  const http = config.http ?? httpParDefaut;
  const canaux = config.canaux ?? ["mobile_money"];

  async function appeler(
    chemin: string,
    methode: "GET" | "POST",
    corps?: unknown,
  ): Promise<Record<string, unknown>> {
    const reponse = await http({
      methode,
      url: `${BASE}${chemin}`,
      entetes: {
        Authorization: `Bearer ${config.cleSecrete}`,
        "Content-Type": "application/json",
      },
      corps: corps === undefined ? undefined : JSON.stringify(corps),
    });

    let lu: Record<string, unknown>;
    try {
      lu = JSON.parse(reponse.corps) as Record<string, unknown>;
    } catch {
      throw new ErreurFournisseur(
        "paystack",
        reponse.statut,
        reponse.corps,
        "paystack a répondu autre chose que du JSON",
      );
    }

    // Paystack porte l'échec dans le corps autant que dans le statut : un 200
    // avec `status: false` est un refus, et le lire comme un succès ferait
    // ouvrir un accès sur une transaction qui n'existe pas.
    if (reponse.statut < 200 || reponse.statut >= 300 || lu["status"] === false) {
      throw new ErreurFournisseur(
        "paystack",
        reponse.statut,
        (lu["message"] as string) ?? reponse.corps,
      );
    }

    return lu;
  }

  function donnees(enveloppe: Record<string, unknown>): Record<string, unknown> {
    const d = enveloppe["data"];
    return d && typeof d === "object" ? (d as Record<string, unknown>) : {};
  }

  return {
    nom: "paystack",
    devises: ["NGN", "GHS", "ZAR", "KES", "XOF", "EGP"],

    async inviter(demande: Demande): Promise<Invitation> {
      // Paystack identifie ses clients par courriel : c'est le seul champ
      // réellement obligatoire, et un abonné mobile money n'en a pas toujours.
      // On refuse tôt et en le disant, plutôt que de laisser le fournisseur
      // répondre « email is required » à trois appels de distance.
      if (!demande.abonne.courriel) {
        throw new ErreurFournisseur(
          "paystack",
          0,
          "",
          "Paystack identifie ses clients par courriel, et cet abonné n'en a pas.",
        );
      }

      const lu = donnees(
        await appeler("/transaction/initialize", "POST", {
          email: demande.abonne.courriel,
          amount: demande.montant,
          currency: demande.devise,
          reference: demande.reference,
          callback_url: demande.retour,
          channels: canaux,
          metadata: {
            libelle: demande.libelle,
            nom: demande.abonne.nom,
            telephone: demande.abonne.telephone,
          },
        }),
      );

      return {
        reference: demande.reference,
        identifiantFournisseur: (lu["access_code"] as string) ?? null,
        url: (lu["authorization_url"] as string) ?? null,
        instruction: null,
        etat: "EN_ATTENTE",
        expireLe: null,
      };
    },

    async constater(reference: string): Promise<Issue> {
      const enveloppe = await appeler(
        `/transaction/verify/${encodeURIComponent(reference)}`,
        "GET",
      );

      return lireTransaction(reference, donnees(enveloppe), enveloppe);
    },

    lireWebhook(corps: string, entetes: Entetes): Issue | null {
      if (!verifierPaystack(corps, entetes["x-paystack-signature"], config.cleSecrete)) {
        throw new SignatureInvalide("paystack");
      }

      let enveloppe: Record<string, unknown>;
      try {
        enveloppe = JSON.parse(corps) as Record<string, unknown>;
      } catch {
        throw new ErreurFournisseur(
          "paystack",
          0,
          corps.slice(0, 200),
          "Webhook signé mais illisible",
        );
      }

      // Paystack émet vingt-trois événements sur la même adresse : litiges,
      // virements, comptes virtuels. Seuls ceux qui parlent d'une charge nous
      // concernent.
      const evenement = enveloppe["event"];
      if (typeof evenement !== "string" || !evenement.startsWith("charge.")) {
        return null;
      }

      const transaction = donnees(enveloppe);
      const reference = (transaction["reference"] as string) ?? "";
      if (!reference) return null;

      return lireTransaction(reference, transaction, enveloppe);
    },
  };
}

function lireTransaction(
  reference: string,
  transaction: Record<string, unknown>,
  brut: unknown,
): Issue {
  const quand = transaction["paid_at"] ?? transaction["paidAt"];

  return {
    reference,
    etat: etatDepuis(transaction["status"] as string),
    montant: Number(transaction["amount"] ?? 0),
    devise: (transaction["currency"] as string) ?? "",
    identifiantFournisseur:
      transaction["id"] === undefined ? null : String(transaction["id"]),
    regleLe: typeof quand === "string" ? new Date(quand) : null,
    brut,
  };
}
