import { etatDe, type Abonnement, type Etat } from "./etats";
import { joursEntre } from "./cycle";

/**
 * Ndank — ce qu'un abonné a le droit de faire, à cet instant.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE MODULE NE SAIT PAS CE QU'EST UN DROIT
 *
 * « publier », « exporter », « inviter_un_membre » : ce sont des mots de
 * l'hôte, et Ndank ne les interprète jamais. Il ne fait qu'une chose — décider
 * **lesquels sont encore valables**, d'après l'état des abonnements.
 *
 * C'est délibéré. Une bibliothèque de facturation qui déciderait de ce qu'est un
 * droit imposerait son vocabulaire à des produits qu'elle ne connaît pas, et le
 * premier hôte dont le modèle ne rentre pas dans la case réécrirait tout.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TROIS NIVEAUX, ET NON UN BOOLÉEN
 *
 * `accesOuvert` répond déjà par oui ou non : l'abonné a-t-il droit au service ?
 * Ce module existe parce que cette question, seule, mène à une cruauté banale.
 *
 * Un abonné qui cesse de payer a écrit des choses. Des factures, des articles,
 * une comptabilité. Lui rendre son propre travail invisible le jour où son
 * paiement échoue, c'est le punir d'un incident de carte — et c'est le meilleur
 * moyen qu'il ne revienne jamais.
 *
 * D'où `LECTURE` : voir ce qui existe, n'en créer rien de plus. Ce n'est pas de
 * la générosité, c'est du calcul — quelqu'un qui peut encore consulter son
 * compte revient le régler ; quelqu'un qui trouve porte close s'en va.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT RESTE POURTANT `AUCUN`, ET IL FAUT DIRE POURQUOI
 *
 * Parce qu'un défaut plus généreux que `accesOuvert` ferait diverger deux
 * fonctions de la même bibliothèque sur la même question. Un hôte lirait
 * « accès coupé » d'un côté et « lecture autorisée » de l'autre, sans avoir rien
 * demandé.
 *
 * Passer en lecture tient en une ligne — `{ impaye: "LECTURE" }` — et ce
 * paragraphe existe pour qu'on la connaisse. Mais c'est un choix de produit, et
 * il revient à l'hôte de le poser.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * RIEN N'EST STOCKÉ
 *
 * Comme `etatDe`, tout se déduit des dates à l'instant de la question. Une
 * colonne `droits` en base serait fausse le lendemain matin, et personne ne le
 * verrait — c'est exactement le travers que `etatDe` refuse.
 */

// ────────────────────────────────────────────────────────────── le vocabulaire ──

/** Ce qu'un abonné peut faire d'un droit. */
export type Niveau =
  /** Tout : consulter, créer, modifier. */
  | "PLEIN"
  /** Consulter ce qui existe déjà. Rien de neuf. */
  | "LECTURE"
  /** Rien. */
  | "AUCUN";

/** Un abonnement, et l'offre dont il tient ses droits. */
export interface Porteur {
  /**
   * L'offre souscrite. Sert de clé dans `droits`.
   *
   * C'est l'identifiant de la grille — `Offre.id` — et non celui de
   * l'abonnement : deux abonnés au même palier ont les mêmes droits.
   */
  offreId: string;

  abonnement: Abonnement;

  /**
   * Le nom que l'abonné reconnaît. Sert au motif, et à rien d'autre.
   *
   * Sans lui, un écran dit « votre abonnement est à renouveler » à quelqu'un
   * qui en a trois.
   */
  libelle?: string;
}

/** Ce que l'hôte déclare, une fois. */
export interface ReglagesPermissions {
  /**
   * Ce que chaque offre donne, par identifiant d'offre.
   *
   * Une offre absente de cette table ne donne aucun droit — et c'est voulu.
   * Ajouter un palier à la grille sans lui donner de droits doit produire un
   * abonné qui ne peut rien, pas un abonné qui peut tout.
   */
  droits: Readonly<Record<string, readonly string[]>>;

  /**
   * Ce qui reste quand l'échéance est passée et la grâce épuisée.
   *
   * `AUCUN` par défaut, pour rester d'accord avec `accesOuvert`. **`LECTURE`
   * est probablement ce que vous voulez** — voir l'en-tête.
   */
  impaye?: Niveau;

  /**
   * Ce qui reste quand le marchand a suspendu à la main.
   *
   * `AUCUN`, et il n'y a pas de raison d'en changer. Une suspension se pose
   * pour un litige ou un abus : c'est un geste délibéré, et le vider de ses
   * effets le viderait de son sens.
   *
   * ══════════════════════════════════════════════════════════════════════════
   * POURQUOI CE RÉGLAGE EST SÉPARÉ DE `impaye`
   *
   * `etatDe` rend `SUSPENDUE` dans les deux cas — le marchand a suspendu, ou la
   * grâce est épuisée. Le mot est le même ; la situation ne l'est pas du tout.
   *
   * Le premier est une sanction. Le second est un retard de paiement, et
   * l'abonné réglera peut-être demain. Les traiter pareil, c'est infliger à
   * quelqu'un dont la carte a expiré ce qu'on réserve à quelqu'un qui a fraudé.
   */
  suspendu?: Niveau;

  /**
   * Ce qui reste quand la fenêtre de reprise est passée.
   *
   * `AUCUN`. À ce stade, se réabonner recommence à zéro — c'est ce que dit
   * `EXPIREE` — et laisser un accès ouvert sur un abonnement que plus rien ne
   * rattache à un paiement finirait par se voir dans les comptes.
   */
  expire?: Niveau;
}

/** Ce que le module répond. */
export interface Verdict {
  /** Le meilleur niveau obtenu, tous abonnements confondus. */
  niveau: Niveau;

  /** Ce qu'il peut faire pleinement. */
  droits: readonly string[];

  /**
   * Ce qu'il peut au moins consulter. **Sur-ensemble de `droits`.**
   *
   * Un droit plein est aussi un droit en lecture : demander « peut-il voir ? »
   * ne doit pas rendre `false` à quelqu'un qui peut écrire.
   */
  enLecture: readonly string[];

  /**
   * Pourquoi, dit à l'abonné. `null` quand tout va bien.
   *
   * ══════════════════════════════════════════════════════════════════════════
   * « ACCÈS REFUSÉ » N'EST PAS UNE RÉPONSE
   *
   * C'est la phrase qui fait écrire au support. L'abonné ne sait pas s'il a
   * oublié de payer, si sa carte a expiré, s'il s'est fait suspendre, ou si le
   * service est en panne — et il ne peut donc rien faire.
   *
   * Ce motif dit lequel des quatre, et depuis quand. C'est la même exigence que
   * `diagnostiquerAndroid` : un message qui ne mène à aucun geste n'est pas un
   * message, c'est un mur.
   */
  motif: string | null;

  /**
   * L'offre qui décide du niveau rendu. `null` quand aucun abonnement ne donne
   * rien. Sert à nommer la bonne offre dans un écran.
   */
  offreId: string | null;
}

// ──────────────────────────────────────────────────────────────── le calcul ──

const RANG: Readonly<Record<Niveau, number>> = {
  AUCUN: 0,
  LECTURE: 1,
  PLEIN: 2,
};

/**
 * Le niveau d'un abonnement, seul.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LA GRÂCE DONNE LE PLEIN ACCÈS, ET C'EST TOUTE SA RAISON D'ÊTRE
 *
 * `A_RENOUVELER` veut dire « l'échéance approche ou vient de passer, on
 * relance ». Diminuer les droits à ce moment-là viderait la grâce de son sens :
 * elle existe précisément pour que celui qui a passé le week-end hors réseau ne
 * perde rien pour deux jours de retard.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * RÉSILIER N'EST PAS CONFISQUER — ICI AUSSI
 *
 * `etatDe` rend `RESILIEE` dès le clic, mais l'accès payé court jusqu'à
 * `accesJusquA`. On ne regarde donc pas l'état seul : un résilié qui a payé
 * jusqu'au 30 garde ses droits pleins jusqu'au 30.
 *
 * C'est la règle que `accesOuvert` a dû apprendre en 0.12, et qu'aucun écran
 * n'avait révélée tant qu'il n'existait pas de bouton « Résilier ».
 */
export function niveauDe(
  porteur: Porteur,
  reglages: ReglagesPermissions,
  maintenant: Date,
): Niveau {
  const { abonnement } = porteur;

  // La suspension du marchand d'abord : elle l'emporte sur les dates, et elle
  // a son propre réglage parce qu'elle n'a rien à voir avec un impayé.
  if (abonnement.suspenduLe != null) return reglages.suspendu ?? "AUCUN";

  const etat = etatDe(abonnement, maintenant);

  if (etat === "RESILIEE") {
    // Ce qui a été payé reste dû, jusqu'à la fin de l'accès et pas au-delà.
    return joursEntre(abonnement.cycle.accesJusquA, maintenant) <= 0
      ? "PLEIN"
      : (reglages.expire ?? "AUCUN");
  }

  if (etat === "ACTIVE" || etat === "A_RENOUVELER") return "PLEIN";
  if (etat === "EXPIREE") return reglages.expire ?? "AUCUN";

  // Reste `SUSPENDUE` par épuisement de la grâce — un impayé, pas une sanction.
  return reglages.impaye ?? "AUCUN";
}

/**
 * Ce que l'abonné peut, tous ses abonnements réunis.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ON ADDITIONNE LES DROITS, ON NE CHOISIT PAS UN ABONNEMENT
 *
 * Quelqu'un peut être abonné à deux offres chez le même hôte — un socle et une
 * option — ou tenir un abonnement à jour et un autre en retard. Ne garder que
 * le « meilleur » lui retirerait ce que l'autre lui donne.
 *
 * Un même droit accordé en plein par un abonnement et en lecture par un autre
 * reste plein : on retient le mieux-disant, droit par droit.
 */
export function permissionsDe(
  porteurs: readonly Porteur[],
  reglages: ReglagesPermissions,
  maintenant: Date = new Date(),
): Verdict {
  const pleins = new Set<string>();
  const lecture = new Set<string>();

  let meilleur: Niveau = "AUCUN";
  let offreId: string | null = null;
  let recale: { porteur: Porteur; etat: Etat } | null = null;

  for (const porteur of porteurs) {
    const niveau = niveauDe(porteur, reglages, maintenant);
    const droits = reglages.droits[porteur.offreId] ?? [];

    if (niveau === "PLEIN") for (const d of droits) pleins.add(d);
    if (niveau === "LECTURE") for (const d of droits) lecture.add(d);

    if (RANG[niveau] > RANG[meilleur]) {
      meilleur = niveau;
      offreId = porteur.offreId;
    }

    // On retient le premier abonnement qui n'accorde pas tout : c'est de lui
    // que l'écran devra parler.
    if (niveau !== "PLEIN" && recale === null) {
      recale = { porteur, etat: etatDe(porteur.abonnement, maintenant) };
    }
  }

  // Un droit plein est aussi un droit en lecture. Sans cette union, un écran
  // qui demande « peut-il voir ? » répondrait non à quelqu'un qui peut écrire.
  for (const d of pleins) lecture.add(d);

  return {
    niveau: meilleur,
    droits: [...pleins].sort(),
    enLecture: [...lecture].sort(),
    motif:
      meilleur === "PLEIN" && recale === null
        ? null
        : motifDe(recale, porteurs.length, maintenant),
    offreId,
  };
}

/** Peut-il faire cela ? */
export function peut(verdict: Verdict, droit: string): boolean {
  return verdict.droits.includes(droit);
}

/**
 * Peut-il au moins le consulter ?
 *
 * Répond `true` aussi quand le droit est plein — voir `Verdict.enLecture`.
 */
export function peutVoir(verdict: Verdict, droit: string): boolean {
  return verdict.enLecture.includes(droit);
}

// ─────────────────────────────────────────────────────────────── le motif ──

/**
 * Pourquoi l'accès est ce qu'il est, dit à quelqu'un qui n'a pas lu le code.
 *
 * Chaque phrase porte un geste ou une date. « Votre abonnement a expiré » ne
 * dit pas quoi faire ; « votre Pass Créateur est à renouveler depuis trois
 * jours » le dit.
 */
function motifDe(
  recale: { porteur: Porteur; etat: Etat } | null,
  combien: number,
  maintenant: Date,
): string {
  if (recale === null) {
    return combien === 0
      ? "Vous n'avez aucun abonnement en cours."
      : "Votre abonnement ne donne pas accès à cette partie du service.";
  }

  const { porteur, etat } = recale;
  const quoi = porteur.libelle ?? "Votre abonnement";
  const depuis = (date: Date): string => {
    const jours = joursEntre(date, maintenant);
    if (jours <= 0) return "aujourd'hui";
    if (jours === 1) return "depuis hier";
    return `depuis ${jours} jours`;
  };

  if (porteur.abonnement.suspenduLe != null) {
    return `${quoi} est suspendu ${depuis(porteur.abonnement.suspenduLe)}. Contactez le service client — une suspension se lève à la main.`;
  }

  if (etat === "EXPIREE") {
    return `${quoi} a expiré ${depuis(porteur.abonnement.cycle.repriseJusquA)}. Il faut souscrire à nouveau : la reprise n'est plus possible.`;
  }

  if (etat === "RESILIEE") {
    return `${quoi} est résilié, et l'accès payé s'est terminé ${depuis(porteur.abonnement.cycle.accesJusquA)}.`;
  }

  // `SUSPENDUE` par épuisement de la grâce : celui-là se règle en payant, et
  // c'est la seule phrase de cette fonction qui appelle un paiement.
  return `${quoi} est à renouveler ${depuis(porteur.abonnement.cycle.echeance)}. Le paiement rouvre l'accès immédiatement.`;
}
