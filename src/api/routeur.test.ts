import { describe, expect, it } from "vitest";

import { ajouterJours, cycleApresPaiement, jour } from "../cycle";
import { etatDe, PREAVIS_JOURS, type Etat } from "../etats";
import type { RequeteWeb } from "../page/port";
import { routeurApi } from "./routeur";
import { bornesDe, type Bornes, type LigneTableau, type Tableau } from "./tableau";

const JETON = "jeton-de-tableau-de-bord";
// L'horloge réelle : le routeur appelle `new Date()`, et c'est ce qu'il doit
// faire. Ancrer les fixtures à une date fixe les ferait vieillir toutes seules.
const MAINTENANT = new Date();

function ligne(sur: Partial<LigneTableau> = {}): LigneTableau {
  const cycle = cycleApresPaiement(ajouterJours(MAINTENANT, -30), "MENSUEL");

  return {
    id: "ab-1",
    abonneId: "user-1",
    libelle: "Pass Créateur",
    montant: 2000,
    devise: "XOF",
    cadence: "MENSUEL",
    echeance: cycle.echeance,
    accesJusquA: cycle.accesJusquA,
    repriseJusquA: cycle.repriseJusquA,
    resilieeLe: null,
    closLe: null,
    ...sur,
  };
}

/**
 * Un tableau en mémoire qui applique vraiment les bornes.
 *
 * C'est ce qui permet de vérifier que la traduction d'un état en dates donne le
 * même verdict que `etatDe` — sans quoi le tableau de bord annoncerait des
 * chiffres que le moteur ne reconnaîtrait pas.
 */
function fauxTableau(lignes: LigneTableau[]) {
  const bornesVues: Bornes[] = [];

  const garde = (l: LigneTableau, b: Bornes): boolean => {
    if (b.resiliee === true && l.resilieeLe === null) return false;
    if (b.resiliee === false && l.resilieeLe !== null) return false;
    if (b.close === true && l.closLe === null) return false;
    if (b.close === false && l.closLe !== null) return false;

    const test = (
      valeur: Date,
      borne: { avant?: Date; apres?: Date } | undefined,
    ): boolean => {
      if (!borne) return true;
      if (borne.avant && !(valeur < borne.avant)) return false;
      if (borne.apres && !(valeur >= borne.apres)) return false;
      return true;
    };

    return (
      test(l.echeance, b.echeance) &&
      test(l.accesJusquA, b.accesJusquA) &&
      test(l.repriseJusquA, b.repriseJusquA)
    );
  };

  const tableau: Tableau = {
    async compter(bornes) {
      bornesVues.push(bornes);
      return lignes.filter((l) => garde(l, bornes)).length;
    },
    async lister(bornes, page) {
      bornesVues.push(bornes);
      return lignes
        .filter((l) => garde(l, bornes))
        .sort((a, b) => a.echeance.getTime() - b.echeance.getTime())
        .slice(page.depuis, page.depuis + page.combien);
    },
    async ligne(id) {
      return lignes.find((l) => l.id === id) ?? null;
    },
  };

  return { tableau, bornesVues };
}

function get(chemin: string, sur: Partial<RequeteWeb> = {}): RequeteWeb {
  return {
    methode: "GET",
    chemin,
    parametres: {},
    corps: "",
    entetes: { authorization: `Bearer ${JETON}` },
    ...sur,
  };
}

function lire(corps: string): Record<string, unknown> {
  return JSON.parse(corps) as Record<string, unknown>;
}

describe("l'API ne sait que lire", () => {
  it("refuse toute méthode qui écrit, même déclarée", async () => {
    // C'est la moitié de la raison d'être de cette API. Le tableau de bord est
    // une application distribuée : son jeton est extractible, et tout ce qu'elle
    // peut faire, quiconque tient ce jeton peut le faire. Il n'y a donc rien à
    // restreindre — il n'y a rien qui écrit.
    const f = fauxTableau([ligne()]);
    const api = routeurApi({ tableau: f.tableau, jeton: JETON });

    for (const methode of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await api(get("/abonnements", { methode }));
      expect(r.statut).toBe(405);
    }
  });

  it("refuse de se construire sans jeton", async () => {
    // Au démarrage, et non au premier appel : le premier appel viendrait du
    // tableau de bord, mais le second pourrait venir de n'importe qui.
    const f = fauxTableau([]);
    expect(() => routeurApi({ tableau: f.tableau, jeton: "  " })).toThrow(
      /jeton est obligatoire/,
    );
  });

  it("refuse un jeton absent, vide ou faux", async () => {
    // Chaque ligne dit ce que telle personne doit, à quoi elle est abonnée, et
    // depuis combien de temps elle est en retard.
    const f = fauxTableau([ligne()]);
    const api = routeurApi({ tableau: f.tableau, jeton: JETON });

    expect((await api(get("/resume", { entetes: {} }))).statut).toBe(401);
    expect(
      (await api(get("/resume", { entetes: { authorization: "Bearer x" } })))
        .statut,
    ).toBe(401);
    expect(
      (await api(get("/resume", { entetes: { authorization: JETON } }))).statut,
    ).toBe(401);
  });
});

describe("la traduction d'un état en dates", () => {
  it("donne le même verdict que le moteur, pour les cinq états", async () => {
    // La vérification qui compte. L'état n'existe pas en base — il se déduit —
    // donc une requête filtre sur des dates, et c'est Ndank qui traduit. Deux
    // traductions divergentes feraient annoncer au tableau de bord des chiffres
    // que le moteur ne reconnaîtrait pas.
    const cas: { etat: Etat; l: LigneTableau }[] = [
      { etat: "ACTIVE", l: ligne({ id: "actif", ...deCycle(MAINTENANT) }) },
      {
        etat: "A_RENOUVELER",
        l: ligne({
          id: "a-relancer",
          ...deCycle(ajouterJours(MAINTENANT, -PREAVIS_JOURS - 24)),
        }),
      },
      {
        etat: "SUSPENDUE",
        l: ligne({ id: "suspendu", ...deCycle(ajouterJours(MAINTENANT, -40)) }),
      },
      {
        etat: "EXPIREE",
        l: ligne({ id: "expire", ...deCycle(ajouterJours(MAINTENANT, -70)) }),
      },
      {
        etat: "RESILIEE",
        l: ligne({ id: "resilie", resilieeLe: ajouterJours(MAINTENANT, -3) }),
      },
    ];

    for (const { etat, l } of cas) {
      // Le moteur et la traduction doivent tomber d'accord sur cette ligne.
      expect(
        etatDe(
          {
            cycle: {
              debut: l.echeance,
              echeance: l.echeance,
              accesJusquA: l.accesJusquA,
              repriseJusquA: l.repriseJusquA,
            },
            resilieeLe: l.resilieeLe,
          },
          MAINTENANT,
        ),
      ).toBe(etat);

      const f = fauxTableau(cas.map((c) => c.l));
      expect(await f.tableau.compter(bornesDe(etat, MAINTENANT))).toBe(1);
    }
  });

  it("écarte les résiliés de tous les autres états", async () => {
    // `etatDe` rend RESILIEE avant même de regarder les dates. La traduction
    // suit la même première ligne, sinon un résilié serait compté deux fois.
    const resilie = ligne({
      id: "resilie",
      ...deCycle(ajouterJours(MAINTENANT, -70)),
      resilieeLe: ajouterJours(MAINTENANT, -3),
    });

    const f = fauxTableau([resilie]);

    expect(await f.tableau.compter(bornesDe("EXPIREE", MAINTENANT))).toBe(0);
    expect(await f.tableau.compter(bornesDe("RESILIEE", MAINTENANT))).toBe(1);
  });
});

describe("le résumé", () => {
  it("compte par état, et dit combien ont vraiment accès", async () => {
    const f = fauxTableau([
      ligne({ id: "a", ...deCycle(MAINTENANT) }),
      ligne({ id: "b", ...deCycle(ajouterJours(MAINTENANT, -31)) }),
      ligne({ id: "c", ...deCycle(ajouterJours(MAINTENANT, -40)) }),
    ]);

    const api = routeurApi({ tableau: f.tableau, jeton: JETON });
    const corps = lire((await api(get("/resume"))).corps);
    const comptes = corps["comptes"] as Record<string, number>;

    expect(comptes["ACTIVE"]).toBe(1);
    expect(comptes["A_RENOUVELER"]).toBe(1);
    expect(comptes["SUSPENDUE"]).toBe(1);
    // Le chiffre qui compte : ceux qui ont accès au service, maintenant.
    expect(corps["actifs"]).toBe(2);
    expect(corps["aRattraper"]).toBe(2);
  });
});

describe("la liste", () => {
  it("calcule l'état à la réponse, et ne le lit jamais d'une colonne", async () => {
    const f = fauxTableau([ligne({ ...deCycle(ajouterJours(MAINTENANT, -40)) })]);
    const api = routeurApi({ tableau: f.tableau, jeton: JETON });

    const corps = lire((await api(get("/abonnements"))).corps);
    const lignes = corps["lignes"] as Record<string, unknown>[];

    expect(lignes[0]!["etat"]).toBe("SUSPENDUE");
    expect(lignes[0]!["joursRestants"]).toBeLessThan(0);
  });

  it("rend les plus urgents d'abord", async () => {
    // Même ordre que `aRelancer`, et pour la même raison : quand on ne voit
    // qu'une page, il faut que ce soit celle qui demande une décision.
    const f = fauxTableau([
      ligne({ id: "loin", ...deCycle(MAINTENANT) }),
      ligne({ id: "proche", ...deCycle(ajouterJours(MAINTENANT, -29)) }),
    ]);

    const api = routeurApi({ tableau: f.tableau, jeton: JETON });
    const corps = lire((await api(get("/abonnements"))).corps);
    const lignes = corps["lignes"] as Record<string, unknown>[];

    expect(lignes[0]!["id"]).toBe("proche");
  });

  it("borne la taille d'une page", async () => {
    const f = fauxTableau([ligne()]);
    const api = routeurApi({ tableau: f.tableau, jeton: JETON });

    const corps = lire(
      (await api(get("/abonnements", { parametres: { combien: "100000" } })))
        .corps,
    );

    expect(corps["combien"]).toBe(100);
  });

  it("écarte par défaut les résiliés et les clos", async () => {
    // Rendre tout le fichier par défaut ferait payer une lecture complète à
    // chaque ouverture du tableau de bord.
    const f = fauxTableau([ligne()]);
    const api = routeurApi({ tableau: f.tableau, jeton: JETON });

    await api(get("/abonnements"));

    expect(f.bornesVues[0]).toEqual({ resiliee: false, close: false });
  });

  it("refuse un état qu'il ne connaît pas, et dit lesquels il connaît", async () => {
    const f = fauxTableau([ligne()]);
    const api = routeurApi({ tableau: f.tableau, jeton: JETON });

    const r = await api(get("/abonnements", { parametres: { etat: "PAYEE" } }));

    expect(r.statut).toBe(400);
    expect(lire(r.corps)["connus"]).toContain("SUSPENDUE");
  });
});

describe("un abonnement", () => {
  it("se lit par son identifiant", async () => {
    const f = fauxTableau([ligne()]);
    const api = routeurApi({ tableau: f.tableau, jeton: JETON });

    const r = await api(get("/abonnements/ab-1"));

    expect(r.statut).toBe(200);
    expect(lire(r.corps)["libelle"]).toBe("Pass Créateur");
  });

  it("rend 404 sur un identifiant inconnu", async () => {
    const f = fauxTableau([ligne()]);
    const api = routeurApi({ tableau: f.tableau, jeton: JETON });

    expect((await api(get("/abonnements/ab-999"))).statut).toBe(404);
  });
});

/** Un cycle dont le paiement est tombé à cette date. */
function deCycle(paiement: Date): Pick<
  LigneTableau,
  "echeance" | "accesJusquA" | "repriseJusquA"
> {
  const c = cycleApresPaiement(jour(paiement), "MENSUEL");
  return {
    echeance: c.echeance,
    accesJusquA: c.accesJusquA,
    repriseJusquA: c.repriseJusquA,
  };
}
