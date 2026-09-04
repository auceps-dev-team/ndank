import { cleDeCycle, jour, joursEntre, type Cycle, type Reglages } from "./cycle";
import type { Creances } from "./encaissement/reconciliation";
import { reconcilier } from "./encaissement/reconciliation";
import type { Issue } from "./encaissement/port";
import type { DossierAbonnement } from "./dossier";
import { canauxDuPalier, PALIERS } from "./etats";
import type { AbonnementLu, Canal, Ecriture, Envoi, Lecture } from "./ports";
import type { Politique } from "./reglement";

/**
 * Ndank — les gestes qu'une personne pose à la main.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI ILS N'ÉTAIENT PAS LÀ, ET POURQUOI ILS Y SONT MAINTENANT
 *
 * Tout le reste de Ndank est mû par des dates : le passage quotidien lit
 * l'échéance, en déduit un geste, l'exécute. Personne n'y décide rien.
 *
 * Mais un marchand a des cas que les dates ne prévoient pas. Un abonné qui
 * paie en espèces au comptoir. Un litige qu'on veut suspendre le temps de
 * comprendre. Quelqu'un au téléphone qui n'a pas reçu sa relance et qu'on
 * veut relancer tout de suite. Sans ces verbes, il ouvre sa base et écrit
 * dedans — ce qui est exactement ce qu'on cherche à éviter.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TROIS GARDE-FOUS, UN PAR RISQUE
 *
 * L'API du tableau de bord a été conçue en lecture seule pour deux raisons
 * nommées : **les erreurs de saisie** et **les risques de corruption**. Ces
 * verbes les rouvrent, donc ils doivent répondre aux deux — pas s'en remettre
 * à la prudence de celui qui clique.
 *
 *   — **rien ne s'écrit sans auteur.** Chaque geste porte le nom de qui l'a
 *     posé, et va au journal. Une base qu'on peut modifier sans laisser de
 *     trace est une base dont on ne peut plus rien reconstituer ;
 *
 *   — **un paiement manuel exige une pièce.** Pas un montant tapé dans le
 *     vide : un numéro de reçu, de virement, de bordereau. C'est ce qui rend
 *     l'écriture vérifiable après coup, et c'est aussi ce qui la rend
 *     idempotente — enregistrer deux fois le même reçu ne fait rien ;
 *
 *   — **une relance manuelle est bornée à une par jour.** Un bouton se clique
 *     cinq fois quand rien ne semble se passer, et cinq SMS partent. Ils sont
 *     facturés, et l'abonné les reçoit.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ILS NE LÈVENT PAS SUR UN REFUS
 *
 * Un geste refusé n'est pas une panne : c'est un cas normal. « Cet abonnement
 * est déjà suspendu », « ce reçu a déjà été enregistré », « une relance
 * manuelle est déjà partie aujourd'hui ». Chacun rend une `Suite` qui le dit,
 * pour que l'écran l'affiche plutôt que de montrer une erreur.
 *
 * Ce qui lève, c'est ce qui ne devrait pas arriver : une base injoignable, un
 * abonnement introuvable.
 */

/** Ce qu'un geste a produit. */
export type Suite =
  /** Le geste a été posé. */
  | { faire: "FAIT"; detail?: string }
  /** Rien à faire — et ce n'est pas une erreur. */
  | { faire: "RIEN"; motif: string }
  /** Le geste ne s'applique pas ici. */
  | { faire: "REFUSE"; motif: string };

/** Ce que Ndank consigne de chaque geste manuel. */
export interface FaitIntervention {
  abonnementId: string;
  /** `suspendre`, `retablir`, `resilier`, `paiement-manuel`, `relance-manuelle`. */
  geste: string;
  /** Qui l'a posé. Obligatoire — voir l'en-tête. */
  auteur: string;
  quand: Date;
  /** Ce qu'il faut pour comprendre après coup : montant, pièce, motif. */
  detail?: Readonly<Record<string, string | number | null>>;
}

/**
 * Ce que l'hôte doit savoir écrire pour que les gestes manuels existent.
 *
 * Séparé d'`Ecriture` à dessein : le passage quotidien n'a rien à faire de ces
 * méthodes, et un hôte du niveau 1 qui ne veut pas de tableau de bord n'a
 * aucune raison de les implémenter.
 */
export interface Interventions {
  /** Pose la suspension manuelle, ou la lève avec `null`. */
  suspendre(abonnementId: string, quand: Date | null): Promise<void>;

  /** Pose la résiliation. Elle ne se lève pas : on se réabonne. */
  resilier(abonnementId: string, quand: Date): Promise<void>;

  /**
   * Enregistre un versement constaté hors ligne.
   *
   * `identifiant` est déterministe — `manuel:<pièce>` — donc réenregistrer la
   * même pièce ne crée pas un second versement.
   */
  versementManuel(versement: {
    abonnementId: string;
    identifiant: string;
    reference: string;
    montant: number;
    devise: string;
    recuLe: Date;
    moyen: string;
    auteur: string;
  }): Promise<void>;

  /** Consigne le geste. Appelé pour chacun, y compris les refus utiles. */
  journaliser(fait: FaitIntervention): Promise<void>;

  /**
   * Exécute `travail` avec des écritures liées à une seule unité de travail.
   *
   * ════════════════════════════════════════════════════════════════════════
   * POURQUOI CETTE MÉTHODE EXISTE
   *
   * Enregistrer un paiement au comptoir demande deux écritures : le reçu, puis
   * l'échéance. Entre les deux, le processus peut tomber.
   *
   * La première version les enchaînait, en pariant qu'un rejeu réparerait. Le
   * pari était faux : écrire le reçu pose `compteLe`, donc au rejeu
   * `dejaCompte` répond « déjà compté », `reconcilier` rend « rien à faire », et
   * **l'échéance ne bouge jamais**. L'abonné a payé, l'argent est enregistré, et
   * son abonnement reste en retard — sans qu'aucune tentative ne puisse le
   * corriger.
   *
   * `reconciliation.ts` avait pourtant posé la règle dès la 0.3.0 : « faire
   * avancer une échéance et noter le versement qui l'a payée doivent tomber ou
   * réussir **ensemble** ». `marquerPaye` faisait exactement ce que ce
   * paragraphe interdit.
   *
   * ════════════════════════════════════════════════════════════════════════
   * ELLE REND LES ÉCRITURES, ELLE NE SE CONTENTE PAS D'ENVELOPPER
   *
   * C'est le piège de la transaction interactive, et il est facile à manquer.
   * Écrire ceci ne transactionne **rien** :
   *
   *     ensemble: (travail) => client.$transaction(() => travail())
   *
   * Prisma ouvre bien une transaction, mais les écritures de `travail` passent
   * par le client extérieur — pas par le `tx` qu'il vient de fournir. Elles
   * sont donc hors de la transaction, et l'on croit tenir une garantie qu'on
   * n'a pas. Ce serait pire que de ne rien avoir : on aurait cessé de se
   * méfier.
   *
   * D'où la forme : `travail` **reçoit** les écritures, et l'implémentation les
   * construit contre le client transactionnel.
   *
   *     ensemble: (travail) =>
   *       client.$transaction((tx) => travail(ecrituresDe(tx)))
   *
   * ════════════════════════════════════════════════════════════════════════
   * FACULTATIVE, ET CE QUE CELA COÛTE
   *
   * Un hôte du niveau 1 qui n'a pas de transaction n'est pas exclu : sans
   * elle, les deux écritures se suivent, exactement comme avant. Ce qui change,
   * c'est qu'il le sait — et qu'il peut exiger le contraire avec
   * `PortsIntervention.exigerEnsemble`.
   */
  ensemble?<T>(travail: (ecritures: EcrituresPaiement) => Promise<T>): Promise<T>;
}

/**
 * Les deux écritures d'un paiement, qui doivent tomber ou réussir ensemble.
 *
 * Rien de plus : ce sont exactement celles que `marquerPaye` pose. Y ajouter le
 * journal serait une erreur — consigner un geste ne doit jamais empêcher de le
 * poser, et une transaction qui échouerait sur le journal annulerait le
 * paiement.
 */
export interface EcrituresPaiement {
  versementManuel(versement: {
    abonnementId: string;
    identifiant: string;
    reference: string;
    montant: number;
    devise: string;
    recuLe: Date;
    moyen: string;
    auteur: string;
  }): Promise<void>;

  renouveler(abonnementId: string, cycle: Cycle): Promise<void>;
}

/** Ce qu'il faut brancher pour poser des gestes. */
export interface PortsIntervention {
  dossier: DossierAbonnement;
  interventions: Interventions;
  /** Pour la relance manuelle seulement. */
  lecture?: Lecture;
  ecriture?: Ecriture;
  envoi?: Envoi;
  /** Pour le paiement manuel seulement. */
  creances?: Creances;

  /**
   * Refuser un paiement manuel plutôt que de l'écrire hors transaction.
   *
   * `false` par défaut, pour ne pas exclure un hôte qui n'a pas de transaction
   * à offrir. Le mettre à `true` échange une commodité contre une garantie :
   * plus aucun paiement manuel ne peut laisser un reçu enregistré et une
   * échéance en retard.
   *
   * C'est un réglage et non une supposition — l'hôte choisit ce qu'il préfère
   * risquer, en le sachant.
   */
  exigerEnsemble?: boolean;
}

// ─────────────────────────────────────────────────────────────── suspendre ──

/**
 * Suspend l'accès, à la main.
 *
 * Coupe **sur-le-champ** : c'est ce qui distingue le geste de la résiliation.
 * On suspend pour un litige ou un abus, et attendre la fin du cycle le viderait
 * de son sens.
 *
 * L'échéance, elle, ne bouge pas. Une suspension n'est pas une remise : le
 * temps continue de courir, et l'abonné qui règle son différend retrouve son
 * cycle là où il l'avait laissé.
 */
export async function suspendre(
  ports: PortsIntervention,
  abonnementId: string,
  par: { auteur: string; motif?: string },
  maintenant: Date = new Date(),
): Promise<Suite> {
  const abonnement = await exiger(ports, abonnementId);

  if (abonnement.resilieeLe !== null) {
    return { faire: "REFUSE", motif: "Cet abonnement est résilié." };
  }

  if (abonnement.suspenduLe != null) {
    return { faire: "RIEN", motif: "Déjà suspendu." };
  }

  await ports.interventions.suspendre(abonnementId, maintenant);

  await consigner(ports, {
    abonnementId,
    geste: "suspendre",
    auteur: par.auteur,
    quand: maintenant,
    detail: { motif: par.motif ?? null },
  });

  return { faire: "FAIT" };
}

/**
 * Lève la suspension.
 *
 * L'accès reprend là où les dates le disent — pas au jour du rétablissement.
 * Si l'échéance est passée pendant la suspension, l'abonné se retrouve à
 * relancer, ce qui est juste : la suspension n'a jamais été une remise.
 */
export async function retablir(
  ports: PortsIntervention,
  abonnementId: string,
  par: { auteur: string },
  maintenant: Date = new Date(),
): Promise<Suite> {
  const abonnement = await exiger(ports, abonnementId);

  if (abonnement.suspenduLe == null) {
    return { faire: "RIEN", motif: "Cet abonnement n'est pas suspendu." };
  }

  await ports.interventions.suspendre(abonnementId, null);

  await consigner(ports, {
    abonnementId,
    geste: "retablir",
    auteur: par.auteur,
    quand: maintenant,
  });

  return { faire: "FAIT" };
}

// ──────────────────────────────────────────────────────────────── resilier ──

/**
 * Résilie.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ELLE NE COUPE PAS L'ACCÈS, ET C'EST LE POINT
 *
 * Elle arrête les relances et le renouvellement. Le temps déjà payé reste dû
 * jusqu'à `accesJusquA` — voir `accesOuvert`, qui porte la règle.
 *
 * Un abonné qui résilie le 3 a payé jusqu'au 30 : lui couper le service à
 * l'instant du clic, ce serait garder son argent et lui retirer ce qu'il a
 * acheté.
 *
 * Le geste ne se lève pas. Reprendre après une résiliation, c'est souscrire de
 * nouveau — et c'est voulu : `Souscriptions.enCours` ne verra plus
 * d'abonnement en cours, donc `souscrire` en ouvrira un vrai.
 */
export async function resilier(
  ports: PortsIntervention,
  abonnementId: string,
  par: { auteur: string; motif?: string },
  maintenant: Date = new Date(),
): Promise<Suite & { accesJusquA?: Date }> {
  const abonnement = await exiger(ports, abonnementId);

  if (abonnement.resilieeLe !== null) {
    return { faire: "RIEN", motif: "Déjà résilié." };
  }

  await ports.interventions.resilier(abonnementId, maintenant);

  await consigner(ports, {
    abonnementId,
    geste: "resilier",
    auteur: par.auteur,
    quand: maintenant,
    detail: {
      motif: par.motif ?? null,
      accesJusquA: abonnement.cycle.accesJusquA.toISOString(),
    },
  });

  // Rendu pour que l'écran puisse le dire : « votre accès tient jusqu'au… ».
  // Le taire ferait croire à une coupure immédiate, ce qui est précisément le
  // malentendu que cette version corrige.
  return { faire: "FAIT", accesJusquA: abonnement.cycle.accesJusquA };
}

// ────────────────────────────────────────────────────────── paiement manuel ──

export interface PaiementManuel {
  /** En unités mineures ISO, comme partout. */
  montant: number;
  /**
   * La pièce justificative : numéro de reçu, de virement, de bordereau.
   *
   * ─────────────────────────────────────────────────────────────────────
   * OBLIGATOIRE, ET C'EST LE GARDE-FOU DE CE VERBE
   *
   * « Marquer payé » enregistre de l'argent que Ndank n'a jamais vu passer.
   * C'est le geste le plus lourd du tableau de bord, et le seul qui puisse
   * faire apparaître un mois d'abonnement sans qu'un franc ait bougé.
   *
   * Exiger une pièce fait deux choses. Elle rend l'écriture vérifiable après
   * coup — on peut aller regarder le reçu. Et elle rend le geste
   * **idempotent** : la même pièce enregistrée deux fois ne compte qu'une,
   * parce que l'identifiant du versement en dérive.
   */
  piece: string;
  recuLe: Date;
  /** « espèces », « virement », « wave-direct »… Libre, mais consigné. */
  moyen: string;
  auteur: string;
}

/**
 * Enregistre un paiement constaté hors ligne, et avance le cycle en conséquence.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL PASSE PAR LE MÊME CHEMIN QU'UN VRAI PAIEMENT
 *
 * On fabrique une `Issue` et on la donne à `reconcilier`. C'est délibéré : un
 * paiement manuel doit obéir aux mêmes règles qu'un paiement d'opérateur — la
 * politique de crédit ou de prorata, le cumul des versements partiels, la
 * vérification de la devise.
 *
 * Écrire un chemin séparé aurait produit deux arithmétiques pour un seul fait,
 * et c'est toujours la seconde qui se trompe.
 */
export async function marquerPaye(
  ports: PortsIntervention,
  abonnementId: string,
  paiement: PaiementManuel,
  politique: Politique = "CREDIT",
  reglages?: Reglages,
): Promise<Suite & { jours?: number }> {
  const abonnement = await exiger(ports, abonnementId);

  if (!ports.creances || !ports.ecriture) {
    return {
      faire: "REFUSE",
      motif:
        "Cet hôte n'a pas branché `creances` et `ecriture` : " +
        "un paiement manuel ne peut pas être compté.",
    };
  }

  if (!Number.isInteger(paiement.montant) || paiement.montant <= 0) {
    return { faire: "REFUSE", motif: "Le montant doit être un entier positif." };
  }

  if (paiement.piece.trim() === "") {
    return {
      faire: "REFUSE",
      motif: "Une pièce justificative est obligatoire — reçu, virement, bordereau.",
    };
  }

  const identifiant = `manuel:${paiement.piece.trim()}`;

  const etat = await ports.creances.etat(abonnementId);

  const issue: Issue = {
    // La référence porte le cycle courant : `reconcilier` refuse un versement
    // qui viserait un autre cycle, et cette vérification-là doit valoir aussi
    // pour les paiements manuels.
    reference: referenceManuelle(abonnement, etat.versements),
    etat: "REUSSI",
    montant: paiement.montant,
    devise: abonnement.devise,
    identifiantFournisseur: identifiant,
    regleLe: paiement.recuLe,
    brut: {
      manuel: true,
      piece: paiement.piece,
      moyen: paiement.moyen,
      auteur: paiement.auteur,
    },
  };

  const decision = await reconcilier(
    ports.creances,
    abonnement,
    issue,
    politique,
    reglages,
  );

  if (decision.faire === "RIEN") {
    // Le cas le plus fréquent : la pièce a déjà été enregistrée. Ce n'est pas
    // une erreur, c'est quelqu'un qui a cliqué deux fois.
    return { faire: "RIEN", motif: decision.motif };
  }

  if (decision.faire === "INCIDENT") {
    return { faire: "REFUSE", motif: decision.motif };
  }

  /**
   * Les deux écritures, ensemble ou pas du tout.
   *
   * ─────────────────────────────────────────────────────────────────────
   * L'ORDRE NE SUFFISAIT PAS, ET C'ÉTAIT L'ERREUR
   *
   * La première version écrivait le reçu puis le cycle, en pariant qu'un rejeu
   * réparerait une panne au milieu. Le pari était faux : le reçu porte
   * `compteLe`, donc au rejeu `dejaCompte` répond « déjà compté » et l'échéance
   * ne bouge **jamais**. Aucun ordre ne rattrape cela — il fallait une
   * transaction, ce que `reconciliation.ts` disait depuis la 0.3.0.
   */
  const ensemble = ports.interventions.ensemble;

  if (!ensemble && ports.exigerEnsemble === true) {
    return {
      faire: "REFUSE",
      motif:
        "Cet hôte exige une transaction et n'en fournit pas : " +
        "implémentez `Interventions.ensemble`, ou retirez `exigerEnsemble`.",
    };
  }

  const poser = async (ecritures: EcrituresPaiement): Promise<void> => {
    await ecritures.versementManuel({
      abonnementId,
      identifiant,
      reference: issue.reference,
      montant: paiement.montant,
      devise: abonnement.devise,
      recuLe: paiement.recuLe,
      moyen: paiement.moyen,
      auteur: paiement.auteur,
    });

    if (decision.faire === "RENOUVELER") {
      await ecritures.renouveler(abonnementId, decision.cycle);
    }
  };

  if (ensemble) {
    await ensemble(poser);
  } else {
    // Sans transaction : les deux écritures se suivent, et l'ordre garde son
    // sens relatif — mieux vaut un reçu sans cycle qu'un cycle sans reçu, qui
    // offrirait un mois. Mais ce n'est plus présenté comme une garantie.
    await poser({
      versementManuel: (v) => ports.interventions.versementManuel(v),
      renouveler: (id, cycle) => ports.ecriture!.renouveler(id, cycle),
    });
  }

  await consigner(ports, {
    abonnementId,
    geste: "paiement-manuel",
    auteur: paiement.auteur,
    quand: paiement.recuLe,
    detail: {
      montant: paiement.montant,
      devise: abonnement.devise,
      piece: paiement.piece,
      moyen: paiement.moyen,
      suite: decision.faire,
    },
  });

  return decision.faire === "RENOUVELER"
    ? { faire: "FAIT", jours: decision.jours }
    : { faire: "FAIT", detail: `Il reste ${decision.manque} à verser.` };
}

/**
 * La référence d'un versement manuel.
 *
 * Même forme que celle d'un versement d'opérateur — `20260209-1-ab-1` — parce
 * que `reconcilier` la relit pour vérifier le cycle et l'abonnement. Une forme
 * à part la ferait passer pour une référence étrangère, donc pour un incident.
 */
function referenceManuelle(abonnement: AbonnementLu, versements: number): string {
  const compact = cleDeCycle(abonnement.cycle.echeance).replace(/-/g, "");
  const sur = /^[A-Za-z0-9-]+$/.test(abonnement.id)
    ? abonnement.id
    : Buffer.from(abonnement.id, "utf8").toString("hex");

  return `${compact}-${versements + 1}-${sur}`;
}

// ───────────────────────────────────────────────────────── relance manuelle ──

/**
 * Envoie une relance tout de suite.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UNE PAR JOUR, ET LA BORNE N'EST PAS DE LA PRUDENCE
 *
 * Un bouton se clique cinq fois quand rien ne semble se passer — c'est le
 * comportement normal de quelqu'un devant un écran qui ne réagit pas. Cinq SMS
 * partent alors, ils sont facturés, et l'abonné les reçoit tous.
 *
 * La clé de la relance manuelle porte donc le jour civil :
 * `2026-02-09:manuel:2026-02-11`. Elle passe par `noterRelance` et
 * `relancesEnvoyees` comme les autres, donc la borne est portée par la même
 * contrainte d'unicité que le reste — pas par un compteur qu'on aurait pu
 * oublier de remettre à zéro.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE PALIER SUIT L'ÉCHÉANCE, PAS LE CLIC
 *
 * On envoie le message du palier qui s'applique vraiment. Relancer trois
 * semaines avant l'échéance passe donc par le courriel et la notification, qui
 * ne coûtent rien ; relancer après l'échéance sort le SMS, qui coûte.
 *
 * Laisser choisir le canal aurait fait cliquer « SMS » par défaut — c'est
 * celui dont on est sûr qu'il arrive — et rendu chaque relance payante.
 */
export async function relancerMaintenant(
  ports: PortsIntervention,
  abonnementId: string,
  redaction: {
    lien: (a: AbonnementLu) => string;
    montant: (a: AbonnementLu) => string;
  },
  par: { auteur: string },
  maintenant: Date = new Date(),
): Promise<Suite & { canaux?: Canal[] }> {
  const abonnement = await exiger(ports, abonnementId);

  if (!ports.lecture || !ports.ecriture || !ports.envoi) {
    return {
      faire: "REFUSE",
      motif:
        "Cet hôte n'a pas branché `lecture`, `ecriture` et `envoi` : " +
        "aucune relance ne peut partir.",
    };
  }

  if (abonnement.resilieeLe !== null) {
    // Un abonné qui a dit non ne doit plus jamais recevoir de rappel. La règle
    // vaut pour le passage quotidien ; elle vaut aussi pour un bouton.
    return { faire: "REFUSE", motif: "Cet abonnement est résilié." };
  }

  const cycle = cleDeCycle(abonnement.cycle.echeance);
  const cle = `${cycle}:manuel:${jour(maintenant).toISOString().slice(0, 10)}`;

  const deja = await ports.lecture.relancesEnvoyees(abonnementId, cycle);
  if (deja.includes(cle)) {
    return {
      faire: "RIEN",
      motif: "Une relance manuelle est déjà partie aujourd'hui.",
    };
  }

  const ou = await ports.lecture.coordonnees(abonnement.abonneId);
  const palier = palierApplicable(abonnement, maintenant);

  const message = {
    cle,
    destinataire: ou.nom,
    offre: abonnement.libelle,
    montant: redaction.montant(abonnement),
    lien: redaction.lien(abonnement),
    joursRestants: joursEntre(maintenant, abonnement.cycle.accesJusquA),
    dernier: palier === PALIERS.length - 1,
  };

  const partis: Canal[] = [];

  for (const canal of canauxDuPalier(palier)) {
    if (!ports.envoi.disponible(canal, ou)) continue;
    if (await ports.envoi.envoyer(canal, ou, message)) {
      partis.push(canal);
      break;
    }
  }

  if (partis.length === 0) {
    // On ne note pas : rien n'étant parti, réessayer demain doit rester
    // possible. Même règle que le passage quotidien.
    return { faire: "RIEN", motif: "Aucun canal disponible pour cet abonné." };
  }

  await ports.ecriture.noterRelance(abonnementId, cle, partis);

  await consigner(ports, {
    abonnementId,
    geste: "relance-manuelle",
    auteur: par.auteur,
    quand: maintenant,
    detail: { palier, canaux: partis.join(", ") },
  });

  return { faire: "FAIT", canaux: partis };
}

/** Le palier qui s'applique à cette date, ou le premier si l'échéance est loin. */
function palierApplicable(abonnement: AbonnementLu, maintenant: Date): number {
  const ecart = joursEntre(abonnement.cycle.echeance, maintenant);

  for (let i = PALIERS.length - 1; i >= 0; i -= 1) {
    if (ecart >= PALIERS[i]!.jour) return i;
  }

  // Avant même le premier palier : on relance quand même, par le canal le
  // moins cher. C'est ce que le marchand demande en cliquant.
  return 0;
}

// ────────────────────────────────────────────────────────────────── communs ──

async function exiger(
  ports: PortsIntervention,
  abonnementId: string,
): Promise<AbonnementLu> {
  const abonnement = await ports.dossier.abonnement(abonnementId);

  // Celle-ci lève : un identifiant introuvable n'est pas un cas normal du
  // tableau de bord, c'est un lien mort ou une base qui a perdu une ligne.
  if (abonnement === null) {
    throw new Error(`Abonnement introuvable : ${abonnementId}`);
  }

  return abonnement;
}

/**
 * Consigne, sans jamais faire échouer le geste.
 *
 * Le journal sert à comprendre après coup ; il ne doit pas empêcher d'agir. Un
 * geste posé et non consigné vaut mieux qu'un geste refusé parce que le journal
 * était plein — surtout quand ce geste est « suspendre », qu'on pose rarement
 * sans raison.
 */
async function consigner(
  ports: PortsIntervention,
  fait: FaitIntervention,
): Promise<void> {
  try {
    await ports.interventions.journaliser(fait);
  } catch {
    /* rien */
  }
}
