import { cleDeCycle, jour, type Cadence, type Cycle } from "../cycle";
import type {
  Encaisse,
  EncaisseParFournisseur,
  Recurrent,
} from "../argent";
import type { AbonnementLu, Canal, Coordonnees, Ecriture, Lecture } from "../ports";
import type { Creances, EtatCreance } from "../encaissement/reconciliation";
import { CREANCE_VIERGE } from "../encaissement/reconciliation";
import type {
  Bornes,
  LigneTableau,
  LigneVersement,
  Page,
  Tableau,
} from "../api/tableau";
import type { Battements, Trace } from "../battement";
import type { DossierAbonnement } from "../dossier";
import type { Passage } from "../moteur";
import { grille, type Grille, type Offre } from "../offre";
import type {
  EcrituresPaiement,
  FaitIntervention,
  Interventions,
} from "../intervention";
import type { NouvelAbonnement, Souscriptions } from "../souscription";
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

/** Ce que l'adaptateur rend : tout ce que les couches de Ndank réclament. */
export interface PortsPrisma {
  lecture: Lecture;
  ecriture: Ecriture;
  creances: Creances;
  /** Pour la page de validation et le gestionnaire de webhooks. */
  dossier: DossierAbonnement;
  /** Pour l'API que le tableau de bord consomme. */
  tableau: Tableau;
  /** Pour faire naître un abonnement à partir d'un premier paiement. */
  souscriptions: Souscriptions;
  /** La grille tarifaire telle qu'elle est en base. */
  offres(): Promise<Grille>;
  /** Pour savoir si le moteur tourne encore. */
  battements: Battements;
  /** Pour les gestes manuels du tableau de bord. */
  interventions: Interventions;
}

/** `avant` est strict, `apres` est inclusif — comme dans `bornesDe`. */
function intervalle(
  borne: { avant?: Date; apres?: Date } | undefined,
): Record<string, Date> | undefined {
  if (!borne) return undefined;

  const clauses: Record<string, Date> = {};
  if (borne.avant) clauses["lt"] = borne.avant;
  if (borne.apres) clauses["gte"] = borne.apres;

  return Object.keys(clauses).length > 0 ? clauses : undefined;
}

/**
 * Traduit les bornes d'un état en clauses Prisma.
 *
 * Le cloisonnement par projet est ajouté ici comme partout ailleurs : un
 * tableau de bord qui compterait les abonnés d'un autre projet serait pire
 * qu'un chiffre faux.
 */
function ouSont(bornes: Bornes, projetId: string): Record<string, unknown> {
  const ou: Record<string, unknown> = { projetId };

  if (bornes.resiliee === true) ou["resilieeLe"] = { not: null };
  if (bornes.resiliee === false) ou["resilieeLe"] = null;
  if (bornes.close === true) ou["closLe"] = { not: null };
  if (bornes.close === false) ou["closLe"] = null;

  const echeance = intervalle(bornes.echeance);
  if (echeance) ou["echeance"] = echeance;

  const acces = intervalle(bornes.accesJusquA);
  if (acces) ou["accesJusquA"] = acces;

  const reprise = intervalle(bornes.repriseJusquA);
  if (reprise) ou["repriseJusquA"] = reprise;

  return ou;
}

/** Une ligne, ramenée à ce que le tableau de bord lit. */
function ligneDe(l: LigneAbonnement): LigneTableau {
  return {
    id: l.id,
    abonneId: l.abonneId,
    libelle: l.libelle,
    montant: l.montant,
    devise: l.devise,
    cadence: l.cadence,
    echeance: l.echeance,
    accesJusquA: l.accesJusquA,
    repriseJusquA: l.repriseJusquA,
    resilieeLe: l.resilieeLe,
    suspenduLe: l.suspenduLe,
    closLe: l.closLe,
    // Joint par `include`, quand la requête l'a demandé. On relance quelqu'un,
    // pas un `cuid`.
    ...(l.abonne
      ? {
          abonne: {
            reference: l.abonne.reference,
            nom: l.abonne.nom,
            courriel: l.abonne.courriel,
            telephone: l.abonne.telephone,
          },
        }
      : {}),
  };
}

/**
 * Les deux écritures d'un paiement, construites contre un client donné.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UNE FABRIQUE, ET NON DES MÉTHODES QUI FERMENT SUR `client`
 *
 * C'est ce qui permet de les reconstruire contre le client **transactionnel**
 * que Prisma fournit à `$transaction`. Sans cette fabrique, elles resteraient
 * liées au client extérieur — donc hors de la transaction, alors même qu'on
 * l'aurait ouverte.
 *
 * Ce piège-là ne se voit pas : la transaction s'ouvre, se ferme, tout paraît
 * normal, et rien n'est atomique. On aurait cessé de se méfier pour rien.
 */
function ecrituresDe(c: ClientNdank, projetId: string): EcrituresPaiement {
  return {
    /**
     * Enregistre un versement constaté hors ligne.
     *
     * `upsert` sur `(fournisseur, identifiantFournisseur)` — la même unicité
     * que pour les versements d'opérateur. La pièce justificative devient donc
     * la clé d'idempotence, et le même reçu ne peut pas entrer deux fois.
     *
     * `compteLe` est posé tout de suite : un versement manuel n'attend aucun
     * webhook, il est constaté au moment où on l'enregistre.
     */
    async versementManuel(v): Promise<void> {
      await c.versement.upsert({
        where: {
          fournisseur_identifiantFournisseur: {
            fournisseur: "manuel",
            identifiantFournisseur: v.identifiant,
          },
        },
        create: {
          abonnementId: v.abonnementId,
          fournisseur: "manuel",
          identifiantFournisseur: v.identifiant,
          reference: v.reference,
          montant: v.montant,
          devise: v.devise,
          etat: "REUSSI",
          regleLe: v.recuLe,
          compteLe: new Date(),
          brut: { manuel: true, moyen: v.moyen, auteur: v.auteur },
        },
        // La première écriture fait foi. Réécrire ferait bouger un montant déjà
        // compté, sur une pièce que quelqu'un a peut-être déjà rapprochée.
        update: {},
      });
    },

    async renouveler(abonnementId: string, cycle: Cycle): Promise<void> {
      await c.abonnement.updateMany({
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
}

/**
 * Ce que le tableau de bord joint à chaque abonnement.
 *
 * `select` et non `include` tout court : on ne veut ni les jetons d'appareil —
 * ce sont des poignées opaques qui n'ont rien à faire dans un écran — ni les
 * dates de création de l'abonné, qui n'y servent à rien. Ce qu'on ne demande
 * pas ne traverse pas le réseau, et ne finit pas dans un journal.
 */
const AVEC_ABONNE = {
  abonne: {
    select: { reference: true, nom: true, courriel: true, telephone: true },
  },
} as const;

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
    suspenduLe: ligne.suspenduLe,
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

  const dossier: DossierAbonnement = {
    /**
     * Lire par identifiant.
     *
     * `findFirst` avec `projetId` et non `findUnique` : un identifiant vient du
     * dehors — d'un jeton de lien, d'une référence de webhook — et `findUnique`
     * rendrait la ligne d'un autre projet aussi volontiers que la sienne.
     */
    async abonnement(id: string): Promise<AbonnementLu | null> {
      const ligne = await client.abonnement.findFirst({
        where: { id, projetId },
      });

      return ligne === null ? null : abonnementDe(ligne);
    },

    coordonnees(abonneId: string): Promise<Coordonnees> {
      return lecture.coordonnees(abonneId);
    },
  };

  const tableau: Tableau = {
    async compter(bornes: Bornes): Promise<number> {
      return client.abonnement.count({ where: ouSont(bornes, projetId) });
    },

    async lister(bornes: Bornes, page: Page): Promise<readonly LigneTableau[]> {
      const lignes = await client.abonnement.findMany({
        where: ouSont(bornes, projetId),
        include: AVEC_ABONNE,
        // Les plus urgents d'abord : même ordre que `aRelancer`, et pour la
        // même raison — quand on ne voit qu'une page, il faut que ce soit celle
        // qui demande une décision.
        orderBy: { echeance: "asc" },
        skip: page.depuis,
        take: page.combien,
      });

      return lignes.map(ligneDe);
    },

    async ligne(id: string): Promise<LigneTableau | null> {
      const ligne = await client.abonnement.findFirst({
        where: { id, projetId },
        include: AVEC_ABONNE,
      });

      return ligne === null ? null : ligneDe(ligne);
    },

    /**
     * Les versements d'un abonnement, les plus récents d'abord.
     *
     * Par `creeLe` et non par `regleLe` : un versement jamais réglé n'a pas de
     * seconde date, et trier dessus le ferait disparaître de la liste — alors
     * que c'est précisément celui qu'on cherche quand un abonné dit avoir payé.
     */
    async versements(
      abonnementId: string,
      page: Page,
    ): Promise<readonly LigneVersement[]> {
      const lignes = await client.versement.findMany({
        where: { abonnementId, abonnement: { projetId } },
        orderBy: { creeLe: "desc" },
        skip: page.depuis,
        take: page.combien,
      });

      return lignes.map((v) => ({
        id: v.id,
        abonnementId: v.abonnementId,
        fournisseur: v.fournisseur,
        reference: v.reference,
        montant: v.montant,
        devise: v.devise,
        etat: v.etat,
        regleLe: v.regleLe,
        compteLe: v.compteLe,
        creeLe: v.creeLe,
      }));
    },

    /**
     * Combien de versements par état depuis cette date.
     *
     * `groupBy` et non cinq `count` : les états ne sont pas connus d'avance —
     * un fournisseur peut en rendre un qu'on traduit en `INCONNU` — et cinq
     * requêtes rendraient quatre zéros pour un chiffre qui manquerait.
     */
    /**
     * Ce qui est entré sur une période, par devise.
     *
     * Le filtre porte sur `compteLe` et non sur `etat` : un versement `REUSSI`
     * mais jamais compté est un paiement qui n'a pas prolongé l'abonnement —
     * un incident, pas une recette. L'inclure ferait afficher de l'argent dont
     * personne n'a rien fait, et masquerait l'écart qu'on cherche justement
     * quand un abonné dit avoir payé.
     */
    async encaisse(depuis: Date, jusqua: Date): Promise<readonly Encaisse[]> {
      const groupes = await client.versement.groupBy({
        by: ["devise"],
        where: {
          compteLe: { gte: depuis, lt: jusqua },
          abonnement: { projetId },
        },
        _sum: { montant: true },
        _count: { _all: true },
      });

      return groupes.map((g) => ({
        devise: String(g["devise"] ?? ""),
        total: Number(g._sum?.["montant"] ?? 0),
        nombre: g._count._all,
      }));
    },

    async encaisseParFournisseur(
      depuis: Date,
      jusqua: Date,
    ): Promise<readonly EncaisseParFournisseur[]> {
      const groupes = await client.versement.groupBy({
        by: ["fournisseur", "devise"],
        where: {
          compteLe: { gte: depuis, lt: jusqua },
          abonnement: { projetId },
        },
        _sum: { montant: true },
        _count: { _all: true },
      });

      return groupes.map((g) => ({
        fournisseur: String(g["fournisseur"] ?? ""),
        devise: String(g["devise"] ?? ""),
        total: Number(g._sum?.["montant"] ?? 0),
        nombre: g._count._all,
      }));
    },

    /**
     * Les abonnements qui ont accès, groupés par devise et par cadence.
     *
     * ─────────────────────────────────────────────────────────────────────
     * LE FILTRE EST CELUI DE L'ACCÈS, PAS CELUI DE L'ÉCHÉANCE
     *
     * `accesJusquA >= aujourd'hui`, ni résilié ni suspendu ni clos. Cela
     * couvre d'un seul coup `ACTIVE` et `A_RENOUVELER` — les deux états où
     * l'on sert quelqu'un et où l'on attend son prochain règlement.
     *
     * Un abonné dont l'échéance est passée mais dont la grâce court est donc
     * compté : on le sert, on le relance, et il paiera probablement. Le sortir
     * ferait chuter le revenu récurrent chaque fin de mois, puis remonter, sur
     * des gens qui n'ont jamais cessé d'être abonnés.
     */
    async recurrent(maintenant: Date): Promise<readonly Recurrent[]> {
      const groupes = await client.abonnement.groupBy({
        by: ["devise", "cadence"],
        where: {
          projetId,
          resilieeLe: null,
          suspenduLe: null,
          closLe: null,
          accesJusquA: { gte: jour(maintenant) },
        },
        _sum: { montant: true },
        _count: { _all: true },
      });

      return groupes.map((g) => ({
        devise: String(g["devise"] ?? ""),
        cadence: String(g["cadence"] ?? ""),
        total: Number(g._sum?.["montant"] ?? 0),
        nombre: g._count._all,
      }));
    },

    async compterVersements(
      depuis: Date,
    ): Promise<Readonly<Record<string, number>>> {
      const groupes = await client.versement.groupBy({
        by: ["etat"],
        where: { creeLe: { gte: depuis }, abonnement: { projetId } },
        _count: { _all: true },
      });

      const comptes: Record<string, number> = {};
      for (const g of groupes) comptes[String(g["etat"] ?? "")] = g._count._all;

      return comptes;
    },
  };

  const souscriptions: Souscriptions = {
    /**
     * Trouve l'abonné ou le crée.
     *
     * `upsert` sur l'unicité `(projetId, reference)` : deux souscriptions
     * simultanées du même abonné ne peuvent pas en écrire deux. C'est la même
     * règle que pour les relances — l'idempotence est une contrainte de la
     * base, pas une intention du code.
     *
     * Les coordonnées sont mises à jour à chaque passage : quelqu'un qui
     * souscrit à une seconde offre a pu changer de numéro entre-temps, et
     * garder l'ancien ferait partir la relance sur une ligne résiliée.
     */
    async abonne(reference: string, coordonnees: Coordonnees): Promise<string> {
      const ligne = (await client.abonne.upsert({
        where: { projetId_reference: { projetId, reference } },
        create: {
          projetId,
          reference,
          nom: coordonnees.nom,
          courriel: coordonnees.courriel,
          telephone: coordonnees.telephone,
          appareils: coordonnees.appareils,
        },
        update: {
          nom: coordonnees.nom,
          courriel: coordonnees.courriel,
          telephone: coordonnees.telephone,
          appareils: coordonnees.appareils,
        },
        select: { id: true },
      })) as { id: string };

      return ligne.id;
    },

    /**
     * L'abonnement en cours de cet abonné pour cette offre.
     *
     * « En cours » : ni résilié, ni clos. Un abonnement expiré, lui, **est**
     * clos par le passage quotidien — donc quelqu'un qui revient après six mois
     * en souscrit bien un nouveau, ce qui est la règle : se réabonner repart de
     * zéro.
     */
    async enCours(abonneId: string, offreId: string): Promise<AbonnementLu | null> {
      const ligne = await client.abonnement.findFirst({
        where: {
          projetId,
          abonneId,
          offreId,
          resilieeLe: null,
          closLe: null,
        },
      });

      return ligne === null ? null : abonnementDe(ligne);
    },

    /**
     * Crée l'abonnement.
     *
     * Le prix et le libellé sont **recopiés** depuis l'offre, et non lus par
     * jointure. C'est une décision du schéma : augmenter un tarif ne doit pas
     * changer rétroactivement ce que doivent les abonnés en cours, y compris
     * sur un cycle déjà à moitié payé.
     */
    async ouvrir(nouveau: NouvelAbonnement): Promise<AbonnementLu> {
      const ligne = (await client.abonnement.create({
        data: {
          projetId,
          abonneId: nouveau.abonneId,
          offreId: nouveau.offre.id,
          libelle: nouveau.offre.libelle,
          montant: nouveau.offre.montant,
          devise: nouveau.offre.devise,
          cadence: nouveau.offre.cadence,
          debut: nouveau.cycle.debut,
          echeance: nouveau.cycle.echeance,
          accesJusquA: nouveau.cycle.accesJusquA,
          repriseJusquA: nouveau.cycle.repriseJusquA,
        },
      })) as LigneAbonnement;

      return abonnementDe(ligne);
    },
  };

  /**
   * La grille, lue en base et **vérifiée**.
   *
   * `grille()` lève sur une ligne fautive plutôt que de la rendre. Une devise
   * mal saisie dans un tableau d'administration passerait sinon jusqu'au
   * fournisseur, qui la refuserait avec un message parlant du compte marchand.
   */
  async function offres(): Promise<Grille> {
    const lignes = await client.offre.findMany({
      where: { projetId },
      orderBy: { montant: "asc" },
    });

    return grille(
      lignes.map((l) => ({
        id: l.id,
        libelle: l.libelle,
        montant: l.montant,
        devise: l.devise,
        cadence: l.cadence as Offre["cadence"],
        actif: l.actif,
      })),
    );
  }

  const interventions: Interventions = {
    /**
     * Pose ou lève la suspension.
     *
     * `updateMany` avec `projetId` : l'identifiant vient d'un tableau de bord,
     * donc du dehors, et `update` toucherait la ligne d'un autre projet aussi
     * volontiers que la sienne.
     */
    async suspendre(abonnementId: string, quand: Date | null): Promise<void> {
      await client.abonnement.updateMany({
        where: { id: abonnementId, projetId },
        data: { suspenduLe: quand },
      });
    },

    /**
     * Pose la résiliation.
     *
     * `resilieeLe: null` dans le filtre : la première résiliation fait foi.
     * Sans cela, un second clic déplacerait la date — et l'on perdrait le
     * moment où l'abonné a vraiment dit non.
     */
    async resilier(abonnementId: string, quand: Date): Promise<void> {
      await client.abonnement.updateMany({
        where: { id: abonnementId, projetId, resilieeLe: null },
        data: { resilieeLe: quand },
      });
    },

    /** Déléguée à la fabrique, pour qu'elle serve aussi dans la transaction. */
    versementManuel: (v) => ecrituresDe(client, projetId).versementManuel(v),

    /**
     * Les deux écritures d'un paiement, dans une seule transaction.
     *
     * `travail` **reçoit** les écritures, construites contre le client
     * transactionnel `tx`. Écrire `client.$transaction(() => travail())`
     * ouvrirait bien une transaction, mais les écritures passeraient par le
     * client extérieur — donc hors d'elle. On croirait tenir une garantie
     * qu'on n'a pas, ce qui est pire que de ne pas en avoir.
     */
    ensemble: client.$transaction
      ? <T>(travail: (e: EcrituresPaiement) => Promise<T>): Promise<T> =>
          client.$transaction!((tx) => travail(ecrituresDe(tx, projetId)))
      : undefined,

    /**
     * Consigne le geste.
     *
     * La clé porte l'horodatage exact, et non le cycle : deux suspensions
     * successives dans le même cycle sont deux faits distincts, et l'unicité
     * `(abonnementId, type, cle)` les écraserait l'un l'autre si la clé ne les
     * distinguait pas.
     *
     * C'est l'inverse du journal du moteur, où la clé de cycle sert justement à
     * n'en garder qu'un — parce que là, c'est le même fait redit trente fois.
     */
    async journaliser(fait: FaitIntervention): Promise<void> {
      await client.evenement.upsert({
        where: {
          abonnementId_type_cle: {
            abonnementId: fait.abonnementId,
            type: `manuel.${fait.geste}`,
            cle: fait.quand.toISOString(),
          },
        },
        create: {
          projetId,
          abonnementId: fait.abonnementId,
          type: `manuel.${fait.geste}`,
          cle: fait.quand.toISOString(),
          quandLe: fait.quand,
          detail: { auteur: fait.auteur, ...fait.detail },
        },
        update: {},
      });
    },
  };

  const battements: Battements = {
    /**
     * Ouvre la trace, avant que le passage ne commence.
     *
     * `create` et non `upsert` : chaque passage est un fait distinct, même
     * lancé deux fois dans la même minute. En écraser un masquerait précisément
     * le cas qu'on veut voir — deux processus qui tournent en parallèle.
     */
    async commencer(quand: Date): Promise<string> {
      const ligne = (await client.passage.create({
        data: { projetId, commenceLe: quand },
      })) as { id: string };

      return ligne.id;
    },

    async terminer(id: string, bilan: Passage, quand: Date): Promise<void> {
      await client.passage.updateMany({
        where: { id, projetId },
        data: {
          termineLe: quand,
          vus: bilan.vus,
          relances: bilan.relances,
          suspendus: bilan.suspendus,
          clos: bilan.clos,
          injoignables: bilan.injoignables,
          // Le compte suffit ici : le détail de chaque échec a sa place dans
          // le journal, pas dans une ligne qu'on lit d'un coup d'œil.
          echecs: bilan.echecs.length,
          lotPlein: bilan.lotPlein,
        },
      });
    },

    async echouer(id: string, erreur: string, quand: Date): Promise<void> {
      await client.passage.updateMany({
        where: { id, projetId },
        data: { termineLe: quand, erreur },
      });
    },

    /**
     * La dernière trace, par date de début.
     *
     * Par `commenceLe` et non `termineLe` : un passage encore ouvert n'a pas de
     * seconde date, et trier dessus le ferait disparaître — alors que c'est
     * précisément celui qu'on cherche quand le processus est bloqué.
     */
    async dernier(): Promise<Trace | null> {
      const ligne = await client.passage.findFirst({
        where: { projetId },
        orderBy: { commenceLe: "desc" },
      });

      return ligne === null
        ? null
        : {
            id: ligne.id,
            commenceLe: ligne.commenceLe,
            termineLe: ligne.termineLe,
            vus: ligne.vus,
            relances: ligne.relances,
            suspendus: ligne.suspendus,
            clos: ligne.clos,
            injoignables: ligne.injoignables,
            echecs: ligne.echecs,
            lotPlein: ligne.lotPlein,
            erreur: ligne.erreur,
          };
    },
  };

  return {
    lecture,
    ecriture,
    creances,
    dossier,
    tableau,
    souscriptions,
    offres,
    interventions,
    battements,
  };
}
