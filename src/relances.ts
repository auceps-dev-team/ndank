import { cleDeCycle } from "./cycle";
import type { Canal } from "./ports";

/**
 * Ndank — ce que les relances coûtent, et ce que les paiements racontent.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NDANK NE CONNAÎT AUCUN PRIX, ET NE DOIT PAS EN CONNAÎTRE
 *
 * Un SMS ne coûte pas la même chose selon l'opérateur, le pays, le volume
 * négocié, et le jour où le contrat a été signé. Écrire un tarif dans la
 * bibliothèque, ce serait afficher un chiffre faux à tout le monde sauf à celui
 * pour qui il a été écrit.
 *
 * L'hôte déclare donc ses tarifs, et Ndank compte. C'est le même partage que
 * pour `Redaction.montant` : la bibliothèque sait combien de messages sont
 * partis, l'hôte sait ce qu'ils lui coûtent.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CE CHIFFRE MÉRITE D'ÊTRE AFFICHÉ
 *
 * L'échelle des relances est construite autour d'une idée : on commence par le
 * gratuit et l'on ne sort le SMS qu'au moment où il décide de quelque chose.
 * C'est une décision de conception, écrite dans `PALIERS` — et elle est
 * invérifiable tant que personne ne voit la facture.
 *
 * Un tableau de bord qui affiche « 1 800 F de SMS ce mois pour 47 abonnés »
 * rend la décision mesurable. Le jour où ce chiffre double sans que le nombre
 * d'abonnés bouge, c'est que trop de gens arrivent au dernier palier — donc que
 * les relances gratuites n'arrivent plus.
 */

/** Le prix d'un message, par canal, en unités mineures. */
export type Tarifs = Partial<Record<Canal, number>>;

/** Combien de relances sont parties, par canal. */
export type ComptesParCanal = Partial<Record<Canal, number>>;

export interface CoutCanal {
  canal: Canal;
  nombre: number;
  /** En unités mineures. `0` quand le canal est gratuit. */
  cout: number;
}

export interface CoutDesRelances {
  devise: string;
  parCanal: CoutCanal[];
  total: number;
  /** Combien de messages, tous canaux confondus. */
  messages: number;
}

/**
 * Ce que les relances d'une période ont coûté.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UN MESSAGE, UN PRIX — ET C'EST EXACT ICI
 *
 * Compter par message serait faux si un SMS pouvait coûter deux segments. Il ne
 * le peut pas : `redigerSms` garantit un segment, en rognant le nom de l'offre
 * plutôt que le lien. Le seul cas où elle rend deux segments est celui où le
 * lien seul déborde — et l'hôte le voit alors dans `Sms.segments`.
 *
 * Chaque relance ne compte non plus qu'un seul canal : `relancer` s'arrête au
 * premier qui part. Une relance n'apparaît donc jamais deux fois.
 */
export function coutDesRelances(
  comptes: ComptesParCanal,
  tarifs: Tarifs,
  devise: string,
): CoutDesRelances {
  const parCanal: CoutCanal[] = [];
  let total = 0;
  let messages = 0;

  for (const canal of ["courriel", "push", "sms"] as const) {
    const nombre = comptes[canal] ?? 0;
    if (nombre === 0) continue;

    // Un tarif absent vaut zéro, et non « inconnu » : le courriel et la
    // notification sont gratuits chez la plupart des passerelles, et obliger à
    // déclarer `0` pour eux ferait oublier de déclarer le SMS.
    const cout = nombre * (tarifs[canal] ?? 0);

    parCanal.push({ canal, nombre, cout });
    total += cout;
    messages += nombre;
  }

  return { devise, parCanal, total, messages };
}

// ─────────────────────────────────────────────── statistiques d'un abonné ──

/** Un versement compté, réduit à ce qu'il faut pour mesurer un retard. */
export interface VersementCompte {
  /** La référence, dont on tire le cycle visé. */
  reference: string;
  /** Quand Ndank l'a compté. */
  compteLe: Date;
}

export interface Statistiques {
  /** Combien de cycles ont été réglés. « Cycles payés : 6 », dans la maquette. */
  cyclesPayes: number;
  /**
   * De combien de jours l'abonné règle en retard, en moyenne.
   *
   * `null` quand aucun versement n'est lisible — mieux vaut ne rien afficher
   * qu'un zéro qui laisserait croire à quelqu'un de parfaitement ponctuel.
   */
  retardMoyenJours: number | null;
  /** Le premier versement compté, qui donne l'ancienneté réelle. */
  depuis: Date | null;
}

/**
 * Ce que les versements d'un abonné disent de lui.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE RETARD SE MESURE CONTRE L'ÉCHÉANCE VISÉE, PAS CONTRE LA PRÉCÉDENTE
 *
 * C'est la subtilité, et elle vient du modèle de cycle. L'échéance s'enchaîne
 * sur l'échéance et non sur le paiement — un abonné qui règle trois jours en
 * retard chaque mois garde la même date d'échéance, mois après mois.
 *
 * Son retard est donc constant, et non cumulatif. Le mesurer contre la date du
 * versement précédent ferait apparaître un retard de zéro, alors qu'il paie
 * systématiquement en retard depuis un an.
 *
 * La référence porte le cycle visé — `20260209-1-ab-1`. C'est contre cette
 * date-là qu'on compare, et c'est la seule qui ait un sens.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UN RETARD NÉGATIF EST UNE AVANCE, ET ON LA GARDE
 *
 * Quelqu'un qui règle trois jours avant l'échéance compte pour −3. Ramener ces
 * valeurs à zéro ferait apparaître en retard une population qui ne l'est pas —
 * et c'est justement la moyenne qui doit distinguer « paie toujours la veille »
 * de « paie toujours le surlendemain ».
 */
export function statistiques(
  versements: readonly VersementCompte[],
): Statistiques {
  if (versements.length === 0) {
    return { cyclesPayes: 0, retardMoyenJours: null, depuis: null };
  }

  const cycles = new Set<string>();
  const retards: number[] = [];
  let premier: Date | null = null;

  for (const v of versements) {
    if (premier === null || v.compteLe < premier) premier = v.compteLe;

    const echeance = echeanceDe(v.reference);
    if (echeance === null) continue;

    cycles.add(cleDeCycle(echeance));

    // En jours civils, comme partout : l'heure à laquelle un webhook arrive ne
    // doit pas décider qu'un abonné est ponctuel ou non.
    retards.push(
      Math.round((jourDe(v.compteLe) - jourDe(echeance)) / 86_400_000),
    );
  }

  return {
    // Le nombre de CYCLES distincts, et non de versements : payer en trois fois
    // ne fait pas trois cycles payés.
    cyclesPayes: cycles.size,
    retardMoyenJours:
      retards.length === 0
        ? null
        : Math.round(
            (retards.reduce((s, r) => s + r, 0) / retards.length) * 10,
          ) / 10,
    depuis: premier,
  };
}

/** L'échéance que vise une référence, ou `null` si on ne sait pas la lire. */
function echeanceDe(reference: string): Date | null {
  const trouve = /^(\d{4})(\d{2})(\d{2})-\d+-/.exec(reference);
  if (!trouve) return null;

  const [, a, m, j] = trouve as unknown as [string, string, string, string];

  return new Date(`${a}-${m}-${j}T00:00:00.000Z`);
}

/** Minuit UTC, en millisecondes. */
function jourDe(date: Date): number {
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
}
