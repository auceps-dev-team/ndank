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
 * En combien de décimales Flutterwave compte — **vérifié le 5 septembre 2026**.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DES UNITÉS MAJEURES, ET LA DOCUMENTATION LE MONTRE
 *
 * Longtemps supposé, jamais constaté. La documentation v4 de la charge en
 * mobile money donne l'exemple sans ambiguïté :
 *
 *     { "currency": "GHS", "amount": 200, ... }
 *
 * — deux cents cedis, et non deux cedis. Le champ est décrit comme « the
 * payment amount in decimals », minimum `0.01` : ce sont bien des unités
 * majeures, exactement le contraire de Paystack qui compte en centièmes.
 *
 * `0` est donc juste. C'était la case #8 de « ce qui n'est pas encore
 * éprouvé », et elle tombe sur lecture de la documentation — reste à la
 * confirmer sur le fil, ce qu'un tableau de bord marchand seul peut faire.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ET LE FRANC CFA NE POUVAIT PAS LE DIRE
 *
 * Pour le XOF, les deux lectures coïncident : l'ISO 4217 lui donne zéro
 * décimale, donc `versFournisseur(2000, "XOF", 0)` rend `2000` dans tous les
 * cas. L'essai le plus naturel de ce projet est précisément celui qui ne
 * départage rien.
 *
 * `npm run bac-a-sable` prend donc NGN par défaut, où deux cent mille unités
 * mineures partent comme deux mille — et prévient quand on lui donne une
 * devise qui n'apprend rien.
 */
const DECIMALES_FLUTTERWAVE = 0;

/**
 * Les adresses, vérifiées contre la documentation le 5 septembre 2026.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ELLES ÉTAIENT FAUSSES JUSQU'À LA 0.14.0
 *
 * On visait `api.flutterwave.cloud/developersandbox`, qui n'existe pas. La
 * documentation donne deux hôtes distincts, et non un hôte avec un chemin — la
 * différence est invisible à la lecture et absolue à l'exécution.
 *
 * Personne ne l'avait vu parce que rien n'avait jamais appelé : les tests
 * tournent contre un faux `Http`, et un faux répond à n'importe quelle adresse.
 */
const BASE = "https://developersandbox-api.flutterwave.com";
const BASE_PROD = "https://f4bexperience.flutterwave.com";

/** Là où l'on échange ses identifiants contre un jeton. Commun aux deux. */
const IDP =
  "https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token";

export interface ConfigFlutterwave {
  /**
   * L'identifiant client, du tableau de bord Flutterwave.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * CE N'EST PLUS UNE CLÉ SECRÈTE, ET C'EST UN CHANGEMENT DE FOND
   *
   * La v3 portait un `FLWSECK_TEST-…` qu'on présentait tel quel en `Bearer`.
   * La v4 ne l'accepte plus : on échange un couple identifiant/secret contre
   * un jeton d'accès valable **dix minutes**, et c'est ce jeton qui voyage.
   *
   * L'adaptateur envoyait le secret en direct jusqu'à la 0.14.0. Il ne s'est
   * jamais authentifié une seule fois — et rien ne l'a signalé, parce que les
   * tests répondent depuis un faux qui ne vérifie aucun en-tête.
   *
   * L'identifiant marchand du tableau de bord (`100837168`, ou le
   * `200772265` du mode test) n'est **pas** cela non plus : il désigne le
   * compte, il n'authentifie rien.
   */
  clientId: string;
  /** Le secret client, qui l'accompagne. Jamais envoyé ailleurs qu'à l'IDP. */
  clientSecret: string;
  /** Le « secret hash » déclaré côté webhooks. Sans lui, on ne peut rien vérifier. */
  secretWebhook: string;
  /** `false` par défaut : on ne part pas en production par accident. */
  production?: boolean;
  http?: Http;
}

/** Les champs que l'hôte doit remplir. Sert à la validation du registre. */
export const CHAMPS_FLUTTERWAVE = [
  "clientId",
  "clientSecret",
  "secretWebhook",
] as const;

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

  /**
   * Le jeton d'accès, gardé entre deux appels.
   *
   * ════════════════════════════════════════════════════════════════════════════
   * IL EST EN MÉMOIRE, ET C'EST SUFFISANT ICI
   *
   * Une souscription fait trois appels — client, moyen de paiement, charge — et
   * en redemander un à chaque fois multiplierait par deux le nombre d'allers-
   * retours pour rien.
   *
   * En mémoire de processus : deux instances en demandent chacune un, ce qui
   * est sans conséquence. Flutterwave ne les invalide pas l'un l'autre, et l'on
   * évite ainsi d'exiger un magasin partagé pour une valeur qui vit dix
   * minutes.
   *
   * On renouvelle trente secondes **avant** l'échéance. Sans cette marge, un
   * jeton obtenu à la première étape peut expirer entre le moyen de paiement et
   * la charge — et l'on échouerait au moment précis où l'on parle d'argent.
   */
  let jeton: { valeur: string; expireA: number } | null = null;

  async function jetonDAcces(): Promise<string> {
    if (jeton !== null && Date.now() < jeton.expireA) return jeton.valeur;

    const reponse = await http({
      methode: "POST",
      url: IDP,
      entetes: { "Content-Type": "application/x-www-form-urlencoded" },
      corps: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "client_credentials",
      }).toString(),
    });

    if (reponse.statut < 200 || reponse.statut >= 300) {
      throw new ErreurFournisseur(
        "flutterwave",
        reponse.statut,
        reponse.corps,
        "Flutterwave a refusé les identifiants. Ce sont `clientId` et " +
          "`clientSecret` du tableau de bord — ni une clé `FLWSECK_…`, ni " +
          "l'identifiant marchand.",
      );
    }

    const charge = JSON.parse(reponse.corps) as Record<string, unknown>;
    const valeur = charge["access_token"];
    if (typeof valeur !== "string" || valeur === "") {
      throw new ErreurFournisseur(
        "flutterwave",
        reponse.statut,
        reponse.corps,
        "aucun `access_token` dans la réponse de l'IDP",
      );
    }

    const secondes = Number(charge["expires_in"] ?? 600);
    jeton = { valeur, expireA: Date.now() + Math.max(0, secondes - 30) * 1000 };

    return valeur;
  }

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
        Authorization: `Bearer ${await jetonDAcces()}`,
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

      /**
       * Les en-têtes que la v4 exige sur chaque écriture.
       *
       * ═══════════════════════════════════════════════════════════════════
       * LA CLÉ D'IDEMPOTENCE DÉRIVE DE LA RÉFÉRENCE, ET NON DU HASARD
       *
       * C'est tout l'enjeu. Une clé tirée au sort à chaque appel satisferait
       * la validation de Flutterwave et ne protégerait de rien : deux passages
       * simultanés créeraient deux charges, chacune avec sa clé unique.
       *
       * La référence, elle, porte déjà le cycle et l'abonnement — c'est notre
       * garantie d'idempotence à nous. En la réutilisant ici, un rejeu retombe
       * sur la même clé, et Flutterwave rend la charge existante au lieu d'en
       * ouvrir une seconde.
       *
       * Le suffixe distingue les trois étapes : sans lui, la création du moyen
       * de paiement se verrait rendre le client de l'étape précédente.
       */
      const cles = (etape: string): Record<string, string> => ({
        "X-Idempotency-Key": `${demande.reference}-${etape}`,
        // Le traçage, lui, doit changer à chaque appel : c'est ce qui permet au
        // support de retrouver UNE tentative et non toutes.
        "X-Trace-Id": `${demande.reference}-${etape}-${Date.now().toString(36)}`,
      });

      // 1 — le client.
      const client = donnees(
        await appeler("/customers", "POST", {
          email: demande.abonne.courriel ?? undefined,
          name: { first: demande.abonne.nom ?? "Abonné" },
          phone: { country_code: decoupe.indicatif, number: decoupe.numero },
        }, cles("client")),
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
        }, cles("moyen")),
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
        }, cles("charge")),
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
