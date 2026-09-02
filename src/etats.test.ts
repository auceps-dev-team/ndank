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

  it("est fermé dès la résiliation", () => {
    const resilie = abonnement({}, DEPART);
    expect(accesOuvert(resilie, ajouterJours(DEPART, 1))).toBe(false);
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

  it("annonce la confirmation, parce qu'elle part vraiment", () => {
    // `finaliserRenouvellement` la pousse. Si un jour ce n'était plus le cas,
    // ce test resterait vert — d'où le test d'intégration qui, lui, vérifie
    // l'envoi.
    expect(relancesAnnoncees("push")).toContain("CONFIRMATION");
  });

  it("suit la table plutôt qu'une chaîne recopiée", () => {
    // Le vrai sujet : autant de libellés que de paliers du canal, plus la
    // confirmation. Ajouter un palier ajoute une pastille à l'écran.
    const attendus = PALIERS.filter((p) => p.canaux.includes("push")).length;
    expect(relancesAnnoncees("push")).toHaveLength(attendus + 1);
  });
});
