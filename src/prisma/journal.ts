import type { FaitEnvoi, JournalEnvoi } from "../envoi/port";
import type { FaitPage } from "../page/routeur";
import type { FaitWebhook } from "../webhook/gestionnaire";
import type { ClientNdank } from "./client";

/**
 * Ndank — les cinq journaux, enfin écrits quelque part.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CINQ CROCHETS QUE PERSONNE NE CÂBLAIT
 *
 * L'envoi, la page, les webhooks, l'API et les gestes exposent chacun un
 * `journal?` facultatif. Aucun n'était implémenté : ils existaient, ils étaient
 * documentés, et tout ce qu'ils racontaient disparaissait à la fin du
 * processus.
 *
 * La table `WebhookRecu` porte le même reproche en plus grave — déclarée dans le
 * schéma depuis la 0.4.0, **jamais écrite une seule fois**. Une table morte
 * n'est pas neutre : elle fait croire qu'on garde quelque chose.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QU'ON GARDE, ET SURTOUT CE QU'ON JETTE
 *
 * Un journal qui se remplit de bruit cesse d'être lu. Ce dépôt porte déjà
 * l'argument, écrit à propos des pertes GSM-7 : on criait au loup à chaque
 * relance, si bien qu'une vraie perte n'aurait plus été vue.
 *
 * La politique par défaut applique cela crochet par crochet :
 *
 *   — **envoi : les échecs seulement.** Les relances parties sont déjà dans la
 *     table `Relance`, avec leurs canaux. Les journaliser en plus doublerait
 *     cinq cents lignes par jour pour ne rien apprendre ;
 *
 *   — **page : tout.** C'est le seul endroit qui puisse dire combien de gens
 *     ouvrent la page et ne vont pas au bout — la moitié de la raison
 *     d'héberger cette page plutôt que de renvoyer chez le fournisseur ;
 *
 *   — **webhooks : tout**, plus la ligne `WebhookRecu` avec le corps brut ;
 *
 *   — **API : les réponses non-2xx seulement.** Un tableau de bord qui
 *     interroge toutes les trente secondes inonderait la table en une nuit ;
 *
 *   — **gestes : les refus seulement.** Les gestes posés sont déjà dans
 *     `Evenement` avec leur auteur, écrits par `interventions.journaliser`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ILS TAMPONNENT, PARCE QUE LES CROCHETS SONT SYNCHRONES
 *
 * `JournalEnvoi` rend `void`, et c'est délibéré : il est appelé dans la boucle
 * d'envoi du passage quotidien, où une écriture lente ralentirait tout le lot.
 *
 * On ne peut donc pas attendre. Écrire sans attendre — cinq cents insertions
 * lancées de front — n'est pas mieux : c'est une rafale sur la base, au moment
 * précis où elle sert à autre chose.
 *
 * D'où le tampon. On accumule, on écrit par lots, et l'appelant vide à un
 * moment qu'il choisit — après un passage, après une réponse HTTP. Un lot plein
 * part tout seul, pour que la mémoire reste bornée même si personne ne vide.
 */

/** Ce que l'hôte branche sur chaque couche. */
export interface JournalPrisma {
  envoi: JournalEnvoi;
  page: (fait: FaitPage) => void;
  webhook: (fait: FaitWebhook) => void;
  api: (fait: { route: string; statut: number }) => void;
  gestes: (fait: { route: string; auteur: string | null; statut: number }) => void;

  /**
   * Écrit ce qui attend.
   *
   * À appeler après un passage quotidien, ou après avoir répondu à une requête.
   * Ne lève jamais : un journal qui fait tomber ce qu'il observe ne sert à rien.
   */
  vider(): Promise<void>;

  /** Combien de faits attendent. Sert aux tests et au diagnostic. */
  enAttente(): number;
}

export interface ReglagesJournal {
  projetId: string;
  /**
   * Combien de faits accumuler avant d'écrire tout seul.
   *
   * Cinquante : assez pour qu'un passage de cinq cents abonnés ne fasse pas
   * cinq cents allers-retours, assez peu pour que la mémoire reste bornée si
   * personne ne vide jamais.
   */
  parLot?: number;
  /**
   * Ce qu'on fait quand le journal lui-même échoue.
   *
   * Sans ce crochet, une base qui refuse les écritures rendrait le journal
   * silencieusement inutile — ce qui est exactement la panne qu'il existe pour
   * révéler ailleurs.
   */
  surErreur?: (cause: unknown) => void;
  /** Journaliser aussi les envois réussis. Faux par défaut — voir l'en-tête. */
  envoisReussis?: boolean;
  /** Journaliser aussi les lectures d'API réussies. Faux par défaut. */
  lecturesReussies?: boolean;
}

/**
 * Ce qu'un corps de webhook peut peser dans la base.
 *
 * Vingt mille caractères : plusieurs fois ce qu'envoient Paystack ou
 * Flutterwave, et très en deçà de ce qui fait grossir une table sans qu'on s'en
 * aperçoive. Un corps plus long est tronqué — mieux vaut un début lisible que
 * rien du tout, et ce qui compte est toujours au début.
 */
const CORPS_MAX = 20_000;

interface AEcrire {
  type: string;
  abonnementId: string | null;
  detail: Record<string, unknown>;
  quandLe: Date;
}

/** La cause, ramenée à quelque chose qu'on puisse relire dans six mois. */
function lisible(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause).slice(0, 500);
}

export function journalPrisma(
  client: ClientNdank,
  reglages: ReglagesJournal,
): JournalPrisma {
  const { projetId } = reglages;
  const parLot = reglages.parLot ?? 50;

  let attente: AEcrire[] = [];
  let recus: Array<Record<string, unknown>> = [];

  /** Vide sans attendre, quand le lot déborde. Les erreurs vont au crochet. */
  function peutEtreVider(): void {
    if (attente.length + recus.length < parLot) return;
    void vider();
  }

  async function vider(): Promise<void> {
    const lot = attente;
    const lotRecus = recus;
    attente = [];
    recus = [];

    if (lot.length === 0 && lotRecus.length === 0) return;

    try {
      // Deux écritures groupées, et non une par fait : c'est tout l'intérêt du
      // tampon. `skipDuplicates` parce que l'unicité d'`Evenement` porte sur
      // `(abonnementId, type, cle)` — nos lignes ont `cle` nul, donc aucun
      // conflit, mais un hôte qui la modifierait ne verrait pas ses journaux
      // faire tomber son passage.
      if (lot.length > 0) {
        await client.evenement.createMany({
          data: lot.map((f) => ({
            projetId,
            abonnementId: f.abonnementId,
            type: f.type,
            detail: f.detail,
            quandLe: f.quandLe,
          })),
          skipDuplicates: true,
        });
      }

      if (lotRecus.length > 0) {
        await client.webhookRecu.createMany({ data: lotRecus });
      }
    } catch (cause) {
      try {
        reglages.surErreur?.(cause);
      } catch {
        /* rien */
      }
    }
  }

  function noter(fait: AEcrire): void {
    attente.push(fait);
    peutEtreVider();
  }

  return {
    /**
     * L'envoi : les échecs seulement, par défaut.
     *
     * Une relance partie est déjà dans `Relance`, avec ses canaux et sa clé.
     * La journaliser en plus doublerait cinq cents lignes par jour sans rien
     * apprendre — et noierait les quelques échecs qui, eux, demandent une
     * action.
     */
    envoi(fait: FaitEnvoi): void {
      /**
       * Un envoi réussi peut quand même porter quelque chose.
       *
       * ─────────────────────────────────────────────────────────────────
       * LES JETONS MORTS NE SE VOIENT NULLE PART AILLEURS
       *
       * La règle « on jette les réussites » était trop large, et c'est un test
       * qui l'a montré : son commentaire disait qu'on gardait les jetons morts,
       * son assertion disait le contraire.
       *
       * Expo répond `200` avec un refus par appareil. Une notification peut
       * donc **partir** vers un téléphone et être refusée par l'autre, dont
       * l'application a été désinstallée. `Relance` note l'envoi et ses canaux ;
       * elle ne dit rien de ce jeton-là.
       *
       * Or c'est lui qui fait qu'un abonné semble joignable en push — sa liste
       * d'appareils n'est pas vide — alors qu'il ne l'est plus. Le perdre,
       * c'est laisser un palier se consommer chaque cycle sur un canal qui ne
       * mène nulle part.
       */
      const porteQuelqueChose =
        !fait.parti ||
        fait.cause !== undefined ||
        (fait.aRetirer?.length ?? 0) > 0;

      if (!porteQuelqueChose && reglages.envoisReussis !== true) return;

      noter({
        type: fait.parti ? "envoi.parti" : "envoi.echoue",
        abonnementId: null,
        detail: {
          canal: fait.canal,
          transporteur: fait.transporteur,
          cle: fait.cle,
          reference: fait.reference,
          // Les jetons morts : ce sont eux qui disent qu'un abonné n'est plus
          // joignable en push alors que sa liste d'appareils n'est pas vide.
          ...(fait.aRetirer?.length ? { aRetirer: fait.aRetirer } : {}),
          ...(fait.cause === undefined ? {} : { cause: lisible(fait.cause) }),
        },
        quandLe: new Date(),
      });
    },

    /**
     * La page : tout, y compris les ouvertures.
     *
     * C'est le seul endroit qui puisse dire combien de gens ouvrent la page et
     * ne vont pas au bout — et c'est la moitié de la raison d'héberger cette
     * page plutôt que de renvoyer chez le fournisseur.
     */
    page(fait: FaitPage): void {
      noter({
        type: `page.${fait.quoi}`,
        abonnementId: fait.abonnementId,
        detail: {
          fournisseur: fait.fournisseur,
          reference: fait.reference,
          ...(fait.detail === undefined ? {} : { detail: fait.detail }),
          ...(fait.cause === undefined ? {} : { cause: lisible(fait.cause) }),
        },
        quandLe: new Date(),
      });
    },

    /**
     * Les webhooks : tout, plus la ligne `WebhookRecu`.
     *
     * `RECU` n'écrit rien : il est émis avant qu'on sache si la signature vaut
     * quelque chose, et `WebhookRecu.signatureValide` n'accepte pas de doute.
     * C'est le fait terminal qui porte le corps.
     */
    webhook(fait: FaitWebhook): void {
      noter({
        type: `webhook.${fait.quoi}`,
        abonnementId: fait.abonnementId,
        detail: {
          fournisseur: fait.fournisseur,
          reference: fait.reference,
          ...(fait.detail === undefined ? {} : { detail: fait.detail }),
          ...(fait.cause === undefined ? {} : { cause: lisible(fait.cause) }),
        },
        quandLe: new Date(),
      });

      if (fait.corps === undefined || fait.signatureValide === undefined) return;

      recus.push({
        fournisseur: fait.fournisseur,
        signatureValide: fait.signatureValide,
        reference: fait.reference,
        corps: fait.corps.slice(0, CORPS_MAX),
        traiteLe: new Date(),
        issue: fait.quoi,
      });

      peutEtreVider();
    },

    /**
     * L'API de lecture : les réponses non-2xx seulement.
     *
     * Un tableau de bord qui interroge toutes les trente secondes produit deux
     * mille huit cents lectures par jour. Les journaliser inonderait la table
     * en une nuit, et l'on n'y trouverait plus les quelques 401 qui disent
     * qu'un jeton a fuité.
     */
    api(fait: { route: string; statut: number }): void {
      if (fait.statut < 400 && reglages.lecturesReussies !== true) return;

      noter({
        type: "api.refus",
        abonnementId: null,
        detail: { route: fait.route, statut: fait.statut },
        quandLe: new Date(),
      });
    },

    /**
     * Les gestes : les refus seulement.
     *
     * Les gestes **posés** sont déjà dans `Evenement`, écrits par
     * `interventions.journaliser` avec leur auteur et leur détail. Ce qui
     * manque, ce sont ceux qui n'ont pas abouti : un jeton invalide, un auteur
     * manquant, un geste refusé. Ceux-là ne laissent aucune trace ailleurs.
     */
    gestes(fait: { route: string; auteur: string | null; statut: number }): void {
      if (fait.statut < 400) return;

      noter({
        type: "geste.refus",
        abonnementId: null,
        detail: { route: fait.route, auteur: fait.auteur, statut: fait.statut },
        quandLe: new Date(),
      });
    },

    vider,

    enAttente: () => attente.length + recus.length,
  };
}
