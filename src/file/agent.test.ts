import { describe, expect, it } from "vitest";

import type { Http, Requete } from "../http";
import type { Remise, TransporteurSms } from "../envoi/port";
import { agentSms, type FaitAgent } from "./agent";

const BASE = "https://mon-app.ci/sms";
const JETON = "jeton-de-la-file";

/** Une file jouée à l'avance : chaque tour rend ce qu'on lui a mis. */
function fausseFile(tours: Array<{ statut?: number; corps?: unknown }>) {
  const vues: Requete[] = [];
  let i = 0;

  const http: Http = async (requete) => {
    vues.push(requete);

    if (requete.url.includes("/accuses")) {
      return { statut: 200, corps: '{"recus":0}' };
    }

    const t = tours[i++];
    // Rien de prévu : la file est vide, ce qui arrête la boucle des tests.
    if (!t) return { statut: 204, corps: "" };

    return {
      statut: t.statut ?? 200,
      corps: t.corps === undefined ? "" : JSON.stringify(t.corps),
    };
  };

  return {
    http,
    vues,
    accuses: () =>
      vues
        .filter((v) => v.url.includes("/accuses"))
        .map((v) => JSON.parse(v.corps!)),
  };
}

function fauxTransporteur(remise: Partial<Remise> = {}): TransporteurSms & {
  vus: string[];
} {
  const t = {
    nom: "faux",
    canal: "sms" as const,
    vus: [] as string[],
    async envoyer(ou: { telephone: string | null }): Promise<Remise> {
      t.vus.push(ou.telephone!);
      return { parti: true, reference: "SIM-1", ...remise };
    },
  };
  return t;
}

const attente = (id: string, dans = 3600) => ({
  id,
  telephone: "+2250718350482",
  texte: "Pass Créateur : 2 000 XOF.",
  expireLe: new Date(Date.now() + dans * 1000).toISOString(),
});

/** Arrête l'agent au premier tour vide, pour que les tests se terminent. */
function jusquAuVide(faits: FaitAgent[], agent: { arreter(): void }) {
  return (f: FaitAgent) => {
    faits.push(f);
    if (f.quoi === "VIDE") agent.arreter();
  };
}

describe("l'agent", () => {
  it("prend un lot, l'émet, et l'acquitte", async () => {
    const f = fausseFile([{ corps: [attente("m-1"), attente("m-2")] }]);
    const t = fauxTransporteur();
    const faits: FaitAgent[] = [];

    const agent = agentSms({
      base: BASE,
      jeton: JETON,
      transporteur: t,
      http: f.http,
      journal: (x) => journal(x),
    });
    const journal = jusquAuVide(faits, agent);

    await agent.demarrer();

    expect(t.vus).toEqual(["+2250718350482", "+2250718350482"]);
    expect(f.accuses()[0]).toEqual([
      { id: "m-1", parti: true, reference: "SIM-1" },
      { id: "m-2", parti: true, reference: "SIM-1" },
    ]);
    expect(faits[0]).toEqual({ quoi: "LOT", recus: 2, partis: 2, expires: 0 });
  });

  it("porte le jeton sur les deux routes", async () => {
    const f = fausseFile([{ corps: [attente("m-1")] }]);
    const agent = agentSms({
      base: BASE,
      jeton: JETON,
      transporteur: fauxTransporteur(),
      http: f.http,
      journal: (x) => journal(x),
    });
    const journal = jusquAuVide([], agent);

    await agent.demarrer();

    for (const v of f.vues) {
      expect(v.entetes["Authorization"]).toBe(`Bearer ${JETON}`);
    }
  });

  it("acquitte aussi ce qui a échoué, au lieu de se taire", async () => {
    // Se taire laisserait les messages sous bail plusieurs minutes, alors
    // qu'on sait déjà qu'il faut réessayer.
    const f = fausseFile([{ corps: [attente("m-1")] }]);
    const t = fauxTransporteur({ parti: false, reference: null });
    const agent = agentSms({
      base: BASE,
      jeton: JETON,
      transporteur: t,
      http: f.http,
      journal: (x) => journal(x),
    });
    const journal = jusquAuVide([], agent);

    await agent.demarrer();

    expect(f.accuses()[0]).toEqual([{ id: "m-1", parti: false, reference: null }]);
  });

  it("n'émet pas un message expiré pendant que le lot s'écoulait", async () => {
    // Avec six secondes d'espacement, dix messages prennent une minute : le
    // dernier peut avoir expiré. Un rappel qui arrive après sa date dit le
    // contraire de ce qu'il devait dire.
    const f = fausseFile([
      { corps: [attente("m-1"), { ...attente("m-2"), expireLe: new Date(Date.now() - 1000).toISOString() }] },
    ]);
    const t = fauxTransporteur();
    const faits: FaitAgent[] = [];
    const agent = agentSms({
      base: BASE,
      jeton: JETON,
      transporteur: t,
      http: f.http,
      journal: (x) => journal(x),
    });
    const journal = jusquAuVide(faits, agent);

    await agent.demarrer();

    expect(t.vus).toHaveLength(1);
    // Acquitté comme parti pour qu'il quitte la file : le rendre le ferait
    // réessayer jusqu'à ce que la file le purge d'elle-même.
    expect(f.accuses()[0]).toContainEqual({ id: "m-2", parti: true, reference: null });
    expect(faits[0]).toMatchObject({ expires: 1 });
  });

  it("ne laisse pas une passerelle qui lève emporter le reste du lot", async () => {
    // Les neuf autres messages n'y sont pour rien.
    const f = fausseFile([{ corps: [attente("m-1"), attente("m-2")] }]);
    let appels = 0;
    const t: TransporteurSms = {
      nom: "faux",
      canal: "sms",
      async envoyer(): Promise<Remise> {
        appels += 1;
        if (appels === 1) throw new Error("passerelle injoignable");
        return { parti: true, reference: "SIM-2" };
      },
    };

    const faits: FaitAgent[] = [];
    const agent = agentSms({
      base: BASE,
      jeton: JETON,
      transporteur: t,
      http: f.http,
      journal: (x) => journal(x),
    });
    const journal = jusquAuVide(faits, agent);

    await agent.demarrer();

    expect(appels).toBe(2);
    expect(f.accuses()[0][0]).toMatchObject({ id: "m-1", parti: false });
    expect(f.accuses()[0][1]).toMatchObject({ id: "m-2", parti: true });
    expect(faits.some((x) => x.quoi === "ERREUR")).toBe(true);
  });
});

describe("ce qui arrête l'agent, et ce qui ne l'arrête pas", () => {
  it("s'arrête sur un jeton refusé : réessayer n'y changerait rien", async () => {
    const f = fausseFile([{ statut: 401, corps: { erreur: "non" } }]);
    const faits: FaitAgent[] = [];

    await agentSms({
      base: BASE,
      jeton: "faux",
      transporteur: fauxTransporteur(),
      http: f.http,
      journal: (x) => faits.push(x),
    }).demarrer();

    expect(faits).toEqual([{ quoi: "REFUSE", statut: 401 }]);
    // Un seul appel : il n'a pas bouclé.
    expect(f.vues).toHaveLength(1);
  });

  it("souffle après une erreur réseau, au lieu de tourner à vide", async () => {
    // Sans pause, un serveur inaccessible ferait de l'agent la charge qu'il est
    // censé alléger.
    const attentes: number[] = [];
    let tours = 0;

    const http: Http = async () => {
      tours += 1;
      if (tours === 1) throw new Error("ECONNREFUSED");
      return { statut: 204, corps: "" };
    };

    const faits: FaitAgent[] = [];
    const agent = agentSms({
      base: BASE,
      jeton: JETON,
      transporteur: fauxTransporteur(),
      http,
      pauseErreur: 5000,
      attendre: async (ms) => {
        attentes.push(ms);
      },
      journal: (x) => journal(x),
    });
    const journal = jusquAuVide(faits, agent);

    await agent.demarrer();

    expect(attentes).toEqual([5000]);
    expect(faits[0]).toMatchObject({ quoi: "ERREUR", ou: "FILE" });
  });

  it("continue après un 500, parce qu'un serveur se relève", async () => {
    const f = fausseFile([{ statut: 500, corps: {} }, { corps: [attente("m-1")] }]);
    const t = fauxTransporteur();
    const agent = agentSms({
      base: BASE,
      jeton: JETON,
      transporteur: t,
      http: f.http,
      attendre: async () => {},
      journal: (x) => journal(x),
    });
    const journal = jusquAuVide([], agent);

    await agent.demarrer();

    expect(t.vus).toHaveLength(1);
  });

  it("s'arrête quand on le lui demande", async () => {
    const f = fausseFile([]);
    const faits: FaitAgent[] = [];
    const agent = agentSms({
      base: BASE,
      jeton: JETON,
      transporteur: fauxTransporteur(),
      http: f.http,
      journal: (x) => journal(x),
    });
    const journal = jusquAuVide(faits, agent);

    await agent.demarrer();

    expect(faits).toEqual([{ quoi: "VIDE" }]);
  });
});
