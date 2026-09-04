import { timingSafeEqual } from "node:crypto";

import { ajouterJours, joursEntre } from "../cycle";
import {
  direSante,
  sante,
  type Battements,
  type ReglagesSante,
} from "../battement";
import { etatDe, type Etat } from "../etats";
import type { ReponseWeb, RequeteWeb } from "../web";
import { evolution, recurrentMensuel } from "../argent";
import { coutDesRelances, type Statistiques, type Tarifs } from "../relances";
import { formater } from "../devise";
import { offresActives, type Grille } from "../offre";
import {
  bornesDe,
  type LigneTableau,
  type LigneVersement,
  type Tableau,
} from "./tableau";

/**
 * Ndank — l'API que le tableau de bord consomme.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ELLE NE SAIT QUE LIRE, ET CE N'EST PAS UNE POLITESSE
 *
 * Le tableau de bord ne parle pas à la base : il parle à cette API. Le détour
 * existe pour une raison précise — rendre une manipulation depuis le tableau de
 * bord **impossible** plutôt qu'interdite.
 *
 * Une application cliente est distribuée. Son code est lisible, son jeton est
 * extractible, et tout ce qu'elle peut faire, quiconque tient ce jeton peut le
 * faire. Si elle parlait à la base, « lecture seule » reposerait sur des droits
 * qu'on aurait pensé à restreindre — et qu'on aurait un jour élargis « juste
 * pour un bouton ».
 *
 * Ici il n'y a rien à restreindre. Le port `Tableau` n'a aucun verbe qui écrit,
 * et ce routeur refuse tout ce qui n'est pas `GET`. Un jeton volé donne accès à
 * des chiffres, jamais à un changement.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CES CHIFFRES SONT DES DONNÉES PERSONNELLES
 *
 * Une ligne dit ce que telle personne doit, à quoi elle est abonnée, et depuis
 * combien de temps elle est en retard. Sans authentification, l'adresse est
 * publique et le fichier d'abonnés avec elle.
 *
 * Le jeton est donc obligatoire — `routeurApi` refuse de se construire sans —
 * et comparé à temps constant. Ce dernier point compte plus qu'il n'en a l'air :
 * une comparaison ordinaire sort au premier caractère qui diffère, et le temps
 * de réponse laisse alors deviner le jeton, caractère par caractère.
 */

/** Combien de lignes une page peut rendre. */
import { bilan, pire, type Constat, type Signaux } from "../sante";

export const PAR_PAGE_MAX = 100;
const PAR_PAGE_DEFAUT = 25;

/** Les états qu'on peut demander. Dérivé, pour qu'un ajout suive tout seul. */
const ETATS: readonly Etat[] = [
  "ACTIVE",
  "A_RENOUVELER",
  "SUSPENDUE",
  "RESILIEE",
  "EXPIREE",
];

export interface ReglagesApi {
  tableau: Tableau;
  /**
   * De quoi dire si le moteur tourne encore. Facultatif.
   *
   * Sans lui, `GET /sante` répond 501 — la route existe, l'hôte ne trace pas
   * ses passages. C'est une réponse plus utile qu'un 404, qui ferait chercher
   * une faute de frappe.
   */
  battements?: Battements;
  sante?: ReglagesSante;
  /**
   * Les autres signaux de santé. Facultatif, et indépendant du battement.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * LE BATTEMENT NE DIT QUE « ÇA TOURNE »
   *
   * Un moteur qui tourne parfaitement peut passer ses journées à ne rien
   * faire : la passerelle SMS refuse la clé depuis mardi, ou quarante abonnés
   * ont payé sans que leur abonnement bouge. Rien de cela n'arrête le passage
   * quotidien, et rien de cela n'apparaît dans `Sante`.
   *
   * Branché, `GET /sante` porte en plus `constats` — une phrase et un geste
   * par chose à savoir. Non branché, la réponse garde exactement la forme
   * qu'elle avait : un tableau de bord existant ne casse pas.
   */
  signaux?: Omit<Signaux, "battements">;
  /**
   * La grille tarifaire, quand l'hôte veut l'exposer. Facultatif.
   *
   * `portsPrisma(...).offres` la fournit telle quelle. Un hôte du niveau 1 qui
   * déclare sa grille en code passe `async () => GRILLE`.
   *
   * Elle est **publique pour qui tient le jeton**, mais elle ne contient rien
   * de personnel : ce sont les prix affichés. La route existe pour qu'un
   * tableau de bord montre ce qu'on vend sans le recopier — un tarif recopié
   * ailleurs finit par diverger de celui qu'on facture.
   */
  offres?: () => Promise<Grille>;
  /**
   * Sur combien de jours compter les versements du résumé.
   *
   * Trente par défaut : un mois, soit un cycle complet pour la cadence la plus
   * répandue. Sur sept jours, un taux d'échec ne se distingue pas du hasard.
   */
  fenetreVersements?: number;
  /**
   * Ce qu'un message coûte, par canal, en unités mineures.
   *
   * Ndank ne connaît aucun prix : un SMS ne coûte pas la même chose selon
   * l'opérateur, le pays et le volume négocié. Sans tarifs, il compte les
   * messages et laisse le coût à zéro — ce qui reste utile.
   */
  tarifs?: Tarifs;
  /**
   * Le jeton que le tableau de bord présente.
   *
   * Obligatoire. Le rendre facultatif aurait fait qu'un oubli de configuration
   * ouvre le fichier d'abonnés — une panne silencieuse, du genre qu'on ne
   * découvre pas.
   */
  jeton: string;
  /** Où raconter les accès. Facultatif. */
  journal?: (fait: { route: string; statut: number }) => void;
}

function json(statut: number, valeur: unknown): ReponseWeb {
  return {
    statut,
    entetes: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
    corps: JSON.stringify(valeur),
  };
}

/** Comparaison à temps constant. Deux longueurs différentes valent faux. */
function memeJeton(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");

  if (x.length !== y.length) return false;

  return timingSafeEqual(x, y);
}

/** Le jeton présenté, ou `null`. */
function jetonPresente(requete: RequeteWeb): string | null {
  const entete = requete.entetes["authorization"];
  if (typeof entete !== "string") return null;

  const trouve = /^Bearer\s+(.+)$/i.exec(entete.trim());
  return trouve?.[1] ?? null;
}

/** Une ligne, telle que le tableau de bord la reçoit. */
function versJson(
  ligne: LigneTableau,
  maintenant: Date,
): Record<string, unknown> {
  const etat = etatDe(
    {
      cycle: {
        debut: ligne.echeance,
        echeance: ligne.echeance,
        accesJusquA: ligne.accesJusquA,
        repriseJusquA: ligne.repriseJusquA,
      },
      resilieeLe: ligne.resilieeLe,
      suspenduLe: ligne.suspenduLe,
    },
    maintenant,
  );

  return {
    id: ligne.id,
    abonneId: ligne.abonneId,
    libelle: ligne.libelle,
    montant: ligne.montant,
    devise: ligne.devise,
    cadence: ligne.cadence,
    // L'état est calculé ici, à l'instant de la réponse — jamais lu d'une
    // colonne. C'est la même règle que partout : la base garde les faits, pas
    // les conclusions.
    etat,
    echeance: ligne.echeance.toISOString(),
    accesJusquA: ligne.accesJusquA.toISOString(),
    repriseJusquA: ligne.repriseJusquA.toISOString(),
    joursRestants: joursEntre(maintenant, ligne.accesJusquA),
    resilieeLe: ligne.resilieeLe?.toISOString() ?? null,
    suspenduLe: ligne.suspenduLe?.toISOString() ?? null,
    closLe: ligne.closLe?.toISOString() ?? null,
    // Absent quand l'implémentation ne joint pas l'abonné. Un tableau de bord
    // qui n'affiche que des identifiants est inutilisable : on relance
    // quelqu'un, pas un `cuid`.
    abonne: ligne.abonne ?? null,
  };
}

/** Le détail d'un abonnement, avec ce que ses versements disent de lui. */
function versJsonDetaille(
  ligne: LigneTableau,
  stats: Statistiques | null,
  maintenant: Date,
): Record<string, unknown> {
  return {
    ...versJson(ligne, maintenant),
    // Absentes quand l'hôte ne tient pas de registre de versements : `null`
    // dit qu'on ne sait pas, là où des zéros feraient croire à un abonné
    // parfaitement ponctuel qui n'aurait jamais payé.
    statistiques: stats,
  };
}

/** Un versement, tel que le tableau de bord le reçoit. */
function versementJson(v: LigneVersement): Record<string, unknown> {
  return {
    id: v.id,
    abonnementId: v.abonnementId,
    fournisseur: v.fournisseur,
    reference: v.reference,
    montant: v.montant,
    devise: v.devise,
    etat: v.etat,
    regleLe: v.regleLe?.toISOString() ?? null,
    compteLe: v.compteLe?.toISOString() ?? null,
    creeLe: v.creeLe.toISOString(),
    // La nuance qui fait comprendre un écart : un versement réglé mais jamais
    // compté est un paiement qui n'a pas prolongé l'abonnement. C'est
    // exactement ce qu'on cherche quand un abonné dit avoir payé.
    regleNonCompte: v.regleLe !== null && v.compteLe === null,
  };
}

/**
 * Fabrique le routeur de l'API.
 *
 *   `GET /resume`             les comptes par état, et ce qu'ils représentent ;
 *   `GET /abonnements`        une page, filtrée par état ;
 *   `GET /abonnements/<id>`   un abonnement.
 */
export function routeurApi(
  reglages: ReglagesApi,
): (requete: RequeteWeb) => Promise<ReponseWeb> {
  if (reglages.jeton.trim() === "") {
    // À la construction, et non au premier appel : le premier appel viendrait
    // du tableau de bord, mais le second pourrait venir de n'importe qui.
    throw new Error(
      "routeurApi : un jeton est obligatoire. Sans lui, l'adresse expose le " +
        "fichier d'abonnés — ce que chaque ligne dit, c'est ce que telle " +
        "personne doit.",
    );
  }

  const raconter = (route: string, statut: number): void => {
    try {
      reglages.journal?.({ route, statut });
    } catch {
      /* le journal observe */
    }
  };

  return async function repondre(requete: RequeteWeb): Promise<ReponseWeb> {
    const morceaux = requete.chemin.split("/").filter((m) => m !== "");
    const route = `/${morceaux.join("/")}`;

    const rendre = (reponse: ReponseWeb): ReponseWeb => {
      raconter(route, reponse.statut);
      return reponse;
    };

    // Aucune méthode qui écrit n'est acceptée, pas même en la déclarant.
    // C'est la moitié de la raison d'être de cette API.
    if (requete.methode.toUpperCase() !== "GET") {
      return rendre(
        json(405, {
          erreur: "Cette API est en lecture seule.",
        }),
      );
    }

    const presente = jetonPresente(requete);

    if (presente === null || !memeJeton(presente, reglages.jeton)) {
      return rendre(json(401, { erreur: "Jeton absent ou invalide." }));
    }

    const maintenant = new Date();

    /**
     * L'état du moteur, avant tout le reste.
     *
     * ─────────────────────────────────────────────────────────────────────
     * C'EST LA PREMIÈRE CHOSE QU'UN TABLEAU DE BORD DOIT LIRE
     *
     * Tous les autres chiffres de cette API sont justes — l'état se déduit des
     * dates, donc il ne ment jamais. Mais ils ne disent pas si quelqu'un
     * **agit** dessus.
     *
     * Un tableau de bord qui affiche « 6 abonnés en grâce » alors que le
     * passage quotidien est arrêté depuis dix jours est pire qu'un tableau de
     * bord vide : il donne l'impression que le système travaille.
     */
    if (morceaux[0] === "sante" && morceaux.length === 1) {
      if (!reglages.battements) {
        return rendre(
          json(501, {
            erreur:
              "Cet hôte ne trace pas ses passages. Passez `battements` à " +
              "`routeurApi`, et remplacez `passer()` par `passerEtTracer()` " +
              "dans votre tâche quotidienne.",
          }),
        );
      }

      const etat = await sante(reglages.battements, reglages.sante, maintenant);

      // `bilan` refait l'appel à `sante` pour son propre constat MOTEUR. Un
      // appel de plus sur une route de diagnostic ne vaut pas de tordre l'une
      // des deux fonctions pour que l'autre lui passe son résultat.
      const constats: readonly Constat[] | undefined = reglages.signaux
        ? await bilan(
            { ...reglages.signaux, battements: reglages.battements },
            reglages.sante,
            maintenant,
          )
        : undefined;

      return rendre(
        json(200, {
          ...etat,
          ...(constats ? { constats, pire: pire(constats) } : {}),
          // Une phrase et son action, pas un mot seul : « BLOQUE » n'aide
          // personne. C'est ce que l'écran affiche tel quel.
          ...direSante(etat),
          dernier:
            "dernier" in etat ? etat.dernier.toISOString() : null,
          depuis: "depuis" in etat ? etat.depuis.toISOString() : null,
        }),
      );
    }

    if (morceaux[0] === "resume" && morceaux.length === 1) {
      return rendre(json(200, await resume(reglages, maintenant)));
    }

    /**
     * L'argent : ce qui est entré, et ce qui se répète.
     *
     * ─────────────────────────────────────────────────────────────────────
     * SÉPARÉE DE `/resume`, ET CE N'EST PAS UN DÉTAIL DE ROUTAGE
     *
     * `/resume` compte des abonnements : cinq requêtes indexées, rapides, que
     * le tableau de bord peut demander souvent. L'argent demande des sommes et
     * des regroupements sur la table des versements, qui grossit sans fin.
     *
     * Les mélanger ferait payer le prix du second à chaque affichage du
     * premier — et le premier est celui qu'on regarde toutes les trente
     * secondes.
     */
    if (morceaux[0] === "argent" && morceaux.length === 1) {
      return rendre(await argent(reglages, requete, maintenant));
    }

    if (morceaux[0] === "offres" && morceaux.length === 1) {
      if (!reglages.offres) {
        // 501 et non 404 : la route existe, l'hôte ne l'a simplement pas
        // branchée. Un 404 ferait chercher une faute de frappe dans l'URL.
        return rendre(
          json(501, {
            erreur:
              "Cet hôte n'expose pas sa grille tarifaire. " +
              "Passez `offres` à `routeurApi`.",
          }),
        );
      }

      const grille = await reglages.offres();
      const toutes = requete.parametres["toutes"] === "1";

      return rendre(
        json(200, {
          // Par défaut, seulement ce qu'on propose aujourd'hui. Une offre
          // retirée reste dans la grille — des abonnements en cours la
          // référencent — mais l'afficher ferait vendre ce qu'on ne vend plus.
          offres: (toutes ? grille : offresActives(grille)).map((o) => ({
            id: o.id,
            libelle: o.libelle,
            montant: o.montant,
            devise: o.devise,
            cadence: o.cadence,
            actif: o.actif !== false,
          })),
        }),
      );
    }

    if (morceaux[0] === "abonnements" && morceaux.length === 1) {
      return rendre(await lister(reglages, requete, maintenant));
    }

    if (morceaux[0] === "abonnements" && morceaux.length === 2) {
      const ligne = await reglages.tableau.ligne(morceaux[1]!);

      if (ligne === null) {
        return rendre(json(404, { erreur: "Abonnement introuvable." }));
      }

      const stats = reglages.tableau.statistiques
        ? await reglages.tableau.statistiques(morceaux[1]!)
        : null;

      return rendre(json(200, versJsonDetaille(ligne, stats, maintenant)));
    }

    if (
      morceaux[0] === "abonnements" &&
      morceaux.length === 3 &&
      morceaux[2] === "versements"
    ) {
      if (!reglages.tableau.versements) {
        return rendre(
          json(501, {
            erreur:
              "Cet hôte ne tient pas de registre de versements. " +
              "Implémentez `Tableau.versements`.",
          }),
        );
      }

      // On vérifie que l'abonnement existe avant de lister ses versements :
      // sinon un identifiant inventé rendrait une liste vide, indiscernable
      // d'un abonnement qui n'a jamais payé.
      const ligne = await reglages.tableau.ligne(morceaux[1]!);
      if (ligne === null) {
        return rendre(json(404, { erreur: "Abonnement introuvable." }));
      }

      const lignes = await reglages.tableau.versements(
        morceaux[1]!,
        pageDe(requete),
      );

      return rendre(
        json(200, { lignes: lignes.map(versementJson) }),
      );
    }

    return rendre(json(404, { erreur: "Route inconnue." }));
  };
}

/** Les bornes de page d'une requête, toujours plafonnées. */
function pageDe(requete: RequeteWeb): { depuis: number; combien: number } {
  return {
    depuis: Math.max(0, entier(requete.parametres["depuis"], 0)),
    combien: Math.min(
      PAR_PAGE_MAX,
      Math.max(1, entier(requete.parametres["combien"], PAR_PAGE_DEFAUT)),
    ),
  };
}

/**
 * Les comptes par état.
 *
 * Un appel par état, et non un balayage : c'est le seul moyen d'obtenir ces
 * chiffres sans charger la table, puisqu'aucune colonne ne porte l'état. Cinq
 * requêtes indexées valent mieux qu'une lecture complète, y compris à cent
 * mille abonnés.
 */
async function resume(
  reglages: ReglagesApi,
  maintenant: Date,
): Promise<Record<string, unknown>> {
  const comptes: Record<string, number> = {};

  for (const etat of ETATS) {
    comptes[etat] = await reglages.tableau.compter(bornesDe(etat, maintenant));
  }

  const actifs = (comptes["ACTIVE"] ?? 0) + (comptes["A_RENOUVELER"] ?? 0);
  const jours = reglages.fenetreVersements ?? 30;
  const depuis = ajouterJours(maintenant, -jours);

  /**
   * Les paiements de la période, par état.
   *
   * ────────────────────────────────────────────────────────────────────────
   * C'EST LE TAUX D'ÉCHEC QU'ON VIENT CHERCHER ICI
   *
   * Pris isolément, un versement échoué ressemble à un abonné qui a changé
   * d'avis — et l'on n'y regarde pas. C'est leur proportion qui parle : un
   * taux qui monte veut dire une passerelle en difficulté, un opérateur en
   * panne, ou une clé qui a expiré. Aucun de ces trois ne se signale
   * autrement.
   */
  const versements = reglages.tableau.compterVersements
    ? await reglages.tableau.compterVersements(depuis)
    : null;

  const reussis = versements?.["REUSSI"] ?? 0;
  const echoues = (versements?.["ECHOUE"] ?? 0) + (versements?.["EXPIRE"] ?? 0);
  const conclus = reussis + echoues;

  return {
    calculeLe: maintenant.toISOString(),
    comptes,
    /** Ceux qui ont accès au service, maintenant. C'est le chiffre qui compte. */
    actifs,
    /** Ceux qu'il faut aller chercher : la grâce court encore. */
    aRattraper: (comptes["A_RENOUVELER"] ?? 0) + (comptes["SUSPENDUE"] ?? 0),
    versements:
      versements === null
        ? null
        : {
            depuis: depuis.toISOString(),
            jours,
            parEtat: versements,
            reussis,
            echoues,
            // `null` et non zéro quand rien n'a encore été conclu : un taux de
            // 0 % sur zéro paiement ferait croire à une panne totale.
            tauxDeReussite: conclus === 0 ? null : reussis / conclus,
          },
  };
}

/** Une page d'abonnements. */
async function lister(
  reglages: ReglagesApi,
  requete: RequeteWeb,
  maintenant: Date,
): Promise<ReponseWeb> {
  const demande = requete.parametres["etat"];

  if (demande !== undefined && !ETATS.includes(demande as Etat)) {
    return json(400, {
      erreur: `État inconnu : « ${demande} ».`,
      connus: ETATS,
    });
  }

  // Sans état demandé, on rend les vivants — ceux dont il peut encore advenir
  // quelque chose. Rendre tout le fichier par défaut ferait payer une lecture
  // complète à chaque ouverture du tableau de bord.
  const bornes =
    demande === undefined
      ? { resiliee: false, close: false }
      : bornesDe(demande as Etat, maintenant);

  const { depuis, combien } = pageDe(requete);

  const [total, lignes] = await Promise.all([
    reglages.tableau.compter(bornes),
    reglages.tableau.lister(bornes, { depuis, combien }),
  ]);

  return json(200, {
    total,
    depuis,
    combien,
    lignes: lignes.map((l) => versJson(l, maintenant)),
  });
}

function entier(valeur: string | undefined, defaut: number): number {
  const n = Number.parseInt(valeur ?? "", 10);
  return Number.isFinite(n) ? n : defaut;
}

/**
 * Ce qui est entré, et ce qui se répète.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DEUX PÉRIODES, PARCE QU'UN CHIFFRE SEUL NE DIT RIEN
 *
 * « 214 000 F encaissés ce mois » ne dit ni si c'est bien ni si c'est
 * inquiétant. C'est la comparaison qui parle, et elle demande la période
 * précédente — donc deux requêtes, pas une.
 *
 * `jours` est réglable : trente par défaut, ce qui compare un mois au
 * précédent. Sur sept, on compare une semaine à la précédente et l'on voit un
 * incident d'opérateur ; sur quatre-vingt-dix, une tendance.
 */
async function argent(
  reglages: ReglagesApi,
  requete: RequeteWeb,
  maintenant: Date,
): Promise<ReponseWeb> {
  if (!reglages.tableau.encaisse || !reglages.tableau.recurrent) {
    return json(501, {
      erreur:
        "Cet hôte ne tient pas de registre de versements. " +
        "Implémentez `Tableau.encaisse` et `Tableau.recurrent`.",
    });
  }

  const jours = Math.min(365, Math.max(1, entier(requete.parametres["jours"], 30)));

  const debutCourant = ajouterJours(maintenant, -jours);
  const debutPrecedent = ajouterJours(maintenant, -jours * 2);

  const [courant, precedent, groupes, parFournisseur, relances] =
    await Promise.all([
      reglages.tableau.encaisse(debutCourant, maintenant),
      reglages.tableau.encaisse(debutPrecedent, debutCourant),
      reglages.tableau.recurrent(maintenant),
      reglages.tableau.encaisseParFournisseur?.(debutCourant, maintenant) ?? [],
      reglages.tableau.compterRelances?.(debutCourant, maintenant) ?? null,
    ]);

  // La devise du premier encaissement, ou celle du récurrent : le coût des
  // relances n'a pas de devise à lui, il se paie dans celle du marchand.
  const devisePrincipale =
    courant[0]?.devise ?? groupes[0]?.devise ?? "XOF";

  const avant = new Map(precedent.map((e) => [e.devise, e.total]));

  return json(200, {
    calculeLe: maintenant.toISOString(),
    jours,
    depuis: debutCourant.toISOString(),

    /**
     * Une ligne par devise, jamais un total unique.
     *
     * Le franc CFA et le cedi n'ont ni la même valeur ni le même nombre de
     * décimales. Les additionner produirait un nombre qui ressemble à de
     * l'argent sans en être — et personne ne s'en apercevrait, parce qu'un
     * total est toujours plausible.
     */
    encaisse: courant.map((e) => ({
      devise: e.devise,
      total: e.total,
      nombre: e.nombre,
      lisible: formater(e.total, e.devise),
      // `null` le premier mois : rendre « +100 % » quand il n'y a rien à
      // comparer serait inventer une histoire.
      evolution: evolution(e.total, avant.get(e.devise) ?? 0),
    })),

    parFournisseur: parFournisseur.map((e) => ({
      fournisseur: e.fournisseur,
      devise: e.devise,
      total: e.total,
      nombre: e.nombre,
      lisible: formater(e.total, e.devise),
    })),

    /**
     * Le revenu récurrent, ramené au mois.
     *
     * Il compte les abonnements **qui ont accès** — actifs et en grâce — et
     * pas les suspendus : les inclure gonflerait le chiffre exactement au
     * moment où il devrait baisser. Voir `argent.ts`, qui porte l'arbitrage.
     */
    recurrentMensuel: recurrentMensuel(groupes).map((m) => ({
      devise: m.devise,
      total: m.total,
      nombre: m.nombre,
      lisible: formater(m.total, m.devise),
    })),

    /**
     * Ce que les relances de la période ont coûté.
     *
     * C'est ce qui rend mesurable la décision la plus coûteuse du coeur :
     * l'échelle commence par le gratuit et ne sort le SMS qu'au dernier
     * moment. Le jour où ce chiffre double sans que le nombre d'abonnés
     * bouge, c'est que trop de gens arrivent au dernier palier — donc que les
     * relances gratuites n'arrivent plus.
     */
    relances:
      relances === null
        ? null
        : coutDesRelances(relances, reglages.tarifs ?? {}, devisePrincipale),
  });
}
