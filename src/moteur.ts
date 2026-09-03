import { ajouterJours, cleDeCycle, joursEntre } from "./cycle";
import {
  canauxDuPalier,
  etatDe,
  gesteDuJour,
  PALIERS,
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

export interface Passage {
  /** Abonnements examinés. */
  vus: number;
  relances: number;
  suspendus: number;
  clos: number;
  /** Abonnés qu'on ne sait plus joindre. C'est un incident, pas une statistique. */
  injoignables: number;
}

/** Un passage ne traite pas cent mille abonnements d'un coup. */
const LOT = 500;

/**
 * Jusqu'où regarder devant soi.
 *
 * Le préavis le plus lointain, plus une marge. Chercher au-delà ferait remonter
 * des abonnements dont il n'y a rien à faire, et le moteur les écarterait un par
 * un — du travail pour rien, à l'échelle de tout le fichier.
 */
const FENETRE_JOURS = Math.abs(PALIERS[0]?.jour ?? 3) + 2;

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
  nom: string;
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
 */
async function relancer(
  ports: Ports,
  ou: Coordonnees,
  palier: number,
  message: Message,
): Promise<string[]> {
  const partis: string[] = [];

  for (const canal of canauxDuPalier(palier)) {
    const c = canal as Canal;
    if (!ports.envoi.disponible(c, ou)) continue;

    if (await ports.envoi.envoyer(c, ou, message)) {
      partis.push(c);
      break;
    }
  }

  return partis;
}

/**
 * Fait un tour, et rend ce qu'il a fait.
 *
 * `lienDeValidation` construit l'adresse où l'abonné ira payer. Elle dépend de
 * l'hôte — Baobart n'a pas les mêmes URL qu'un autre projet — donc elle est
 * fournie, pas devinée.
 */
export async function passer(
  ports: Ports,
  reglages: {
    /** Où l'abonné ira valider. Dépend de l'hôte, donc fournie. */
    lien: (abonnement: AbonnementLu) => string;
    /** Le montant écrit comme l'hôte l'écrit. Idem. */
    montant: (abonnement: AbonnementLu) => string;
  },
  maintenant: Date = new Date(),
): Promise<Passage> {
  const bilan: Passage = {
    vus: 0,
    relances: 0,
    suspendus: 0,
    clos: 0,
    injoignables: 0,
  };

  const candidats = await ports.lecture.aRelancer(
    ajouterJours(maintenant, FENETRE_JOURS),
    LOT,
  );

  for (const abonnement of candidats) {
    bilan.vus += 1;

    const dejaEnvoyes = new Set(
      await ports.lecture.relancesEnvoyees(abonnement.id),
    );

    const geste = gesteDuJour(
      { cycle: abonnement.cycle, resilieeLe: abonnement.resilieeLe },
      maintenant,
      dejaEnvoyes,
    );

    if (geste.faire === "RIEN") continue;

    if (geste.faire === "SUSPENDRE") {
      await ports.ecriture.suspendre(abonnement.id);
      bilan.suspendus += 1;
      continue;
    }

    if (geste.faire === "CLORE") {
      await ports.ecriture.clore(abonnement.id);
      bilan.clos += 1;
      continue;
    }

    const ou = await ports.lecture.coordonnees(abonnement.abonneId);
    const partis = await relancer(
      ports,
      ou,
      geste.palier,
      messagePour({
        abonnement,
        palier: geste.palier,
        cle: geste.cle,
        lien: reglages.lien(abonnement),
        nom: ou.nom ?? abonnement.libelle,
        montantLisible: reglages.montant(abonnement),
        maintenant,
      }),
    );

    if (partis.length === 0) {
      // On ne note PAS la relance : ne rien avoir envoyé ne doit pas empêcher
      // de réessayer demain. Sans cela, une panne d'un jour couperait l'accès
      // à quelqu'un qu'on n'a jamais prévenu.
      bilan.injoignables += 1;
      continue;
    }

    await ports.ecriture.noterRelance(abonnement.id, geste.cle, partis);
    bilan.relances += 1;
  }

  return bilan;
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
