import { passer, type Passage, type Redaction } from "./moteur";
import type { Ports } from "./ports";

/**
 * Ndank — savoir que le moteur tourne encore.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LA PANNE LA PLUS DANGEREUSE NE PRODUIT AUCUNE ERREUR
 *
 * Tout le reste de ce dépôt s'occupe de ce qui peut mal se passer *pendant* un
 * passage : une passerelle en délai d'attente, une ligne corrompue, un
 * fournisseur qui répond de travers. Chacun est rattrapé, compté, journalisé.
 *
 * Mais la panne la plus coûteuse n'est pas là. C'est le passage quotidien qui
 * **ne tourne plus du tout**.
 *
 * Le cron meurt. Le conteneur ne redémarre pas. Un déploiement casse la
 * planification, ou change le fuseau. Alors il n'y a aucun échec à journaliser
 * — il y a du silence. Et le silence ressemble exactement à « tout va bien ».
 *
 * Pendant ce temps : plus une relance ne part, plus un accès n'est coupé, plus
 * un abonnement ne se clôt. Le tableau de bord continue d'afficher des chiffres
 * justes — l'état se déduit des dates, donc il ne ment pas — mais plus personne
 * n'agit dessus. On s'en aperçoit quand un abonné appelle pour dire qu'il n'a
 * jamais été prévenu, trois semaines plus tard.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * C'EST L'ABSENCE DE BATTEMENT QUI ALERTE, PAS LA PRÉSENCE D'ERREUR
 *
 * D'où le renversement : on enregistre **chaque passage, y compris ceux où tout
 * s'est bien passé**. Un journal d'incidents ne le fait jamais — il n'a rien à
 * dire d'un jour sans incident — et c'est précisément pour cela que cette panne
 * échappe partout.
 *
 * Le tableau de bord n'a plus qu'à lire une date : « dernier passage il y a
 * trois jours » se voit d'un coup d'œil, et ne demande à personne d'interpréter
 * une absence.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TROIS ÉTATS, ET NON DEUX
 *
 * On note le début **avant** de commencer, et la fin après. Un passage qui a
 * démarré et n'a jamais fini est donc distinguable d'un passage qui n'a jamais
 * démarré — et ce n'est pas la même panne :
 *
 *   — rien du tout : la planification est morte ;
 *   — commencé, jamais fini : le processus est bloqué, ou tué en cours. La base
 *     est peut-être à moitié écrite.
 *
 * Les confondre ferait chercher au mauvais endroit.
 */

/** La trace d'un passage, telle qu'on la conserve. */
export interface Trace {
  id: string;
  commenceLe: Date;
  /** `null` tant qu'il n'est pas fini — donc soit en cours, soit interrompu. */
  termineLe: Date | null;
  vus: number;
  relances: number;
  suspendus: number;
  clos: number;
  injoignables: number;
  /** Combien d'abonnements ont échoué. Le détail est dans le journal. */
  echecs: number;
  /** Vrai si le lot était plein : il restait probablement du travail. */
  lotPlein: boolean;
  /** Ce qui a fait tomber le passage entier, quand cela arrive. */
  erreur: string | null;
}

/** Ce que l'hôte doit savoir écrire pour que le battement existe. */
export interface Battements {
  /** Ouvre une trace, et rend son identifiant. Appelé AVANT le passage. */
  commencer(quand: Date): Promise<string>;

  /** Ferme la trace avec le bilan. */
  terminer(id: string, bilan: Passage, quand: Date): Promise<void>;

  /** Ferme la trace sur l'erreur qui a emporté le passage entier. */
  echouer(id: string, erreur: string, quand: Date): Promise<void>;

  /** La dernière trace connue, ou `null` si aucun passage n'a jamais tourné. */
  dernier(): Promise<Trace | null>;
}

/**
 * Lance un passage et en garde la trace.
 *
 * À appeler à la place de `passer()` — c'est le seul changement à faire dans un
 * cron existant.
 *
 * Le bilan est rendu tel quel, et l'erreur relancée telle quelle : ce
 * enveloppement ne change rien à ce que l'appelant voit, il ajoute seulement ce
 * que personne ne voyait.
 */
export async function passerEtTracer(
  ports: Ports,
  redaction: Redaction,
  battements: Battements,
  maintenant: Date = new Date(),
): Promise<Passage> {
  const id = await battements.commencer(maintenant);

  try {
    const bilan = await passer(ports, redaction, maintenant);
    await battements.terminer(id, bilan, new Date());
    return bilan;
  } catch (cause) {
    // On ferme la trace avant de relancer : sans cela, une panne du passage
    // laisserait une trace ouverte pour toujours, indiscernable d'un passage
    // encore en cours.
    try {
      await battements.echouer(id, String(cause).slice(0, 500), new Date());
    } catch {
      /* la trace ne doit pas masquer la vraie cause */
    }

    throw cause;
  }
}

// ──────────────────────────────────────────────────────────────── la santé ──

/**
 * Combien d'heures on tolère entre deux passages.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * VINGT-SIX, ET NON VINGT-QUATRE
 *
 * Un cron quotidien dérive. S'il tourne à 6 h 00 un jour et à 6 h 05 le
 * lendemain, l'écart est de vingt-quatre heures et cinq minutes — et un seuil à
 * vingt-quatre alerterait sur cette dérive normale, chaque semaine, jusqu'à ce
 * que plus personne ne regarde.
 *
 * Deux heures de marge absorbent la dérive, un changement d'heure, une machine
 * lente au démarrage. Elles ne cachent pas un jour manqué, qui donne
 * quarante-huit heures.
 */
export const RETARD_TOLERE_HEURES = 26;

/**
 * Au bout de combien d'heures un passage encore ouvert est réputé bloqué.
 *
 * Un passage sur cinq cents abonnements prend des secondes. Deux heures est
 * plusieurs ordres de grandeur au-dessus : si la trace est encore ouverte, le
 * processus est bloqué ou a été tué sans pouvoir la fermer.
 */
export const BLOQUE_APRES_HEURES = 2;

export interface ReglagesSante {
  retardTolereHeures?: number;
  bloqueApresHeures?: number;
}

/** Ce que le tableau de bord affiche en haut de page. */
export type Sante =
  /** Le moteur tourne. */
  | { va: "BIEN"; dernier: Date; heures: number }
  /** Aucun passage n'a jamais tourné. Le cron n'a peut-être jamais été posé. */
  | { va: "JAMAIS" }
  /** Le dernier passage est trop vieux. La planification est probablement morte. */
  | { va: "MUET"; dernier: Date; heures: number }
  /** Un passage a commencé et n'a jamais fini. */
  | { va: "BLOQUE"; depuis: Date; heures: number }
  /** Le dernier passage est tombé en entier. */
  | { va: "TOMBE"; dernier: Date; heures: number; erreur: string };

/**
 * Dit où en est le moteur, en une phrase que le tableau de bord peut afficher.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ICI ON COMPARE DES HEURES, ET C'EST LA SEULE EXCEPTION DU DÉPÔT
 *
 * Partout ailleurs, Ndank compare des **jours civils** : `joursEntre` ramène
 * ses bornes à minuit UTC, pour que l'heure du cron ne décide jamais d'une
 * coupure d'accès. C'est la règle qui empêche deux serveurs d'accorder deux
 * durées de grâce différentes.
 *
 * Elle ne s'applique pas ici, et l'inverser serait une faute. On ne mesure plus
 * un droit d'accès : on mesure **le cron lui-même**. Un passage qui remonte à
 * vingt-cinq heures va bien ; un qui remonte à cinquante ne va pas — et les
 * deux peuvent tomber sur « hier » en jours civils.
 */
export async function sante(
  battements: Battements,
  reglages: ReglagesSante = {},
  maintenant: Date = new Date(),
): Promise<Sante> {
  const trace = await battements.dernier();

  if (trace === null) return { va: "JAMAIS" };

  const heuresDepuis = (quand: Date): number =>
    (maintenant.getTime() - quand.getTime()) / 3_600_000;

  if (trace.termineLe === null) {
    const ouvert = heuresDepuis(trace.commenceLe);

    if (ouvert >= (reglages.bloqueApresHeures ?? BLOQUE_APRES_HEURES)) {
      return { va: "BLOQUE", depuis: trace.commenceLe, heures: arrondi(ouvert) };
    }

    // Ouvert depuis peu : c'est probablement le passage en cours, appelé par le
    // tableau de bord pendant qu'il tourne. Ce n'est pas une panne.
    return { va: "BIEN", dernier: trace.commenceLe, heures: arrondi(ouvert) };
  }

  const heures = heuresDepuis(trace.termineLe);

  if (trace.erreur !== null) {
    return {
      va: "TOMBE",
      dernier: trace.termineLe,
      heures: arrondi(heures),
      erreur: trace.erreur,
    };
  }

  if (heures >= (reglages.retardTolereHeures ?? RETARD_TOLERE_HEURES)) {
    return { va: "MUET", dernier: trace.termineLe, heures: arrondi(heures) };
  }

  return { va: "BIEN", dernier: trace.termineLe, heures: arrondi(heures) };
}

/** Une décimale suffit : personne ne décide sur des minutes. */
function arrondi(heures: number): number {
  return Math.round(heures * 10) / 10;
}

/**
 * La santé, dite à quelqu'un qui n'a pas écrit ce code.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UNE PHRASE, ET L'ACTION AVEC
 *
 * Un marchand qui lit des lignes de journal pour décider fait notre travail. Le
 * tableau de bord doit surtout lui dire qu'il n'y a **rien** à décider — et,
 * quand il y a quelque chose, le dire en une phrase avec le geste attaché.
 *
 * « BLOQUE » sans rien d'autre n'aide personne. « Un passage a démarré il y a
 * 4 h et n'a jamais fini » se comprend, et la suite se devine.
 */
export function direSante(etat: Sante): { titre: string; quoiFaire: string } {
  switch (etat.va) {
    case "BIEN":
      return {
        titre: `Dernier passage il y a ${etat.heures} h.`,
        quoiFaire: "Rien à faire.",
      };

    case "JAMAIS":
      return {
        titre: "Aucun passage n'a jamais tourné.",
        quoiFaire:
          "La tâche quotidienne n'est probablement pas planifiée. " +
          "Tant qu'elle ne tourne pas, aucune relance ne part et aucun accès " +
          "n'est coupé.",
      };

    case "MUET":
      return {
        titre: `Aucun passage depuis ${etat.heures} h.`,
        quoiFaire:
          "La tâche quotidienne ne tourne plus. Vérifiez la planification : " +
          "pendant ce temps, plus une relance ne part et plus un accès n'est " +
          "coupé.",
      };

    case "BLOQUE":
      return {
        titre: `Un passage a démarré il y a ${etat.heures} h et n'a jamais fini.`,
        quoiFaire:
          "Le processus est bloqué ou a été interrompu. Vérifiez qu'il n'en " +
          "tourne pas deux à la fois avant d'en relancer un.",
      };

    case "TOMBE":
      return {
        titre: `Le dernier passage est tombé, il y a ${etat.heures} h.`,
        quoiFaire: `Cause : ${etat.erreur}`,
      };
  }
}
