import { describe, expect, it } from "vitest";

import { ajouterJours, cycleApresPaiement, jour } from "../cycle";
import { etatDe, PREAVIS_JOURS, type Etat } from "../etats";
import type { RequeteWeb } from "../web";
import { grille } from "../offre";
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
    suspenduLe: null,
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

describe("la grille tarifaire, par l'API", () => {
  it("ne montre que ce qu'on propose aujourd'hui", async () => {
    // Une offre retirée reste dans la grille — des abonnements en cours la
    // référencent — mais l'afficher ferait vendre ce qu'on ne vend plus.
    const f = fauxTableau([]);
    const api = routeurApi({
      tableau: f.tableau,
      jeton: JETON,
      offres: async () =>
        grille([
          { id: "a", libelle: "Pass", montant: 2000, devise: "XOF", cadence: "MENSUEL" },
          { id: "b", libelle: "Vieux", montant: 500, devise: "XOF", cadence: "MENSUEL", actif: false },
        ]),
    });

    const visibles = lire((await api(get("/offres"))).corps);
    expect((visibles["offres"] as unknown[]).length).toBe(1);

    const toutes = lire(
      (await api(get("/offres", { parametres: { toutes: "1" } }))).corps,
    );
    expect((toutes["offres"] as unknown[]).length).toBe(2);
  });

  it("répond 501 quand l'hôte ne l'a pas branchée, et non 404", async () => {
    // Un 404 ferait chercher une faute de frappe dans l'URL. La route existe.
    const f = fauxTableau([]);
    const r = await routeurApi({ tableau: f.tableau, jeton: JETON })(get("/offres"));

    expect(r.statut).toBe(501);
    expect(String(lire(r.corps)["erreur"])).toContain("offres");
  });
});

describe("les versements, par l'API", () => {
  const V = {
    id: "v1",
    abonnementId: "ab-1",
    fournisseur: "paystack",
    reference: "20260209-1-ab-1",
    montant: 2000,
    devise: "XOF",
    etat: "REUSSI",
    regleLe: MAINTENANT,
    compteLe: null,
    creeLe: MAINTENANT,
  };

  it("signale un versement réglé mais jamais compté", async () => {
    // C'est exactement ce qu'on cherche quand un abonné dit avoir payé : le
    // paiement a eu lieu, l'abonnement n'a pas avancé.
    const f = fauxTableau([ligne()]);
    const api = routeurApi({
      tableau: { ...f.tableau, versements: async () => [V] },
      jeton: JETON,
    });

    const corps = lire((await api(get("/abonnements/ab-1/versements"))).corps);
    const lignes = corps["lignes"] as Record<string, unknown>[];

    expect(lignes[0]!["regleNonCompte"]).toBe(true);
  });

  it("distingue un abonnement inconnu d'un abonnement sans versement", async () => {
    // Sans cette vérification, un identifiant inventé rendrait une liste vide,
    // indiscernable d'un abonné qui n'a jamais payé.
    const f = fauxTableau([ligne()]);
    const api = routeurApi({
      tableau: { ...f.tableau, versements: async () => [] },
      jeton: JETON,
    });

    expect((await api(get("/abonnements/ab-999/versements"))).statut).toBe(404);
    expect((await api(get("/abonnements/ab-1/versements"))).statut).toBe(200);
  });

  it("répond 501 quand l'hôte ne tient pas de registre", async () => {
    // Un hôte du niveau 1 peut ne garder que des abonnements et laisser les
    // paiements chez son fournisseur. L'exiger l'obligerait à écrire une
    // méthode qui rend un tableau vide, c'est-à-dire à mentir.
    const f = fauxTableau([ligne()]);
    const r = await routeurApi({ tableau: f.tableau, jeton: JETON })(
      get("/abonnements/ab-1/versements"),
    );

    expect(r.statut).toBe(501);
  });
});

describe("le résumé enrichi", () => {
  it("rend le taux de réussite des paiements de la période", async () => {
    // Pris isolément, un versement échoué ressemble à un abonné qui a changé
    // d'avis. C'est leur proportion qui parle.
    const f = fauxTableau([ligne()]);
    const api = routeurApi({
      tableau: {
        ...f.tableau,
        compterVersements: async () => ({ REUSSI: 8, ECHOUE: 2 }),
      },
      jeton: JETON,
    });

    const v = lire((await api(get("/resume"))).corps)["versements"] as Record<
      string,
      unknown
    >;

    expect(v["reussis"]).toBe(8);
    expect(v["echoues"]).toBe(2);
    expect(v["tauxDeReussite"]).toBeCloseTo(0.8, 5);
    expect(v["jours"]).toBe(30);
  });

  it("rend null plutôt que zéro quand rien n'a encore été conclu", async () => {
    // Un taux de 0 % sur zéro paiement ferait croire à une panne totale.
    const f = fauxTableau([ligne()]);
    const api = routeurApi({
      tableau: { ...f.tableau, compterVersements: async () => ({}) },
      jeton: JETON,
    });

    const v = lire((await api(get("/resume"))).corps)["versements"] as Record<
      string,
      unknown
    >;

    expect(v["tauxDeReussite"]).toBeNull();
  });

  it("omet la section quand l'hôte ne compte pas les versements", async () => {
    const f = fauxTableau([ligne()]);
    const api = routeurApi({ tableau: f.tableau, jeton: JETON });

    expect(lire((await api(get("/resume"))).corps)["versements"]).toBeNull();
  });
});

describe("les coordonnées de l'abonné", () => {
  it("voyagent avec la liste, parce qu'on relance quelqu'un", async () => {
    const f = fauxTableau([
      ligne({
        abonne: {
          reference: "usr-1",
          nom: "Awa",
          courriel: "awa@ndank.test",
          telephone: "+2250700000000",
        },
      }),
    ]);

    const api = routeurApi({ tableau: f.tableau, jeton: JETON });
    const corps = lire((await api(get("/abonnements"))).corps);
    const lignes = corps["lignes"] as Record<string, unknown>[];

    expect(lignes[0]!["abonne"]).toEqual({
      reference: "usr-1",
      nom: "Awa",
      courriel: "awa@ndank.test",
      telephone: "+2250700000000",
    });
  });

  it("valent null quand l'implémentation ne les joint pas", async () => {
    const f = fauxTableau([ligne()]);
    const api = routeurApi({ tableau: f.tableau, jeton: JETON });
    const corps = lire((await api(get("/abonnements"))).corps);

    expect((corps["lignes"] as Record<string, unknown>[])[0]!["abonne"]).toBeNull();
  });
});

describe("la santé du moteur, par l'API", () => {
  const battements = (trace: unknown) => ({
    async commencer() {
      return "p-1";
    },
    async terminer() {},
    async echouer() {},
    async dernier() {
      return trace as never;
    },
  });

  it("est la première chose qu'un tableau de bord doit lire", async () => {
    // Tous les autres chiffres de cette API sont justes — l'état se déduit des
    // dates. Mais ils ne disent pas si quelqu'un AGIT dessus. « 6 abonnés en
    // grâce » alors que le passage est arrêté depuis dix jours est pire qu'un
    // tableau de bord vide : cela donne l'impression que le système travaille.
    const f = fauxTableau([ligne()]);
    const api = routeurApi({
      tableau: f.tableau,
      jeton: JETON,
      battements: battements({
        id: "p-1",
        commenceLe: new Date(Date.now() - 50 * 3_600_000),
        termineLe: new Date(Date.now() - 50 * 3_600_000),
        vus: 0, relances: 0, suspendus: 0, clos: 0, injoignables: 0,
        echecs: 0, lotPlein: false, erreur: null,
      }),
    });

    const corps = lire((await api(get("/sante"))).corps);

    expect(corps["va"]).toBe("MUET");
    // Une phrase et son action, pas un mot seul.
    expect(String(corps["titre"])).toContain("Aucun passage");
    expect(String(corps["quoiFaire"])).toContain("relance");
  });

  it("dit « rien à faire » quand le moteur tourne", async () => {
    const f = fauxTableau([ligne()]);
    const api = routeurApi({
      tableau: f.tableau,
      jeton: JETON,
      battements: battements({
        id: "p-1",
        commenceLe: new Date(Date.now() - 2 * 3_600_000),
        termineLe: new Date(Date.now() - 2 * 3_600_000),
        vus: 12, relances: 3, suspendus: 0, clos: 0, injoignables: 0,
        echecs: 0, lotPlein: false, erreur: null,
      }),
    });

    const corps = lire((await api(get("/sante"))).corps);

    expect(corps["va"]).toBe("BIEN");
    expect(corps["quoiFaire"]).toBe("Rien à faire.");
  });

  it("distingue « jamais tourné » de « ne tourne plus »", async () => {
    const f = fauxTableau([ligne()]);
    const api = routeurApi({
      tableau: f.tableau,
      jeton: JETON,
      battements: battements(null),
    });

    const corps = lire((await api(get("/sante"))).corps);

    expect(corps["va"]).toBe("JAMAIS");
    expect(String(corps["quoiFaire"])).toContain("planifiée");
  });

  it("répond 501 quand l'hôte ne trace pas ses passages", async () => {
    // La route existe, l'hôte ne la sert pas. Un 404 ferait chercher une faute
    // de frappe dans l'URL.
    const f = fauxTableau([ligne()]);
    const r = await routeurApi({ tableau: f.tableau, jeton: JETON })(get("/sante"));

    expect(r.statut).toBe(501);
    expect(String(lire(r.corps)["erreur"])).toContain("passerEtTracer");
  });

  it("exige le jeton, comme le reste de l'API", async () => {
    const f = fauxTableau([ligne()]);
    const api = routeurApi({
      tableau: f.tableau,
      jeton: JETON,
      battements: battements(null),
    });

    expect((await api(get("/sante", { entetes: {} }))).statut).toBe(401);
  });
});

describe("l'argent, par l'API", () => {
  const argent = (sur: Partial<Tableau> = {}) => ({
    ...fauxTableau([ligne()]).tableau,
    async encaisse(depuis: Date) {
      // La période courante commence il y a moins de 31 jours ; la précédente
      // avant. C'est ce qui permet de distinguer les deux appels.
      const recente = Date.now() - depuis.getTime() < 31 * 86_400_000;
      return recente
        ? [{ devise: "XOF", total: 216_800, nombre: 43 }]
        : [{ devise: "XOF", total: 200_000, nombre: 40 }];
    },
    async recurrent() {
      return [
        { devise: "XOF", cadence: "MENSUEL", nombre: 38, total: 76_000 },
        { devise: "XOF", cadence: "ANNUEL", nombre: 2, total: 40_000 },
      ];
    },
    ...sur,
  });

  it("compare deux périodes, parce qu'un chiffre seul ne dit rien", async () => {
    // « 214 000 F encaissés ce mois » ne dit ni si c'est bien ni si c'est
    // inquiétant. C'est la comparaison qui parle.
    const api = routeurApi({ tableau: argent() as Tableau, jeton: JETON });

    const corps = lire((await api(get("/argent"))).corps);
    const lignes = corps["encaisse"] as Record<string, unknown>[];

    expect(lignes[0]!["total"]).toBe(216_800);
    expect(lignes[0]!["nombre"]).toBe(43);
    expect(lignes[0]!["evolution"]).toBe(8.4);
  });

  it("écrit le montant avec le bon nombre de décimales", async () => {
    // Le franc CFA n'en a pas. Afficher « 216 800,00 » ferait douter du
    // chiffre autant que de celui qui l'affiche.
    const api = routeurApi({ tableau: argent() as Tableau, jeton: JETON });

    const lignes = lire((await api(get("/argent"))).corps)["encaisse"] as Record<
      string,
      unknown
    >[];

    expect(String(lignes[0]!["lisible"])).not.toContain(",00");
  });

  it("ramène le récurrent au mois, toutes cadences confondues", async () => {
    const api = routeurApi({ tableau: argent() as Tableau, jeton: JETON });

    const lignes = lire((await api(get("/argent"))).corps)[
      "recurrentMensuel"
    ] as Record<string, unknown>[];

    expect(lignes[0]!["nombre"]).toBe(40);
    expect(lignes[0]!["total"]).toBe(76_000 + Math.round((40_000 * 30) / 365));
  });

  it("ventile par fournisseur quand l'hôte sait le faire", async () => {
    const api = routeurApi({
      tableau: argent({
        async encaisseParFournisseur() {
          return [
            { fournisseur: "paystack", devise: "XOF", total: 150_000, nombre: 30 },
            { fournisseur: "manuel", devise: "XOF", total: 66_800, nombre: 13 },
          ];
        },
      }) as Tableau,
      jeton: JETON,
    });

    const lignes = lire((await api(get("/argent"))).corps)[
      "parFournisseur"
    ] as Record<string, unknown>[];

    expect(lignes.map((l) => l["fournisseur"])).toEqual(["paystack", "manuel"]);
  });

  it("laisse choisir la fenêtre, et la borne", async () => {
    const api = routeurApi({ tableau: argent() as Tableau, jeton: JETON });

    expect(
      lire((await api(get("/argent", { parametres: { jours: "7" } }))).corps)["jours"],
    ).toBe(7);
    expect(
      lire((await api(get("/argent", { parametres: { jours: "9999" } }))).corps)["jours"],
    ).toBe(365);
  });

  it("répond 501 quand l'hôte ne tient pas de registre", async () => {
    const f = fauxTableau([ligne()]);
    const r = await routeurApi({ tableau: f.tableau, jeton: JETON })(get("/argent"));

    expect(r.statut).toBe(501);
  });

  it("reste séparée de /resume, qu'on interroge bien plus souvent", async () => {
    // `/resume` compte des abonnements : cinq requêtes indexées. L'argent
    // somme sur la table des versements, qui grossit sans fin. Les mélanger
    // ferait payer le prix du second à chaque affichage du premier.
    const f = fauxTableau([ligne()]);
    const api = routeurApi({ tableau: f.tableau, jeton: JETON });

    const resume = lire((await api(get("/resume"))).corps);

    expect(resume["encaisse"]).toBeUndefined();
    expect(resume["recurrentMensuel"]).toBeUndefined();
  });
});
