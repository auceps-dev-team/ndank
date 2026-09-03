import {
  ajouterJours,
  cleDeCycle,
  cycleSuivant,
  joursEntre,
  type Cycle,
  type Reglages,
} from "./cycle";
import {
  canauxDuPalier,
  etatDe,
  gesteDuJour,
  PALIERS,
  PREAVIS_JOURS,
  type Geste,
} from "./etats";
import type {
  AbonnementLu,
  Canal,
  Coordonnees,
  Message,
  Ports,
} from "./ports";

/**
 * Ndank — le passage quotidien.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL N'UTILISE QUE LES PORTS
 *
 * Pas un import de Baobart, pas une requête, pas un `fetch`. C'est ce qui
 * permettra à ce fichier de sortir d'ici tel quel, sans rien emporter.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL PEUT ÊTRE REJOUÉ SANS DÉGÂT
 *
 * Un passage quotidien rate son tour. Panne, déploiement, machine éteinte — cela
 * arrive, et cela arrivera. Deux choses le rendent inoffensif :
 *
 *   — l'état est **déduit** des dates, jamais stocké. Un jour sauté ne laisse
 *     donc rien de faux derrière lui ;
 *   — les relances portent une **clé par cycle et par palier**. La même ne part
 *     jamais deux fois, même si le passage tourne dix fois dans la journée.
 *
 * Et quand plusieurs jours ont été ratés, on n'envoie qu'**une** relance : la
 * plus avancée. Rattraper en envoyant trois messages d'affilée ferait
 * désinstaller l'application.
 */

/** Un abonnement qu'une erreur a empêché de traiter, et ce qui l'a causée. */
export interface Incident {
  abonnementId: string;
  cause: unknown;
}

export interface Passage {
  /** Abonnements examinés. */
  vus: number;
  relances: number;
  suspendus: number;
  clos: number;
  /** Abonnés qu'on ne sait plus joindre. C'est un incident, pas une statistique. */
  injoignables: number;
  /**
   * Ceux qu'une erreur a fait sauter. Le passage continue sans eux.
   *
   * On garde la cause et pas seulement un compte : un module qui reproche
   * partout ailleurs les pannes muettes ne peut pas avaler les siennes.
   */
  echecs: Incident[];
  /**
   * Vrai si le lot était plein — il restait donc probablement du travail.
   *
   * Sans ce drapeau, une base plus grosse que `LOT` se vide silencieusement par
   * le mauvais bout, et personne ne sait qu'il fallait repasser.
   */
  lotPlein: boolean;
}

/** Un passage ne traite pas cent mille abonnements d'un coup. */
export const LOT = 500;

/**
 * Combien de lectures mener de front.
 *
 * Les lectures d'un passage sont indépendantes : les attendre une par une fait
 * passer le temps du lot en allers-retours. Les envois, eux, restent en série —
 * une passerelle SMS limitée en débit refuserait huit messages simultanés, et
 * ce refus deviendrait un échec compté, c'est-à-dire une relance qui ne part
 * pas. On accélère donc ce qui est sans risque, et rien d'autre.
 */
const LECTURES_EN_PARALLELE = 8;

/**
 * Jusqu'où regarder devant soi.
 *
 * Le préavis le plus lointain, plus une marge. Chercher au-delà ferait remonter
 * des abonnements dont il n'y a rien à faire, et le moteur les écarterait un par
 * un — du travail pour rien, à l'échelle de tout le fichier.
 *
 * Dérivé de `PREAVIS_JOURS` plutôt que recalculé depuis `PALIERS` : refaire le
 * calcul ici, c'était reprendre la recopie que `PREAVIS_JOURS` existe pour
 * supprimer — et les deux replis avaient déjà divergé.
 */
const FENETRE_JOURS = PREAVIS_JOURS + 2;

/**
 * Les faits à transmettre, pas la prose.
 *
 * Le montant arrive déjà formaté : l'hôte seul connaît sa devise et ses
 * conventions — cinq mille francs ne s'écrivent pas comme cinquante euros.
 */
function messagePour(input: {
  abonnement: AbonnementLu;
  palier: number;
  cle: string;
  lien: string;
  nom: string | null;
  montantLisible: string;
  maintenant: Date;
}): Message {
  return {
    cle: input.cle,
    destinataire: input.nom,
    offre: input.abonnement.libelle,
    montant: input.montantLisible,
    lien: input.lien,
    // `joursEntre` et non une division de millisecondes : cette dernière
    // comptait depuis l'instant du passage vers une borne à minuit, donc rendait
    // 7 à minuit et 6 à treize heures pour le même abonnement. Le nombre annoncé
    // à l'abonné dépendait de l'heure du cron.
    joursRestants: joursEntre(
      input.maintenant,
      input.abonnement.cycle.accesJusquA,
    ),
    dernier: input.palier === PALIERS.length - 1,
  };
}

/**
 * Essaie les canaux du palier, s'arrête au premier qui part.
 *
 * L'ordre du palier est délibéré : le gratuit d'abord, le SMS en dernier. Sur
 * mille abonnés mensuels, relancer par SMS trois jours avant coûterait mille
 * SMS par mois pour des gens qui auraient payé de toute façon.
 *
 * Les envois restent strictement en série, y compris d'un abonnement à l'autre :
 * une passerelle SMS limitée en débit refuserait une rafale, et ce refus-là
 * deviendrait une relance qui ne part pas.
 */
async function relancer(
  ports: Ports,
  ou: Coordonnees,
  palier: number,
  message: Message,
): Promise<Canal[]> {
  const partis: Canal[] = [];

  for (const canal of canauxDuPalier(palier)) {
    if (!ports.envoi.disponible(canal, ou)) continue;

    if (await ports.envoi.envoyer(canal, ou, message)) {
      partis.push(canal);
      break;
    }
  }

  return partis;
}

/** Ce que l'hôte fournit pour rédiger : où valider, et comment écrire un montant. */
export interface Redaction {
  /** Où l'abonné ira valider. Dépend de l'hôte, donc fournie. */
  lien: (abonnement: AbonnementLu) => string;
  /** Le montant écrit comme l'hôte l'écrit. Idem. */
  montant: (abonnement: AbonnementLu) => string;
}

/** Ce qu'un abonnement a donné à la lecture, avant qu'on agisse. */
type Prepare =
  | { ok: true; abonnement: AbonnementLu; geste: Geste; ou: Coordonnees | null }
  | { ok: false; abonnement: AbonnementLu; cause: unknown };

/**
 * Applique `travail` à chaque élément, au plus `largeur` à la fois.
 *
 * `travail` ne doit jamais lever : un rejet ici emporterait la grappe entière,
 * ce qui est précisément ce qu'on cherche à empêcher.
 */
async function parGrappes<T, R>(
  items: readonly T[],
  largeur: number,
  travail: (item: T) => Promise<R>,
): Promise<R[]> {
  const sorties = new Array<R>(items.length);
  let prochain = 0;

  const ouvrier = async (): Promise<void> => {
    while (prochain < items.length) {
      const i = prochain;
      prochain += 1;
      sorties[i] = await travail(items[i]!);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(largeur, items.length) }, ouvrier),
  );

  return sorties;
}

/**
 * Lit ce qu'il faut savoir d'un abonnement, sans rien décider d'irréversible.
 *
 * Les coordonnées ne sont lues que si l'on va relancer : sur un lot où presque
 * tout est tranquille, les lire pour tout le monde doublerait les requêtes pour
 * rien.
 */
async function preparer(
  ports: Ports,
  abonnement: AbonnementLu,
  maintenant: Date,
): Promise<Prepare> {
  try {
    const dejaEnvoyes = new Set(
      await ports.lecture.relancesEnvoyees(
        abonnement.id,
        cleDeCycle(abonnement.cycle.echeance),
      ),
    );

    const geste = gesteDuJour(
      { cycle: abonnement.cycle, resilieeLe: abonnement.resilieeLe },
      maintenant,
      dejaEnvoyes,
    );

    const ou =
      geste.faire === "RAPPELER"
        ? await ports.lecture.coordonnees(abonnement.abonneId)
        : null;

    return { ok: true, abonnement, geste, ou };
  } catch (cause) {
    return { ok: false, abonnement, cause };
  }
}

/** Exécute le geste décidé. Peut lever — l'appelant rattrape. */
async function agir(
  ports: Ports,
  redaction: Redaction,
  prete: Extract<Prepare, { ok: true }>,
  maintenant: Date,
  bilan: Passage,
): Promise<void> {
  const { abonnement, geste } = prete;

  if (geste.faire === "RIEN") return;

  if (geste.faire === "SUSPENDRE") {
    await ports.ecriture.suspendre(abonnement.id);
    bilan.suspendus += 1;
    return;
  }

  if (geste.faire === "CLORE") {
    await ports.ecriture.clore(abonnement.id);
    bilan.clos += 1;
    return;
  }

  const ou = prete.ou ?? (await ports.lecture.coordonnees(abonnement.abonneId));

  const partis = await relancer(
    ports,
    ou,
    geste.palier,
    messagePour({
      abonnement,
      palier: geste.palier,
      cle: geste.cle,
      lien: redaction.lien(abonnement),
      // Et non `?? abonnement.libelle` : ce repli-là faisait dire « Bonjour
      // Baobart Pro » à un abonné dont on ignorait le nom. On transmet
      // l'ignorance, la rédaction sait la dire.
      nom: ou.nom,
      montantLisible: redaction.montant(abonnement),
      maintenant,
    }),
  );

  if (partis.length === 0) {
    // On ne note PAS la relance : ne rien avoir envoyé ne doit pas empêcher
    // de réessayer demain. Sans cela, une panne d'un jour couperait l'accès
    // à quelqu'un qu'on n'a jamais prévenu.
    bilan.injoignables += 1;
    return;
  }

  await ports.ecriture.noterRelance(abonnement.id, geste.cle, partis);
  bilan.relances += 1;
}

/**
 * Fait un tour, et rend ce qu'il a fait.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UN ABONNEMENT QUI ÉCHOUE N'EMPORTE PAS LE LOT
 *
 * Chaque abonnement est rattrapé séparément, et l'incident est noté dans
 * `bilan.echecs` avec sa cause. Sans cela, une ligne corrompue ou une passerelle
 * en délai d'attente arrêtait le passage entier : ni relance ni suspension pour
 * tous ceux qui suivaient dans le lot. Et comme l'état se déduit des dates, ils
 * recevaient le lendemain le palier le plus avancé — donc, pour certains, un SMS
 * payant à la place du courriel gratuit de la veille.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LECTURES DE FRONT, ENVOIS EN SÉRIE
 *
 * Les lectures ne décident de rien : elles se mènent par grappes bornées. Les
 * envois et les écritures restent séquentiels, dans l'ordre du lot.
 */
export async function passer(
  ports: Ports,
  redaction: Redaction,
  maintenant: Date = new Date(),
): Promise<Passage> {
  const bilan: Passage = {
    vus: 0,
    relances: 0,
    suspendus: 0,
    clos: 0,
    injoignables: 0,
    echecs: [],
    lotPlein: false,
  };

  const candidats = await ports.lecture.aRelancer(
    ajouterJours(maintenant, FENETRE_JOURS),
    LOT,
  );

  bilan.lotPlein = candidats.length >= LOT;

  const preparees = await parGrappes(
    candidats,
    LECTURES_EN_PARALLELE,
    (abonnement) => preparer(ports, abonnement, maintenant),
  );

  for (const prete of preparees) {
    bilan.vus += 1;

    if (!prete.ok) {
      bilan.echecs.push({
        abonnementId: prete.abonnement.id,
        cause: prete.cause,
      });
      continue;
    }

    try {
      await agir(ports, redaction, prete, maintenant, bilan);
    } catch (cause) {
      bilan.echecs.push({ abonnementId: prete.abonnement.id, cause });
    }
  }

  return bilan;
}

/**
 * Enchaîne le cycle suivant, une fois le paiement confirmé.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NDANK N'ENCAISSE TOUJOURS PAS
 *
 * L'hôte constate le paiement — il a déjà son opérateur — puis appelle ceci
 * pour que le rythme reparte au bon endroit. C'est tout ce que le moteur a
 * besoin d'en savoir, et c'est ce qui donne enfin un appelant au port
 * `renouveler`, jusqu'ici déclaré et jamais utilisé.
 *
 * Le cycle s'enchaîne sur l'échéance et non sur la date de paiement, sauf quand
 * l'accès était déjà perdu : `cycleSuivant` porte la règle et son exception.
 *
 * Aucune notification ne part d'ici. Le moteur ne parle qu'au moment de
 * relancer ; l'hôte qui veut confirmer un paiement le fait chez lui.
 */
export async function finaliserRenouvellement(
  ports: Ports,
  abonnement: AbonnementLu,
  paiement: Date,
  reglages?: Reglages,
): Promise<Cycle> {
  const suivant = cycleSuivant(
    abonnement.cycle,
    paiement,
    abonnement.cadence,
    reglages,
  );

  await ports.ecriture.renouveler(abonnement.id, suivant);

  return suivant;
}

/**
 * Ce que voit un abonné qui ouvre son application.
 *
 * Séparé du passage : l'un décide d'agir, l'autre se contente de raconter. Les
 * mêler ferait envoyer un SMS chaque fois que quelqu'un consulte sa liste.
 */
export interface Apercu {
  id: string;
  libelle: string;
  montant: number;
  devise: string;
  etat: ReturnType<typeof etatDe>;
  echeance: Date;
  accesJusquA: Date;
  /** Jours restants avant que l'accès ne s'arrête. Négatif s'il est déjà coupé. */
  joursRestants: number;
  /** La clé du cycle en cours, pour rapprocher un paiement d'une échéance. */
  cycle: string;
}

export function apercuDe(
  abonnement: AbonnementLu,
  maintenant: Date = new Date(),
): Apercu {
  const etat = etatDe(
    { cycle: abonnement.cycle, resilieeLe: abonnement.resilieeLe },
    maintenant,
  );

  return {
    id: abonnement.id,
    libelle: abonnement.libelle,
    montant: abonnement.montant,
    devise: abonnement.devise,
    etat,
    echeance: abonnement.cycle.echeance,
    accesJusquA: abonnement.cycle.accesJusquA,
    // Même compte que dans une relance : le jour civil, et non une division
    // de millisecondes. L'écran et le message doivent dire le même nombre.
    joursRestants: joursEntre(maintenant, abonnement.cycle.accesJusquA),
    cycle: cleDeCycle(abonnement.cycle.echeance),
  };
}
