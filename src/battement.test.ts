import { describe, expect, it } from "vitest";

import {
  BLOQUE_APRES_HEURES,
  RETARD_TOLERE_HEURES,
  direSante,
  passerEtTracer,
  sante,
  type Battements,
  type Trace,
} from "./battement";
import { cycleApresPaiement } from "./cycle";
import type { AbonnementLu, Ports } from "./ports";

const MAINTENANT = new Date("2026-02-09T06:00:00Z");

const ilYA = (heures: number): Date =>
  new Date(MAINTENANT.getTime() - heures * 3_600_000);

function trace(sur: Partial<Trace> = {}): Trace {
  return {
    id: "p-1",
    commenceLe: ilYA(2),
    termineLe: ilYA(2),
    vus: 12,
    relances: 3,
    suspendus: 1,
    clos: 0,
    injoignables: 0,
    echecs: 0,
    lotPlein: false,
    erreur: null,
    ...sur,
  };
}

/** Des battements en mémoire, qui retiennent ce qu'on leur a demandé. */
function faussesTraces(derniere: Trace | null = null) {
  const traces: Trace[] = [];
  const appels: string[] = [];

  const battements: Battements = {
    async commencer(quand) {
      appels.push("commencer");
      traces.push(trace({ id: `p-${traces.length + 1}`, commenceLe: quand, termineLe: null }));
      return `p-${traces.length}`;
    },
    async terminer(id, bilan, quand) {
      appels.push("terminer");
      const t = traces.find((x) => x.id === id)!;
      Object.assign(t, {
        termineLe: quand,
        vus: bilan.vus,
        relances: bilan.relances,
        suspendus: bilan.suspendus,
        clos: bilan.clos,
        injoignables: bilan.injoignables,
        echecs: bilan.echecs.length,
        lotPlein: bilan.lotPlein,
      });
    },
    async echouer(id, erreur, quand) {
      appels.push("echouer");
      const t = traces.find((x) => x.id === id)!;
      Object.assign(t, { termineLe: quand, erreur });
    },
    async dernier() {
      return derniere ?? traces[traces.length - 1] ?? null;
    },
  };

  return { battements, traces, appels };
}

function abonnement(): AbonnementLu {
  return {
    id: "ab-1",
    abonneId: "usr-1",
    cadence: "MENSUEL",
    cycle: cycleApresPaiement(MAINTENANT, "MENSUEL"),
    resilieeLe: null,
    suspenduLe: null,
    montant: 2000,
    devise: "XOF",
    libelle: "Pass",
  };
}

function fauxPorts(quiCasse = false): Ports {
  return {
    lecture: {
      async aRelancer() {
        if (quiCasse) throw new Error("base injoignable");
        return [abonnement()];
      },
      async relancesEnvoyees() {
        return [];
      },
      async coordonnees() {
        return { nom: null, courriel: null, telephone: null, appareils: [] };
      },
    },
    ecriture: {
      async noterRelance() {},
      async suspendre() {},
      async clore() {},
      async renouveler() {},
    },
    envoi: {
      disponible: () => false,
      async envoyer() {
        return false;
      },
    },
  };
}

const REDACTION = { lien: () => "https://p.test/v/x", montant: () => "2000 XOF" };

describe("tracer un passage", () => {
  it("ouvre la trace AVANT de commencer, et la ferme après", async () => {
    // L'ordre est le point : un passage qui a démarré et n'a jamais fini doit
    // être distinguable d'un passage qui n'a jamais démarré. Ce ne sont pas les
    // mêmes pannes, et les confondre ferait chercher au mauvais endroit.
    const f = faussesTraces();

    await passerEtTracer(fauxPorts(), REDACTION, f.battements, MAINTENANT);

    expect(f.appels).toEqual(["commencer", "terminer"]);
    expect(f.traces[0]!.termineLe).not.toBeNull();
    expect(f.traces[0]!.vus).toBe(1);
  });

  it("ferme la trace même quand le passage tombe, et relance l'erreur", async () => {
    // Sans cela, une panne laisserait une trace ouverte pour toujours —
    // indiscernable d'un passage encore en cours.
    const f = faussesTraces();

    await expect(
      passerEtTracer(fauxPorts(true), REDACTION, f.battements, MAINTENANT),
    ).rejects.toThrow(/base injoignable/);

    expect(f.appels).toEqual(["commencer", "echouer"]);
    expect(f.traces[0]!.erreur).toContain("base injoignable");
    expect(f.traces[0]!.termineLe).not.toBeNull();
  });

  it("ne masque pas la vraie cause si la trace elle-même ne peut pas s'écrire", async () => {
    const f = faussesTraces();
    f.battements.echouer = async () => {
      throw new Error("disque plein");
    };

    await expect(
      passerEtTracer(fauxPorts(true), REDACTION, f.battements, MAINTENANT),
    ).rejects.toThrow(/base injoignable/);
  });

  it("rend le bilan tel quel", async () => {
    // L'enveloppement ne change rien à ce que l'appelant voit ; il ajoute
    // seulement ce que personne ne voyait.
    const f = faussesTraces();

    const bilan = await passerEtTracer(
      fauxPorts(),
      REDACTION,
      f.battements,
      MAINTENANT,
    );

    expect(bilan.vus).toBe(1);
    expect(bilan.lotPlein).toBe(false);
  });
});

describe("la santé du moteur", () => {
  it("dit BIEN quand un passage vient de tourner", async () => {
    const f = faussesTraces(trace({ termineLe: ilYA(3) }));

    const etat = await sante(f.battements, {}, MAINTENANT);

    expect(etat.va).toBe("BIEN");
    expect(etat.va === "BIEN" && etat.heures).toBe(3);
  });

  it("distingue « jamais tourné » de « ne tourne plus »", async () => {
    // La planification n'a jamais été posée, ou elle est morte. Ce n'est pas
    // la même conversation.
    const jamais = faussesTraces(null);
    const mort = faussesTraces(trace({ termineLe: ilYA(50) }));

    expect((await sante(jamais.battements, {}, MAINTENANT)).va).toBe("JAMAIS");
    expect((await sante(mort.battements, {}, MAINTENANT)).va).toBe("MUET");
  });

  it("tolère la dérive normale d'un cron quotidien", async () => {
    // S'il tourne à 6 h 00 un jour et 6 h 05 le lendemain, l'écart dépasse
    // vingt-quatre heures. Un seuil à vingt-quatre alerterait chaque semaine,
    // jusqu'à ce que plus personne ne regarde.
    const derive = faussesTraces(trace({ termineLe: ilYA(24.2) }));
    const manque = faussesTraces(trace({ termineLe: ilYA(48) }));

    expect((await sante(derive.battements, {}, MAINTENANT)).va).toBe("BIEN");
    expect((await sante(manque.battements, {}, MAINTENANT)).va).toBe("MUET");
    expect(RETARD_TOLERE_HEURES).toBeGreaterThan(24);
  });

  it("signale un passage ouvert depuis trop longtemps", async () => {
    // Un passage sur cinq cents abonnements prend des secondes. Si la trace est
    // encore ouverte deux heures après, le processus est bloqué ou a été tué.
    const bloque = faussesTraces(
      trace({ commenceLe: ilYA(BLOQUE_APRES_HEURES + 1), termineLe: null }),
    );

    const etat = await sante(bloque.battements, {}, MAINTENANT);

    expect(etat.va).toBe("BLOQUE");
  });

  it("ne prend pas le passage en cours pour une panne", async () => {
    // Le tableau de bord peut être ouvert pendant que le cron tourne.
    const enCours = faussesTraces(trace({ commenceLe: ilYA(0.01), termineLe: null }));

    expect((await sante(enCours.battements, {}, MAINTENANT)).va).toBe("BIEN");
  });

  it("dit TOMBE quand le dernier passage a échoué en entier", async () => {
    const f = faussesTraces(
      trace({ termineLe: ilYA(1), erreur: "Error: base injoignable" }),
    );

    const etat = await sante(f.battements, {}, MAINTENANT);

    expect(etat.va).toBe("TOMBE");
    expect(etat.va === "TOMBE" && etat.erreur).toContain("injoignable");
  });

  it("laisse l'hôte resserrer les seuils", async () => {
    const f = faussesTraces(trace({ termineLe: ilYA(3) }));

    expect(
      (await sante(f.battements, { retardTolereHeures: 2 }, MAINTENANT)).va,
    ).toBe("MUET");
  });
});

describe("ce qu'on affiche au marchand", () => {
  it("attache une action à chaque état, jamais un mot seul", async () => {
    // « BLOQUE » sans rien d'autre n'aide personne.
    const cas = [
      { va: "JAMAIS" } as const,
      { va: "MUET", dernier: ilYA(50), heures: 50 } as const,
      { va: "BLOQUE", depuis: ilYA(4), heures: 4 } as const,
      { va: "TOMBE", dernier: ilYA(1), heures: 1, erreur: "Error: x" } as const,
    ];

    for (const etat of cas) {
      const dit = direSante(etat);
      expect(dit.titre.length).toBeGreaterThan(10);
      expect(dit.quoiFaire.length).toBeGreaterThan(10);
    }
  });

  it("dit « rien à faire » quand tout va bien, plutôt que de se taire", async () => {
    const dit = direSante({ va: "BIEN", dernier: ilYA(3), heures: 3 });

    expect(dit.titre).toContain("3 h");
    expect(dit.quoiFaire).toBe("Rien à faire.");
  });

  it("explique la conséquence, et pas seulement le symptôme", async () => {
    // Ce qui compte pour un marchand, ce n'est pas qu'un cron soit mort :
    // c'est que plus une relance ne parte.
    const dit = direSante({ va: "MUET", dernier: ilYA(50), heures: 50 });

    expect(dit.quoiFaire).toContain("relance");
    expect(dit.quoiFaire).toContain("accès");
  });
});
