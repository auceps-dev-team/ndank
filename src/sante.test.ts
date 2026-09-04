import { describe, expect, it } from "vitest";

import type { Battements, Trace } from "./battement";
import { bilan, pire, type Constat, type Signaux } from "./sante";

const MAINTENANT = new Date("2026-02-09T06:00:00Z");

function trace(sur: Partial<Trace> = {}): Trace {
  return {
    id: "p-1",
    commenceLe: new Date("2026-02-09T05:00:00Z"),
    termineLe: new Date("2026-02-09T05:00:12Z"),
    vus: 120,
    relances: 14,
    suspendus: 2,
    clos: 1,
    injoignables: 0,
    echecs: 0,
    lotPlein: false,
    erreur: null,
    ...sur,
  };
}

function battements(derniere: Trace | null = trace()): Battements {
  return {
    async commencer() {
      return "p-1";
    },
    async terminer() {},
    async echouer() {},
    async dernier() {
      return derniere;
    },
  };
}

/** Le constat portant cette clé, ou `undefined`. */
function celui(constats: readonly Constat[], quoi: Constat["quoi"]) {
  return constats.find((c) => c.quoi === quoi);
}

function tous(constats: readonly Constat[], quoi: Constat["quoi"]) {
  return constats.filter((c) => c.quoi === quoi);
}

describe("le moteur", () => {
  it("dit que tout va bien, sans se taire", async () => {
    // Un tableau de bord qui n'affiche rien quand tout va bien laisse le
    // marchand se demander si la page est cassée.
    const c = await bilan({ battements: battements() }, {}, MAINTENANT);

    expect(celui(c, "MOTEUR")?.gravite).toBe("RIEN");
    expect(celui(c, "MOTEUR")?.titre).toMatch(/Dernier passage/);
  });

  it("crie quand le passage ne tourne plus", async () => {
    const vieux = trace({
      commenceLe: new Date("2026-02-05T05:00:00Z"),
      termineLe: new Date("2026-02-05T05:00:12Z"),
    });

    const c = await bilan({ battements: battements(vieux) }, {}, MAINTENANT);

    expect(celui(c, "MOTEUR")?.gravite).toBe("PANNE");
    expect(celui(c, "MOTEUR")?.quoiFaire).toMatch(/plus une relance ne part/);
  });

  it("crie quand aucun passage n'a jamais tourné", async () => {
    const c = await bilan({ battements: battements(null) }, {}, MAINTENANT);

    expect(celui(c, "MOTEUR")?.gravite).toBe("PANNE");
    expect(celui(c, "MOTEUR")?.titre).toMatch(/jamais tourné/);
  });

  it("crie quand le dernier passage est tombé", async () => {
    const c = await bilan(
      { battements: battements(trace({ erreur: "ECONNREFUSED" })) },
      {},
      MAINTENANT,
    );

    expect(celui(c, "MOTEUR")?.gravite).toBe("PANNE");
    expect(celui(c, "MOTEUR")?.quoiFaire).toContain("ECONNREFUSED");
  });
});

describe("ce que le dernier passage porte, et que rien d'autre ne dit", () => {
  it("signale les abonnements qui ont échoué, sans dramatiser", async () => {
    const c = await bilan(
      { battements: battements(trace({ echecs: 3, vus: 120 })) },
      {},
      MAINTENANT,
    );

    expect(celui(c, "ECHECS_PASSAGE")?.gravite).toBe("ATTENTION");
    expect(celui(c, "ECHECS_PASSAGE")?.titre).toBe(
      "3 abonnements sur 120 ont échoué au dernier passage.",
    );
  });

  it("passe en alerte quand tout le passage a échoué", async () => {
    // Trois sur cent vingt est la vie normale. Cent vingt sur cent vingt est
    // une cause unique, et elle ne se corrigera pas toute seule.
    const c = await bilan(
      { battements: battements(trace({ echecs: 120, vus: 120 })) },
      {},
      MAINTENANT,
    );

    expect(celui(c, "ECHECS_PASSAGE")?.gravite).toBe("ALERTE");
  });

  it("ne dit rien quand aucun abonnement n'a échoué", async () => {
    const c = await bilan({ battements: battements() }, {}, MAINTENANT);

    expect(celui(c, "ECHECS_PASSAGE")).toBeUndefined();
  });

  it("accorde le verbe au singulier", async () => {
    const c = await bilan(
      { battements: battements(trace({ echecs: 1, vus: 120 })) },
      {},
      MAINTENANT,
    );

    expect(celui(c, "ECHECS_PASSAGE")?.titre).toBe(
      "1 abonnement sur 120 a échoué au dernier passage.",
    );
  });

  it("signale un lot plein, qui est une panne silencieuse", async () => {
    // Le passage réussit, ses compteurs sont bons, et du travail reste sur le
    // côté tous les jours. Aucun autre signal ne le dit.
    const c = await bilan(
      { battements: battements(trace({ lotPlein: true, vus: 500 })) },
      {},
      MAINTENANT,
    );

    expect(celui(c, "LOT_PLEIN")?.gravite).toBe("ATTENTION");
    expect(celui(c, "LOT_PLEIN")?.titre).toContain("500");
    expect(celui(c, "LOT_PLEIN")?.quoiFaire).toMatch(/n'ont pas été relancés/);
  });
});

describe("les envois", () => {
  function avecEnvois(bilans: Array<{ canal: string; tentes: number; echoues: number }>) {
    return {
      battements: battements(),
      async envois() {
        return bilans;
      },
    } satisfies Signaux;
  }

  it("distingue un canal mort d'échecs dispersés", async () => {
    // Trois SMS ratés sur cinquante est un réseau mobile. Cinquante sur
    // cinquante est une clé refusée, un compte suspendu, un crédit épuisé — et
    // cela se règle aujourd'hui.
    const c = await bilan(
      avecEnvois([
        { canal: "SMS", tentes: 50, echoues: 50 },
        { canal: "courriel", tentes: 80, echoues: 3 },
      ]),
      {},
      MAINTENANT,
    );

    expect(celui(c, "CANAL_MORT")?.gravite).toBe("ALERTE");
    expect(celui(c, "CANAL_MORT")?.titre).toContain("SMS");
    expect(celui(c, "CANAL_MORT")?.quoiFaire).toMatch(/configuration/);

    expect(celui(c, "ENVOIS")?.gravite).toBe("ATTENTION");
    expect(celui(c, "ENVOIS")?.titre).toBe(
      "3 relances sur 130 n'ont pas pu partir.",
    );
  });

  it("ne compte pas deux fois les échecs d'un canal mort", async () => {
    // Sans cette soustraction, cinquante SMS morts seraient annoncés une
    // première fois comme canal mort, puis une seconde comme « échecs
    // dispersés » — et le marchand chercherait deux pannes là où il n'y en a
    // qu'une.
    const c = await bilan(
      avecEnvois([{ canal: "SMS", tentes: 50, echoues: 50 }]),
      {},
      MAINTENANT,
    );

    expect(celui(c, "CANAL_MORT")).toBeDefined();
    expect(tous(c, "ENVOIS").filter((x) => x.gravite === "ATTENTION")).toHaveLength(
      0,
    );
  });

  it("signale chaque canal mort séparément", async () => {
    const c = await bilan(
      avecEnvois([
        { canal: "SMS", tentes: 50, echoues: 50 },
        { canal: "push", tentes: 12, echoues: 12 },
      ]),
      {},
      MAINTENANT,
    );

    expect(tous(c, "CANAL_MORT")).toHaveLength(2);
  });

  it("dit que tout est parti quand tout est parti", async () => {
    const c = await bilan(
      avecEnvois([{ canal: "courriel", tentes: 80, echoues: 0 }]),
      {},
      MAINTENANT,
    );

    expect(celui(c, "ENVOIS")?.gravite).toBe("RIEN");
    expect(celui(c, "ENVOIS")?.titre).toBe("80 relances parties, aucune en échec.");
  });

  it("ne prend pas zéro envoi pour une panne quand le moteur tourne", async () => {
    // Zéro tentative peut vouloir dire « personne n'était à relancer », qui est
    // une bonne nouvelle, ou « l'échelle ne se déclenche plus ». On ne peut pas
    // trancher d'ici, donc on ne dit ni l'un ni l'autre.
    const c = await bilan(avecEnvois([]), {}, MAINTENANT);

    expect(celui(c, "ENVOIS")?.gravite).toBe("RIEN");
    expect(celui(c, "ENVOIS")?.titre).toMatch(/Aucune relance à envoyer/);
  });

  it("se tait sur les envois quand c'est le moteur qui est muet", async () => {
    // Quand le passage ne tourne plus, tous les compteurs sont à zéro pour la
    // même raison. Annoncer « aucune relance à envoyer » ferait passer la
    // conséquence de la panne pour une bonne nouvelle.
    const mort = trace({
      commenceLe: new Date("2026-02-05T05:00:00Z"),
      termineLe: new Date("2026-02-05T05:00:12Z"),
    });

    const c = await bilan(
      { battements: battements(mort), async envois() { return []; } },
      {},
      MAINTENANT,
    );

    expect(celui(c, "MOTEUR")?.gravite).toBe("PANNE");
    expect(celui(c, "ENVOIS")).toBeUndefined();
  });

  it("passe la fenêtre demandée au signal", async () => {
    let vu: [Date, Date] | null = null;

    await bilan(
      {
        battements: battements(),
        async envois(depuis, jusqua) {
          vu = [depuis, jusqua];
          return [];
        },
      },
      { fenetreHeures: 48 },
      MAINTENANT,
    );

    expect(vu![0]).toEqual(new Date("2026-02-07T06:00:00Z"));
    expect(vu![1]).toEqual(MAINTENANT);
  });

  it("regarde vingt-quatre heures par défaut", async () => {
    let depuis: Date | null = null;

    await bilan(
      {
        battements: battements(),
        async envois(d) {
          depuis = d;
          return [];
        },
      },
      {},
      MAINTENANT,
    );

    expect(depuis!).toEqual(new Date("2026-02-08T06:00:00Z"));
  });
});

describe("l'argent arrivé qui n'a rien prolongé", () => {
  it("alerte, parce que l'abonné va être relancé pour ce qu'il a payé", async () => {
    const c = await bilan(
      {
        battements: battements(),
        async paiementsNonComptes() {
          return 4;
        },
      },
      {},
      MAINTENANT,
    );

    expect(celui(c, "PAIEMENTS_NON_COMPTES")?.gravite).toBe("ALERTE");
    expect(celui(c, "PAIEMENTS_NON_COMPTES")?.titre).toBe(
      "4 paiements ont réussi sans prolonger l'abonnement.",
    );
    expect(celui(c, "PAIEMENTS_NON_COMPTES")?.quoiFaire).toMatch(
      /déjà versée/,
    );
  });

  it("ne dit rien quand il n'y en a pas", async () => {
    const c = await bilan(
      {
        battements: battements(),
        async paiementsNonComptes() {
          return 0;
        },
      },
      {},
      MAINTENANT,
    );

    expect(celui(c, "PAIEMENTS_NON_COMPTES")).toBeUndefined();
  });
});

describe("les signatures refusées", () => {
  it("dit la cause la plus fréquente plutôt que le symptôme", async () => {
    const c = await bilan(
      {
        battements: battements(),
        async signaturesRefusees() {
          return 17;
        },
      },
      {},
      MAINTENANT,
    );

    expect(celui(c, "SIGNATURES_REFUSEES")?.gravite).toBe("ALERTE");
    expect(celui(c, "SIGNATURES_REFUSEES")?.quoiFaire).toMatch(
      /secret changé d'un seul côté/,
    );
  });
});

describe("les injoignables", () => {
  it("dit ce qui va leur arriver, et non juste leur nombre", async () => {
    const c = await bilan(
      {
        battements: battements(),
        async injoignables() {
          return 12;
        },
      },
      {},
      MAINTENANT,
    );

    expect(celui(c, "INJOIGNABLES")?.gravite).toBe("ATTENTION");
    expect(celui(c, "INJOIGNABLES")?.quoiFaire).toMatch(/sans avoir été prévenus/);
  });
});

describe("le câblage des passerelles", () => {
  it("dit qu'un canal sans transporteur perd un barreau en silence", async () => {
    const c = await bilan(
      {
        battements: battements(),
        async passerelles() {
          return ["SMS"];
        },
      },
      {},
      MAINTENANT,
    );

    expect(celui(c, "PASSERELLES")?.gravite).toBe("ALERTE");
    expect(celui(c, "PASSERELLES")?.titre).toBe("1 canal sans passerelle : SMS.");
  });

  it("accorde « canaux » au pluriel", async () => {
    const c = await bilan(
      {
        battements: battements(),
        async passerelles() {
          return ["SMS", "push"];
        },
      },
      {},
      MAINTENANT,
    );

    expect(celui(c, "PASSERELLES")?.titre).toBe(
      "2 canaux sans passerelle : SMS, push.",
    );
  });
});

describe("ce qu'on ne sait pas lire", () => {
  it("le dit, au lieu de rendre zéro", async () => {
    // Le tableau de bord afficherait sinon « tout va bien » sur la foi d'une
    // question qu'on n'a pas pu poser.
    const c = await bilan(
      {
        battements: battements(),
        async paiementsNonComptes(): Promise<number> {
          throw new Error("relation « versement » inconnue");
        },
      },
      {},
      MAINTENANT,
    );

    expect(celui(c, "ILLISIBLE")?.gravite).toBe("ATTENTION");
    expect(celui(c, "ILLISIBLE")?.titre).toContain("PAIEMENTS_NON_COMPTES");
    expect(celui(c, "ILLISIBLE")?.quoiFaire).toMatch(/on n'en sait rien/);
  });

  it("n'emporte pas les autres constats", async () => {
    // Si elle levait, la page d'un marchand dont une seule requête échoue
    // n'afficherait plus rien — et il perdrait les huit autres constats.
    const c = await bilan(
      {
        battements: battements(),
        async signaturesRefusees(): Promise<number> {
          throw new Error("boum");
        },
        async injoignables() {
          return 5;
        },
      },
      {},
      MAINTENANT,
    );

    expect(celui(c, "MOTEUR")).toBeDefined();
    expect(celui(c, "INJOIGNABLES")).toBeDefined();
    expect(celui(c, "ILLISIBLE")).toBeDefined();
  });

  it("survit même à un battement illisible", async () => {
    const c = await bilan(
      {
        battements: {
          ...battements(),
          async dernier(): Promise<Trace | null> {
            throw new Error("base injoignable");
          },
        },
        async injoignables() {
          return 5;
        },
      },
      {},
      MAINTENANT,
    );

    expect(celui(c, "ILLISIBLE")?.titre).toContain("MOTEUR");
    expect(celui(c, "INJOIGNABLES")).toBeDefined();
  });
});

describe("ce qui n'est pas branché", () => {
  it("ne produit aucun constat, et surtout pas un constat rassurant", async () => {
    // Un hôte du niveau 1 n'a ni journal, ni webhooks, ni table de versements.
    // Lui annoncer « 0 paiement non compté » lui ferait croire qu'on a vérifié.
    const c = await bilan({ battements: battements() }, {}, MAINTENANT);

    expect(celui(c, "PAIEMENTS_NON_COMPTES")).toBeUndefined();
    expect(celui(c, "SIGNATURES_REFUSEES")).toBeUndefined();
    expect(celui(c, "INJOIGNABLES")).toBeUndefined();
    expect(celui(c, "PASSERELLES")).toBeUndefined();
    expect(celui(c, "ENVOIS")).toBeUndefined();
    expect(c.map((x) => x.quoi)).toEqual(["MOTEUR"]);
  });
});

describe("l'ordre et le pire", () => {
  it("met le plus grave en premier", async () => {
    const mort = trace({
      commenceLe: new Date("2026-02-05T05:00:00Z"),
      termineLe: new Date("2026-02-05T05:00:12Z"),
    });

    const c = await bilan(
      {
        battements: battements(mort),
        async injoignables() {
          return 3;
        },
        async paiementsNonComptes() {
          return 2;
        },
      },
      {},
      MAINTENANT,
    );

    expect(c.map((x) => x.gravite)).toEqual(["PANNE", "ALERTE", "ATTENTION"]);
  });

  it("rend RIEN quand il n'y a rien, et non null", async () => {
    // Un appelant qui doit distinguer « aucun constat » de « tout va bien »
    // finira par afficher une page vide le jour où tout va bien.
    expect(pire([])).toBe("RIEN");
  });

  it("rend le pire, et non le premier", async () => {
    expect(
      pire([
        { quoi: "ENVOIS", gravite: "RIEN", titre: "", quoiFaire: "" },
        { quoi: "MOTEUR", gravite: "PANNE", titre: "", quoiFaire: "" },
        { quoi: "INJOIGNABLES", gravite: "ATTENTION", titre: "", quoiFaire: "" },
      ]),
    ).toBe("PANNE");
  });
});

describe("chaque constat se lit sans avoir écrit ce code", () => {
  it("porte toujours une phrase et un geste", async () => {
    const c = await bilan(
      {
        battements: battements(trace({ echecs: 2, lotPlein: true })),
        async envois() {
          return [
            { canal: "SMS", tentes: 50, echoues: 50 },
            { canal: "courriel", tentes: 80, echoues: 4 },
          ];
        },
        async paiementsNonComptes() {
          return 1;
        },
        async signaturesRefusees() {
          return 2;
        },
        async injoignables() {
          return 3;
        },
        async passerelles() {
          return ["push"];
        },
      },
      {},
      MAINTENANT,
    );

    expect(c.length).toBeGreaterThan(6);

    for (const constat of c) {
      expect(constat.titre.length).toBeGreaterThan(10);
      expect(constat.quoiFaire.length).toBeGreaterThan(10);
      // Une phrase, pas un identifiant : elle finit par un point.
      expect(constat.titre.trim().endsWith(".")).toBe(true);
    }
  });
});
