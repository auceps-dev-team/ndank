import { cleDeCycle, type Cadence, type Cycle } from "../cycle";
import type { AbonnementLu, Canal, Coordonnees, Ecriture, Lecture } from "../ports";
import type { Creances, EtatCreance } from "../encaissement/reconciliation";
import { CREANCE_VIERGE } from "../encaissement/reconciliation";
import type { ClientNdank, LigneAbonnement } from "./client";

/**
 * Ndank — les ports, implémentés contre le schéma fourni.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE NIVEAU 2 N'EST QUE CELA
 *
 * Pas une seconde version du moteur, pas une règle de plus : les mêmes ports,
 * remplis contre les tables livrées. C'est ce qui permet aux deux niveaux de
 * cohabiter sans dupliquer une ligne de logique — et ce qui fait qu'un hôte
 * peut commencer au niveau 2 puis descendre au niveau 1 sur une seule méthode,
 * le jour où sa base diverge.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TOUT EST CLOISONNÉ PAR PROJET
 *
 * Chaque requête porte `projetId`. Ce n'est pas une commodité de multi-locataire
 * : c'est ce qui garantit qu'un passage quotidien lancé pour un projet ne
 * relance jamais l'abonné d'un autre. L'oublier une seule fois, sur une seule
 * méthode, suffirait — d'où le fait qu'il soit obligatoire à la construction
 * plutôt que passé à chaque appel.
 */

export interface ReglagesPrisma {
  /** Le projet auquel tout ce qui suit appartient. */
  projetId: string;
}

/** Ce que l'adaptateur rend : les trois ports du cœur, plus les créances. */
export interface PortsPrisma {
  lecture: Lecture;
  ecriture: Ecriture;
  creances: Creances;
}

/** Les cadences du schéma, ramenées à celles du cœur. */
function cadenceDe(valeur: string): Cadence {
  switch (valeur) {
    case "HEBDOMADAIRE":
    case "MENSUEL":
    case "TRIMESTRIEL":
    case "ANNUEL":
      return valeur;
    default:
      // Une cadence qu'on ne connaît pas ne doit pas devenir « mensuel » par
      // défaut : on facturerait au mauvais rythme sans que rien ne le dise.
      throw new Error(
        `Cadence inconnue en base : « ${valeur} ». ` +
          `Attendu HEBDOMADAIRE, MENSUEL, TRIMESTRIEL ou ANNUEL.`,
      );
  }
}

/** Une ligne, ramenée à ce que le moteur sait lire. */
export function abonnementDe(ligne: LigneAbonnement): AbonnementLu {
  return {
    id: ligne.id,
    abonneId: ligne.abonneId,
    cadence: cadenceDe(ligne.cadence),
    cycle: {
      debut: ligne.debut,
      echeance: ligne.echeance,
      accesJusquA: ligne.accesJusquA,
      repriseJusquA: ligne.repriseJusquA,
    },
    resilieeLe: ligne.resilieeLe,
    montant: ligne.montant,
    devise: ligne.devise,
    libelle: ligne.libelle,
  };
}

export function portsPrisma(
  client: ClientNdank,
  reglages: ReglagesPrisma,
): PortsPrisma {
  const { projetId } = reglages;

  const lecture: Lecture = {
    /**
     * Les abonnements qu'un passage pourrait avoir à toucher.
     *
     * ─────────────────────────────────────────────────────────────────────
     * POURQUOI `echeance` SEULE SUFFIT
     *
     * Le contrat parle de l'échéance **ou** de la fin d'accès. Une seule
     * comparaison les couvre pourtant toutes les deux, parce que l'accès vient
     * toujours après l'échéance : un abonnement à suspendre ou à clore a
     * forcément une échéance déjà passée, donc antérieure à `avant`.
     *
     * ─────────────────────────────────────────────────────────────────────
     * DEUX EXCLUSIONS, ET AUCUNE N'EST COSMÉTIQUE
     *
     * Les **clos** sont écartés parce que le moteur ne peut pas savoir qu'ils
     * le sont : il redirait `clore` chaque jour, indéfiniment.
     *
     * Les **résiliés** le sont pour une raison plus retorse. `etatDe` rend
     * `RESILIEE` avant même de regarder les dates, donc `gesteDuJour` rend
     * `RIEN` — pour toujours. Le moteur ne clôt jamais un abonnement résilié.
     * Laissés éligibles, ils resteraient dans le lot aussi longtemps que la
     * base existe, et finiraient par en occuper les cinq cents places.
     */
    async aRelancer(avant: Date, limite: number): Promise<AbonnementLu[]> {
      const lignes = await client.abonnement.findMany({
        where: {
          projetId,
          closLe: null,
          resilieeLe: null,
          echeance: { lte: avant },
        },
        // Les plus en retard d'abord : si le lot déborde, ce sont eux qu'il
        // faut avoir traités.
        orderBy: { echeance: "asc" },
        take: limite,
      });

      return lignes.map(abonnementDe);
    },

    /**
     * Les clés de relance déjà parties pour ce cycle.
     *
     * On filtre sur le préfixe plutôt que de tout rendre : après trois ans
     * d'abonnement mensuel, tout rendre ferait charger une centaine de clés
     * chaque matin pour n'en regarder qu'une poignée.
     */
    async relancesEnvoyees(abonnementId: string, cycle: string): Promise<string[]> {
      const lignes = await client.relance.findMany({
        where: { abonnementId, cle: { startsWith: `${cycle}:` } },
        select: { cle: true },
      });

      return lignes.map((l) => l.cle);
    },

    async coordonnees(abonneId: string): Promise<Coordonnees> {
      const ligne = await client.abonne.findUnique({
        where: { id: abonneId },
        select: { nom: true, courriel: true, telephone: true, appareils: true },
      });

      // Un abonné introuvable n'est pas une panne : c'est quelqu'un qu'on ne
      // sait plus joindre. Le moteur comptera un `injoignable`, ce qui est un
      // incident visible — et il ne notera pas la relance, donc il réessaiera.
      if (!ligne) {
        return { nom: null, courriel: null, telephone: null, appareils: [] };
      }

      return {
        nom: ligne.nom,
        courriel: ligne.courriel,
        telephone: ligne.telephone,
        appareils: ligne.appareils,
      };
    },
  };

  const ecriture: Ecriture = {
    /**
     * Note qu'une relance est partie.
     *
     * `upsert` sur l'unicité `(abonnementId, cle)` : deux passages simultanés ne
     * peuvent pas en écrire deux. L'idempotence est une contrainte de la base,
     * pas une intention du code.
     */
    async noterRelance(
      abonnementId: string,
      cle: string,
      canaux: readonly Canal[],
    ): Promise<void> {
      await client.relance.upsert({
        where: { abonnementId_cle: { abonnementId, cle } },
        create: { abonnementId, cle, canaux: [...canaux] },
        // Rien à mettre à jour : la première écriture fait foi. Réécrire les
        // canaux ferait croire à un second envoi qui n'a pas eu lieu.
        update: {},
      });
    },

    /**
     * Coupe l'accès.
     *
     * Il n'y a rien à écrire sur l'abonnement : l'accès se déduit des dates par
     * `accesOuvert`, et poser une colonne ici rouvrirait la désynchronisation
     * que le cœur existe pour éviter.
     *
     * Ce qu'on écrit, c'est le fait — une fois. Le moteur redit `suspendre`
     * chaque jour de la fenêtre de reprise, soit trente fois pour un seul
     * événement ; la clé de cycle et l'unicité du journal n'en gardent qu'un.
     */
    async suspendre(abonnementId: string): Promise<void> {
      await journaliser(abonnementId, "abonnement.suspendu");
    },

    /**
     * Clôt définitivement.
     *
     * `updateMany` avec `closLe: null` dans le filtre : la seconde fois, aucune
     * ligne ne correspond et rien ne se passe. `update` aurait levé, et le
     * contrat dit que clore un dossier déjà clos est un geste normal.
     *
     * C'est aussi ce qui retire l'abonnement du lot pour de bon.
     */
    async clore(abonnementId: string): Promise<void> {
      await client.abonnement.updateMany({
        where: { id: abonnementId, projetId, closLe: null },
        data: { closLe: new Date() },
      });

      await journaliser(abonnementId, "abonnement.clos");
    },

    /** Enregistre le nouveau cycle après un paiement confirmé. */
    async renouveler(abonnementId: string, cycle: Cycle): Promise<void> {
      await client.abonnement.updateMany({
        where: { id: abonnementId, projetId },
        data: {
          debut: cycle.debut,
          echeance: cycle.echeance,
          accesJusquA: cycle.accesJusquA,
          repriseJusquA: cycle.repriseJusquA,
        },
      });
    },
  };

  const creances: Creances = {
    async etat(abonnementId: string): Promise<EtatCreance> {
      const ligne = await client.abonnement.findUnique({
        where: { id: abonnementId },
        select: { verse: true, joursAccordes: true, versements: true },
      });

      if (!ligne) return CREANCE_VIERGE;

      return {
        verse: ligne.verse,
        joursAccordes: ligne.joursAccordes,
        versements: ligne.versements,
      };
    },

    /**
     * Vrai si ce versement a déjà été compté.
     *
     * `compteLe` et non la simple existence de la ligne : une invitation crée
     * un versement `EN_ATTENTE` bien avant qu'il ne compte. Confondre les deux
     * ferait ignorer le paiement au moment où il arrive enfin.
     */
    async dejaCompte(versementId: string): Promise<boolean> {
      const ligne = await client.versement.findFirst({
        where: {
          identifiantFournisseur: versementId,
          compteLe: { not: null },
        },
        select: { id: true },
      });

      return ligne !== null;
    },
  };

  /** Journalise un fait, une seule fois par cycle. */
  async function journaliser(abonnementId: string, type: string): Promise<void> {
    const ligne = await client.abonnement.findUnique({
      where: { id: abonnementId },
      select: { echeance: true },
    });

    // Sans échéance, pas de clé de cycle — donc pas d'unicité possible. On
    // s'abstient plutôt que d'écrire une ligne par jour.
    if (!ligne) return;

    const cle = cleDeCycle(ligne.echeance);

    await client.evenement.upsert({
      where: { abonnementId_type_cle: { abonnementId, type, cle } },
      create: { projetId, abonnementId, type, cle },
      update: {},
    });
  }

  return { lecture, ecriture, creances };
}
