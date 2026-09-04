import { describe, expect, it } from "vitest";

import {
  ajouterJours,
  cycleApresPaiement,
  type Cycle,
} from "./cycle";
import {
  PALIERS,
  accesOuvert,
  canauxDuPalier,
  etatDe,
  gesteDuJour,
  relancesAnnoncees,
  peutReprendre,
  type Abonnement,
} from "./etats";

const DEPART = new Date("2026-01-10T00:00:00Z");

function abonnement(cycle?: Partial<Cycle>, resilieeLe: Date | null = null): Abonnement {
  return {
    cycle: { ...cycleApresPaiement(DEPART, "MENSUEL"), ...cycle },
    resilieeLe,
  };
}

const RIEN = new Set<string>();

describe("l'état déduit", () => {
  const a = abonnement();

  it("est actif au lendemain du paiement", () => {
    expect(etatDe(a, ajouterJours(DEPART, 1))).toBe("ACTIVE");
  });

  it("bascule exactement au premier palier, jamais après", () => {
    // LE test qui empêche un palier écrit et jamais envoyé.
    //
    // `gesteDuJour` rend `RIEN` tant que l'état est ACTIVE. Si le préavis
    // était plus court que le premier palier, la première relance ne partirait
    // jamais — sans erreur, sans journal, sans que rien ne le dise. Les deux
    // sont donc liés dans le code, et ce test le vérifie.
    const premier = PALIERS[0]!.jour;

    expect(etatDe(a, ajouterJours(a.cycle.echeance, premier - 1))).toBe("ACTIVE");
    expect(etatDe(a, ajouterJours(a.cycle.echeance, premier))).toBe("A_RENOUVELER");
    expect(etatDe(a, a.cycle.echeance)).toBe("A_RENOUVELER");
  });

  it("reste à renouveler pendant toute la grâce", () => {
    // L'échéance est passée et l'accès tient : c'est exactement ce que la
    // grâce doit produire.
    expect(etatDe(a, ajouterJours(a.cycle.echeance, 3))).toBe("A_RENOUVELER");
    expect(etatDe(a, a.cycle.accesJusquA)).toBe("A_RENOUVELER");
  });

  it("suspend le lendemain de la grâce", () => {
    expect(etatDe(a, ajouterJours(a.cycle.accesJusquA, 1))).toBe("SUSPENDUE");
  });

  it("expire une fois la fenêtre de reprise passée", () => {
    expect(etatDe(a, ajouterJours(a.cycle.repriseJusquA, 1))).toBe("EXPIREE");
  });

  it("place la résiliation au-dessus de tout le reste", () => {
    // Un abonné qui a dit non ne doit plus rien recevoir, même si son échéance
    // tombe demain.
    const resilie = abonnement({}, ajouterJours(DEPART, 2));
    expect(etatDe(resilie, resilie.cycle.echeance)).toBe("RESILIEE");
    expect(etatDe(resilie, ajouterJours(resilie.cycle.repriseJusquA, 99))).toBe(
      "RESILIEE",
    );
  });
});

describe("l'accès", () => {
  const a = abonnement();

  it("tient pendant la grâce, alors que le paiement est en retard", () => {
    // Le cœur du sujet : deux horloges. Couper le jour de l'échéance ferait
    // perdre l'abonné parti en week-end.
    expect(accesOuvert(a, ajouterJours(a.cycle.echeance, 5))).toBe(true);
  });

  it("se ferme quand la grâce est épuisée", () => {
    expect(accesOuvert(a, ajouterJours(a.cycle.accesJusquA, 1))).toBe(false);
  });

  it("tient jusqu'à la fin de ce qui a été payé, même après résiliation", () => {
    // Ce test disait le contraire, et il avait tort. Un abonné qui résilie le
    // 3 a payé jusqu'au 30 : lui couper le service à l'instant du clic, c'est
    // garder son argent et lui retirer ce qu'il a acheté.
    //
    // Résilier veut dire deux choses, et deux seulement : plus de relance, plus
    // de renouvellement. Les deux sont déjà vraies ailleurs — `gesteDuJour`
    // rend RIEN sur un résilié, et le lot du passage les écarte.
    const resilie = abonnement({}, DEPART);

    expect(accesOuvert(resilie, ajouterJours(DEPART, 1))).toBe(true);
    expect(accesOuvert(resilie, resilie.cycle.accesJusquA)).toBe(true);
  });

  it("ne donne aucune grâce à qui a résilié", () => {
    // La grâce existe pour laisser le temps de payer pendant qu'on relance. On
    // ne relance pas un résilié : la prolonger n'aurait aucun sens.
    const resilie = abonnement({}, DEPART);

    expect(accesOuvert(resilie, ajouterJours(resilie.cycle.accesJusquA, 1))).toBe(
      false,
    );
  });

  it("se ferme sur-le-champ quand le marchand suspend", () => {
    // À l'inverse de la résiliation : c'est la raison d'être du geste. On
    // suspend pour un litige ou un abus, et attendre la fin du cycle le
    // viderait de son sens.
    const a = abonnement();
    const suspendu = { ...a, suspenduLe: DEPART };

    expect(accesOuvert(a, ajouterJours(DEPART, 1))).toBe(true);
    expect(accesOuvert(suspendu, ajouterJours(DEPART, 1))).toBe(false);
    expect(etatDe(suspendu, ajouterJours(DEPART, 1))).toBe("SUSPENDUE");
  });

  it("laisse la résiliation l'emporter sur la suspension", () => {
    // Un abonné qui a dit non n'a plus à être suspendu : il est déjà parti.
    const deux = { ...abonnement({}, DEPART), suspenduLe: DEPART };

    expect(etatDe(deux, ajouterJours(DEPART, 1))).toBe("RESILIEE");
    // Mais l'accès reste coupé : la suspension est le geste le plus fort.
    expect(accesOuvert(deux, ajouterJours(DEPART, 1))).toBe(false);
  });
});

describe("la reprise", () => {
  const a = abonnement();

  it("est offerte tant que la fenêtre dure", () => {
    expect(peutReprendre(a, ajouterJours(a.cycle.accesJusquA, 5))).toBe(true);
  });

  it("n'est plus offerte une fois expiré", () => {
    // Se réabonner recommence alors à zéro : ce n'est plus une reprise.
    expect(peutReprendre(a, ajouterJours(a.cycle.repriseJusquA, 1))).toBe(false);
  });

  it("n'a pas de sens sur un abonnement encore actif", () => {
    expect(peutReprendre(a, ajouterJours(DEPART, 1))).toBe(false);
  });
});

describe("le geste du jour", () => {
  const a = abonnement();

  it("ne fait rien sur un abonnement tranquille", () => {
    // Le cas le plus fréquent, et de loin.
    expect(gesteDuJour(a, ajouterJours(DEPART, 1), RIEN)).toEqual({
      faire: "RIEN",
    });
  });

  it("rappelle dès le premier palier", () => {
    // Le jour vient de la table, pas d'un nombre recopié ici : avancer un
    // palier ne doit pas rendre ce test faux en silence.
    const g = gesteDuJour(a, ajouterJours(a.cycle.echeance, PALIERS[0]!.jour), RIEN);
    expect(g.faire).toBe("RAPPELER");
    expect(g.faire === "RAPPELER" && g.palier).toBe(0);
  });

  it("relance une semaine avant, puis la veille", () => {
    // Ce que les maquettes annoncent à l'abonné : « RELANCE J−7 » puis
    // « RAPPEL J−1 ». L'écrire ici empêche l'écran de promettre un calendrier
    // que le moteur ne tient pas.
    expect(PALIERS[0]!.jour).toBe(-7);
    expect(PALIERS[1]!.jour).toBe(-1);
  });

  it("ne rappelle pas deux fois le même palier", () => {
    // Sans cela, un passage quotidien enverrait sept messages pour une seule
    // échéance — et le premier SMS de trop suffit à faire désinstaller l'app.
    const quand = ajouterJours(a.cycle.echeance, -3);
    const premier = gesteDuJour(a, quand, RIEN);
    expect(premier.faire).toBe("RAPPELER");

    const cle = premier.faire === "RAPPELER" ? premier.cle : "";
    expect(gesteDuJour(a, quand, new Set([cle]))).toEqual({ faire: "RIEN" });
  });

  it("n'envoie qu'une relance quand un passage a raté des jours", () => {
    // Un cron arrêté trois jours ne doit pas rattraper en envoyant trois
    // messages d'affilée : on prend le palier le plus avancé, pas le premier.
    const g = gesteDuJour(a, ajouterJours(a.cycle.echeance, 5), RIEN);
    expect(g.faire).toBe("RAPPELER");
    expect(g.faire === "RAPPELER" && g.palier).toBe(PALIERS.length - 1);
  });

  it("suspend une fois la grâce passée", () => {
    expect(gesteDuJour(a, ajouterJours(a.cycle.accesJusquA, 1), RIEN)).toEqual({
      faire: "SUSPENDRE",
    });
  });

  it("clôt une fois la reprise passée", () => {
    expect(gesteDuJour(a, ajouterJours(a.cycle.repriseJusquA, 1), RIEN)).toEqual({
      faire: "CLORE",
    });
  });

  it("ne touche plus à un abonnement résilié", () => {
    const resilie = abonnement({}, DEPART);
    expect(gesteDuJour(resilie, resilie.cycle.echeance, RIEN)).toEqual({
      faire: "RIEN",
    });
  });
});

describe("l'échelle des canaux", () => {
  it("commence par le gratuit", () => {
    // Un SMS se paie à chaque envoi. Relancer par SMS une semaine avant, pour
    // un abonné qui paiera de toute façon, c'est mille SMS par mois pour rien.
    expect(canauxDuPalier(0)).not.toContain("sms");
    expect(canauxDuPalier(0)).toContain("courriel");
  });

  it("sort le SMS quand l'accès va être coupé", () => {
    expect(canauxDuPalier(PALIERS.length - 1)).toContain("sms");
  });

  it("monte en coût sans jamais redescendre", () => {
    // Une échelle qui repasserait au gratuit après le SMS n'aurait aucun sens.
    let vuSms = false;
    for (let i = 0; i < PALIERS.length; i += 1) {
      const aSms = canauxDuPalier(i).includes("sms");
      if (vuSms) expect(aSms, `palier ${i}`).toBe(true);
      if (aSms) vuSms = true;
    }
    expect(vuSms).toBe(true);
  });

  it("rend une liste vide sur un palier qui n'existe pas", () => {
    expect(canauxDuPalier(99)).toEqual([]);
  });
});

describe("ce qu'on annonce à l'abonné", () => {
  it("dit les paliers du canal, et rien que les siens", () => {
    // Promettre sur la notification une relance qui ne part qu'en SMS serait
    // la même faute que d'inventer un jour : un message attendu qui n'arrive
    // pas, et rien pour le signaler.
    const push = relancesAnnoncees("push");
    const sms = relancesAnnoncees("sms");

    expect(push).toContain("RELANCE J−7");
    expect(push).toContain("RAPPEL LA VEILLE");
    // J+5 ne passe qu'en SMS : il n'a rien à faire dans la liste des poussées.
    expect(push).not.toContain("RELANCE J+5");
    expect(sms).toContain("RELANCE J+5");
  });

  it("n'annonce que ce que ce module envoie", () => {
    // « CONFIRMATION » figurait ici, justifiée par une fonction restée dans
    // Baobart. Ndank enchaîne bien le cycle après un paiement, mais ne pousse
    // aucune notification à cette occasion : l'annoncer faisait mentir l'écran,
    // ce que cette fonction existe précisément pour empêcher.
    expect(relancesAnnoncees("push")).not.toContain("CONFIRMATION");
    expect(relancesAnnoncees("sms")).not.toContain("CONFIRMATION");
  });

  it("suit la table plutôt qu'une chaîne recopiée", () => {
    // Le vrai sujet : autant de libellés que de paliers du canal. Ajouter un
    // palier ajoute une pastille à l'écran.
    const attendus = PALIERS.filter((p) => p.canaux.includes("push")).length;
    expect(relancesAnnoncees("push")).toHaveLength(attendus);
  });
});

describe("l'heure du passage", () => {
  // Toute cette suite partait de minuit UTC, et `ajouterJours` conserve
  // minuit : pas un test ne s'exécutait à une autre heure. Une comparaison
  // d'instants contre une borne à minuit passait donc inaperçue, alors qu'elle
  // faisait dépendre la coupure d'accès de l'heure à laquelle le cron tourne.
  const a = abonnement();
  const HEURES = [0, 3, 12, 23];

  /** Le même jour civil, à telle heure. */
  function heure(quand: Date, h: number): Date {
    return new Date(quand.getTime() + h * 3_600_000);
  }

  it("ne change pas l'état, le dernier jour de grâce", () => {
    for (const h of HEURES) {
      expect(etatDe(a, heure(a.cycle.accesJusquA, h)), `${h} h`).toBe(
        "A_RENOUVELER",
      );
    }
  });

  it("ne change pas l'état, le lendemain de la grâce", () => {
    const lendemain = ajouterJours(a.cycle.accesJusquA, 1);
    for (const h of HEURES) {
      expect(etatDe(a, heure(lendemain, h)), `${h} h`).toBe("SUSPENDUE");
    }
  });

  it("ne change pas l'état, au bord de l'expiration", () => {
    const apres = ajouterJours(a.cycle.repriseJusquA, 1);
    for (const h of HEURES) {
      expect(etatDe(a, heure(a.cycle.repriseJusquA, h)), `${h} h`).toBe(
        "SUSPENDUE",
      );
      expect(etatDe(a, heure(apres, h)), `${h} h`).toBe("EXPIREE");
    }
  });

  it("ne change pas le geste, au premier palier", () => {
    const jourDuPalier = ajouterJours(a.cycle.echeance, PALIERS[0]!.jour);
    for (const h of HEURES) {
      const g = gesteDuJour(a, heure(jourDuPalier, h), RIEN);
      expect(g.faire, `${h} h`).toBe("RAPPELER");
      expect(g.faire === "RAPPELER" && g.palier, `${h} h`).toBe(0);
    }
  });
});

describe("la table des paliers", () => {
  it("garde ses jours dans l'ordre croissant", () => {
    // `gesteDuJour` la parcourt à l'envers pour trouver le palier le plus
    // avancé. Un palier inséré au mauvais rang casserait ce choix en silence :
    // on enverrait le rappel de la veille alors que l'accès va tomber.
    const jours = PALIERS.map((p) => p.jour);
    expect(jours).toEqual([...jours].sort((x, y) => x - y));
  });

  it("n'a pas deux paliers le même jour", () => {
    const jours = PALIERS.map((p) => p.jour);
    expect(new Set(jours).size).toBe(jours.length);
  });
});
