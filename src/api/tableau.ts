import type { Encaisse, EncaisseParFournisseur, Recurrent } from "../argent";
import { ajouterJours, jour } from "../cycle";
import { PREAVIS_JOURS, type Etat } from "../etats";

/**
 * Ndank — ce que le tableau de bord a le droit de demander.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ON NE PEUT PAS DEMANDER « COMBIEN DE SUSPENDUS »
 *
 * C'est la contrainte qui donne sa forme à ce fichier, et elle découle
 * directement de la première décision du cœur : **l'état se déduit, il ne se
 * stocke pas.** Il n'y a pas de colonne `etat` — le schéma le dit, et c'est ce
 * qui empêche un abonnement de vieillir de travers quand un passage rate son
 * tour.
 *
 * La conséquence est ici : une requête ne peut pas filtrer sur un état. Elle
 * filtre sur des **dates**, et c'est Ndank qui traduit. `bornesDe("SUSPENDUE",
 * maintenant)` rend les bornes qui, à cet instant précis, décrivent exactement
 * ce que `etatDe` appellerait « suspendue ».
 *
 * Le faire ici plutôt que dans chaque implémentation du port est le point :
 * deux traductions du même état finiraient par diverger, et le tableau de bord
 * annoncerait un chiffre que le moteur ne reconnaîtrait pas.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CELA NE MARCHE QUE PARCE QUE LES DATES SONT À MINUIT
 *
 * `etatDe` compare des **jours civils** — c'est `joursEntre` qui le garantit,
 * et c'est ce qui empêche l'heure du cron de décider d'une coupure d'accès.
 *
 * Une base, elle, compare des instants. Les deux ne coïncident que si les dates
 * stockées sont déjà au minuit civil UTC, ce que `jour()` garantit à
 * l'écriture : tout cycle sort de `cycleApresPaiement` ou de `cycleAvance`, qui
 * en passent toutes les bornes par `jour()`.
 *
 * Un hôte qui écrirait une échéance avec une heure verrait donc ses comptes
 * décalés d'un jour, sans rien pour le lui dire. C'est la seule hypothèse que
 * ce fichier fait sur la base, et elle méritait d'être écrite.
 */

/** Les bornes d'une requête de tableau. Toutes facultatives, toutes cumulatives. */
export interface Bornes {
  /** `true` : seulement les résiliés. `false` : seulement les non-résiliés. */
  resiliee?: boolean;
  /** Idem pour la clôture. */
  close?: boolean;
  echeance?: { avant?: Date; apres?: Date };
  accesJusquA?: { avant?: Date; apres?: Date };
  repriseJusquA?: { avant?: Date; apres?: Date };
}

/**
 * Les bornes qui décrivent un état, à cet instant.
 *
 * Elles suivent `etatDe` ligne pour ligne, y compris dans l'ordre des
 * exclusions — un résilié n'est jamais compté ailleurs, même si ses dates le
 * placeraient dans un autre état.
 */
export function bornesDe(etat: Etat, maintenant: Date): Bornes {
  const aujourdHui = jour(maintenant);

  if (etat === "RESILIEE") return { resiliee: true };

  // Les quatre autres excluent tous les résiliés, comme `etatDe` le fait par sa
  // première ligne.
  const vivant = { resiliee: false } as const;

  if (etat === "EXPIREE") {
    // `joursEntre(repriseJusquA, maintenant) > 0`, soit `repriseJusquA` d'un
    // jour civil strictement antérieur à aujourd'hui.
    return { ...vivant, repriseJusquA: { avant: aujourdHui } };
  }

  if (etat === "SUSPENDUE") {
    // L'accès est tombé, la reprise court encore.
    return {
      ...vivant,
      accesJusquA: { avant: aujourdHui },
      repriseJusquA: { apres: aujourdHui },
    };
  }

  if (etat === "A_RENOUVELER") {
    // L'accès tient, et l'échéance est dans la fenêtre de préavis — ce qui
    // inclut les échéances déjà passées, tant que la grâce dure.
    return {
      ...vivant,
      accesJusquA: { apres: aujourdHui },
      echeance: { avant: ajouterJours(aujourdHui, PREAVIS_JOURS) },
    };
  }

  // ACTIVE : l'accès tient, et l'échéance est encore au-delà du préavis.
  return {
    ...vivant,
    accesJusquA: { apres: aujourdHui },
    echeance: { apres: ajouterJours(aujourdHui, PREAVIS_JOURS) },
  };
}

/** Une ligne telle que le tableau de bord la lit. */
export interface LigneTableau {
  id: string;
  abonneId: string;
  libelle: string;
  montant: number;
  devise: string;
  cadence: string;
  echeance: Date;
  accesJusquA: Date;
  repriseJusquA: Date;
  resilieeLe: Date | null;
  /** Posée quand le marchand suspend à la main. Coupe l'accès sur-le-champ. */
  suspenduLe: Date | null;
  closLe: Date | null;

  /**
   * Qui est l'abonné. Absent si l'implémentation ne le joint pas.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * IL EST DANS LA LISTE, ET PAS SEULEMENT DANS LE DÉTAIL
   *
   * On aurait pu le réserver au détail d'un abonnement, en se disant qu'un
   * fichier d'abonnés ne devrait pas transiter à chaque ouverture d'écran.
   * Ce serait un réconfort et non une protection : le jeton donne accès aux
   * deux routes, donc quiconque peut lire le détail peut le lire cent fois.
   *
   * Ce qui protège vraiment, c'est le jeton — et le fait que rien ici
   * n'écrive. Le reste relève de ce que l'hôte fait de sa réponse : elle part
   * avec `Cache-Control: no-store` et ne doit pas finir dans un journal.
   *
   * Un tableau de bord qui n'affiche que des identifiants est inutilisable :
   * on relance quelqu'un, pas un `cuid`.
   */
  abonne?: {
    /** L'identifiant que l'hôte lui donne chez lui. */
    reference: string;
    nom: string | null;
    courriel: string | null;
    telephone: string | null;
  };
}

/** Un versement, tel que le tableau de bord le lit. */
export interface LigneVersement {
  id: string;
  abonnementId: string;
  fournisseur: string;
  reference: string;
  montant: number;
  devise: string;
  /** L'état chez le fournisseur : REUSSI, ECHOUE, EN_ATTENTE, EXPIRE, INCONNU. */
  etat: string;
  /** Quand le fournisseur dit l'avoir réglé. */
  regleLe: Date | null;
  /**
   * Quand Ndank l'a **compté**.
   *
   * Distinct de `regleLe`, et la nuance est celle qui fait comprendre un
   * écart : un versement réglé mais jamais compté est un paiement qui n'a
   * pas prolongé l'abonnement. C'est exactement ce qu'on cherche quand un
   * abonné dit avoir payé.
   */
  compteLe: Date | null;
  creeLe: Date;
}

export interface Page {
  /** À partir de combien. */
  depuis: number;
  /** Combien au plus. Le routeur le borne — voir `PAR_PAGE_MAX`. */
  combien: number;
}

/**
 * Ce que l'hôte fournit pour que le tableau de bord ait quelque chose à lire.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL N'Y A AUCUNE MÉTHODE QUI ÉCRIT, ET C'EST LE POINT
 *
 * Le tableau de bord n'appelle pas la base : il appelle une API que le SDK
 * expose. Ce détour n'est pas une élégance d'architecture, c'est ce qui rend
 * une manipulation depuis le tableau de bord **impossible** plutôt
 * qu'interdite.
 *
 * Une application cliente est distribuée : son code est lisible, son jeton est
 * extractible, et ce qu'elle peut faire, n'importe qui muni de ce jeton peut le
 * faire. Si elle parlait à la base, « lecture seule » reposerait sur des droits
 * qu'on aurait pensé à restreindre. Ici, il n'y a rien à restreindre : le port
 * n'a pas de verbe qui écrit, et le routeur refuse toute méthode qui n'est pas
 * `GET`.
 */
export interface Tableau {
  /** Combien d'abonnements vérifient ces bornes. */
  compter(bornes: Bornes): Promise<number>;

  /**
   * Une page d'abonnements, les plus urgents d'abord.
   *
   * « Les plus urgents » : par échéance croissante. C'est le même ordre que
   * `aRelancer`, et pour la même raison — quand on ne voit qu'une page, il faut
   * que ce soit celle qui demande une décision.
   */
  lister(bornes: Bornes, page: Page): Promise<readonly LigneTableau[]>;

  /** Un abonnement précis, ou `null`. */
  ligne(id: string): Promise<LigneTableau | null>;

  /**
   * Les versements d'un abonnement, les plus récents d'abord. Facultatif.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * FACULTATIF, PARCE QUE TOUS LES HÔTES NE TIENNENT PAS DE REGISTRE
   *
   * Un hôte du niveau 1 implémente `Tableau` contre sa propre base. Il peut
   * très bien n'y garder que des abonnements, et laisser les paiements chez
   * son fournisseur — c'est un choix défendable, puisque Ndank ne touche
   * jamais l'argent.
   *
   * L'exiger l'obligerait à écrire une méthode qui rend un tableau vide,
   * c'est-à-dire à mentir. La route répond alors qu'elle n'est pas servie,
   * ce qui est la vérité.
   */
  versements?(
    abonnementId: string,
    page: Page,
  ): Promise<readonly LigneVersement[]>;

  /**
   * Combien de versements par état depuis cette date. Facultatif.
   *
   * C'est le chiffre que réclame un tableau de bord : combien de paiements
   * ont réussi, combien ont échoué. Un taux d'échec qui monte se voit là, et
   * nulle part ailleurs — chaque échec pris isolément ressemble à un abonné
   * qui a changé d'avis.
   */
  compterVersements?(depuis: Date): Promise<Readonly<Record<string, number>>>;

  /**
   * Ce qui est entré sur une période, par devise. Facultatif.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * SEULEMENT CE QUI A ÉTÉ COMPTÉ
   *
   * Un versement `REUSSI` mais jamais compté est un paiement qui n'a pas
   * prolongé l'abonnement — un incident, pas une recette. L'inclure ferait
   * afficher de l'argent qu'on a bien reçu mais dont personne n'a rien fait,
   * et masquerait précisément l'écart qu'on cherche quand un abonné dit avoir
   * payé.
   *
   * L'implémentation filtre donc sur `compteLe`, jamais sur `etat`.
   */
  encaisse?(depuis: Date, jusqua: Date): Promise<readonly Encaisse[]>;

  /** La même chose, ventilée par fournisseur. Facultatif. */
  encaisseParFournisseur?(
    depuis: Date,
    jusqua: Date,
  ): Promise<readonly EncaisseParFournisseur[]>;

  /**
   * Les abonnements qui ont accès, groupés par devise et par cadence.
   *
   * Groupés et non listés : sur cent mille abonnés, rendre les montants un par
   * un ferait passer la table entière par le réseau pour calculer une somme
   * que la base sait faire. `recurrentMensuel` normalise ensuite au mois.
   */
  recurrent?(maintenant: Date): Promise<readonly Recurrent[]>;
}
