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
import { createHmac, timingSafeEqual } from "node:crypto";
import { lireReference } from "../reconciliation";

/**
 * lomi. — le seul adaptateur écrit après avoir appelé l'API, pas avant.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QU'IL EST
 *
 * Un PSP ouest-africain qui agrège Wave, MTN, Orange Money, Djamo, les cartes,
 * et — c'est ce qui nous a menés à lui — **π-SPI**, l'infrastructure de paiement
 * instantané de la BCEAO. Chez lomi., π-SPI est un canal parmi les autres, et
 * il ne se présente que sur la page hébergée : « Direct vs hosted : *hosted
 * only* ». Cela nous convient, puisque Ndank envoie un lien de toute façon.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL CONFIRME LE POSTULAT DE NDANK, PAR ÉCRIT
 *
 * Leur documentation d'exploitation, écrite par des gens qui font tourner ces
 * rails en production :
 *
 *   « Mobile money does not expose a saved off-session token like cards. […]
 *     lomi. does not auto-debit the wallet. This matches how async mobile-money
 *     rails work in production (PIN approval, no standing mandate).
 *     It is intentional, not a missing card feature. »
 *
 * On ne pouvait pas espérer meilleure confirmation, ni d'une source moins
 * complaisante.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TOUT CE QUI SUIT A ÉTÉ MESURÉ
 *
 * Le 10 septembre 2026, contre `sandbox.api.lomi.africa`, avec une clé
 * `lomi_sk_test_…`. Quand la documentation et l'API se contredisent, c'est
 * l'API qui a gagné, et la contradiction est notée sur place.
 *
 * Voir `docs/lomi.md` pour le relevé complet.
 */

// ────────────────────────────────────────────────────────────── les unités ──

/**
 * lomi. compte en vraies unités mineures ISO 4217.
 *
 *   « Integer amount in the smallest currency unit. For `XOF`, `5000` means
 *     5 000 XOF. »
 *
 * Mesuré : `amount: 2000` envoyé, `2000` relu. `versFournisseur` est donc
 * l'identité pour le franc CFA, et il n'y a rien à convertir.
 *
 * Ce zéro mérite pourtant d'être écrit plutôt que sous-entendu, parce que le
 * SDK π-SPI **de la même maison** annonce l'inverse — des centimes, `1 500 XOF
 * → 150000`. Deux conventions chez un même éditeur : c'est exactement la
 * situation pour laquelle `devise.ts` a été écrit.
 */
const DECIMALES_LOMI = 0;

/**
 * Les deux adresses, et le piège qu'elles tendent.
 *
 * Mesuré : un objet créé contre `sandbox.` est visible sur l'hôte de
 * production, avec le même identifiant. **Le nom d'hôte n'isole rien.** Leur
 * documentation finit par le dire : « Environment is determined by your API
 * key, not the hostname ».
 *
 * On choisit donc l'adresse d'après la clé, et jamais l'inverse. Le garde-fou
 * qui compte est plus bas, dans `lomi()`.
 */
const BASE_TEST = "https://sandbox.api.lomi.africa";
const BASE_LIVE = "https://api.lomi.africa";

/** Ce que lomi. accepte. Le XOF est le seul qui nous intéresse vraiment. */
const DEVISES = ["XOF", "USD", "EUR"] as const;

export interface ConfigLomi {
  /** Clé secrète `lomi_sk_test_…` ou `lomi_sk_live_…`. */
  cleSecrete: string;

  /**
   * Le secret de signature des webhooks, `whsec_…`.
   *
   * Mesuré : **l'API ne l'expose pas.** L'objet webhook ne le porte ni à la
   * création ni à la relecture — vérifié champ par champ. Il faut le recopier
   * depuis le tableau de bord, onglet Webhooks.
   */
  secretWebhook: string;

  /**
   * Combien de jours le lien de paiement reste valable.
   *
   * Par défaut 45, ce qui couvre confortablement la grâce et la reprise d'un
   * cycle mensuel. Ne pas laisser lomi. décider : leur `payment_link_duration`
   * vaut **1 jour**, et un lien mort le lendemain matin est pire qu'un lien
   * absent — l'abonné croit avoir affaire à un service en panne.
   */
  joursDeValidite?: number;

  /** Assumé et obligatoire pour appeler avec une clé qui n'est pas de test. */
  production?: boolean;

  http?: Http;
}

export const CHAMPS_LOMI = ["cleSecrete", "secretWebhook"] as const;

// ────────────────────────────────────────────────────────────── les états ──

/**
 * Le vocabulaire de lomi., traduit dans le nôtre.
 *
 * Leurs statuts de transaction : `pending`, `completed`, `failed`, `refunded`,
 * `expired`, `held`.
 *
 * `held` demande une décision. C'est une transaction retenue — contrôle de
 * risque, vérification. L'argent n'est pas acquis, mais l'abonné a payé. On
 * rend `EN_ATTENTE` plutôt que `REUSSI` : ouvrir un accès sur des fonds qui
 * peuvent être rendus est une perte sèche, et `EN_ATTENTE` laisse la relance
 * suivre son cours sans rien conclure.
 *
 * `refunded` devient `ECHOUE`. Un remboursement n'est pas un paiement, et
 * l'abonné qui s'est fait rembourser n'a pas acheté de temps.
 */
function etatDepuis(statut: string | undefined): EtatEncaissement {
  switch ((statut ?? "").toLowerCase()) {
    case "completed":
    case "succeeded":
    case "success":
      return "REUSSI";
    case "pending":
    case "processing":
    case "held":
      return "EN_ATTENTE";
    case "failed":
    case "cancelled":
    case "canceled":
    case "refunded":
      return "ECHOUE";
    case "expired":
      return "EXPIRE";
    default:
      return "INCONNU";
  }
}

/**
 * Traduit les refus qui parlent du **compte**, pas de la requête.
 *
 * Mesuré, et c'est le mur qu'on rencontre en premier :
 *
 *   POST /charge/wave → « Wave provider not configured for this organization
 *                         (missing Aggregated Merchant ID) »
 *   POST /charge/mtn  → « MTN provider is not connected for this organization »
 *
 * Rien dans ces phrases ne dit qu'aucune ligne de code n'y changera quoi que ce
 * soit. Sur 132 routes documentées, **il n'en existe aucune pour raccorder un
 * canal** : c'est lomi. qui le fait de son côté, après identification du
 * marchand. Un développeur qui lit « not configured » cherche sa configuration
 * pendant une heure. Cette phrase-ci lui rend l'heure.
 */
function traduireRefus(dit: string): string | null {
  if (/not connected|not configured|Aggregated Merchant ID/i.test(dit)) {
    return (
      `lomi. a refusé : « ${dit} ». Ce n'est pas la requête qui est en cause, ` +
      `c'est le compte marchand — le canal de paiement n'est pas raccordé à ` +
      `l'organisation. Aucune route d'API ne permet de le faire : il faut le ` +
      `demander à lomi., qui procède à l'identification du marchand et obtient ` +
      `l'identifiant d'agrégation auprès de l'opérateur.`
    );
  }

  if (/temporarily unavailable/i.test(dit)) {
    return (
      `lomi. a répondu que le canal est momentanément indisponible : ` +
      `« ${dit} ». C'est de leur côté, et cela ne se corrige pas en réessayant ` +
      `tout de suite. Proposez un autre moyen à l'abonné.`
    );
  }

  return null;
}

// ─────────────────────────────────────────────────────────── l'adaptateur ──

export function lomi(config: ConfigLomi): Encaissement {
  const http = config.http ?? httpParDefaut;
  const jours = config.joursDeValidite ?? 45;

  const estTest = config.cleSecrete.includes("_test_");

  /**
   * Le second refus de démarrage du dépôt, et il a été gagné par la mesure.
   *
   * Une clé `lomi_pk_` sans segment `test_` ni `live_` — format non documenté,
   * mais qui existe : le portail en a délivré une — écrit en **production**
   * même quand on appelle l'hôte `sandbox`. Un objet ainsi créé est ressorti
   * marqué `"environment":"live"` et visible sur l'hôte de production.
   *
   * On regarde donc la clé, comme pour Flutterwave, et pour la même raison :
   * l'URL ne distingue pas un essai d'un débit réel.
   */
  if (!estTest && config.production !== true) {
    throw new ErreurFournisseur(
      "lomi",
      0,
      "",
      "Cette clé lomi. ne porte pas le marqueur `_test_`, et `production` " +
        "n'est pas activé. Chez lomi., c'est la clé qui décide de " +
        "l'environnement et non l'adresse : appeler l'hôte « sandbox » avec " +
        "une clé de production écrit en production.",
    );
  }

  const base = estTest ? BASE_TEST : BASE_LIVE;

  async function appeler(
    chemin: string,
    methode: "GET" | "POST",
    corps?: unknown,
    idempotence?: string,
  ): Promise<Record<string, unknown>> {
    const reponse = await http({
      methode,
      url: `${base}${chemin}`,
      entetes: {
        "X-API-Key": config.cleSecrete,
        "Content-Type": "application/json",
        // Mesuré : sans cet en-tête, toute écriture est refusée en `400
        // idempotency_key_required`. Leur documentation le présente pourtant
        // comme facultatif — « send an idempotency key when your flow supports
        // it ». Il est obligatoire.
        ...(idempotence === undefined ? {} : { "Idempotency-Key": idempotence }),
      },
      corps: corps === undefined ? undefined : JSON.stringify(corps),
    });

    let lu: Record<string, unknown>;
    try {
      lu = JSON.parse(reponse.corps) as Record<string, unknown>;
    } catch {
      throw new ErreurFournisseur(
        "lomi",
        reponse.statut,
        reponse.corps,
        "lomi. a répondu autre chose que du JSON",
      );
    }

    if (reponse.statut < 200 || reponse.statut >= 300) {
      const erreur = lu["error"] as Record<string, unknown> | undefined;
      const dit = (erreur?.["message"] as string) ?? reponse.corps;

      throw new ErreurFournisseur(
        "lomi",
        reponse.statut,
        dit,
        traduireRefus(dit) ?? undefined,
      );
    }

    return lu;
  }

  /**
   * Retrouve un lien déjà créé pour cette référence.
   *
   * ══════════════════════════════════════════════════════════════════════════
   * POURQUOI CETTE FONCTION EXISTE
   *
   * `port.ts` affirme, sur `Demande.reference` : « un passage rejoué produit
   * donc la même référence, et le fournisseur reconnaît la demande au lieu
   * d'en créer une seconde ». C'est vrai des trois autres adaptateurs.
   *
   * **C'est faux ici.** Mesuré trois fois : trois `POST /payment-links` avec la
   * même `Idempotency-Key` et le même corps ont rendu trois liens distincts, et
   * aucun `Idempotency-Cache-Hit`. Sur `POST /payment-requests`, le même
   * en-tête fonctionne pourtant. Le même en-tête, exigé sur les deux routes,
   * honoré sur une seule — et c'est l'autre dont nous avons besoin.
   *
   * Sans cette recherche préalable, un `inviter` rejoué après une coupure
   * réseau enverrait deux liens pour un seul cycle.
   *
   * Le filtre côté serveur ne sert à rien non plus : `?metadata[…]=` et
   * `?search=` ont rendu la liste entière, sans filtrer. On lit donc une page
   * et on trie ici.
   */
  async function lienExistant(reference: string): Promise<
    Record<string, unknown> | null
  > {
    const lu = await appeler("/payment-links?limit=100", "GET");
    const liste = (lu["data"] as Array<Record<string, unknown>>) ?? [];

    for (const lien of liste) {
      const meta = lien["metadata"] as Record<string, unknown> | null;
      if (meta?.["ndank_reference"] !== reference) continue;
      if (lien["is_active"] === false) continue;

      const expire = lien["expires_at"];
      if (typeof expire === "string" && new Date(expire).getTime() < Date.now()) {
        continue;
      }

      return lien;
    }

    return null;
  }

  return {
    nom: "lomi",
    devises: DEVISES,

    /**
     * Crée un lien de paiement durable, ou rend celui qui existe déjà.
     *
     * ════════════════════════════════════════════════════════════════════════
     * POURQUOI UN LIEN, ET NON UNE SESSION
     *
     * lomi. offre trois routes qui pourraient porter une invitation. Aucune ne
     * fait les trois choses à la fois, et il a fallu les appeler pour le voir :
     *
     *   /payment-requests   pas d'URL (`payment_link: null`)  idempotente
     *   /checkout-sessions  URL, idempotente, **60 minutes**
     *   /payment-links      URL, durée choisie, **pas idempotente**
     *
     * La session de soixante minutes est disqualifiée d'office. Une relance
     * Ndank part par SMS et se lit le lendemain matin ; l'abonné qui ouvre le
     * lien à huit heures trouverait une page morte. La session est faite pour
     * un tunnel d'achat ouvert dans l'instant, pas pour une échéance.
     *
     * On prend donc le lien durable, et on répare l'idempotence nous-mêmes.
     */
    async inviter(demande: Demande): Promise<Invitation> {
      const dejaLa = await lienExistant(demande.reference);

      if (dejaLa !== null) {
        return lireLien(demande.reference, dejaLa);
      }

      const expire = new Date(Date.now() + jours * 24 * 60 * 60 * 1000);

      const lu = await appeler(
        "/payment-links",
        "POST",
        {
          link_type: "instant",
          title: demande.libelle,
          currency_code: demande.devise,
          amount: versFournisseur(
            demande.montant,
            demande.devise,
            DECIMALES_LOMI,
          ),
          expires_at: expire.toISOString(),
          success_url: demande.retour,
          // Le seul endroit où notre référence peut voyager sur cette route :
          // `payment_reference` n'existe que sur `/payment-requests` et
          // `/charge/*`. Elle se retrouve ensuite dans les métadonnées de la
          // transaction, ce qui est exactement ce dont `constater` a besoin.
          metadata: { ndank_reference: demande.reference },
          // Le téléphone n'est pas accepté à la création d'un lien : c'est
          // l'abonné qui le saisira sur la page. Il l'a de toute façon en main.
          require_phone: true,
        },
        `pl-${demande.reference}`,
      );

      return lireLien(demande.reference, lu);
    },

    /**
     * Relit l'état d'un paiement.
     *
     * ════════════════════════════════════════════════════════════════════════
     * LE SECOND PARAMÈTRE N'EST PAS UN CONFORT
     *
     * lomi. ne retrouve un objet que par **son propre identifiant**. Mesuré :
     *
     *   GET /payment-requests/20261010-1-testndank6365  → 404 not found
     *   GET /payment-requests/c599f357-19e7-…           → 200
     *
     * Et `GET /transactions` ne filtre ni par référence ni par métadonnée : ses
     * paramètres sont `isPos`, `startDate`, `endDate`, `page`, `pageSize`,
     * `paymentMethod`, `currency`, `type`, `status`, `provider`. Flutterwave et
     * Paystack savent chercher par référence marchande ; lomi. non.
     *
     * Quand l'appelant a retenu l'identifiant — c'est le cas après un webhook,
     * qui porte `transaction_id` — un seul appel suffit.
     *
     * ════════════════════════════════════════════════════════════════════════
     * ET QUAND IL NE L'A PAS
     *
     * Le routeur n'a que la référence : elle vient de l'URL par laquelle
     * l'abonné revient. On balaie alors les transactions — mais **borné par la
     * date que la référence porte elle-même**. `20261010-1-abc` désigne le
     * cycle du 10 octobre : il n'y a aucune raison de remonter avant.
     *
     * C'est un balayage, et c'est plus lent qu'un appel direct. C'est le prix
     * d'un fournisseur qui ne sait pas chercher par notre clé, et il vaut mieux
     * le payer visiblement que de prétendre que le chemin est droit.
     */
    async constater(
      reference: string,
      identifiantFournisseur?: string | null,
    ): Promise<Issue> {
      if (identifiantFournisseur != null && identifiantFournisseur !== "") {
        const lu = await appeler(
          `/transactions/${encodeURIComponent(identifiantFournisseur)}`,
          "GET",
        );

        return lireTransaction(reference, lu, lu);
      }

      const lue = lireReference(reference);
      const depuis = lue === null ? undefined : `${lue.cycle}T00:00:00.000Z`;

      let page = 1;
      // Une borne franche plutôt qu'une boucle qui pourrait ne pas finir. Dix
      // pages de cent, c'est mille transactions depuis l'échéance : au-delà,
      // ce n'est plus un balayage, c'est un aveu qu'il faut retenir
      // l'identifiant.
      const PAGES_MAX = 10;

      while (page <= PAGES_MAX) {
        const q = new URLSearchParams({
          page: String(page),
          pageSize: "100",
        });
        if (depuis !== undefined) q.set("startDate", depuis);

        const lu = await appeler(`/transactions?${q.toString()}`, "GET");
        const liste = (lu["data"] as Array<Record<string, unknown>>) ?? [];

        for (const t of liste) {
          const meta = t["metadata"] as Record<string, unknown> | null;
          if (meta?.["ndank_reference"] === reference) {
            return lireTransaction(reference, t, t);
          }
        }

        if (lu["has_more"] !== true || liste.length === 0) break;
        page += 1;
      }

      // Rien trouvé n'est pas un échec : l'abonné n'a peut-être pas encore
      // payé. `EN_ATTENTE` laisse la relance suivre son cours, là où `ECHOUE`
      // clorait un cycle qui n'a rien décidé.
      return {
        reference,
        etat: "EN_ATTENTE",
        montant: 0,
        devise: "XOF",
        identifiantFournisseur: null,
        regleLe: null,
        brut: null,
      };
    },

    /**
     * Lit un webhook, et refuse ce qui n'est pas signé.
     *
     * ════════════════════════════════════════════════════════════════════════
     * ICI, LA SIGNATURE SIGNE VRAIMENT
     *
     *   crypto.createHmac('sha256', secret).update(payload).digest('hex')
     *
     * En-tête `X-Lomi-Signature`. C'est un HMAC du **corps brut**, et cela
     * mérite d'être souligné parce que ce n'est pas la norme dans la région :
     * le `verif-hash` de Flutterwave est un secret partagé qui n'authentifie
     * rien du contenu — un webhook dont le montant est réécrit de 2 000 à
     * 200 000 passe la vérification. Mesuré le 9 septembre 2026.
     *
     * Ici, un octet modifié fait échouer la comparaison.
     */
    lireWebhook(corps: string, entetes: Entetes): Issue | null {
      if (!verifierLomi(corps, entetes, config.secretWebhook)) {
        throw new SignatureInvalide("lomi");
      }

      let enveloppe: Record<string, unknown>;
      try {
        enveloppe = JSON.parse(corps) as Record<string, unknown>;
      } catch {
        throw new ErreurFournisseur(
          "lomi",
          0,
          corps.slice(0, 200),
          "Webhook signé mais illisible",
        );
      }

      // L'enveloppe relue d'une vraie livraison :
      //   { id, data: { object: { id, amount, currency, status, metadata } } }
      // Un seul événement par envoi — pas un lot, contrairement à π-SPI.
      const donnees = enveloppe["data"] as Record<string, unknown> | undefined;
      const objet =
        (donnees?.["object"] as Record<string, unknown> | undefined) ??
        donnees ??
        enveloppe;

      const meta = objet["metadata"] as Record<string, unknown> | null;
      const reference = meta?.["ndank_reference"];

      // Beaucoup d'autres événements passent par la même adresse — versements,
      // remboursements, litiges, mises à jour d'abonnement. Ceux qui ne portent
      // pas notre référence ne nous concernent pas ; les ignorer poliment vaut
      // mieux que lever.
      if (typeof reference !== "string" || reference === "") return null;

      return lireTransaction(reference, objet, enveloppe);
    },
  };
}

// ──────────────────────────────────────────────────────────── les lectures ──

/** Ce qu'on tire d'un lien de paiement fraîchement créé ou retrouvé. */
function lireLien(
  reference: string,
  lien: Record<string, unknown>,
): Invitation {
  const expire = lien["expires_at"];

  return {
    reference,
    identifiantFournisseur: (lien["link_id"] as string) ?? null,
    url: (lien["url"] as string) ?? null,
    // lomi. porte tout le choix de l'opérateur sur sa page — Wave, MTN, Orange,
    // π-SPI, USSD. Il n'y a donc rien à dire à l'abonné que « suivez le lien ».
    instruction: null,
    etat: "EN_ATTENTE",
    expireLe: typeof expire === "string" ? new Date(expire) : null,
  };
}

/** Ce qu'on tire d'une transaction, qu'elle vienne d'un webhook ou d'un GET. */
function lireTransaction(
  reference: string,
  t: Record<string, unknown>,
  brut: unknown,
): Issue {
  const devise = (t["currency_code"] as string) ?? (t["currency"] as string) ?? "XOF";

  // `gross_amount` est le montant payé par l'abonné ; `net_amount` est ce qui
  // reste après les frais de lomi. C'est le brut qui dit si l'abonné s'est
  // acquitté de son dû — le net ne le concerne pas.
  const brutMontant = t["gross_amount"] ?? t["amount"];
  const montant =
    typeof brutMontant === "number"
      ? depuisFournisseur(brutMontant, devise, DECIMALES_LOMI)
      : 0;

  const etat = etatDepuis(t["status"] as string | undefined);
  const quand = t["created_at"] ?? t["completed_at"];

  return {
    reference,
    etat,
    montant,
    devise,
    identifiantFournisseur:
      (t["transaction_id"] as string) ?? (t["id"] as string) ?? null,
    regleLe:
      etat === "REUSSI" && typeof quand === "string" ? new Date(quand) : null,
    brut,
  };
}

// ─────────────────────────────────────────────────────────── la signature ──

/**
 * Vérifie `X-Lomi-Signature`.
 *
 * La comparaison est en temps constant, comme leur propre exemple le fait — et
 * `timingSafeEqual` lève si les longueurs diffèrent, ce qu'on rattrape plutôt
 * que de laisser remonter : une signature de mauvaise taille est une signature
 * fausse, pas une panne.
 */
export function verifierLomi(
  corps: string,
  entetes: Entetes,
  secret: string,
): boolean {
  const donnee =
    entetes["x-lomi-signature"] ?? entetes["X-Lomi-Signature"] ?? "";

  if (donnee === "" || secret === "") return false;

  const attendu = createHmac("sha256", secret).update(corps, "utf8").digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(donnee, "utf8"),
      Buffer.from(attendu, "utf8"),
    );
  } catch {
    return false;
  }
}
