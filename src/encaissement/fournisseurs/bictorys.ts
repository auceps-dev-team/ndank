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

/**
 * Bictorys — le cinquième, et le premier écrit sans rien découvrir.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QU'IL EST
 *
 * Une infrastructure de paiement d'Afrique de l'Ouest **et centrale** : dix
 * pays, dont le Cameroun et le Nigeria, là où lomi. s'arrête aux huit de
 * l'UEMOA. Quatre devises — XOF, XAF, GNF, NGN — et les opérateurs qu'on
 * attend : Wave, Orange Money, MTN, Free Money, Moov, Mobicash.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL A COÛTÉ UN APPEL, ET IL FAUT DIRE POURQUOI
 *
 * Flutterwave a coûté trois versions, Paystack un facteur cent sur les montants,
 * lomi. une demi-journée de sondage, la passerelle Android quatre tentatives.
 * Celui-ci a marché du premier coup.
 *
 * La différence n'est pas la chance : c'est `afrotools`, un registre public de
 * spécifications d'API africaines qui documente les **pièges** en plus des
 * champs. Il annonçait qu'omettre `payment_type` rend un `202` avec un lien
 * hébergé plutôt qu'un `201` direct. C'est exactement ce qui s'est produit.
 *
 * Deux avertissements sur ce registre, parce qu'ils valent pour la suite :
 *
 *   — son README affirme « each spec is verified against the live API ».
 *     Les fichiers disent autre chose : sur 157 schémas, **9 portent le statut
 *     `verified`**, et aucun n'est celui-ci ;
 *   — mais plusieurs pièges citent des appels réels (« *confirmed working
 *     end-to-end in production* »). **Ce sont les pièges qui portent la preuve,
 *     pas l'étiquette.** On les lit un par un.
 *
 * Ce qui suit distingue donc ce qui a été **mesuré ici** de ce qui a été **lu**.
 */

// ────────────────────────────────────────────────────────────── les unités ──

/**
 * Bictorys compte dans l'unité courante de la devise, pas en centimes.
 *
 * **Mesuré** : `amount: 2000` en XOF accepté, charge créée. Pour le franc CFA,
 * qui n'a pas de décimale, `versFournisseur` est donc l'identité.
 *
 * **Non mesuré, et il faut le savoir** : le NGN a deux décimales à l'ISO 4217.
 * Avec ce zéro, 1 500,50 ₦ partirait comme `1500.5` — un nombre à virgule
 * flottante, ce qu'on évite partout ailleurs dans ce dépôt. Aucun essai n'a été
 * fait en naira. Un hôte qui encaisse au Nigeria doit le vérifier avant de
 * s'en servir.
 */
const DECIMALES_BICTORYS = 0;

/**
 * Les deux adresses.
 *
 * Contrairement à lomi., **l'hôte décide bien de l'environnement** : les clés
 * de test portent le préfixe `test_`, et les deux bases sont distinctes. Le
 * garde-fou plus bas regarde quand même la clé — l'URL se recopie, le préfixe
 * non.
 */
const BASE_TEST = "https://api.test.bictorys.com";
const BASE_LIVE = "https://api.bictorys.com";

/** Ce que Bictorys accepte. Voir la réserve sur le NGN, plus haut. */
const DEVISES = ["XOF", "XAF", "GNF", "NGN"] as const;

/** Cinq minutes, comme leur documentation le demande. */
const DERIVE_MAX_MS = 5 * 60 * 1000;

export interface ConfigBictorys {
  /**
   * La clé **publique**, `test_public-…` ou `public-…`.
   *
   * C'est elle qui crée les charges. Oui, « publique » pour une opération qui
   * prend de l'argent : chez Bictorys, la clé publique est celle du tunnel de
   * paiement, et la privée celle qui lit et qui verse.
   */
  clePublique: string;

  /**
   * La clé **privée**, `test_secret-…`.
   *
   * Pour relire l'état d'une transaction, et pour les versements.
   *
   * **Mesuré, et contraire à ce qu'annonce `afrotools`** : en bac à sable, la
   * clé publique passe aussi sur `GET /transactions/{id}/status`. On envoie la
   * privée quand même — c'est ce que leur documentation demande, et une
   * permissivité de bac à sable n'est pas une garantie de production.
   */
  clePrivee: string;

  /**
   * Le secret de signature des webhooks.
   *
   * Voir `lireWebhook` : Bictorys envoie **deux** en-têtes de validation, et
   * ils ne se valent pas du tout.
   */
  secretWebhook: string;

  /** Assumé et obligatoire pour appeler avec une clé qui n'est pas de test. */
  production?: boolean;

  http?: Http;
}

export const CHAMPS_BICTORYS = [
  "clePublique",
  "clePrivee",
  "secretWebhook",
] as const;

// ────────────────────────────────────────────────────────────── les états ──

/**
 * Le vocabulaire de Bictorys, traduit dans le nôtre.
 *
 * Le webhook rend `succeeded | authorized | failed | cancelled | reversed`.
 * La route d'état ajoute `pending` et `processing`.
 *
 * **`authorized` n'est pas `REUSSI`**, et c'est la seule traduction qui demande
 * un arbitrage. Les fonds sont réservés, pas capturés : leur documentation est
 * nette là-dessus. Ouvrir un accès sur une réservation qui peut se relâcher est
 * une perte sèche — on rend `EN_ATTENTE`, et la relance suit son cours sans
 * rien conclure. C'est le même raisonnement que le `held` de lomi.
 *
 * `reversed` devient `ECHOUE` : un paiement repris n'achète pas de temps.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * `expired` EST GARDÉ PAR PRUDENCE, ET NON SUR PREUVE
 *
 * Ce cas tombait dans `INCONNU` jusqu'à la 0.22.3, et on ne concluait donc rien
 * d'une charge peut-être close. La traduction reste — elle ne coûte rien et un
 * état inconnu est pire qu'un état traduit.
 *
 * Mais **la source ne tient pas**, et il faut le dire plutôt que de laisser
 * croire. Elle venait d'une page datée « il y a presque deux ans », qui montre
 * une enveloppe de webhook — `{"event": "charge.successful"}`, statut
 * « réussi » en français — que l'API n'envoie plus. Le guide à jour liste
 * `succeeded · failed · cancelled · authorized · reversed`, sans `expired`.
 *
 * Le détail qui aurait dû alerter était sous les yeux : cette incohérence
 * d'enveloppe avait été relevée en 0.22.3 comme un défaut de la documentation,
 * puis la même page avait servi d'autorité trois lignes plus bas. Une page
 * périmée dans un paragraphe ne redevient pas fraîche au suivant.
 */
function etatDepuis(statut: string | undefined): EtatEncaissement {
  switch ((statut ?? "").toLowerCase()) {
    case "succeeded":
      return "REUSSI";
    case "pending":
    case "processing":
    case "authorized":
      return "EN_ATTENTE";
    case "failed":
    case "cancelled":
    case "canceled":
    case "reversed":
      return "ECHOUE";
    case "expired":
      return "EXPIRE";
    default:
      return "INCONNU";
  }
}

/**
 * Lit l'horodatage de Bictorys, qui n'est pas de l'ISO 8601.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UN ESPACE À LA PLACE DU « T », ET AUCUN FUSEAU
 *
 * Relevé en production par `afrotools` : `"2026-08-08 18:45:44.10254"`. Pas de
 * `T`, pas de `Z`, et une précision fractionnaire non standard.
 *
 * Le piège n'est pas qu'il soit illisible — `new Date()` l'accepte. C'est qu'il
 * l'interprète en **heure locale du serveur**, faute de fuseau. Un serveur à
 * Paris décalerait donc chaque date de deux heures en été, silencieusement, et
 * Ndank compte en jours civils UTC : une échéance du 1er à 00h30 UTC
 * deviendrait le 31 du mois précédent.
 *
 * On normalise donc explicitement plutôt que de laisser faire.
 */
export function lireHorodatage(brut: unknown): Date | null {
  if (typeof brut !== "string" || brut.trim() === "") return null;

  // Déjà en ISO avec fuseau : on ne touche à rien.
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(brut.trim())) {
    const d = new Date(brut);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(`${brut.trim().replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─────────────────────────────────────────────────────────── l'adaptateur ──

export function bictorys(config: ConfigBictorys): Encaissement {
  const http = config.http ?? httpParDefaut;

  const estTest =
    config.clePublique.startsWith("test_") && config.clePrivee.startsWith("test_");

  /**
   * Le troisième refus de démarrage du dépôt, après Flutterwave et lomi.
   *
   * Bictorys sépare bien ses deux bases, donc le risque est plus faible
   * qu'ailleurs. On regarde quand même la clé : une URL de base se recopie d'un
   * projet à l'autre, un préfixe de clé non.
   */
  if (!estTest && config.production !== true) {
    throw new ErreurFournisseur(
      "bictorys",
      0,
      "",
      "Ces clés Bictorys ne portent pas le préfixe `test_`, et `production` " +
        "n'est pas activé. Un vrai débit sur un vrai abonné se fait une fois " +
        "et se regrette longtemps.",
    );
  }

  const base = estTest ? BASE_TEST : BASE_LIVE;

  async function appeler(
    chemin: string,
    methode: "GET" | "POST",
    cle: string,
    corps?: unknown,
  ): Promise<Record<string, unknown>> {
    const reponse = await http({
      methode,
      url: `${base}${chemin}`,
      entetes: {
        "X-Api-Key": cle,
        "Content-Type": "application/json",
      },
      corps: corps === undefined ? undefined : JSON.stringify(corps),
    });

    // 403 avec du HTML : c'est le pare-feu applicatif d'AWS qui limite le
    // débit, et non Bictorys qui refuse la requête. Le dire évite de chercher
    // une erreur de format dans un corps qui n'en est pas un.
    if (reponse.statut === 403 && !reponse.corps.trimStart().startsWith("{")) {
      throw new ErreurFournisseur(
        "bictorys",
        403,
        reponse.corps.slice(0, 120),
        "Bictorys a répondu 403 avec une page HTML : c'est le pare-feu " +
          "applicatif qui limite le débit, pas un refus d'autorisation. " +
          "Espacez les appels d'au moins cinq secondes.",
      );
    }

    let lu: Record<string, unknown>;
    try {
      lu = JSON.parse(reponse.corps) as Record<string, unknown>;
    } catch {
      throw new ErreurFournisseur(
        "bictorys",
        reponse.statut,
        reponse.corps,
        "bictorys a répondu autre chose que du JSON",
      );
    }

    if (reponse.statut < 200 || reponse.statut >= 300) {
      throw new ErreurFournisseur(
        "bictorys",
        reponse.statut,
        (lu["details"] as string) ?? (lu["message"] as string) ?? reponse.corps,
      );
    }

    return lu;
  }

  /**
   * Retrouve une transaction par notre référence.
   *
   * Rend `null` quand rien ne correspond — ce qui n'est pas un échec : l'abonné
   * n'a peut-être pas encore payé. `ECHOUE` clorait un cycle qui n'a rien
   * décidé.
   */
  async function parReference(reference: string): Promise<Issue | null> {
    const lu = await appeler("/pay/v1/transactions", "GET", config.clePrivee);
    const liste = Array.isArray(lu)
      ? (lu as Array<Record<string, unknown>>)
      : ((lu["data"] as Array<Record<string, unknown>>) ?? []);

    for (const t of liste) {
      if (t["paymentReference"] === reference) {
        return lireTransaction(reference, t, t, null);
      }
    }

    return null;
  }

  return {
    nom: "bictorys",
    devises: DEVISES,

    /**
     * Crée une charge, et rend le lien du tunnel hébergé.
     *
     * ════════════════════════════════════════════════════════════════════════
     * ON OMET `payment_type`, ET C'EST LE POINT
     *
     * `payment_type` est un paramètre d'**URL**, pas un champ du corps — piège
     * documenté par `afrotools`, confirmé ici. En le posant, on choisit
     * l'opérateur à la place de l'abonné et l'on reçoit un `201` avec un
     * paiement direct. En l'omettant, on reçoit un `202` avec un lien vers la
     * page de Bictorys, où l'abonné choisit lui-même.
     *
     * C'est ce second chemin qu'il nous faut : Ndank ne sait pas si son abonné
     * a Wave ou Orange Money, et lui demander serait une question de plus entre
     * le rappel et le paiement.
     *
     * Les deux réponses sont traitées, parce qu'un `201` peut arriver d'un
     * compte configuré autrement, et qu'échouer là-dessus serait absurde.
     */
    async inviter(demande: Demande): Promise<Invitation> {
      const lu = await appeler("/pay/v1/charges", "POST", config.clePublique, {
        amount: versFournisseur(
          demande.montant,
          demande.devise,
          DECIMALES_BICTORYS,
        ),
        currency: demande.devise,
        // Notre référence voyage ici, et Bictorys la rend **dans le webhook et
        // dans la relecture d'état**. C'est ce qui évite le balayage qu'il a
        // fallu écrire pour lomi.
        paymentReference: demande.reference,
        successRedirectUrl: demande.retour,
        errorRedirectUrl: demande.retour,
        ...(demande.abonne.telephone === null && demande.abonne.nom === null
          ? {}
          : {
              customerObject: {
                // `country` est le seul champ obligatoire du client.
                country: paysDe(demande.abonne.telephone),
                ...(demande.abonne.nom === null ? {} : { name: demande.abonne.nom }),
                ...(demande.abonne.telephone === null
                  ? {}
                  : { phone: demande.abonne.telephone }),
                ...(demande.abonne.courriel === null
                  ? {}
                  : { email: demande.abonne.courriel }),
              },
            }),
      });

      // 202 : un lien hébergé. 201 : un paiement direct avec sa propre URL.
      const url = (lu["link"] as string) ?? (lu["redirectUrl"] as string) ?? null;
      const id =
        (lu["chargeId"] as string) ?? (lu["transactionId"] as string) ?? null;

      if (url === null) {
        throw new ErreurFournisseur(
          "bictorys",
          0,
          JSON.stringify(lu).slice(0, 200),
          "Bictorys a accepté la charge mais n'a rendu aucun lien. Sans lui, " +
            "il n'y a nulle part où envoyer l'abonné.",
        );
      }

      return {
        reference: demande.reference,
        identifiantFournisseur: id,
        url,
        // Le choix de l'opérateur se fait sur leur page. Rien à dire de plus.
        instruction: null,
        etat: "EN_ATTENTE",
        // Aucune expiration n'est documentée, et aucune n'a été mesurée.
        // `null` dit « on ne sait pas », là où une date inventée ferait croire
        // qu'on sait.
        expireLe: null,
      };
    },

    /**
     * Relit l'état d'un paiement.
     *
     * ════════════════════════════════════════════════════════════════════════
     * LE SECOND PARAMÈTRE COMPTE ENCORE PLUS QU'AILLEURS
     *
     * Avec l'identifiant, un appel suffit : `GET /transactions/{id}/status`.
     *
     * Sans lui, on balaie la liste des transactions en filtrant sur notre
     * `paymentReference`. **Éprouvé le 14 septembre 2026**, contre un paiement
     * réellement abouti par le simulateur du bac à sable — la liste ne se
     * peuple qu'à ce moment-là, ce qui avait d'abord fait croire que ce chemin
     * était intestable.
     *
     * ════════════════════════════════════════════════════════════════════════
     * DEUX RÉPONSES DU BAC À SABLE QUI SURPRENNENT
     *
     * Mesuré : `{"id": null, "status": "pending"}`. L'identifiant revient
     * **nul**, alors qu'on vient de le demander — on reprend donc celui qu'on
     * a passé plutôt que de propager un `null` qui ferait perdre le fil.
     *
     * Et leur documentation prévient que cette route rend `500` par
     * intermittence en bac à sable. La levée remonte alors à l'appelant, qui
     * traite un fournisseur injoignable comme une attente et non comme un
     * échec — c'est ce que fait la page de relance. Ne jamais traduire un 500
     * en `ECHOUE` : l'abonné a peut-être payé.
     */
    async constater(
      reference: string,
      identifiantFournisseur?: string | null,
    ): Promise<Issue> {
      if (identifiantFournisseur != null && identifiantFournisseur !== "") {
        const lu = await appeler(
          `/pay/v1/transactions/${encodeURIComponent(identifiantFournisseur)}/status`,
          "GET",
          config.clePrivee,
        );

        const brut = lireTransaction(reference, lu, lu, identifiantFournisseur);

        /**
         * ══════════════════════════════════════════════════════════════════
         * LE CHEMIN RAPIDE EN DIT MOINS, ET C'EST DANGEREUX
         *
         * Mesuré le 14 septembre 2026, sur un paiement réellement abouti :
         *
         *     /status        → { "id": "aa8aeb74…", "status": "succeeded" }
         *     /transactions  → … "amount": 100.0, "timestamp": "…"
         *
         * La route d'état ne rend **ni montant ni horodatage**. Un `REUSSI`
         * en sortirait donc avec `montant: 0` — et `reconcilier` achète du
         * temps avec ce montant. L'abonné aurait payé, le fournisseur
         * l'aurait confirmé, et le cycle n'aurait pas avancé d'un jour.
         *
         * Aucun test contre un faux n'aurait trouvé cela : c'est celui qui
         * écrit le faux qui décide de ce que la réponse contient, et il y met
         * naturellement un montant.
         *
         * On complète donc par la liste quand le succès arrive sans montant.
         * Un appel de plus, seulement dans ce cas, et seulement au moment où
         * l'on s'apprête à conclure.
         */
        if (brut.etat !== "REUSSI" || brut.montant > 0) return brut;

        const complet = await parReference(reference);
        return complet ?? brut;
      }

      return (
        (await parReference(reference)) ?? {
          reference,
          etat: "EN_ATTENTE",
          montant: 0,
          devise: "XOF",
          identifiantFournisseur: null,
          regleLe: null,
          brut: null,
        }
      );
    },


    /**
     * Lit un webhook, et refuse ce qui n'est pas signé.
     *
     * ════════════════════════════════════════════════════════════════════════
     * BICTORYS ENVOIE DEUX EN-TÊTES, ET ILS NE SE VALENT PAS
     *
     *   X-Webhook-Signature   HMAC-SHA256 de `${horodatage}.${corps brut}`
     *   X-Webhook-Timestamp   l'horodatage en millisecondes
     *   X-Secret-Key          le secret partagé, en clair
     *
     * Le premier couple est ce qu'on veut : il **lie le corps**, et
     * l'horodatage protège du rejeu — on refuse au-delà de cinq minutes de
     * dérive. Aucune autre passerelle du dépôt n'offre cela.
     *
     * ════════════════════════════════════════════════════════════════════════
     * MAIS IL N'ARRIVE PAS, ET IL A FALLU UN VRAI ENVOI POUR LE SAVOIR
     *
     * Webhook réellement reçu le 14 septembre 2026, capté octet pour octet.
     * Ses en-têtes, en entier :
     *
     *   accept · content-length · content-type · host · user-agent
     *   x-secret-key
     *
     * **Pas de signature. Pas d'horodatage.** Seulement le secret partagé.
     *
     * Et la documentation officielle, relue le 14 septembre, tranche :
     *
     *   « Chaque notification envoyée inclut le header **X-Secret-Key** qui
     *     contient la valeur de la clé secrète du webhook que vous avez
     *     renseignée sur votre dashboard. Vous devez vérifier que la clé
     *     secrète envoyée correspond à la clé secrète enregistrée. »
     *
     * Cette page-là ne mentionne ni HMAC ni horodatage. **Mais une autre le
     * fait**, et ce module a affirmé le contraire jusqu'à la 0.22.4.
     *
     * `docs.bictorys.com/docs/intégration-en`, mis à jour en mars 2026,
     * documente exactement le couple que décrit `afrotools` :
     *
     *   X-Webhook-Signature: <hmac_sha256_hex>       # optional (if HMAC enabled)
     *   X-Webhook-Timestamp: <unix_timestamp_ms>     # optional (if HMAC enabled)
     *
     * Même formule, même fenêtre de cinq minutes, même comparaison en temps
     * constant. **Le mécanisme existe : il est simplement désactivé par
     * défaut, compte par compte.**
     *
     * L'erreur mérite d'être nommée, parce que c'est celle qu'on reproche aux
     * autres : une page lue, une mesure prise, et une conclusion tirée de leur
     * intersection plutôt que de l'ensemble. « La documentation n'en parle
     * pas » n'a jamais voulu dire « la documentation que j'ai lue n'en parle
     * pas ». Relevé par la revue de la PR afrotools#67.
     *
     * Conséquence pratique, et elle ne change pas : **n'attendez pas la
     * signature.** Sur un compte où elle n'est pas activée, c'est le repli qui
     * tourne en production, et c'est la réconciliation qui protège.
     *
     * Ce paragraphe a donc affirmé le contraire jusqu'à la 0.22.2 — « la
     * meilleure des cinq passerelles » — sur la foi d'une fiche. **En pratique,
     * Bictorys est au niveau de Flutterwave** : un secret partagé qui prouve
     * que l'expéditeur le connaît, et rien du contenu. Mesuré : un montant
     * réécrit de 100 à 100 000 passe.
     *
     * Le code du dessous ne change pas : il préfère le HMAC quand il arrive. Ce
     * qui change, c'est ce qu'on a le droit d'en dire — et ce sur quoi il faut
     * compter en attendant, c'est-à-dire la réconciliation.
     *
     * Le troisième est exactement le `verif-hash` de Flutterwave : un secret
     * partagé qui prouve seulement que l'expéditeur le connaît. **Il
     * n'authentifie pas le corps** — un montant réécrit en route passerait.
     *
     * On accepte quand même ce repli, parce que la signature est annoncée
     * *optionnelle* : un marchand dont le compte ne l'envoie pas verrait sinon
     * tous ses paiements rejetés.
     *
     * Ce qui compense, c'est la réconciliation — `reconcilier` refuse un
     * versement fabriqué pour un autre abonnement, et `Creances.dejaCompte`
     * empêche de compter deux fois. Un corps réécrit passerait la porte mais ne
     * pourrait pas prolonger n'importe quoi.
     */
    lireWebhook(corps: string, entetes: Entetes): Issue | null {
      if (!verifierBictorys(corps, entetes, config.secretWebhook)) {
        throw new SignatureInvalide("bictorys");
      }

      let evenement: Record<string, unknown>;
      try {
        evenement = JSON.parse(corps) as Record<string, unknown>;
      } catch {
        throw new ErreurFournisseur(
          "bictorys",
          0,
          corps.slice(0, 200),
          "Webhook signé mais illisible",
        );
      }

      const reference = evenement["paymentReference"];

      // Remboursements, versements, événements de client : ils passent par la
      // même adresse et ne portent pas notre référence. Les ignorer poliment
      // vaut mieux que lever.
      if (typeof reference !== "string" || reference === "") return null;

      return lireTransaction(
        reference,
        evenement,
        evenement,
        (evenement["id"] as string) ?? null,
      );
    },
  };
}

// ──────────────────────────────────────────────────────────── les lectures ──

/**
 * Le pays d'un numéro, pour `customerObject.country` qui est obligatoire.
 *
 * On le déduit de l'indicatif plutôt que de le demander : Ndank ne le stocke
 * pas, et un champ de plus au formulaire est un abandon de plus. `SN` par
 * défaut — c'est le marché principal de Bictorys, et un pays faux n'empêche pas
 * le paiement, il change seulement l'ordre des opérateurs proposés.
 */
function paysDe(telephone: string | null): string {
  if (telephone === null) return "SN";

  const indicatifs: Record<string, string> = {
    "225": "CI",
    "221": "SN",
    "224": "GN",
    "223": "ML",
    "228": "TG",
    "229": "BJ",
    "226": "BF",
    "227": "NE",
    "237": "CM",
    "234": "NG",
  };

  const chiffres = telephone.replace(/[^\d]/g, "");
  return indicatifs[chiffres.slice(0, 3)] ?? "SN";
}

/** Ce qu'on tire d'une transaction, de la route d'état ou d'un webhook. */
function lireTransaction(
  reference: string,
  t: Record<string, unknown>,
  brut: unknown,
  replis: string | null,
): Issue {
  const devise = (t["currency"] as string) ?? "XOF";
  const etat = etatDepuis(t["status"] as string | undefined);

  // `amount` est ce que l'abonné a payé ; `settledAmount` ce que le marchand
  // reçoit après conversion et frais. C'est le premier qui dit si l'abonné
  // s'est acquitté de son dû.
  const paye = t["amount"];
  const montant =
    typeof paye === "number"
      ? depuisFournisseur(paye, devise, DECIMALES_BICTORYS)
      : 0;

  const quand = lireHorodatage(t["timestamp"]);

  return {
    reference,
    etat,
    montant,
    devise,
    // Le bac à sable rend `id: null` sur la route d'état. On reprend celui
    // qu'on a demandé plutôt que de perdre le fil.
    identifiantFournisseur: (t["id"] as string) ?? replis,
    regleLe: etat === "REUSSI" ? quand : null,
    brut,
  };
}

// ─────────────────────────────────────────────────────────── la signature ──

/**
 * Vérifie l'authenticité d'un webhook Bictorys.
 *
 * Rend `true` dès qu'une des deux preuves tient. Voir `lireWebhook` pour ce que
 * chacune vaut — elles sont très loin de se valoir.
 */
export function verifierBictorys(
  corps: string,
  entetes: Entetes,
  secret: string,
  maintenant: Date = new Date(),
): boolean {
  if (secret === "") return false;

  const lire = (nom: string): string =>
    entetes[nom] ?? entetes[nom.toLowerCase()] ?? "";

  const signature = lire("x-webhook-signature");
  const horodatage = lire("x-webhook-timestamp");

  if (signature !== "" && horodatage !== "") {
    const pose = Number.parseInt(horodatage, 10);

    // Un horodatage illisible ou trop vieux fait tomber la vérification. Sans
    // cette borne, un webhook capté une fois se rejouerait indéfiniment — et
    // chaque rejeu prolongerait un abonnement.
    if (
      Number.isNaN(pose) ||
      Math.abs(maintenant.getTime() - pose) > DERIVE_MAX_MS
    ) {
      return false;
    }

    const attendu = createHmac("sha256", secret)
      .update(`${horodatage}.${corps}`, "utf8")
      .digest("hex");

    return egales(signature, attendu);
  }

  // Le repli : le secret partagé, en clair. Il ne prouve rien du corps.
  const partage = lire("x-secret-key");
  return partage !== "" && egales(partage, secret);
}

/**
 * Comparaison à durée constante.
 *
 * `timingSafeEqual` lève quand les longueurs diffèrent — on le rattrape plutôt
 * que de laisser remonter : une valeur de mauvaise taille est une valeur
 * fausse, pas une panne.
 */
function egales(recu: string, attendu: string): boolean {
  try {
    return timingSafeEqual(
      Buffer.from(recu, "utf8"),
      Buffer.from(attendu, "utf8"),
    );
  } catch {
    return false;
  }
}
