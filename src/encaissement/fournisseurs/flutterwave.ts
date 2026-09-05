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
 * L'adresse, éprouvée avec de vraies clés le 5 septembre 2026.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LA V3, PARCE QUE C'EST CELLE QUI RÉPOND
 *
 * La 0.14.0 visait la v4 — deux hôtes, un échange OAuth préalable, un flux en
 * trois appels. C'était fidèle à la documentation la plus récente, et
 * inutilisable : le tableau de bord Flutterwave délivre des clés `FLWSECK_…`,
 * et l'IDP de la v4 les refuse. Mesuré, pas supposé :
 *
 *     v4  idp.flutterwave.com   → 401  invalid_client
 *     v3  api.flutterwave.com   → 200
 *
 * On ne choisit donc pas l'API la plus moderne, on choisit celle que le compte
 * d'un marchand peut réellement employer. Le jour où Flutterwave délivrera des
 * identifiants v4 depuis le même tableau de bord, le travail de la 0.14.0 est
 * dans l'historique — il n'est pas perdu, il est prématuré.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * C'EST LA CLÉ QUI CHOISIT L'ENVIRONNEMENT, PAS L'ADRESSE
 *
 * Un seul hôte pour le bac à sable et la production : `FLWSECK_TEST-…` teste,
 * `FLWSECK-…` débite pour de bon. Rien dans l'URL ne le laisse voir.
 *
 * C'est un piège de configuration sérieux — une clé recopiée du mauvais onglet
 * prélève de l'argent réel sans qu'aucune adresse ne change. D'où le refus plus
 * bas : sans `production: true`, l'adaptateur n'accepte pas une clé de
 * production.
 */
const BASE = "https://api.flutterwave.com/v3";

/**
 * Le canal de charge, selon le pays.
 *
 * Flutterwave ne l'infère pas : c'est un paramètre d'URL, et se tromper donne
 * une erreur qui parle de champs manquants plutôt que de pays.
 */
const CANAUX: Record<string, string> = {
  "225": "mobile_money_franco", // Côte d'Ivoire
  "221": "mobile_money_franco", // Sénégal
  "226": "mobile_money_franco", // Burkina Faso
  "223": "mobile_money_franco", // Mali
  "229": "mobile_money_franco", // Bénin
  "228": "mobile_money_franco", // Togo
  "237": "mobile_money_franco", // Cameroun
  "233": "mobile_money_ghana", // Ghana — exige en plus un réseau
  "256": "mobile_money_uganda", // Ouganda
  "250": "mobile_money_rwanda", // Rwanda
};

/** Le code pays ISO, que la v3 réclame à côté du numéro. */
const PAYS: Record<string, string> = {
  "225": "CI",
  "221": "SN",
  "226": "BF",
  "223": "ML",
  "229": "BJ",
  "228": "TG",
  "237": "CM",
  "233": "GH",
  "256": "UG",
  "250": "RW",
};

export interface ConfigFlutterwave {
  /**
   * La clé secrète du tableau de bord — `FLWSECK_TEST-…` ou `FLWSECK-…`.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * CE N'EST NI LA CLÉ PUBLIQUE, NI LA CLÉ DE CHIFFREMENT
   *
   * Le tableau de bord en donne trois, et une seule sert ici :
   *
   *   — `FLWPUBK_…` est publique et n'authentifie aucun appel serveur ;
   *   — la clé de chiffrement sert au 3-D Secure des cartes, que Ndank ne
   *     touche pas ;
   *   — `FLWSECK_…` est celle-ci.
   *
   * L'identifiant marchand du tableau de bord n'en est pas une non plus : il
   * désigne le compte, il ne l'ouvre pas.
   */
  cleSecrete: string;

  /** Le « secret hash » déclaré côté webhooks. Sans lui, on ne peut rien vérifier. */
  secretWebhook: string;

  /**
   * Le réseau ghanéen, quand l'hôte vend au Ghana.
   *
   * Le Ghana est le seul marché où la v3 réclame le réseau en plus du numéro,
   * et il ne se déduit pas du préfixe : la portabilité y est effective depuis
   * des années, donc un 024 n'est plus forcément MTN.
   *
   * `MTN` par défaut, qui couvre la majorité — mais un hôte ghanéen doit poser
   * la vraie valeur, sinon il facturera les abonnés Vodafone sur le mauvais
   * réseau et la charge échouera.
   */
  reseauGhana?: "MTN" | "VODAFONE" | "AIRTELTIGO";

  /**
   * Autorise une clé de production. `false` par défaut.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * IL NE CHANGE PAS L'ADRESSE — IL AUTORISE UNE CLÉ
   *
   * La v3 n'a qu'un seul hôte : c'est le préfixe de la clé qui décide si l'on
   * teste ou si l'on débite. Une clé recopiée du mauvais onglet prélève donc de
   * l'argent réel sans qu'aucune configuration ne change d'apparence.
   *
   * L'adaptateur refuse de se construire sur une clé sans `_TEST` tant que ce
   * drapeau n'est pas posé. C'est le seul endroit du dépôt où l'on préfère
   * refuser de démarrer plutôt que de laisser passer.
   */
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

  // Le seul refus de démarrage du dépôt. Voir `production` : rien dans l'URL
  // ne distingue un essai d'un débit réel, alors on regarde la clé.
  if (!config.cleSecrete.includes("_TEST") && config.production !== true) {
    throw new ErreurFournisseur(
      "flutterwave",
      0,
      "",
      "Cette clé Flutterwave n'est pas une clé de test, et `production` n'est " +
        "pas activé. La v3 n'a qu'une seule adresse : c'est le préfixe de la " +
        "clé qui décide si l'on éprouve ou si l'on débite.",
    );
  }

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

    if (reponse.statut < 200 || reponse.statut >= 300) {
      throw new ErreurFournisseur("flutterwave", reponse.statut, reponse.corps);
    }

    let enveloppe: Record<string, unknown>;
    try {
      enveloppe = JSON.parse(reponse.corps) as Record<string, unknown>;
    } catch {
      throw new ErreurFournisseur(
        "flutterwave",
        reponse.statut,
        reponse.corps,
        "flutterwave a répondu autre chose que du JSON",
      );
    }

    /**
     * La v3 répond 200 sur des refus, et le dit dans le corps.
     *
     * `{"status":"error","message":"..."}` arrive avec un code 200. Ne
     * regarder que le statut HTTP ferait donc prendre un refus pour une charge
     * ouverte — et l'abonné attendrait une invite qui ne viendra jamais.
     */
    if (enveloppe["status"] === "error") {
      throw new ErreurFournisseur(
        "flutterwave",
        reponse.statut,
        reponse.corps,
        String(enveloppe["message"] ?? "refus sans message"),
      );
    }

    return enveloppe;
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

      const canal = CANAUX[decoupe.indicatif];
      if (!canal) {
        throw new ErreurFournisseur(
          "flutterwave",
          0,
          "",
          `Flutterwave ne couvre pas le mobile money pour l'indicatif +${decoupe.indicatif}.`,
        );
      }

      /**
       * Un seul appel, et `tx_ref` porte notre idempotence.
       *
       * ═══════════════════════════════════════════════════════════════════
       * LA V3 EST PLUS SIMPLE QUE LA V4, ET C'EST TANT MIEUX ICI
       *
       * Là où la v4 demandait un client, puis un moyen de paiement, puis une
       * charge — trois allers-retours par abonné à relancer — la v3 fait tout
       * d'un coup. Sur un passage quotidien de cinq cents abonnés, la
       * différence est de mille appels réseau.
       *
       * `tx_ref` est notre clé de cycle. Un passage rejoué produit la même, et
       * Flutterwave refuse alors un doublon plutôt que d'ouvrir une seconde
       * charge — c'est ce qui rend le rejeu sûr sans qu'on ait à s'en occuper.
       */
      const corps: Record<string, unknown> = {
        tx_ref: demande.reference,
        amount: versFournisseur(
          demande.montant,
          demande.devise,
          DECIMALES_FLUTTERWAVE,
        ),
        currency: demande.devise,
        country: PAYS[decoupe.indicatif],
        // La v3 veut le numéro national, sans indicatif.
        phone_number: decoupe.numero,
        email: demande.abonne.courriel ?? `${decoupe.numero}@sans-adresse.ndank`,
        fullname: demande.abonne.nom ?? "Abonné",
        redirect_url: demande.retour,
      };

      // Le Ghana est le seul à réclamer le réseau, et il ne se déduit pas du
      // préfixe : la portabilité y est effective, donc un 024 n'est plus
      // forcément MTN.
      if (canal === "mobile_money_ghana") {
        corps["network"] = config.reseauGhana ?? "MTN";
      }

      const enveloppe = await appeler(
        `/charges?type=${canal}`,
        "POST",
        corps,
      );

      const charge = donnees(enveloppe);
      const autorisation = (enveloppe["meta"] as Record<string, unknown>)?.[
        "authorization"
      ] as Record<string, unknown> | undefined;

      // `redirect` au Ghana, `redirect_url` en zone franco. Les deux formes
      // coexistent selon le canal, constaté en bac à sable.
      const url =
        (autorisation?.["redirect_url"] as string) ??
        (autorisation?.["redirect"] as string) ??
        null;

      return {
        reference: demande.reference,
        identifiantFournisseur:
          charge["id"] === undefined ? null : String(charge["id"]),
        url,
        instruction: (autorisation?.["note"] as string) ?? null,
        // Une charge qui vient d'être ouverte est en attente, même quand la v3
        // ne renvoie pas de statut — ce que fait le canal ghanéen.
        etat: charge["status"] === undefined
          ? "EN_ATTENTE"
          : etatDepuis(charge["status"] as string),
        expireLe: null,
      };
    },

    /**
     * Le constat, par notre référence et non par leur identifiant.
     *
     * `verify_by_reference` prend le `tx_ref` qu'on a posé, là où
     * `/transactions/<id>/verify` demanderait de stocker l'identifiant
     * Flutterwave. Une charge ouverte puis perdue — le processus meurt entre
     * l'appel et l'écriture — resterait alors introuvable, alors qu'elle est
     * parfaitement retrouvable par la clé de cycle.
     */
    async constater(reference: string): Promise<Issue> {
      const enveloppe = await appeler(
        `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
        "GET",
      );

      return lireCharge(reference, donnees(enveloppe), enveloppe);
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
