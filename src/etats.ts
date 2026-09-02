import { cleDeCycle, joursEntre, type Cycle } from "./cycle";

/**
 * Ndank — où en est un abonnement, et ce qu'il faut en faire.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * L'ÉTAT SE DÉDUIT, IL NE SE STOCKE PAS
 *
 * Un état rangé en base se désynchronise. Il faudrait un passage pour faire
 * vieillir chaque abonnement à la seconde près, et le jour où ce passage rate
 * son tour — panne, déploiement, week-end — des abonnés gardent un accès qu'ils
 * n'ont plus payé, ou perdent celui qu'ils ont payé.
 *
 * Ici l'état est **calculé** à partir de deux dates et de l'instant présent. Il
 * ne peut donc jamais être en retard, et un passage manqué ne fait rien perdre :
 * au prochain, tout est de nouveau juste.
 *
 * Ce que la base garde, ce sont les faits — quand on a été payé, quand on a
 * rappelé, quand l'abonné a résilié. Pas les conclusions.
 */

export type Etat =
  /** Payé, dans les temps. Rien à faire. */
  | "ACTIVE"
  /** L'échéance approche ou vient de passer. On rappelle, l'accès tient. */
  | "A_RENOUVELER"
  /** La grâce est épuisée. L'accès est coupé, mais tout peut reprendre. */
  | "SUSPENDUE"
  /** L'abonné a dit non. Aucun rappel ne doit plus partir. */
  | "RESILIEE"
  /** Suspendue trop longtemps. Se réabonner recommence à zéro. */
  | "EXPIREE";

export interface Abonnement {
  cycle: Cycle;
  /** Posée quand l'abonné résilie. Elle l'emporte sur tout le reste. */
  resilieeLe: Date | null;
}

/**
 * Combien de jours avant l'échéance on commence à s'inquiéter.
 *
 * Trois : assez tôt pour qu'un abonné puisse s'organiser, assez tard pour que
 * le rappel ne soit pas oublié avant d'être utile.
 */
export const PREAVIS_JOURS = 3;

/**
 * Où en est cet abonnement, maintenant.
 *
 * L'ordre des tests n'est pas indifférent. La résiliation passe en premier :
 * un abonné qui a dit non ne doit plus jamais recevoir de rappel, même si son
 * échéance tombe demain. Le reste suit les dates, de la plus lointaine à la
 * plus proche.
 */
export function etatDe(abonnement: Abonnement, maintenant: Date): Etat {
  if (abonnement.resilieeLe !== null) return "RESILIEE";

  const { cycle } = abonnement;

  if (maintenant > cycle.repriseJusquA) return "EXPIREE";
  if (maintenant > cycle.accesJusquA) return "SUSPENDUE";

  // L'accès tient encore. Reste à savoir si l'on doit relancer.
  const restant = joursEntre(maintenant, cycle.echeance);
  if (restant <= PREAVIS_JOURS) return "A_RENOUVELER";

  return "ACTIVE";
}

/** L'abonné a-t-il droit au service, à cet instant ? */
export function accesOuvert(abonnement: Abonnement, maintenant: Date): boolean {
  const etat = etatDe(abonnement, maintenant);
  return etat === "ACTIVE" || etat === "A_RENOUVELER";
}

/**
 * Un abonnement suspendu peut-il reprendre là où il s'est arrêté ?
 *
 * La distinction compte pour l'abonné : reprendre garde son ancienneté et son
 * historique ; se réabonner repart de zéro. Elle compte aussi pour nous — un
 * abonnement repris n'est pas une nouvelle vente.
 */
export function peutReprendre(
  abonnement: Abonnement,
  maintenant: Date,
): boolean {
  return etatDe(abonnement, maintenant) === "SUSPENDUE";
}

/**
 * Ce qu'un passage doit faire de cet abonnement.
 *
 * Trois issues seulement, et c'est voulu : un passage quotidien qui aurait
 * quinze branches serait impossible à relire le jour où il se trompe.
 */
export type Geste =
  /** Envoyer une relance. Le palier dit laquelle. */
  | { faire: "RAPPELER"; palier: number; cle: string }
  /** Couper l'accès. */
  | { faire: "SUSPENDRE" }
  /** Clore définitivement. */
  | { faire: "CLORE" }
  /** Rien. Le cas le plus fréquent, et de loin. */
  | { faire: "RIEN" };

/**
 * L'échelle des relances.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ON MONTE EN COÛT À MESURE QUE L'ÉCHÉANCE APPROCHE
 *
 * Un SMS se paie à chaque envoi ; un courriel et une notification ne coûtent
 * rien. Relancer par SMS trois jours avant l'échéance, pour un abonné qui
 * paiera de toute façon, revient à jeter de l'argent — sur mille abonnés
 * mensuels, c'est mille SMS par mois pour rien.
 *
 * L'échelle commence donc par le gratuit, et ne sort le SMS qu'au moment où il
 * décide vraiment de quelque chose : quand l'accès va être coupé.
 *
 * Les jours sont relatifs à l'échéance. Négatif = avant.
 */
export const PALIERS: readonly { jour: number; canaux: string[] }[] = [
  { jour: -3, canaux: ["courriel", "push"] },
  { jour: 0, canaux: ["courriel", "push"] },
  { jour: 2, canaux: ["push", "sms"] },
  { jour: 5, canaux: ["sms"] },
];

/**
 * Décide du geste, sans rien exécuter.
 *
 * `dejaEnvoyes` porte les clés des relances déjà parties pour ce cycle. C'est
 * ce qui empêche un passage quotidien de renvoyer sept fois le même message :
 * la clé dépend du cycle et du palier, jamais de la date du jour.
 */
export function gesteDuJour(
  abonnement: Abonnement,
  maintenant: Date,
  dejaEnvoyes: ReadonlySet<string>,
): Geste {
  const etat = etatDe(abonnement, maintenant);

  // Un abonné qui a dit non a déjà tout décidé. Rien ne doit plus partir.
  if (etat === "RESILIEE") return { faire: "RIEN" };

  // Ces deux gestes sont idempotents CÔTÉ APPELANT : lui seul sait si l'accès
  // est déjà coupé ou le dossier déjà clos. Ici on dit ce qui doit être vrai,
  // pas ce qui a changé — c'est la même règle que partout dans ce module.
  if (etat === "EXPIREE") return { faire: "CLORE" };
  if (etat === "SUSPENDUE") return { faire: "SUSPENDRE" };

  if (etat === "ACTIVE") return { faire: "RIEN" };

  // A_RENOUVELER : on cherche le palier le plus avancé qui soit dû et pas
  // encore envoyé. Le plus avancé, et non le premier : un passage qui a raté
  // trois jours ne doit pas envoyer trois relances d'un coup.
  const ecart = joursEntre(abonnement.cycle.echeance, maintenant);
  const cycle = cleDeCycle(abonnement.cycle.echeance);

  for (let i = PALIERS.length - 1; i >= 0; i -= 1) {
    const palier = PALIERS[i]!;
    if (ecart < palier.jour) continue;

    const cle = `${cycle}:${i}`;
    if (dejaEnvoyes.has(cle)) return { faire: "RIEN" };

    return { faire: "RAPPELER", palier: i, cle };
  }

  return { faire: "RIEN" };
}

/** Les canaux du palier, dans l'ordre où il faut les essayer. */
export function canauxDuPalier(palier: number): readonly string[] {
  return PALIERS[palier]?.canaux ?? [];
}
