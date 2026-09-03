import { describe, expect, it } from "vitest";

import { regler, resteADevoir, type Politique, type Reglement } from "./reglement";

/** Un Pass Créateur mensuel à 2 000 F, sans versement antérieur. */
function pass(politique: Politique, verse = 0, joursAccordes = 0): Reglement {
  return { politique, du: 2000, joursDeCadence: 30, verse, joursAccordes };
}

/**
 * Verse une suite de montants et rend le total de jours accordés.
 *
 * C'est ce parcours-là qui compte : un abonné qui paie en plusieurs fois passe
 * par autant d'états intermédiaires, et c'est entre eux que la dérive se loge.
 */
function verserSuite(politique: Politique, montants: number[]) {
  let etat = pass(politique);
  let jours = 0;

  for (const m of montants) {
    const suite = regler(etat, m);
    if (suite.faire === "AVANCER") jours += suite.jours;
    etat = { ...etat, verse: suite.verse, joursAccordes: suite.joursAccordes };
  }

  return { jours, verse: etat.verse, joursAccordes: etat.joursAccordes };
}

describe("payer le compte rond", () => {
  it("avance d'un cycle entier, quelle que soit la politique", () => {
    for (const p of ["CREDIT", "PRORATA"] as const) {
      const suite = regler(pass(p), 2000);
      expect(suite.faire, p).toBe("AVANCER");
      expect(suite.faire === "AVANCER" && suite.jours, p).toBe(30);
    }
  });

  it("repart de zéro quand le compte tombe juste", () => {
    // Sans cette remise à zéro, deux cumuls grossiraient pendant des années
    // pour un abonné qui paie simplement son dû chaque mois.
    const suite = regler(pass("PRORATA"), 2000);
    expect(suite.verse).toBe(0);
    expect(suite.joursAccordes).toBe(0);
  });

  it("avance de deux cycles quand on paie le double", () => {
    // La règle posée dès le départ : payé deux fois, deux échéances. Les deux
    // politiques doivent s'accorder ici, et c'est le seul point où elles
    // s'accordent toujours.
    for (const p of ["CREDIT", "PRORATA"] as const) {
      const suite = regler(pass(p), 4000);
      expect(suite.faire === "AVANCER" && suite.jours, p).toBe(60);
    }
  });

  it("avance de six mois sur six fois le montant", () => {
    for (const p of ["CREDIT", "PRORATA"] as const) {
      const suite = regler(pass(p), 12_000);
      expect(suite.faire === "AVANCER" && suite.jours, p).toBe(180);
    }
  });
});

describe("la politique du crédit", () => {
  it("n'avance rien tant que le compte n'y est pas", () => {
    const suite = regler(pass("CREDIT"), 1200);
    expect(suite.faire).toBe("CREDITER");
    expect(suite.verse).toBe(1200);
    expect(suite.faire === "CREDITER" && suite.manque).toBe(800);
  });

  it("dit ce qu'il manque, pour que la relance le dise aussi", () => {
    // Redemander 2 000 F à quelqu'un qui en a déjà versé 1 200 est la meilleure
    // façon de lui faire croire que son premier versement s'est perdu.
    expect(resteADevoir(pass("CREDIT", 1200))).toBe(800);
  });

  it("avance quand le second versement complète le premier", () => {
    // Le parcours réel : 1 200 lundi, 800 jeudi.
    const r = verserSuite("CREDIT", [1200, 800]);
    expect(r.jours).toBe(30);
    expect(r.verse).toBe(0);
  });

  it("garde le surplus pour le cycle d'après", () => {
    // 2 500 sur 2 000 : un cycle avance, 500 restent au compteur.
    const suite = regler(pass("CREDIT"), 2500);
    expect(suite.faire === "AVANCER" && suite.jours).toBe(30);
    expect(suite.verse).toBe(2500);
    expect(resteADevoir({ ...pass("CREDIT"), verse: suite.verse })).toBe(1500);
  });

  it("accumule sans jamais rien perdre", () => {
    // Cinq versements de 400 F valent un cycle, ni plus ni moins.
    const r = verserSuite("CREDIT", [400, 400, 400, 400, 400]);
    expect(r.jours).toBe(30);
    expect(r.verse).toBe(0);
  });

  it("n'accorde jamais de fraction de cycle", () => {
    // C'est toute la différence avec le prorata : 1 999 F n'achètent rien.
    const r = verserSuite("CREDIT", [1999]);
    expect(r.jours).toBe(0);
  });
});

describe("la politique du prorata", () => {
  it("achète dix-huit jours avec mille deux cents francs", () => {
    // Le cas donné en exemple : 1 200 / 2 000 × 30 = 18.
    const suite = regler(pass("PRORATA"), 1200);
    expect(suite.faire === "AVANCER" && suite.jours).toBe(18);
  });

  it("arrondit les jours vers le bas, jamais vers le haut", () => {
    // On n'accorde pas plus de temps qu'il n'en a été payé. 1 250 vaut
    // 18,75 jours : on en donne 18.
    const suite = regler(pass("PRORATA"), 1250);
    expect(suite.faire === "AVANCER" && suite.jours).toBe(18);
  });

  it("n'accorde aucun jour quand le versement n'en paie pas un seul", () => {
    // Un jour coûte 66,67 F. En verser 50 n'achète rien — mais ne les perd pas.
    const suite = regler(pass("PRORATA"), 50);
    expect(suite.faire).toBe("CREDITER");
    expect(suite.verse).toBe(50);
  });

  it("achète un jour dès qu'un jour est payé", () => {
    const suite = regler(pass("PRORATA"), 67);
    expect(suite.faire === "AVANCER" && suite.jours).toBe(1);
  });

  it("cumule d'un versement au suivant", () => {
    // 50 gardés + 50 versés = 100, soit un jour.
    const r = verserSuite("PRORATA", [50, 50]);
    expect(r.jours).toBe(1);
  });

  it("ne dérive pas sur une longue suite de petits versements", () => {
    // LE test qui a fait refaire ce module. Trente versements de 100 F valent
    // 3 000 F, soit 45 jours pleins. La première version arrondissait à chaque
    // versement et n'en accordait que 44 : moins d'un franc perdu à chaque
    // fois, un jour perdu au bout de trente.
    const r = verserSuite("PRORATA", Array(30).fill(100));
    expect(r.jours).toBe(45);
  });

  it("donne le même total quel que soit le découpage des versements", () => {
    // La propriété qui définit l'absence de dérive : seul le total compte.
    const enUneFois = verserSuite("PRORATA", [3000]);
    const enTrente = verserSuite("PRORATA", Array(30).fill(100));
    const irregulier = verserSuite("PRORATA", [7, 993, 1500, 500]);

    expect(enTrente.jours).toBe(enUneFois.jours);
    expect(irregulier.jours).toBe(enUneFois.jours);
  });

  it("ne fabrique jamais de jours à partir de rien", () => {
    // Le contrôle inverse : sur tout un éventail de découpages, le temps
    // accordé ne dépasse jamais ce qui a été payé.
    for (let pas = 1; pas <= 200; pas += 13) {
      const versements = Array(Math.ceil(2000 / pas)).fill(pas);
      const total = versements.reduce((a, b) => a + b, 0);
      const r = verserSuite("PRORATA", versements);

      expect(r.jours, `par ${pas}`).toBeLessThanOrEqual(
        Math.floor((total * 30) / 2000),
      );
    }
  });
});

describe("ce qui ne se règle pas", () => {
  it("ignore un versement nul ou négatif", () => {
    expect(regler(pass("CREDIT"), 0).faire).toBe("RIEN");
    expect(regler(pass("PRORATA"), -100).faire).toBe("RIEN");
  });

  it("laisse l'état intact quand il ne fait rien", () => {
    const suite = regler(pass("CREDIT", 800), 0);
    expect(suite.verse).toBe(800);
    expect(suite.joursAccordes).toBe(0);
  });

  it("refuse un abonnement sans montant plutôt que de diviser par zéro", () => {
    // Sans cette garde, le prorata rendrait une échéance à l'infini — ce qui
    // est bien pire qu'une erreur, parce que personne ne la verrait.
    const gratuit: Reglement = {
      politique: "PRORATA",
      du: 0,
      joursDeCadence: 30,
      verse: 0,
      joursAccordes: 0,
    };
    const suite = regler(gratuit, 1000);

    expect(suite.faire).toBe("RIEN");
    expect(suite.faire === "RIEN" && suite.motif).toContain("montant");
  });

  it("refuse une cadence nulle", () => {
    const sansDuree: Reglement = {
      politique: "CREDIT",
      du: 2000,
      joursDeCadence: 0,
      verse: 0,
      joursAccordes: 0,
    };
    expect(regler(sansDuree, 2000).faire).toBe("RIEN");
  });
});

describe("ce qu'il reste à devoir", () => {
  it("est le montant entier quand rien n'a été versé", () => {
    expect(resteADevoir(pass("CREDIT"))).toBe(2000);
  });

  it("décroît à mesure des versements", () => {
    expect(resteADevoir(pass("CREDIT", 1200))).toBe(800);
  });

  it("repart d'un cycle entier quand le précédent est soldé", () => {
    expect(resteADevoir(pass("CREDIT", 2500))).toBe(1500);
  });

  it("ne divise pas par zéro sur un abonnement gratuit", () => {
    expect(
      resteADevoir({ politique: "CREDIT", du: 0, joursDeCadence: 30, verse: 0, joursAccordes: 0 }),
    ).toBe(0);
  });
});
