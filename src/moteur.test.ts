import { describe, expect, it } from "vitest";

import {
  ajouterJours,
  cycleApresPaiement,
  joursEntre,
  type Cycle,
} from "./cycle";
import { apercuDe, finaliserRenouvellement, LOT, passer } from "./moteur";
import type {
  AbonnementLu,
  Canal,
  Coordonnees,
  Message,
  Ports,
} from "./ports";

const DEPART = new Date("2026-01-10T00:00:00Z");

/**
 * Une implémentation des ports qui vit en mémoire.
 *
 * C'est tout l'intérêt de l'architecture : le moteur s'éprouve sans base, sans
 * réseau et sans cadre applicatif. Ce faux-là fait vingt lignes ; le jour où
 * Ndank sortira de Baobart, il ne changera pas d'une ligne.
 */
function faussePorts(
  abonnements: AbonnementLu[],
  options: {
    coordonnees?: Coordonnees;
    canauxQuiMarchent?: Canal[];
    dejaEnvoyes?: Record<string, string[]>;
    /** Abonnements dont la lecture lève, pour éprouver le rattrapage. */
    lecturesQuiCassent?: string[];
    /** Abonnements dont l'écriture lève, une fois la relance partie. */
    ecrituresQuiCassent?: string[];
  } = {},
) {
  const envois: Array<{ canal: Canal; message: Message }> = [];
  const notees: Array<{ id: string; cle: string; canaux: readonly Canal[] }> = [];
  const suspendus: string[] = [];
  const clos: string[] = [];
  const renouveles: Array<{ id: string; cycle: Cycle }> = [];

  const marchent = options.canauxQuiMarchent ?? ["courriel", "sms", "push"];
  const ou: Coordonnees = options.coordonnees ?? {
    nom: "Awa",
    courriel: "abonne@ndank.test",
    telephone: "+2250700000000",
    appareils: ["appareil-1"],
  };

  const ports: Ports = {
    lecture: {
      async aRelancer() {
        return abonnements;
      },
      async relancesEnvoyees(id) {
        if (options.lecturesQuiCassent?.includes(id)) {
          throw new Error("base indisponible");
        }
        return options.dejaEnvoyes?.[id] ?? [];
      },
      async coordonnees() {
        return ou;
      },
    },
    ecriture: {
      async noterRelance(id, cle, canaux) {
        if (options.ecrituresQuiCassent?.includes(id)) {
          throw new Error("écriture refusée");
        }
        notees.push({ id, cle, canaux });
      },
      async suspendre(id) {
        suspendus.push(id);
      },
      async clore(id) {
        clos.push(id);
      },
      async renouveler(id, cycle) {
        renouveles.push({ id, cycle });
      },
    },
    envoi: {
      disponible(canal, coord) {
        if (canal === "courriel") return coord.courriel !== null;
        if (canal === "sms") return coord.telephone !== null;
        return coord.appareils.length > 0;
      },
      async envoyer(canal, _coord, message) {
        if (!marchent.includes(canal)) return false;
        envois.push({ canal, message });
        return true;
      },
    },
  };

  return { ports, envois, notees, suspendus, clos, renouveles };
}

/** Un abonnement dont l'échéance tombe le jour du passage. */
function du(id: string): AbonnementLu {
  return {
    ...abonnement(),
    id,
    cycle: cycleApresPaiement(ajouterJours(DEPART, -30), "MENSUEL"),
  };
}

function abonnement(cycle?: Partial<Cycle>): AbonnementLu {
  return {
    id: "ab-1",
    abonneId: "user-1",
    cadence: "MENSUEL",
    cycle: { ...cycleApresPaiement(DEPART, "MENSUEL"), ...cycle },
    resilieeLe: null,
    montant: 2_000,
    devise: "XOF",
    libelle: "Pass Créateur",
  };
}

/**
 * Ce que l'hôte fournit : où valider, et comment écrire un montant.
 *
 * Les deux dépendent du projet — Baobart n'a ni les mêmes URL ni la même devise
 * qu'un autre — donc le moteur les reçoit plutôt que de les deviner.
 */
const REGLAGES = {
  lien: (a: AbonnementLu) => `https://ndank.test/valider/${a.id}`,
  montant: (a: AbonnementLu) => `${a.montant} ${a.devise}`,
};

describe("le passage quotidien", () => {
  it("ne fait rien sur un abonnement tranquille", async () => {
    const a = abonnement();
    const f = faussePorts([a]);

    const bilan = await passer(f.ports, REGLAGES, ajouterJours(DEPART, 1));

    expect(bilan.vus).toBe(1);
    expect(bilan.relances).toBe(0);
    expect(f.envois).toHaveLength(0);
  });

  it("relance par le canal gratuit au premier palier", async () => {
    // Un SMS trois jours avant, pour quelqu'un qui paiera de toute façon, c'est
    // mille SMS par mois jetés sur mille abonnés.
    const a = abonnement();
    const f = faussePorts([a]);

    await passer(f.ports, REGLAGES, ajouterJours(a.cycle.echeance, -3));

    expect(f.envois).toHaveLength(1);
    expect(f.envois[0]!.canal).toBe("courriel");
    expect(f.envois[0]!.message.lien).toContain("ab-1");
    expect(f.envois[0]!.message.destinataire).toBe("Awa");
    expect(f.envois[0]!.message.dernier).toBe(false);
  });

  it("ne salue pas l'abonné par le nom de son offre quand il n'a pas de nom", async () => {
    // Le repli était `ou.nom ?? abonnement.libelle`, et il compilait très bien.
    // Le courriel disait « Bonjour Pass Créateur » : on saluait quelqu'un par le
    // nom du produit qu'on lui vend. `Coordonnees.nom` annonçait pourtant la
    // bonne règle depuis le début — on dira « Bonjour » — mais le type de
    // `Message` interdisait de transmettre l'ignorance.
    const a = abonnement();
    const f = faussePorts([a], {
      coordonnees: {
        nom: null,
        courriel: "abonne@ndank.test",
        telephone: null,
        appareils: [],
      },
    });

    await passer(f.ports, REGLAGES, ajouterJours(a.cycle.echeance, -3));

    expect(f.envois).toHaveLength(1);
    expect(f.envois[0]!.message.destinataire).toBeNull();
    expect(f.envois[0]!.message.offre).toBe("Pass Créateur");
  });

  it("sort le SMS au dernier palier, quand l'accès va tomber", async () => {
    const a = abonnement();
    const f = faussePorts([a], { canauxQuiMarchent: ["sms"] });

    await passer(f.ports, REGLAGES, ajouterJours(a.cycle.echeance, 5));

    expect(f.envois[0]!.canal).toBe("sms");
    // Le message porte des faits, pas de la prose : c'est le canal qui met en
    // forme. Un SMS et un courriel ne s'écrivent pas pareil.
    expect(f.envois[0]!.message.dernier).toBe(true);
    expect(f.envois[0]!.message.offre).toBe("Pass Créateur");
  });

  it("n'envoie qu'une relance même après plusieurs jours ratés", async () => {
    // Rattraper en envoyant trois messages d'affilée ferait désinstaller
    // l'application.
    const a = abonnement();
    const f = faussePorts([a]);

    await passer(f.ports, REGLAGES, ajouterJours(a.cycle.echeance, 5));

    expect(f.envois).toHaveLength(1);
    expect(f.notees).toHaveLength(1);
  });

  it("ne renvoie pas une relance déjà partie", async () => {
    const a = abonnement();
    const premier = faussePorts([a]);
    await passer(premier.ports, REGLAGES, ajouterJours(a.cycle.echeance, -3));

    const cle = premier.notees[0]!.cle;
    const second = faussePorts([a], { dejaEnvoyes: { "ab-1": [cle] } });
    await passer(second.ports, REGLAGES, ajouterJours(a.cycle.echeance, -3));

    expect(second.envois).toHaveLength(0);
  });

  it("essaie le canal suivant quand le premier ne part pas", async () => {
    const a = abonnement();
    const f = faussePorts([a], { canauxQuiMarchent: ["push"] });

    await passer(f.ports, REGLAGES, ajouterJours(a.cycle.echeance, -3));

    expect(f.envois[0]!.canal).toBe("push");
  });

  it("saute un canal dont on n'a pas les coordonnées", async () => {
    const a = abonnement();
    const f = faussePorts([a], {
      coordonnees: {
        nom: null,
        courriel: null,
        telephone: "+225",
        appareils: [],
      },
      canauxQuiMarchent: ["courriel", "sms", "push"],
    });

    await passer(f.ports, REGLAGES, ajouterJours(a.cycle.echeance, 5));

    expect(f.envois[0]!.canal).toBe("sms");
  });

  it("NE note PAS une relance qui n'est jamais partie", async () => {
    // Sinon une panne d'un jour couperait l'accès à quelqu'un qu'on n'a jamais
    // prévenu — et le lendemain, le moteur croirait l'avoir fait.
    const a = abonnement();
    const f = faussePorts([a], { canauxQuiMarchent: [] });

    const bilan = await passer(f.ports, REGLAGES, ajouterJours(a.cycle.echeance, -3));

    expect(f.notees).toHaveLength(0);
    expect(bilan.relances).toBe(0);
    expect(bilan.injoignables).toBe(1);
  });

  it("suspend une fois la grâce épuisée", async () => {
    const a = abonnement();
    const f = faussePorts([a]);

    const bilan = await passer(f.ports, REGLAGES, ajouterJours(a.cycle.accesJusquA, 1));

    expect(f.suspendus).toEqual(["ab-1"]);
    expect(bilan.suspendus).toBe(1);
    // On ne relance plus quelqu'un dont l'accès est déjà coupé.
    expect(f.envois).toHaveLength(0);
  });

  it("clôt une fois la fenêtre de reprise passée", async () => {
    const a = abonnement();
    const f = faussePorts([a]);

    await passer(f.ports, REGLAGES, ajouterJours(a.cycle.repriseJusquA, 1));

    expect(f.clos).toEqual(["ab-1"]);
  });

  it("laisse tranquille un abonnement résilié", async () => {
    const a = { ...abonnement(), resilieeLe: DEPART };
    const f = faussePorts([a]);

    await passer(f.ports, REGLAGES, ajouterJours(a.cycle.echeance, 5));

    expect(f.envois).toHaveLength(0);
    expect(f.suspendus).toHaveLength(0);
    expect(f.clos).toHaveLength(0);
  });

  it("traite plusieurs abonnements sans qu'un échec emporte les autres", async () => {
    // Le test qui manquait vraiment. L'ancien montait deux abonnements sains et
    // ne vérifiait qu'un compteur : son nom promettait une résistance que rien
    // n'éprouvait. Ici la lecture du premier lève pour de bon.
    const f = faussePorts([du("casse"), du("sain")], {
      lecturesQuiCassent: ["casse"],
    });

    const bilan = await passer(f.ports, REGLAGES, DEPART);

    expect(bilan.vus).toBe(2);
    // Et surtout : le suivant a bien été traité.
    expect(f.notees.map((n) => n.id)).toEqual(["sain"]);
    expect(bilan.relances).toBe(1);
  });

  it("dit quel abonnement a échoué, et pourquoi", async () => {
    // Compter les échecs sans dire lesquels rendrait l'incident invisible :
    // c'est la faute que ce module reproche partout ailleurs.
    const f = faussePorts([du("casse")], { lecturesQuiCassent: ["casse"] });

    const bilan = await passer(f.ports, REGLAGES, DEPART);

    expect(bilan.echecs).toHaveLength(1);
    expect(bilan.echecs[0]!.abonnementId).toBe("casse");
    expect((bilan.echecs[0]!.cause as Error).message).toBe("base indisponible");
  });

  it("rattrape aussi une écriture qui lève après l'envoi", async () => {
    // L'échec peut tomber n'importe où dans le geste, pas seulement en lecture.
    const f = faussePorts([du("casse"), du("sain")], {
      ecrituresQuiCassent: ["casse"],
    });

    const bilan = await passer(f.ports, REGLAGES, DEPART);

    expect(bilan.echecs.map((e) => e.abonnementId)).toEqual(["casse"]);
    expect(f.notees.map((n) => n.id)).toEqual(["sain"]);
  });

  it("signale un lot plein, pour qu'un appelant sache qu'il en reste", async () => {
    // Sans ce drapeau, une base plus grosse que le lot se vide silencieusement
    // par le mauvais bout : personne ne sait qu'il restait du travail.
    const petit = faussePorts([du("a")]);
    expect((await passer(petit.ports, REGLAGES, DEPART)).lotPlein).toBe(false);

    const plein = faussePorts(
      Array.from({ length: LOT }, (_, i) => du(`a${i}`)),
    );
    expect((await passer(plein.ports, REGLAGES, DEPART)).lotPlein).toBe(true);
  });
});

describe("le renouvellement", () => {
  it("enchaîne le cycle et l'écrit par le port", async () => {
    // `Ecriture.renouveler` était déclaré et jamais appelé : chaque hôte devait
    // l'implémenter pour rien. C'est ce chemin-là qui lui donne un sens.
    const a = abonnement();
    const f = faussePorts([a]);

    const suivant = await finaliserRenouvellement(
      f.ports,
      a,
      ajouterJours(a.cycle.echeance, 3),
    );

    expect(f.renouveles).toHaveLength(1);
    expect(f.renouveles[0]!.id).toBe("ab-1");
    expect(f.renouveles[0]!.cycle.echeance.getTime()).toBe(
      suivant.echeance.getTime(),
    );
  });

  it("garde le rythme d'un abonné qui paie en retard", async () => {
    // La règle de `cycleSuivant`, vue depuis le moteur : on enchaîne sur
    // l'échéance, donc trois jours de retard ne décalent pas la suivante.
    const a = abonnement();
    const f = faussePorts([a]);

    const suivant = await finaliserRenouvellement(
      f.ports,
      a,
      ajouterJours(a.cycle.echeance, 3),
    );

    expect(joursEntre(a.cycle.echeance, suivant.echeance)).toBe(30);
  });

  it("repart du paiement quand l'accès était déjà perdu", async () => {
    const a = abonnement();
    const f = faussePorts([a]);
    const tard = ajouterJours(a.cycle.accesJusquA, 10);

    const suivant = await finaliserRenouvellement(f.ports, a, tard);

    expect(joursEntre(tard, suivant.echeance)).toBe(30);
  });
});

describe("l'aperçu montré à l'abonné", () => {
  it("dit l'état et le temps qui reste", async () => {
    const a = abonnement();
    const vu = apercuDe(a, ajouterJours(DEPART, 1));

    expect(vu.etat).toBe("ACTIVE");
    expect(vu.libelle).toBe("Pass Créateur");
    expect(vu.joursRestants).toBeGreaterThan(0);
  });

  it("rend un compte négatif quand l'accès est déjà coupé", async () => {
    const a = abonnement();
    const vu = apercuDe(a, ajouterJours(a.cycle.accesJusquA, 3));

    expect(vu.etat).toBe("SUSPENDUE");
    expect(vu.joursRestants).toBeLessThan(0);
  });

  it("n'envoie rien : consulter n'est pas relancer", async () => {
    // Mêler les deux ferait partir un SMS chaque fois que quelqu'un ouvre sa
    // liste d'abonnements.
    const a = abonnement();
    expect(apercuDe(a, ajouterJours(a.cycle.echeance, 5)).etat).toBe(
      "A_RENOUVELER",
    );
  });

  it("dit le même nombre de jours quelle que soit l'heure du passage", async () => {
    // Une division de millisecondes comptait depuis l'instant courant vers une
    // borne à minuit : 7 jours à minuit, 6 à treize heures, pour le même
    // abonnement. L'abonné lisait un nombre qui dépendait de l'heure du cron.
    const a = abonnement();
    const jourJ = ajouterJours(a.cycle.accesJusquA, -7);

    const comptes = [0, 3, 13, 23].map(
      (h) => apercuDe(a, new Date(jourJ.getTime() + h * 3_600_000)).joursRestants,
    );

    expect(new Set(comptes).size, `comptes: ${comptes.join(", ")}`).toBe(1);
    expect(comptes[0]).toBe(7);
  });

  it("porte le même compte dans la relance que dans l'aperçu", async () => {
    // L'écran et le message ne doivent pas pouvoir se contredire.
    const a = abonnement();
    const quand = new Date(
      ajouterJours(a.cycle.echeance, -1).getTime() + 13 * 3_600_000,
    );

    const f = faussePorts([a]);
    await passer(f.ports, REGLAGES, quand);

    expect(f.envois[0]!.message.joursRestants).toBe(
      apercuDe(a, quand).joursRestants,
    );
  });
});
