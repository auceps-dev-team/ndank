import { describe, expect, it } from "vitest";

import { ajouterJours, cleDeCycle, cycleApresPaiement, joursEntre } from "../cycle";
import type { AbonnementLu } from "../ports";
import type { Issue } from "./port";
import {
  CREANCE_VIERGE,
  cycleDeReference,
  lireReference,
  reconcilier,
  referencePour,
  referenceDeVersement,
  type Creances,
  type EtatCreance,
} from "./reconciliation";

const DEPART = new Date("2026-01-10T00:00:00Z");

function abonnement(): AbonnementLu {
  return {
    id: "ab-1",
    abonneId: "user-1",
    cadence: "MENSUEL",
    cycle: cycleApresPaiement(DEPART, "MENSUEL"),
    resilieeLe: null,
    montant: 2000,
    devise: "XOF",
    libelle: "Pass Créateur",
  };
}

/** Des créances en mémoire, comme le faux de ports du cœur. */
function faussesCreances(depart: Partial<EtatCreance> = {}, comptes: string[] = []) {
  const etat: EtatCreance = { ...CREANCE_VIERGE, ...depart };
  const vus = new Set(comptes);

  const creances: Creances = {
    async etat() {
      return etat;
    },
    async dejaCompte(id) {
      return vus.has(id);
    },
  };

  return { creances, etat, vus };
}

function issue(partiel: Partial<Issue> = {}): Issue {
  const a = abonnement();
  return {
    reference: referenceDeVersement(a.id, a.cycle.echeance, 0),
    etat: "REUSSI",
    montant: 2000,
    devise: "XOF",
    identifiantFournisseur: "chg_1",
    regleLe: a.cycle.echeance,
    brut: {},
    ...partiel,
  };
}

describe("la référence de versement", () => {
  it("porte le numéro, pour que le second versement existe vraiment", () => {
    // Réutiliser la clé du cycle ferait reconnaître le premier versement par le
    // fournisseur, et le second n'aurait jamais lieu.
    const a = abonnement();
    expect(referenceDeVersement(a.id, a.cycle.echeance, 0)).toBe(
      `20260209-1-${a.id}`,
    );
    expect(referenceDeVersement(a.id, a.cycle.echeance, 1)).toBe(
      `20260209-2-${a.id}`,
    );
  });

  it("porte l'abonnement, sinon deux abonnés se partagent la même clé", () => {
    // C'est le défaut que la 0.7.0 corrige, et il n'était pas cosmétique.
    // « 2026-02-09#1 » ne dépendait que de l'échéance : sur de la facturation
    // mensuelle, les échéances se concentrent, donc deux abonnés recevaient la
    // même référence. Paystack refuse une référence déjà vue — le second à
    // payer ce jour-là était rejeté. Pire, `constater(reference)` interroge le
    // fournisseur PAR cette clé : elle aurait rendu la transaction de
    // quelqu'un d'autre.
    const meme = new Date("2026-02-09T00:00:00Z");

    expect(referenceDeVersement("ab-1", meme, 0)).not.toBe(
      referenceDeVersement("ab-2", meme, 0),
    );
  });

  it("n'emploie que des caractères qu'un fournisseur accepte", () => {
    // Paystack limite une référence aux alphanumériques et à `-`, `.`, `=`,
    // `_`. Le « # » d'avant n'en faisait pas partie — second défaut de la même
    // ligne. Un identifiant exotique passe en hexadécimal : illisible, mais
    // accepté.
    expect(referenceDeVersement("ab-1", new Date("2026-02-09"), 0)).toMatch(
      /^[A-Za-z0-9-]+$/,
    );
    expect(
      referenceDeVersement("ab/1 é", new Date("2026-02-09"), 0),
    ).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it("ne bouge pas tant que le versement n'est pas compté", () => {
    // C'est ce qui rend un passage quotidien rejouable : dix passages avant que
    // l'abonné ne paie redemandent tous le même versement.
    const a = abonnement();
    const dix = Array.from({ length: 10 }, () => referenceDeVersement(a.id, a.cycle.echeance, 0));
    expect(new Set(dix).size).toBe(1);
  });

  it("se laisse relire, et se ramène à sa clé de cycle", () => {
    expect(lireReference("20260209-3-ab-1")).toEqual({
      cycle: "2026-02-09",
      abonnement: "ab-1",
      numero: 3,
    });

    expect(cycleDeReference("20260209-3-ab-1")).toBe("2026-02-09");
  });

  it("rend la référence entière quand elle n'a pas notre forme", () => {
    // Une référence étrangère — un autre système qui poste sur le même webhook
    // — sera donc vue comme portant un autre cycle, et écartée. La confondre
    // avec le cycle courant ferait prolonger un abonnement sur le paiement de
    // quelqu'un d'autre.
    expect(lireReference("REF-EXTERNE-42")).toBeNull();
    expect(cycleDeReference("REF-EXTERNE-42")).toBe("REF-EXTERNE-42");
  });

  it("dit à quel abonnement une référence appartient", () => {
    expect(referencePour("20260209-1-ab-1", "ab-1")).toBe(true);
    expect(referencePour("20260209-1-ab-1", "ab-2")).toBe(false);
    expect(referencePour("REF-EXTERNE-42", "ab-1")).toBe(false);
  });
});

describe("une référence qui appartient à un autre abonnement", () => {
  it("est un incident, et ne prolonge rien", async () => {
    // La page de validation et le gestionnaire de webhooks reçoivent tous deux
    // la référence depuis l'extérieur. Rien d'autre ne dit à qui elle
    // appartient — et la prendre pour argent comptant prolongerait le mauvais
    // abonnement.
    const a = abonnement();
    const f = faussesCreances();

    const d = await reconcilier(
      f.creances,
      a,
      issue({ reference: referenceDeVersement("ab-999", a.cycle.echeance, 0) }),
      "CREDIT",
    );

    expect(d.faire).toBe("INCIDENT");
    expect(d.faire === "INCIDENT" && d.motif).toContain("ab-999");
  });
});

describe("ce qu'on ne compte pas", () => {
  it("ignore un versement qui n'a pas réussi", async () => {
    const f = faussesCreances();
    const d = await reconcilier(f.creances, abonnement(), issue({ etat: "ECHOUE" }), "CREDIT");
    expect(d.faire).toBe("RIEN");
  });

  it("ignore un état INCONNU sans en conclure un échec", async () => {
    // C'est le cas des rappels MTN, qui n'arrivent pas signés. On ne conclut
    // rien : ni payé, ni impayé.
    const f = faussesCreances();
    const d = await reconcilier(f.creances, abonnement(), issue({ etat: "INCONNU" }), "CREDIT");
    expect(d.faire).toBe("RIEN");
  });

  it("ignore un versement déjà compté", async () => {
    // Paystack rejoue ses webhooks pendant 72 heures, et le même paiement
    // arrive souvent deux fois — par le webhook et par l'interrogation.
    const f = faussesCreances({}, ["chg_1"]);
    const d = await reconcilier(f.creances, abonnement(), issue(), "CREDIT");

    expect(d.faire).toBe("RIEN");
    expect(d.faire === "RIEN" && d.motif).toContain("déjà compté");
  });

  it("compte une seule fois un webhook rejoué dix fois", async () => {
    const a = abonnement();
    const vus = new Set<string>();
    const creances: Creances = {
      async etat() {
        return CREANCE_VIERGE;
      },
      async dejaCompte(id) {
        return vus.has(id);
      },
    };

    let renouvellements = 0;
    for (let i = 0; i < 10; i += 1) {
      const d = await reconcilier(creances, a, issue(), "CREDIT");
      if (d.faire === "RENOUVELER") {
        renouvellements += 1;
        vus.add(d.versementId);
      }
    }

    expect(renouvellements).toBe(1);
  });
});

describe("ce qui ne concorde pas", () => {
  it("refuse une devise inattendue, et le signale comme un incident", async () => {
    // Mille deux cents cedis ne sont pas mille deux cents francs : les compter
    // comme tels offrirait deux ans d'abonnement.
    const f = faussesCreances();
    const d = await reconcilier(
      f.creances,
      abonnement(),
      issue({ devise: "GHS" }),
      "CREDIT",
    );

    expect(d.faire).toBe("INCIDENT");
    expect(d.faire === "INCIDENT" && d.motif).toContain("GHS");
  });

  it("refuse un versement portant la clé d'un autre cycle", async () => {
    const f = faussesCreances();
    const d = await reconcilier(
      f.creances,
      abonnement(),
      issue({ reference: "2020-01-01#1" }),
      "CREDIT",
    );

    expect(d.faire).toBe("INCIDENT");
    expect(d.faire === "INCIDENT" && d.motif).toContain("2020-01-01");
  });

  it("distingue l'incident du silence", async () => {
    // Un incident est un paiement réel dont on ne sait pas quoi faire. Le
    // confondre avec du bruit ferait disparaître de l'argent.
    const f = faussesCreances();
    const rien = await reconcilier(f.creances, abonnement(), issue({ etat: "ECHOUE" }), "CREDIT");
    const incident = await reconcilier(f.creances, abonnement(), issue({ devise: "NGN" }), "CREDIT");

    expect(rien.faire).toBe("RIEN");
    expect(incident.faire).toBe("INCIDENT");
  });
});

describe("payer le compte rond", () => {
  it("renouvelle d'un cycle entier et remet les compteurs à zéro", async () => {
    const a = abonnement();
    const f = faussesCreances();

    const d = await reconcilier(f.creances, a, issue(), "CREDIT");

    expect(d.faire).toBe("RENOUVELER");
    if (d.faire !== "RENOUVELER") return;

    expect(d.jours).toBe(30);
    expect(joursEntre(a.cycle.echeance, d.cycle.echeance)).toBe(30);
    expect(d.etat).toEqual({ verse: 0, joursAccordes: 0, versements: 0 });
  });

  it("enchaîne sur l'échéance et non sur la date de paiement", async () => {
    // La règle du cœur, vue depuis l'encaissement : trois jours de retard ne
    // décalent pas l'échéance suivante.
    const a = abonnement();
    const f = faussesCreances();

    const d = await reconcilier(
      f.creances,
      a,
      issue({ regleLe: ajouterJours(a.cycle.echeance, 3) }),
      "CREDIT",
    );

    expect(d.faire === "RENOUVELER" && joursEntre(a.cycle.echeance, d.cycle.echeance)).toBe(30);
  });
});

describe("payer en plusieurs fois — crédit", () => {
  it("ne renouvelle rien et dit ce qui manque", async () => {
    const f = faussesCreances();
    const d = await reconcilier(f.creances, abonnement(), issue({ montant: 1200 }), "CREDIT");

    expect(d.faire).toBe("CREDITER");
    if (d.faire !== "CREDITER") return;

    expect(d.manque).toBe(800);
    expect(d.etat).toEqual({ verse: 1200, joursAccordes: 0, versements: 1 });
  });

  it("renouvelle quand le second versement complète le premier", async () => {
    const a = abonnement();
    // 1 200 déjà versés, un versement compté : le suivant portera `#2`.
    const f = faussesCreances({ verse: 1200, versements: 1 });

    const d = await reconcilier(
      f.creances,
      a,
      issue({
        montant: 800,
        identifiantFournisseur: "chg_2",
        reference: referenceDeVersement(a.id, a.cycle.echeance, 1),
      }),
      "CREDIT",
    );

    expect(d.faire).toBe("RENOUVELER");
    expect(d.faire === "RENOUVELER" && d.jours).toBe(30);
  });
});

describe("payer en plusieurs fois — prorata", () => {
  it("achète dix-huit jours avec mille deux cents francs", async () => {
    const a = abonnement();
    const f = faussesCreances();

    const d = await reconcilier(f.creances, a, issue({ montant: 1200 }), "PRORATA");

    expect(d.faire).toBe("RENOUVELER");
    if (d.faire !== "RENOUVELER") return;

    expect(d.jours).toBe(18);
    expect(joursEntre(a.cycle.echeance, d.cycle.echeance)).toBe(18);
    // Le versement compte, et le cycle n'est pas soldé : le compteur avance.
    expect(d.etat.versements).toBe(1);
    expect(d.etat.verse).toBe(1200);
  });

  it("donne un accès plus court, mais un accès quand même", async () => {
    // C'est toute la différence avec le crédit : l'abonné n'attend pas d'avoir
    // la somme entière pour être servi.
    const a = abonnement();
    const f = faussesCreances();

    const credit = await reconcilier(f.creances, a, issue({ montant: 1200 }), "CREDIT");
    const prorata = await reconcilier(f.creances, a, issue({ montant: 1200 }), "PRORATA");

    expect(credit.faire).toBe("CREDITER");
    expect(prorata.faire).toBe("RENOUVELER");
  });

  it("garde la grâce et la fenêtre de reprise sur un cycle raccourci", async () => {
    // Un cycle de dix-huit jours reste un cycle : l'abonné garde sa grâce.
    const a = abonnement();
    const f = faussesCreances();

    const d = await reconcilier(f.creances, a, issue({ montant: 1200 }), "PRORATA");
    if (d.faire !== "RENOUVELER") throw new Error("attendu RENOUVELER");

    expect(joursEntre(d.cycle.echeance, d.cycle.accesJusquA)).toBe(7);
    expect(joursEntre(d.cycle.accesJusquA, d.cycle.repriseJusquA)).toBe(30);
  });
});

describe("payer deux fois", () => {
  it("avance de deux cycles, dans les deux politiques", async () => {
    // La règle posée dès le départ, et le point où les deux politiques
    // s'accordent toujours.
    for (const politique of ["CREDIT", "PRORATA"] as const) {
      const a = abonnement();
      const f = faussesCreances();

      const d = await reconcilier(f.creances, a, issue({ montant: 4000 }), politique);

      expect(d.faire, politique).toBe("RENOUVELER");
      expect(d.faire === "RENOUVELER" && d.jours, politique).toBe(60);
      expect(
        d.faire === "RENOUVELER" && joursEntre(a.cycle.echeance, d.cycle.echeance),
        politique,
      ).toBe(60);
    }
  });
});
