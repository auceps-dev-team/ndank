/**
 * Ndank — le rythme d'un abonnement payé sans carte.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LA CONTRAINTE QUI DESSINE TOUT
 *
 * Le mobile money ne sait pas prélever. Les réseaux de cartes ont des jetons :
 * un marchand débite une carte enregistrée quand il veut. Orange Money, Wave et
 * MTN ne permettent pas cela — chaque débit exige que l'abonné valide sur son
 * téléphone, et il n'existe pas de mandat de prélèvement généralisé en zone
 * franc CFA.
 *
 * Un abonnement mobile money n'est donc pas « on prélève », c'est **« on
 * rappelle, l'abonné valide »**. Ce n'est pas un pis-aller : c'est la seule
 * forme qui tienne, et tout ce module en découle.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DEUX HORLOGES, ET C'EST LE CŒUR DU SUJET
 *
 * Un abonnement à carte n'en a qu'une : on débite, l'accès suit. Ici il en faut
 * deux, parce que le paiement peut arriver en retard sans que l'accès s'arrête.
 *
 *   — **l'échéance** : la date à laquelle le paiement est dû ;
 *   — **l'accès** : la date jusqu'à laquelle l'abonné garde son service.
 *
 * Entre les deux vit la **grâce** : ces quelques jours où l'on a déjà rappelé,
 * où l'abonné n'a pas encore payé, et où on ne lui coupe rien. Sans elle, un
 * abonné en déplacement, hors réseau ou simplement occupé perdrait son accès
 * pour un retard de deux jours — et ne se réabonnerait pas.
 *
 * Confondre les deux horloges est l'erreur qui rend un système d'abonnement
 * insupportable : soit on coupe trop tôt, soit on offre le service.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * PUR, ET SANS AUCUNE DÉPENDANCE
 *
 * Rien ici ne connaît de base, de réseau, ni de cadre applicatif. C'est ce qui
 * permettra à ce module de vivre hors de Baobart sans rien emporter.
 */

/** À quel rythme un abonnement se renouvelle. */
export type Cadence = "MENSUEL" | "TRIMESTRIEL" | "ANNUEL" | "HEBDOMADAIRE";

/** Combien de jours dure un cycle. */
export const JOURS_DE_CADENCE: Record<Cadence, number> = {
  HEBDOMADAIRE: 7,
  MENSUEL: 30,
  TRIMESTRIEL: 90,
  ANNUEL: 365,
};

export interface Reglages {
  /**
   * Jours d'accès maintenus au-delà de l'échéance.
   *
   * Sept par défaut. En dessous de trois, un abonné parti en week-end perd son
   * accès ; au-delà de dix, on offre un mois sur douze à qui ne paie jamais.
   */
  graceJours: number;

  /**
   * Jours après la fin de la grâce pendant lesquels un abonnement suspendu peut
   * encore reprendre là où il s'était arrêté.
   *
   * Passé ce délai il est clos, et se réabonner recommence à zéro. Trente jours
   * : assez pour un imprévu, pas assez pour que l'historique s'accumule
   * indéfiniment.
   */
  repriseJours: number;
}

export const REGLAGES_PAR_DEFAUT: Reglages = {
  graceJours: 7,
  repriseJours: 30,
};

// ───────────────────────────────────────────────────────────────── dates ──
//
// Tout est calculé en UTC. Un abonnement ne doit pas changer de jour selon le
// fuseau du serveur qui exécute le passage — c'est la même règle que les
// versements, et pour la même raison : deux serveurs dans deux régions
// donneraient deux échéances.

const JOUR_MS = 86_400_000;

/** Ramène un instant au jour civil UTC. */
export function jour(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export function ajouterJours(date: Date, jours: number): Date {
  return new Date(date.getTime() + jours * JOUR_MS);
}

/** Nombre de jours civils entre deux instants. Négatif si `b` précède `a`. */
export function joursEntre(a: Date, b: Date): number {
  return Math.round((jour(b).getTime() - jour(a).getTime()) / JOUR_MS);
}

// ──────────────────────────────────────────────────────────────── cycles ──

export interface Cycle {
  /** Début de la période couverte. */
  debut: Date;
  /** Date à laquelle le paiement suivant est dû. */
  echeance: Date;
  /** Jusqu'à quand l'accès est maintenu, grâce comprise. */
  accesJusquA: Date;
  /** Au-delà, un abonnement suspendu ne reprend plus : il se recommence. */
  repriseJusquA: Date;
}

/**
 * Le cycle qui commence quand un paiement est confirmé.
 *
 * L'accès va jusqu'à l'échéance **plus** la grâce : l'abonné garde son service
 * pendant qu'on le relance. C'est délibéré et cela coûte quelques jours de
 * service offert — bien moins que les abonnés perdus pour un retard de deux
 * jours.
 */
export function cycleApresPaiement(
  paiement: Date,
  cadence: Cadence,
  reglages: Reglages = REGLAGES_PAR_DEFAUT,
): Cycle {
  const debut = jour(paiement);
  const echeance = ajouterJours(debut, JOURS_DE_CADENCE[cadence]);
  const accesJusquA = ajouterJours(echeance, reglages.graceJours);

  return {
    debut,
    echeance,
    accesJusquA,
    repriseJusquA: ajouterJours(accesJusquA, reglages.repriseJours),
  };
}

/**
 * Le cycle suivant, enchaîné sur l'échéance et non sur la date de paiement.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI L'ÉCHÉANCE ET PAS LE PAIEMENT
 *
 * Un abonné qui paie trois jours en retard chaque mois verrait, sinon, son
 * échéance glisser de trois jours à chaque cycle. Au bout d'un an, il paierait
 * onze mois au lieu de douze — et personne ne saurait dire quand.
 *
 * En enchaînant sur l'échéance, le rythme reste fixe : le retard est absorbé
 * par la grâce, pas reporté sur la suite.
 *
 * Une exception : un abonnement repris **après** la fin de son accès repart du
 * jour du paiement. Le faire enchaîner sur une échéance vieille de trois
 * semaines facturerait une période déjà écoulée.
 */
export function cycleSuivant(
  precedent: Cycle,
  paiement: Date,
  cadence: Cadence,
  reglages: Reglages = REGLAGES_PAR_DEFAUT,
): Cycle {
  const paye = jour(paiement);

  if (paye > precedent.accesJusquA) {
    return cycleApresPaiement(paye, cadence, reglages);
  }

  const echeance = ajouterJours(
    precedent.echeance,
    JOURS_DE_CADENCE[cadence],
  );
  const accesJusquA = ajouterJours(echeance, reglages.graceJours);

  return {
    debut: precedent.echeance,
    echeance,
    accesJusquA,
    repriseJusquA: ajouterJours(accesJusquA, reglages.repriseJours),
  };
}

/**
 * Un identifiant stable du cycle, pour ne pas rappeler deux fois.
 *
 * Un passage quotidien repasse sur les mêmes abonnements. Sans une clé qui
 * dépend du cycle — et non de la date du jour — le même rappel repartirait
 * chaque matin, et l'abonné recevrait sept SMS pour une seule échéance.
 */
export function cleDeCycle(echeance: Date): string {
  return jour(echeance).toISOString().slice(0, 10);
}
