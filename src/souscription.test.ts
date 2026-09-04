import { describe, expect, it } from "vitest";

import { joursEntre } from "./cycle";
import {
  GrilleInvalide,
  grille,
  offreDe,
  offresActives,
  prixParJour,
  verifierGrille,
  type Offre,
} from "./offre";
import type { AbonnementLu, Coordonnees } from "./ports";
import {
  estSouscription,
  referenceDeSouscription,
  souscrire,
  type NouvelAbonnement,
  type Souscriptions,
} from "./souscription";

const CREATEUR: Offre = {
  id: "createur",
  libelle: "Pass Créateur",
  montant: 2000,
  devise: "XOF",
  cadence: "MENSUEL",
};

const AWA = {
  reference: "usr-1",
  nom: "Awa",
  courriel: "awa@ndank.test",
  telephone: "+2250700000000",
  appareils: [],
};

/** Des souscriptions en mémoire, qui retiennent ce qu'on leur demande. */
function faussesSouscriptions(existant: AbonnementLu | null = null) {
  const abonnes = new Map<string, Coordonnees>();
  const ouverts: NouvelAbonnement[] = [];

  const souscriptions: Souscriptions = {
    async abonne(reference, coordonnees) {
      abonnes.set(reference, coordonnees);
      return `ab-${reference}`;
    },
    async enCours() {
      return existant;
    },
    async ouvrir(nouveau) {
      ouverts.push(nouveau);
      return {
        id: `abo-${ouverts.length}`,
        abonneId: nouveau.abonneId,
        cadence: nouveau.offre.cadence,
        cycle: nouveau.cycle,
        resilieeLe: null,
        montant: nouveau.offre.montant,
        devise: nouveau.offre.devise,
        libelle: nouveau.offre.libelle,
      };
    },
  };

  return { souscriptions, abonnes, ouverts };
}

describe("la grille tarifaire", () => {
  it("rend tous les défauts d'un coup, et pas le premier", () => {
    // Corriger une grille en cinq redémarrages successifs est une façon de
    // perdre un quart d'heure.
    const defauts = verifierGrille([
      { id: "a", libelle: "", montant: 0, devise: "cfa", cadence: "MENSUEL" },
      { id: "a", libelle: "B", montant: 1.5, devise: "XOF", cadence: "QUOTIDIEN" as never },
    ]);

    expect(defauts.length).toBeGreaterThanOrEqual(5);
    expect(defauts.map((d) => d.probleme).join(" ")).toContain("libellé vide");
    expect(defauts.map((d) => d.probleme).join(" ")).toContain("en double");
  });

  it("refuse un montant non entier, qui se ferait arrondir chez le fournisseur", () => {
    const defauts = verifierGrille([{ ...CREATEUR, montant: 2000.5 }]);

    expect(defauts).toHaveLength(1);
    expect(defauts[0]!.probleme).toContain("non entier");
  });

  it("refuse une devise qui n'est pas de l'ISO 4217 en majuscules", () => {
    // « xof », « FCFA », « XO » : Flutterwave et Paystack les refusent, avec
    // un message qui parle de devise non prise en charge et jamais du champ.
    for (const devise of ["xof", "FCFA", "XO", ""]) {
      expect(verifierGrille([{ ...CREATEUR, devise }])).toHaveLength(1);
    }

    expect(verifierGrille([{ ...CREATEUR, devise: "GHS" }])).toEqual([]);
  });

  it("attrape « CFA », qui passe pourtant la règle de forme", () => {
    // Trois lettres, majuscules : une vérification de forme le laisse passer.
    // Ce n'est pourtant pas un code ISO 4217, et c'est l'erreur la plus
    // probable dans la zone que Ndank sert — personne n'écrit « XOF » sur une
    // facture.
    const defauts = verifierGrille([{ ...CREATEUR, devise: "CFA" }]);

    expect(defauts).toHaveLength(1);
    expect(defauts[0]!.probleme).toContain("XOF");
    expect(defauts[0]!.probleme).toContain("XAF");
  });

  it("lève au démarrage, en nommant chaque défaut", () => {
    // Une configuration fausse doit empêcher de démarrer : découverte plus
    // tard, elle est découverte sur quelqu'un.
    expect(() => grille([{ ...CREATEUR, montant: -1 }])).toThrow(GrilleInvalide);

    try {
      grille([{ ...CREATEUR, montant: -1 }]);
    } catch (e) {
      expect((e as Error).message).toContain("createur");
      expect((e as Error).message).toContain("négatif");
    }
  });

  it("garde une offre retirée, mais ne la propose plus", () => {
    // On ne supprime pas une offre : des abonnements en cours la référencent.
    const g = grille([CREATEUR, { ...CREATEUR, id: "vieux", actif: false }]);

    expect(g).toHaveLength(2);
    expect(offreDe(g, "vieux")).not.toBeNull();
    expect(offresActives(g).map((o) => o.id)).toEqual(["createur"]);
  });

  it("ramène les cadences au jour, pour qu'on puisse les comparer", () => {
    // « 2 000 F/mois » et « 20 000 F/an » côte à côte ne disent pas laquelle
    // est la moins chère.
    const mensuel = prixParJour(CREATEUR);
    const annuel = prixParJour({ ...CREATEUR, montant: 20_000, cadence: "ANNUEL" });

    expect(mensuel).toBeCloseTo(66.67, 1);
    expect(annuel).toBeCloseTo(54.79, 1);
    expect(annuel).toBeLessThan(mensuel);
  });
});

describe("la souscription", () => {
  it("crée l'abonné, puis l'abonnement, à partir du paiement", () => {
    const f = faussesSouscriptions();
    const paiement = new Date("2026-02-09T10:00:00Z");

    return souscrire(f.souscriptions, {
      offre: CREATEUR,
      abonne: AWA,
      paiement,
    }).then((s) => {
      expect(s.cree).toBe(true);
      expect(s.abonnement.libelle).toBe("Pass Créateur");
      expect(s.abonnement.montant).toBe(2000);
      expect(f.abonnes.get("usr-1")?.nom).toBe("Awa");

      // Le cycle part du paiement : trente jours d'échéance, sept de grâce.
      expect(joursEntre(paiement, s.abonnement.cycle.echeance)).toBe(30);
      expect(
        joursEntre(s.abonnement.cycle.echeance, s.abonnement.cycle.accesJusquA),
      ).toBe(7);
    });
  });

  it("part du paiement et non de l'instant de l'écriture", async () => {
    // Le webhook met parfois des minutes à arriver. Facturer à partir de son
    // arrivée ferait perdre à l'abonné ce que le réseau a mis.
    const f = faussesSouscriptions();
    const hier = new Date(Date.now() - 86_400_000);

    const s = await souscrire(f.souscriptions, {
      offre: CREATEUR,
      abonne: AWA,
      paiement: hier,
    });

    expect(joursEntre(hier, s.abonnement.cycle.debut)).toBe(0);
  });

  it("ne crée pas un second abonnement quand il y en a déjà un en cours", async () => {
    // Le cas normal du double-clic, ou de l'abonné qui repaie parce qu'il n'a
    // pas vu la confirmation. Deux abonnements à la même chose, dont un qu'il
    // ne verrait jamais et qui le relancerait pourtant.
    const deja: AbonnementLu = {
      id: "abo-existant",
      abonneId: "ab-usr-1",
      cadence: "MENSUEL",
      cycle: {
        debut: new Date(),
        echeance: new Date(),
        accesJusquA: new Date(),
        repriseJusquA: new Date(),
      },
      resilieeLe: null,
      montant: 2000,
      devise: "XOF",
      libelle: "Pass Créateur",
    };

    const f = faussesSouscriptions(deja);

    const s = await souscrire(f.souscriptions, {
      offre: CREATEUR,
      abonne: AWA,
      paiement: new Date(),
    });

    expect(s.cree).toBe(false);
    expect(s.abonnement.id).toBe("abo-existant");
    expect(f.ouverts).toHaveLength(0);
  });

  it("refuse d'ouvrir sur une offre retirée du catalogue", async () => {
    // Sans ce refus, un lien de souscription périmé continuerait de vendre ce
    // qu'on ne vend plus.
    const f = faussesSouscriptions();

    await expect(
      souscrire(f.souscriptions, {
        offre: { ...CREATEUR, actif: false },
        abonne: AWA,
        paiement: new Date(),
      }),
    ).rejects.toThrow(/n'est plus proposée/);
  });
});

describe("la référence d'un premier paiement", () => {
  it("change d'un essai à l'autre, contrairement à celle d'un versement", () => {
    // Celle d'un versement doit être stable : un passage rejoué redemande le
    // même paiement. Ici c'est l'inverse — quelqu'un qui abandonne puis
    // recommence doit obtenir une NOUVELLE demande, sinon le fournisseur
    // reconnaît l'ancienne et le second essai n'a jamais lieu.
    const un = referenceDeSouscription("createur", "usr-1", "1");
    const deux = referenceDeSouscription("createur", "usr-1", "2");

    expect(un).not.toBe(deux);
    // Mais elle reste déterministe : même entrée, même sortie.
    expect(referenceDeSouscription("createur", "usr-1", "1")).toBe(un);
  });

  it("se distingue d'une référence de versement", () => {
    expect(estSouscription(referenceDeSouscription("o", "u", "1"))).toBe(true);
    expect(estSouscription("20260209-1-ab-1")).toBe(false);
  });

  it("n'emploie que des caractères qu'un fournisseur accepte", () => {
    // Même contrainte que pour les versements : Paystack limite une référence
    // aux alphanumériques et à `-`, `.`, `=`, `_`.
    expect(referenceDeSouscription("pass créateur", "usr/1", "essai 2")).toMatch(
      /^[A-Za-z0-9-]+$/,
    );
  });
});
