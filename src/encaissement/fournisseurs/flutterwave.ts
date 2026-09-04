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
import { depuisFournisseur, versFournisseur } from "../../devise";
import { verifierFlutterwave } from "../signature";

/**
 * Flutterwave — l'agrégateur qui couvre le plus de terrain d'un seul contrat.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TROIS APPELS POUR UNE INVITATION, ET C'EST VOULU PAR EUX
 *
 * Là où Paystack initie une transaction d'un seul coup, Flutterwave demande de
 * créer un client, puis un moyen de paiement, puis la charge. C'est plus
 * bavard, et cela a une conséquence directe sur la latence d'un passage
 * quotidien : trois allers-retours par abonné à relancer, pas un.
 *
 * On ne cherche pas à masquer ce coût derrière une abstraction — on le rend
 * visible, parce que c'est lui qui décidera un jour de mettre les invitations
 * dans une file plutôt que dans la boucle du passage.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LA DEVISE DE LA CHARGE DOIT ÊTRE CELLE DU MOYEN DE PAIEMENT
 *
 * Leur documentation le pose comme une règle : « the charge currency must
 * match the currency_code used when creating the payment method ». Le moyen de
 * paiement est déduit de l'indicatif téléphonique de l'abonné ; la devise vient
 * de l'abonnement. Les deux peuvent diverger — un numéro ivoirien et un
 * abonnement en GHS — et le fournisseur refuse alors sans que la cause soit
 * lisible dans son message.
 *
 * On vérifie donc avant d'appeler, pour que l'erreur nomme le vrai problème.
 */

/**
 * En combien de décimales Flutterwave compte — et ce point n'est PAS vérifié.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QU'ON SAIT, ET CE QU'ON NE SAIT PAS
 *
 * Paystack a été mesuré : il compte en centièmes quelle que soit la devise, ce
 * qui faisait facturer vingt francs pour deux mille. Flutterwave n'a pas pu
 * l'être — personne n'a fourni de clé de bac à sable.
 *
 * `0` traduit la lecture qu'on a de sa documentation : des unités **majeures**,
 * `amount: 2000` valant deux mille francs. C'est le contraire de Paystack.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CE DOUTE NE PEUT PAS MORDRE LE MARCHÉ PRINCIPAL
 *
 * Pour le franc CFA, les deux lectures coïncident : l'ISO 4217 lui donne zéro
 * décimale, donc `versFournisseur(2000, "XOF", 0)` rend `2000` — la même chose
 * qu'avant ce fichier.
 *
 * L'incertitude ne concerne donc que les devises à deux décimales — cedi,
 * naira, shilling — chez un hôte Flutterwave. Et si elle se révélait fausse,
 * elle **sous-facturerait** : `2000` en GHS partirait comme 20 cedis au lieu de
 * 2 000 pesewas. C'est le sens dans lequel on préfère se tromper.
 *
 * `npm run bac-a-sable` le vérifie dès qu'une clé Flutterwave est posée : il
 * compare ce qu'on envoie à ce que la charge rapporte.
 */
const DECIMALES_FLUTTERWAVE = 0;

const BASE = "https://api.flutterwave.cloud/developersandbox";
const BASE_PROD = "https://api.flutterwave.cloud/f4bexperience";

export interface ConfigFlutterwave {
  /** Clé secrète du tableau de bord Flutterwave. */
  cleSecrete: string;
  /** Le « secret hash » déclaré côté webhooks. Sans lui, on ne peut rien vérifier. */
  secretWebhook: string;
  /** `false` par défaut : on ne part pas en production par accident. */
  production?: boolean;
  http?: Http;
}

/** Les champs que l'hôte doit remplir. Sert à la validation du registre. */
export const CHAMPS_FLUTTERWAVE = ["cleSecrete", "secretWebhook"] as const;

/**
 * Indicatif → réseau et devise attendue.
 *
 * Volontairement court : ce sont les marchés où Ndank a un sens aujourd'hui.
 * Un indicatif absent n'est pas une erreur ici — on laisse le fournisseur
 * trancher plutôt que d'inventer une règle qui lui survivrait mal.
 */
const MARCHES: Record<string, { devise: string }> = {
  "225": { devise: "XOF" }, // Côte d'Ivoire
  "221": { devise: "XOF" }, // Sénégal
  "226": { devise: "XOF" }, // Burkina Faso
  "223": { devise: "XOF" }, // Mali
  "229": { devise: "XOF" }, // Bénin
  "228": { devise: "XOF" }, // Togo
  "237": { devise: "XAF" }, // Cameroun
  "233": { devise: "GHS" }, // Ghana
  "234": { devise: "NGN" }, // Nigeria
  "256": { devise: "UGX" }, // Ouganda
  "250": { devise: "RWF" }, // Rwanda
};

/**
 * Leurs statuts, ramenés aux nôtres.
 *
 * `succeeded` et `successful` coexistent selon l'ancienneté de l'endpoint.
 * Tout ce qui n'est pas listé devient `INCONNU` et surtout pas `ECHOUE` :
 * conclure à l'échec sur un mot qu'on ne connaît pas couperait l'accès de
 * quelqu'un qui a peut-être payé.
 */
function etatDepuis(statut: string | undefined): EtatEncaissement {
  switch ((statut ?? "").toLowerCase()) {
    case "succeeded":
    case "successful":
    case "success":
      return "REUSSI";
    case "pending":
    case "processing":
      return "EN_ATTENTE";
    case "failed":
    case "cancelled":
    case "canceled":
      return "ECHOUE";
    case "expired":
    case "timed_out":
      return "EXPIRE";
    default:
      return "INCONNU";
  }
}

/** Sépare `+2250700000000` en indicatif et numéro national. */
export function decouperNumero(
  telephone: string,
): { indicatif: string; numero: string } | null {
  const chiffres = telephone.replace(/[^0-9]/g, "");
  if (chiffres.length < 8) return null;

  // Du plus long au plus court : `225` avant `22`, sinon on couperait mal.
  for (const indicatif of Object.keys(MARCHES).sort((a, b) => b.length - a.length)) {
    if (chiffres.startsWith(indicatif)) {
      return { indicatif, numero: chiffres.slice(indicatif.length) };
    }
  }

  return null;
}

export function flutterwave(config: ConfigFlutterwave): Encaissement {
  const http = config.http ?? httpParDefaut;
  const base = config.production ? BASE_PROD : BASE;

  async function appeler(
    chemin: string,
    methode: "GET" | "POST",
    corps?: unknown,
    entetesEnPlus: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const reponse = await http({
      methode,
      url: `${base}${chemin}`,
      entetes: {
        Authorization: `Bearer ${config.cleSecrete}`,
        "Content-Type": "application/json",
        ...entetesEnPlus,
      },
      corps: corps === undefined ? undefined : JSON.stringify(corps),
    });

    if (reponse.statut < 200 || reponse.statut >= 300) {
      throw new ErreurFournisseur("flutterwave", reponse.statut, reponse.corps);
    }

    try {
      return JSON.parse(reponse.corps) as Record<string, unknown>;
    } catch {
      throw new ErreurFournisseur(
        "flutterwave",
        reponse.statut,
        reponse.corps,
        "flutterwave a répondu autre chose que du JSON",
      );
    }
  }

  function donnees(enveloppe: Record<string, unknown>): Record<string, unknown> {
    const d = enveloppe["data"];
    return d && typeof d === "object" ? (d as Record<string, unknown>) : {};
  }

  return {
    nom: "flutterwave",
    devises: ["XOF", "XAF", "GHS", "NGN", "UGX", "RWF", "KES", "ZAR", "TZS"],

    async inviter(demande: Demande): Promise<Invitation> {
      if (!demande.abonne.telephone) {
        throw new ErreurFournisseur(
          "flutterwave",
          0,
          "",
          "Flutterwave a besoin d'un numéro pour le mobile money, et cet abonné n'en a pas.",
        );
      }

      const decoupe = decouperNumero(demande.abonne.telephone);
      if (!decoupe) {
        throw new ErreurFournisseur(
          "flutterwave",
          0,
          "",
          `Numéro inexploitable ou marché non couvert : ${demande.abonne.telephone}`,
        );
      }

      const marche = MARCHES[decoupe.indicatif]!;
      if (marche.devise !== demande.devise) {
        throw new ErreurFournisseur(
          "flutterwave",
          0,
          "",
          `Flutterwave exige que la devise de la charge soit celle du moyen de ` +
            `paiement : l'indicatif +${decoupe.indicatif} paie en ${marche.devise}, ` +
            `l'abonnement est en ${demande.devise}.`,
        );
      }

      // 1 — le client.
      const client = donnees(
        await appeler("/customers", "POST", {
          email: demande.abonne.courriel ?? undefined,
          name: { first: demande.abonne.nom ?? "Abonné" },
          phone: { country_code: decoupe.indicatif, number: decoupe.numero },
        }),
      );

      // 2 — le moyen de paiement. Le réseau est laissé au fournisseur : il le
      //     déduit du préfixe mieux que nous, et ce mapping vieillirait mal.
      const moyen = donnees(
        await appeler("/payment-methods", "POST", {
          type: "mobile_money",
          mobile_money: {
            country_code: decoupe.indicatif,
            phone_number: decoupe.numero,
          },
        }),
      );

      // 3 — la charge. `reference` est notre clé de cycle : rejouer le passage
      //     ne crée pas une seconde charge.
      const charge = donnees(
        await appeler("/charges", "POST", {
          currency: demande.devise,
          customer_id: client["id"],
          payment_method_id: moyen["id"],
          amount: versFournisseur(
            demande.montant,
            demande.devise,
            DECIMALES_FLUTTERWAVE,
          ),
          reference: demande.reference,
          redirect_url: demande.retour,
          meta: { libelle: demande.libelle },
        }),
      );

      const suite = charge["next_action"] as Record<string, unknown> | undefined;
      const redirection = suite?.["redirect_url"] as Record<string, unknown> | undefined;
      const consigne = suite?.["payment_instruction"] as Record<string, unknown> | undefined;

      return {
        reference: demande.reference,
        identifiantFournisseur: (charge["id"] as string) ?? null,
        url: (redirection?.["url"] as string) ?? null,
        instruction: (consigne?.["note"] as string) ?? null,
        etat: etatDepuis(charge["status"] as string),
        expireLe: null,
      };
    },

    async constater(reference: string): Promise<Issue> {
      const enveloppe = await appeler(
        `/charges?reference=${encodeURIComponent(reference)}`,
        "GET",
      );

      const brut = enveloppe["data"];
      const charge = Array.isArray(brut)
        ? ((brut[0] ?? {}) as Record<string, unknown>)
        : donnees(enveloppe);

      return lireCharge(reference, charge, enveloppe);
    },

    lireWebhook(corps: string, entetes: Entetes): Issue | null {
      if (!verifierFlutterwave(corps, entetes, config.secretWebhook)) {
        throw new SignatureInvalide("flutterwave");
      }

      let enveloppe: Record<string, unknown>;
      try {
        enveloppe = JSON.parse(corps) as Record<string, unknown>;
      } catch {
        throw new ErreurFournisseur(
          "flutterwave",
          0,
          corps.slice(0, 200),
          "Webhook signé mais illisible",
        );
      }

      // Beaucoup d'autres événements passent par la même adresse — virements,
      // litiges, remboursements. Les ignorer poliment vaut mieux que lever.
      const type = enveloppe["type"] ?? enveloppe["event"];
      if (typeof type === "string" && !type.startsWith("charge.")) return null;

      const charge = donnees(enveloppe);
      const reference =
        (charge["reference"] as string) ?? (charge["tx_ref"] as string) ?? "";

      if (!reference) return null;

      return lireCharge(reference, charge, enveloppe);
    },
  };
}

/** Une charge Flutterwave, ramenée à une `Issue`. */
function lireCharge(
  reference: string,
  charge: Record<string, unknown>,
  brut: unknown,
): Issue {
  const quand = charge["created_datetime"] ?? charge["created_at"];

  return {
    reference,
    etat: etatDepuis(charge["status"] as string),
    montant: depuisFournisseur(
      Number(charge["amount"] ?? 0),
      String(charge["currency"] ?? ""),
      DECIMALES_FLUTTERWAVE,
    ),
    devise: (charge["currency"] as string) ?? "",
    identifiantFournisseur: (charge["id"] as string) ?? null,
    regleLe: typeof quand === "string" ? new Date(quand) : null,
    brut,
  };
}
