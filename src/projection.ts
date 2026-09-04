import { createHmac } from "node:crypto";

import type { Cadence } from "./cycle";
import { httpParDefaut, type Http } from "./http";

/**
 * Ndank — ce que l'hôte rapporte à Ndank App.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE SEUL BESOIN QUI NE SE SATISFAIT PAS CHEZ L'HÔTE
 *
 * Tout le reste de Ndank tient chez le marchand : sa base, ses relances, sa
 * page, ses webhooks. C'est délibéré, et c'est ce qui fait qu'un jeton volé ne
 * donne accès qu'à un projet.
 *
 * Une chose échappe à ce découpage : **« voir tous mes abonnements »**. Un
 * abonné chez trois marchands est trois lignes, dans trois bases, que rien ne
 * rapproche — et aucun des trois hôtes ne connaît les deux autres. La question
 * ne peut donc pas se répondre chez eux.
 *
 * D'où la projection : chaque hôte pousse le strict nécessaire, et Ndank App
 * recolle. Ce qui reste chez l'hôte : l'argent, les versements, les webhooks,
 * les coordonnées complètes. Ce qui part : de quoi afficher une carte.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QUI PART, ET CE QUI NE PART PAS
 *
 * On envoie des **dates**, jamais un état. `etatDe` est la seule autorité sur
 * ce qu'est un abonnement « suspendu », et il vit dans le cœur. Envoyer un état
 * calculé chez l'hôte ferait qu'un abonné verrait « à jour » chez lui et
 * « suspendu » chez le marchand, selon la fraîcheur de la dernière poussée.
 *
 * Ndank App applique donc `etatDe` sur les dates reçues, et les deux écrans
 * disent forcément la même chose.
 *
 * On n'envoie ni le numéro, ni l'adresse, ni le nom — voir plus bas.
 */

/**
 * L'identité d'un abonné, telle qu'elle traverse les hôtes.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QUE CETTE EMPREINTE FAIT, ET CE QU'ELLE NE FAIT PAS
 *
 * Il faut le dire sans détour, parce que le contraire se croit facilement.
 *
 * **Ce n'est pas de l'anonymisation.** Un numéro de téléphone vit dans un
 * espace minuscule — quelques milliards de valeurs — et quiconque tient le
 * poivre peut en dresser la table complète en quelques heures. Une empreinte de
 * numéro se retrouve, toujours.
 *
 * **Ce qu'elle fait quand même**, et qui n'est pas rien : une copie de la base
 * de Ndank App, prise sans le poivre, ne livre pas un annuaire. C'est la
 * différence entre une fuite qui donne des numéros et une fuite qui donne des
 * empreintes qu'il faut encore vouloir casser.
 *
 * Le poivre est **partagé** entre Ndank App et tous les hôtes — il le faut,
 * puisque l'hôte doit calculer l'empreinte pour la pousser, et Ndank App doit
 * la recalculer quand l'abonné se connecte. Il fuit donc avec n'importe lequel
 * d'entre eux.
 *
 * La conclusion honnête : Ndank App **détient des données personnelles** pour
 * le compte de plusieurs marchands, et l'empreinte ne l'en dispense pas. Elle
 * réduit l'exposition accidentelle, pas l'attaque décidée.
 */
export function empreinte(identifiant: string, poivre: string): string {
  // Normalisé avant, sinon la vue multi-sites ne recolle rien : deux hôtes qui
  // stockent « 07 00 00 00 00 » et « +2250700000000 », ou « Awa@x.ci » et
  // « awa@x.ci », désignent la même personne et doivent donner la même
  // empreinte.
  //
  // Le « @ » sépare les deux mondes : une adresse se met en minuscules, un
  // numéro se réduit à ses chiffres. Sans cette distinction, « awa@x.ci »
  // deviendrait la chaîne vide et tous les abonnés inscrits par courriel
  // partageraient une seule et même empreinte.
  const cle = identifiant.includes("@")
    ? identifiant.trim().toLowerCase()
    : identifiant.replace(/[^\d]/g, "");

  return createHmac("sha256", poivre).update(cle, "utf8").digest("base64url");
}

/** Une ligne de projection : de quoi afficher une carte, et rien de plus. */
export interface Projection {
  /** L'abonnement chez l'hôte. Sert à ne pas dupliquer une carte. */
  reference: string;
  /** L'abonné, sous la forme qui traverse les hôtes. */
  empreinte: string;

  /** Le nom du service, tel que l'abonné le reconnaît. */
  site: string;
  /** Le nom de l'offre. */
  offre: string;

  montant: number;
  devise: string;
  cadence: Cadence;

  /**
   * Les quatre dates du cycle, en ISO.
   *
   * Ndank App leur applique `etatDe` — jamais un état qu'on lui aurait envoyé.
   * C'est ce qui fait que les deux écrans disent forcément la même chose.
   */
  debut: string;
  echeance: string;
  accesJusquA: string;
  repriseJusquA: string;

  resilieeLe: string | null;
  suspenduLe: string | null;

  /**
   * Le lien de renouvellement, quand il y en a un.
   *
   * ─────────────────────────────────────────────────────────────────────
   * C'EST LUI QUI REND LA VUE UTILE PLUTÔT QUE DÉCORATIVE
   *
   * Sans lui, « vous avez trois abonnements dont un à renouveler » se termine
   * par « allez le chercher ailleurs ». Avec lui, l'abonné paie depuis
   * l'endroit où il vient de voir qu'il devait payer.
   *
   * C'est le même jeton que celui parti par SMS : signé par l'hôte, valable
   * quinze jours, et il n'ouvre que la page de cet abonnement-là. Le pousser
   * ne donne donc rien de plus à Ndank App que ce que l'abonné a déjà dans ses
   * messages.
   */
  lien: string | null;
}

export interface ReglagesProjection {
  /** L'adresse de Ndank App, sans barre oblique finale. */
  base: string;
  /** Le jeton du projet chez Ndank App. */
  jeton: string;
  /** Le poivre des empreintes. **Le même partout**, sinon rien ne recolle. */
  poivre: string;
  /** Le nom du service, tel que l'abonné le reconnaît. */
  site: string;
  http?: Http;
  /**
   * Combien de lignes par envoi.
   *
   * Cent : assez pour que dix mille abonnés fassent cent appels et non dix
   * mille, assez peu pour qu'un envoi qui échoue ne fasse pas tout recommencer.
   */
  parLot?: number;
}

/** Ce qu'une poussée a fait. */
export interface Poussee {
  envoyees: number;
  lots: number;
  /** Les lots qui n'ont pas abouti. Le reste est quand même parti. */
  echecs: Array<{ lot: number; cause: unknown }>;
}

/**
 * Pousse une projection vers Ndank App.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UN LOT QUI ÉCHOUE N'EMPORTE PAS LES AUTRES
 *
 * Même règle que le passage quotidien, et pour la même raison : une projection
 * n'est pas une transaction. Si le troisième lot sur dix échoue, les neuf
 * autres sont à jour — ce qui vaut infiniment mieux que rien, puisque la
 * poussée suivante rattrapera le troisième.
 *
 * Les échecs remontent dans `Poussee.echecs` plutôt que d'être levés : c'est
 * l'appelant qui décide si un lot manquant justifie d'alerter.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ELLE EST IDEMPOTENTE, DONC ON PEUT LA REJOUER SANS RÉFLÉCHIR
 *
 * Chaque ligne porte `(empreinte, site, reference)`. Ndank App remplace, il
 * n'ajoute pas. Pousser deux fois la même journée ne crée pas deux cartes, et
 * pousser après une panne rattrape sans qu'on ait à savoir où l'on s'était
 * arrêté.
 */
export async function pousser(
  lignes: readonly Projection[],
  reglages: ReglagesProjection,
): Promise<Poussee> {
  const http = reglages.http ?? httpParDefaut;
  const parLot = reglages.parLot ?? 100;
  const base = reglages.base.replace(/\/+$/, "");

  const bilan: Poussee = { envoyees: 0, lots: 0, echecs: [] };

  for (let i = 0; i < lignes.length; i += parLot) {
    const lot = lignes.slice(i, i + parLot);
    bilan.lots += 1;

    try {
      const reponse = await http({
        methode: "POST",
        url: `${base}/projection`,
        entetes: {
          Authorization: `Bearer ${reglages.jeton}`,
          "Content-Type": "application/json",
        },
        corps: JSON.stringify({ site: reglages.site, lignes: lot }),
      });

      if (reponse.statut < 200 || reponse.statut >= 300) {
        throw new Error(
          `Ndank App a répondu ${reponse.statut} : ${reponse.corps.slice(0, 200)}`,
        );
      }

      bilan.envoyees += lot.length;
    } catch (cause) {
      bilan.echecs.push({ lot: bilan.lots, cause });
    }
  }

  return bilan;
}

/**
 * Faut-il projeter cet abonnement ?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ON NE POUSSE QUE CE QUI INTÉRESSE ENCORE L'ABONNÉ
 *
 * Un abonnement clos depuis deux ans n'a rien à faire sur l'écran de quelqu'un.
 * Le pousser quand même ferait grossir Ndank App d'un historique que personne
 * ne regarde — et donnerait à un service tiers une trace de tout ce à quoi une
 * personne a jamais été abonnée, ce qui est exactement ce qu'on cherche à
 * éviter en ne poussant que le nécessaire.
 *
 * On garde donc ce dont il peut encore advenir quelque chose : ni clos, ni
 * au-delà de la fenêtre de reprise. Un résilié reste tant que son accès payé
 * court — c'est justement là qu'il a besoin de le voir.
 */
export function aProjeter(
  abonnement: { repriseJusquA: Date; closLe?: Date | null },
  maintenant: Date = new Date(),
): boolean {
  if (abonnement.closLe != null) return false;

  return abonnement.repriseJusquA.getTime() >= maintenant.getTime();
}

/** Ce qu'il faut d'un abonnement pour en faire une carte. Rien de plus. */
export interface AProjeter {
  id: string;
  libelle: string;
  montant: number;
  devise: string;
  cadence: Cadence;
  debut: Date;
  echeance: Date;
  accesJusquA: Date;
  repriseJusquA: Date;
  resilieeLe: Date | null;
  suspenduLe: Date | null;
  closLe?: Date | null;
  abonne?: {
    courriel: string | null;
    telephone: string | null;
  };
}

/**
 * Fait une ligne de projection à partir d'un abonnement.
 *
 * Rend `null` quand l'abonnement n'a pas à être projeté — clos, hors reprise,
 * ou sans le moindre moyen d'identifier l'abonné.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SANS CONTACT, PAS DE CARTE — ET C'EST TANT MIEUX
 *
 * Un abonné dont on n'a ni numéro ni adresse ne pourra jamais se connecter à
 * Ndank App pour y voir cette carte. La pousser reviendrait à confier une ligne
 * de données à un service tiers pour que personne ne la lise jamais.
 */
export function projectionDe(
  abonnement: AProjeter,
  reglages: {
    site: string;
    poivre: string;
    /** Le lien de renouvellement, quand l'hôte veut en donner un. */
    lien?: (abonnementId: string) => string | null;
  },
  maintenant: Date = new Date(),
): Projection | null {
  if (!aProjeter(abonnement, maintenant)) return null;

  // Le numéro d'abord : c'est par lui que l'abonné se connecte à Ndank App.
  // L'adresse en second, pour ne pas rendre invisible un abonné qu'un hôte
  // n'aurait inscrit que par courriel.
  const identifiant =
    abonnement.abonne?.telephone ?? abonnement.abonne?.courriel ?? null;
  if (identifiant === null || identifiant.trim() === "") return null;

  return {
    reference: abonnement.id,
    empreinte: empreinte(identifiant, reglages.poivre),
    site: reglages.site,
    offre: abonnement.libelle,
    montant: abonnement.montant,
    devise: abonnement.devise,
    cadence: abonnement.cadence,
    debut: abonnement.debut.toISOString(),
    echeance: abonnement.echeance.toISOString(),
    accesJusquA: abonnement.accesJusquA.toISOString(),
    repriseJusquA: abonnement.repriseJusquA.toISOString(),
    resilieeLe: abonnement.resilieeLe?.toISOString() ?? null,
    suspenduLe: abonnement.suspenduLe?.toISOString() ?? null,
    lien: reglages.lien?.(abonnement.id) ?? null,
  };
}
