import { direSante, sante, type Battements, type ReglagesSante } from "./battement";

/**
 * Ndank — tout ce qui peut aller mal, dit en phrases.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE BATTEMENT NE RÉPOND QU'À UNE QUESTION
 *
 * `battement.ts` répond à « est-ce que le moteur tourne encore ». C'est la
 * question la plus importante, parce que sa réponse négative ne produit aucune
 * erreur — mais ce n'est pas la seule.
 *
 * Un moteur qui tourne parfaitement peut passer ses journées à ne rien faire :
 * la passerelle SMS refuse la clé depuis mardi, les webhooks arrivent avec une
 * signature qu'on rejette depuis le dernier déploiement, ou quarante abonnés
 * ont payé sans que leur abonnement soit prolongé. Rien de tout cela n'arrête
 * le passage quotidien. Tout cela se voit dans des compteurs que personne ne
 * regarde.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CHAQUE CONSTAT PORTE SON GESTE
 *
 * Même règle que `direSante`, et pour la même raison : un marchand qui lit des
 * compteurs pour décider fait notre travail. « 12 échecs d'envoi » n'aide
 * personne. « 12 relances n'ont pas pu partir hier, toutes en SMS » se comprend,
 * et « votre passerelle SMS refuse probablement la clé » dit quoi faire.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QU'ON NE SAIT PAS LIRE EST UN CONSTAT, PAS UN ZÉRO
 *
 * C'est le point qui vaut d'être écrit, parce que l'erreur inverse est
 * naturelle : si la requête qui compte les envois ratés échoue, on est tenté de
 * rendre zéro et de passer à la suite. Le tableau de bord afficherait alors
 * « tout va bien » sur la foi d'une question qu'on n'a pas pu poser.
 *
 * Un signal illisible devient donc un constat à part entière. Il vaut mieux
 * dire « on ne sait pas » que dire « rien », parce que « rien » se croit.
 */

/**
 * Combien c'est grave.
 *
 * Quatre niveaux et non trois : `ALERTE` et `ATTENTION` ne demandent pas la
 * même chose. Une passerelle qui refuse toutes les clés se règle aujourd'hui ;
 * douze abonnés sans adresse se règlent un jour ou l'autre. Les mettre au même
 * rang ferait que ni l'un ni l'autre ne serait traité.
 */
export type Gravite =
  /** Rien ne part. Le service est à l'arrêt, même si personne ne le voit. */
  | "PANNE"
  /** Quelque chose est cassé et coûte de l'argent ou des abonnés. Aujourd'hui. */
  | "ALERTE"
  /** À regarder, sans urgence. */
  | "ATTENTION"
  /** Pour information. */
  | "RIEN";

const RANG: Record<Gravite, number> = {
  PANNE: 0,
  ALERTE: 1,
  ATTENTION: 2,
  RIEN: 3,
};

/** Un fait, sa gravité, et le geste qui va avec. */
export interface Constat {
  /** De quoi il s'agit. Stable : un tableau de bord peut s'en servir de clé. */
  quoi:
    | "MOTEUR"
    | "ENVOIS"
    | "CANAL_MORT"
    | "PAIEMENTS_NON_COMPTES"
    | "SIGNATURES_REFUSEES"
    | "INJOIGNABLES"
    | "LOT_PLEIN"
    | "ECHECS_PASSAGE"
    | "PASSERELLES"
    | "ILLISIBLE";
  gravite: Gravite;
  titre: string;
  quoiFaire: string;
}

/** Ce qu'un canal a fait sur la période. */
export interface BilanCanal {
  canal: string;
  tentes: number;
  echoues: number;
}

/**
 * Les signaux que l'hôte sait lire.
 *
 * Tous facultatifs sauf le battement : un hôte du niveau 1 n'a ni journal, ni
 * webhooks, ni table de versements. Ce qu'il ne branche pas ne produit pas de
 * constat — et surtout pas un constat rassurant.
 */
export interface Signaux {
  battements: Battements;

  /** Les envois de la période, par canal. */
  envois?(depuis: Date, jusqua: Date): Promise<readonly BilanCanal[]>;

  /**
   * Combien de versements réussis n'ont jamais été comptés.
   *
   * C'est l'écart le plus cher du système : l'abonné a payé, l'argent est
   * arrivé, et son abonnement n'a pas bougé. Il va être relancé pour une somme
   * qu'il a déjà versée.
   */
  paiementsNonComptes?(depuis: Date): Promise<number>;

  /** Combien de webhooks ont été refusés faute de signature valable. */
  signaturesRefusees?(depuis: Date): Promise<number>;

  /** Combien d'abonnements à relancer n'ont aucun canal joignable. */
  injoignables?(): Promise<number>;

  /** Ce qui manque au câblage des passerelles. Voir `verifierEnvoi`. */
  passerelles?(): Promise<readonly string[]>;
}

export interface ReglagesBilan extends ReglagesSante {
  /** Sur combien d'heures on regarde les compteurs. Vingt-quatre par défaut. */
  fenetreHeures?: number;
}

/**
 * Tout ce qu'il y a à dire, du plus grave au moins grave.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ELLE NE LÈVE JAMAIS
 *
 * C'est la fonction qu'un tableau de bord appelle en haut de page. Si elle
 * levait, la page d'un marchand dont une seule requête de diagnostic échoue
 * n'afficherait plus rien — et il perdrait, avec elle, les huit autres constats
 * qui allaient bien.
 *
 * Chaque signal est donc isolé : ce qui échoue devient un constat `ILLISIBLE`,
 * et le reste est rendu quand même.
 */
export async function bilan(
  signaux: Signaux,
  reglages: ReglagesBilan = {},
  maintenant: Date = new Date(),
): Promise<readonly Constat[]> {
  const constats: Constat[] = [];
  const fenetre = reglages.fenetreHeures ?? 24;
  const depuis = new Date(maintenant.getTime() - fenetre * 3_600_000);

  // ── le moteur ─────────────────────────────────────────────────────────────
  //
  // En premier, et pas seulement dans l'affichage : quand il ne tourne plus,
  // tous les autres compteurs sont à zéro pour la même raison, et les lire
  // ferait croire à un calme qui n'est que du silence.
  let moteurMuet = false;

  await isoler(constats, "MOTEUR", async () => {
    const etat = await sante(signaux.battements, reglages, maintenant);
    const dit = direSante(etat);

    moteurMuet = etat.va !== "BIEN";

    constats.push({
      quoi: "MOTEUR",
      gravite: etat.va === "BIEN" ? "RIEN" : "PANNE",
      titre: dit.titre,
      quoiFaire: dit.quoiFaire,
    });

    // Le dernier passage porte deux choses qu'aucun autre signal ne dit.
    const trace = await signaux.battements.dernier();
    if (trace === null) return;

    if (trace.echecs > 0) {
      constats.push({
        quoi: "ECHECS_PASSAGE",
        gravite: trace.echecs >= trace.vus && trace.vus > 0 ? "ALERTE" : "ATTENTION",
        titre: `${trace.echecs} abonnement${sPluriel(trace.echecs)} sur ${trace.vus} ${
          trace.echecs > 1 ? "ont" : "a"
        } échoué au dernier passage.`,
        quoiFaire:
          "Le passage a continué sans eux — c'est voulu, un abonné fautif ne " +
          "doit pas arrêter les autres. Le détail est dans le journal.",
      });
    }

    if (trace.lotPlein) {
      // Ce constat n'existe nulle part ailleurs, et c'est une panne
      // silencieuse : le passage réussit, ses compteurs sont bons, et du
      // travail reste pourtant sur le côté tous les jours.
      constats.push({
        quoi: "LOT_PLEIN",
        gravite: "ATTENTION",
        titre: `Le dernier passage a traité un lot plein (${trace.vus}).`,
        quoiFaire:
          "Il restait probablement du travail : des abonnés n'ont pas été " +
          "relancés hier. Augmentez la taille du lot, ou faites tourner le " +
          "passage plus souvent.",
      });
    }
  });

  // ── les envois ────────────────────────────────────────────────────────────
  if (signaux.envois) {
    await isoler(constats, "ENVOIS", async () => {
      const bilans = await signaux.envois!(depuis, maintenant);
      const tentes = bilans.reduce((n, b) => n + b.tentes, 0);
      const echoues = bilans.reduce((n, b) => n + b.echoues, 0);

      // Un canal qui échoue *à tous les coups* n'est pas la même panne que des
      // échecs dispersés. Le second est la vie normale d'un réseau mobile ; le
      // premier est une clé refusée, un compte suspendu, un crédit épuisé — et
      // cela se règle aujourd'hui.
      for (const b of bilans) {
        if (b.tentes > 0 && b.echoues === b.tentes) {
          constats.push({
            quoi: "CANAL_MORT",
            gravite: "ALERTE",
            titre: `Aucun ${b.canal} n'est parti : ${b.tentes} tentative${sPluriel(
              b.tentes,
            )}, ${b.tentes} échec${sPluriel(b.tentes)}.`,
            quoiFaire:
              `La passerelle ${b.canal} refuse tout. Vérifiez la clé, le solde ` +
              "du compte et l'expéditeur déclaré — ce n'est pas un incident " +
              "réseau, c'est une configuration.",
          });
        }
      }

      const morts = new Set(
        bilans.filter((b) => b.tentes > 0 && b.echoues === b.tentes).map((b) => b.canal),
      );
      const disperses = bilans
        .filter((b) => !morts.has(b.canal))
        .reduce((n, b) => n + b.echoues, 0);

      if (disperses > 0) {
        constats.push({
          quoi: "ENVOIS",
          gravite: "ATTENTION",
          titre: `${disperses} relance${sPluriel(disperses)} sur ${tentes} n'${
            disperses > 1 ? "ont" : "a"
          } pas pu partir.`,
          quoiFaire:
            "Numéros invalides, boîtes pleines, jetons d'appareil périmés : " +
            "c'est la vie normale d'un envoi. À regarder si la part monte.",
        });
      }

      if (echoues === 0 && tentes > 0) {
        constats.push({
          quoi: "ENVOIS",
          gravite: "RIEN",
          titre: `${tentes} relance${sPluriel(tentes)} parties, aucune en échec.`,
          quoiFaire: "Rien à faire.",
        });
      }

      // Zéro tentative alors que le moteur tourne : soit personne n'était à
      // relancer, ce qui est une bonne nouvelle, soit l'échelle ne se déclenche
      // plus. On ne peut pas trancher d'ici, donc on ne dit rien plutôt que de
      // dire une chose ou l'autre à tort.
      if (tentes === 0 && !moteurMuet) {
        constats.push({
          quoi: "ENVOIS",
          gravite: "RIEN",
          titre: "Aucune relance à envoyer sur la période.",
          quoiFaire: "Rien à faire.",
        });
      }
    });
  }

  // ── l'argent arrivé qui n'a rien prolongé ─────────────────────────────────
  if (signaux.paiementsNonComptes) {
    await isoler(constats, "PAIEMENTS_NON_COMPTES", async () => {
      const n = await signaux.paiementsNonComptes!(depuis);
      if (n === 0) return;

      constats.push({
        quoi: "PAIEMENTS_NON_COMPTES",
        gravite: "ALERTE",
        titre: `${n} paiement${sPluriel(n)} ${
          n > 1 ? "ont" : "a"
        } réussi sans prolonger l'abonnement.`,
        quoiFaire:
          "L'argent est arrivé et le service n'a pas suivi : ces abonnés vont " +
          "être relancés pour une somme qu'ils ont déjà versée. Rapprochez " +
          "les versements avant qu'ils n'appellent.",
      });
    });
  }

  // ── les signatures ────────────────────────────────────────────────────────
  if (signaux.signaturesRefusees) {
    await isoler(constats, "SIGNATURES_REFUSEES", async () => {
      const n = await signaux.signaturesRefusees!(depuis);
      if (n === 0) return;

      constats.push({
        quoi: "SIGNATURES_REFUSEES",
        gravite: "ALERTE",
        titre: `${n} webhook${sPluriel(n)} refusé${sPluriel(n)} : signature invalide.`,
        quoiFaire:
          "Presque toujours un secret changé d'un seul côté. Tant qu'il ne " +
          "correspond pas, aucun paiement n'est confirmé automatiquement — et " +
          "les abonnés qui paient restent en attente.",
      });
    });
  }

  // ── les injoignables ──────────────────────────────────────────────────────
  if (signaux.injoignables) {
    await isoler(constats, "INJOIGNABLES", async () => {
      const n = await signaux.injoignables!();
      if (n === 0) return;

      constats.push({
        quoi: "INJOIGNABLES",
        gravite: "ATTENTION",
        titre: `${n} abonné${sPluriel(n)} à relancer n'${
          n > 1 ? "ont" : "a"
        } aucun moyen d'être joint${sPluriel(n)}.`,
        quoiFaire:
          "Ni adresse, ni numéro, ni appareil. Ils arriveront à échéance sans " +
          "avoir été prévenus une seule fois.",
      });
    });
  }

  // ── le câblage ────────────────────────────────────────────────────────────
  if (signaux.passerelles) {
    await isoler(constats, "PASSERELLES", async () => {
      const manques = await signaux.passerelles!();
      if (manques.length === 0) return;

      constats.push({
        quoi: "PASSERELLES",
        gravite: "ALERTE",
        titre: `${manques.length} ${
          manques.length > 1 ? "canaux" : "canal"
        } sans passerelle : ${manques.join(", ")}.`,
        quoiFaire:
          "Ndank ne lèvera pas — un canal sans transporteur est simplement " +
          "sauté — mais l'échelle de relance perd un barreau, en silence.",
      });
    });
  }

  return constats.sort((a, b) => RANG[a.gravite] - RANG[b.gravite]);
}

/**
 * Le pire des constats, pour la ligne unique en haut de page.
 *
 * `RIEN` quand il n'y a rien, et non `null` : un appelant qui doit distinguer
 * « aucun constat » de « tout va bien » finira par afficher une page vide le
 * jour où tout va bien.
 */
export function pire(constats: readonly Constat[]): Gravite {
  return constats.reduce<Gravite>(
    (acquis, c) => (RANG[c.gravite] < RANG[acquis] ? c.gravite : acquis),
    "RIEN",
  );
}

/**
 * Exécute un signal sans le laisser emporter les autres.
 *
 * Ce qui échoue devient un constat `ILLISIBLE` : dire « on ne sait pas » vaut
 * mieux que rendre zéro, parce que zéro se croit.
 */
async function isoler(
  constats: Constat[],
  quoi: Constat["quoi"],
  travail: () => Promise<void>,
): Promise<void> {
  try {
    await travail();
  } catch (cause) {
    constats.push({
      quoi: "ILLISIBLE",
      gravite: "ATTENTION",
      titre: `Impossible de vérifier : ${quoi}.`,
      quoiFaire:
        `Le diagnostic lui-même a échoué (${String(cause).slice(0, 200)}). ` +
        "Cela ne veut pas dire que tout va bien à cet endroit — cela veut dire " +
        "qu'on n'en sait rien.",
    });
  }
}

function sPluriel(n: number): string {
  return n > 1 ? "s" : "";
}
