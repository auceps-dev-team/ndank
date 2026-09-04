import { describe, expect, it } from "vitest";

import type { Battements, Trace } from "../battement";
import { bilan } from "../sante";
import type { ClientNdank } from "./client";
import { signauxPrisma } from "./sante";

const PROJET = "prj-1";
const MAINTENANT = new Date("2026-02-09T06:00:00Z");
const DEPUIS = new Date("2026-02-08T06:00:00Z");

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

/**
 * Un faux client qui retient les clauses envoyées.
 *
 * Ce qu'on vérifie ici n'est pas ce que la fonction rend — ce sont les
 * **requêtes qu'elle pose** : le cloisonnement par projet, la table où elle va
 * chercher chaque moitié d'un compteur, la borne de temps qu'elle applique.
 * Rien de tout cela ne se voit dans un résultat.
 */
function fauxClient(reponses: Record<string, number[]> = {}) {
  const appels: Array<{ table: string; args: any }> = [];
  const restants: Record<string, number[]> = JSON.parse(JSON.stringify(reponses));

  const compteur = (table: string) => async (args?: any) => {
    appels.push({ table, args });
    return restants[table]?.shift() ?? 0;
  };

  const client = {
    relance: { count: compteur("relance") },
    evenement: { count: compteur("evenement") },
    versement: { count: compteur("versement") },
    webhookRecu: { count: compteur("webhookRecu") },
  } as unknown as ClientNdank;

  return { client, appels };
}

describe("les envois, lus dans deux tables et non dans une", () => {
  it("prend les partis dans les relances, et non dans le journal", async () => {
    // Le journal ne garde pas les envois réussis, sauf si l'hôte l'a demandé.
    // En tirer les tentatives donnerait `tentes === echoues` pour tous les
    // canaux, et le bilan annoncerait chaque jour que toutes les passerelles
    // sont mortes. Une alerte qui se déclenche toujours ne se lit plus.
    const f = fauxClient({ relance: [40, 30, 0], evenement: [2, 0, 0] });
    const s = signauxPrisma(f.client, battements(), { projetId: PROJET });

    const bilans = await s.envois!(DEPUIS, MAINTENANT);

    expect(bilans).toEqual([
      { canal: "courriel", tentes: 42, echoues: 2 },
      { canal: "SMS", tentes: 30, echoues: 0 },
    ]);
  });

  it("cloisonne par projet des deux côtés", async () => {
    const f = fauxClient();
    const s = signauxPrisma(f.client, battements(), { projetId: PROJET });

    await s.envois!(DEPUIS, MAINTENANT);

    for (const appel of f.appels.filter((a) => a.table === "relance")) {
      expect(appel.args.where.abonnement.projetId).toBe(PROJET);
    }
    for (const appel of f.appels.filter((a) => a.table === "evenement")) {
      expect(appel.args.where.projetId).toBe(PROJET);
    }
  });

  it("filtre les échecs sur le canal, qui vit dans le détail JSON", async () => {
    const f = fauxClient();
    const s = signauxPrisma(f.client, battements(), { projetId: PROJET });

    await s.envois!(DEPUIS, MAINTENANT);

    const evenements = f.appels.filter((a) => a.table === "evenement");
    expect(evenements[0]!.args.where.type).toBe("envoi.echoue");
    expect(evenements[0]!.args.where.detail).toEqual({
      path: ["canal"],
      equals: "COURRIEL",
    });
  });

  it("borne les deux comptages sur la même fenêtre", async () => {
    const f = fauxClient();
    const s = signauxPrisma(f.client, battements(), { projetId: PROJET });

    await s.envois!(DEPUIS, MAINTENANT);

    expect(f.appels[0]!.args.where.envoyeeLe).toEqual({
      gte: DEPUIS,
      lt: MAINTENANT,
    });
    expect(f.appels[1]!.args.where.quandLe).toEqual({
      gte: DEPUIS,
      lt: MAINTENANT,
    });
  });

  it("omet un canal dont il ne s'est rien passé", async () => {
    // Il n'avait rien à faire ; ce n'est pas un canal mort. L'omettre évite
    // d'avoir à distinguer les deux plus haut.
    const f = fauxClient({ relance: [0, 0, 0], evenement: [0, 0, 0] });
    const s = signauxPrisma(f.client, battements(), { projetId: PROJET });

    expect(await s.envois!(DEPUIS, MAINTENANT)).toEqual([]);
  });

  it("nomme les canaux comme on les dit dans une phrase", async () => {
    const f = fauxClient({ relance: [0, 0, 5], evenement: [0, 0, 1] });
    const s = signauxPrisma(f.client, battements(), { projetId: PROJET });

    expect((await s.envois!(DEPUIS, MAINTENANT))[0]!.canal).toBe("push");
  });

  it("n'interroge que les canaux qu'on lui donne", async () => {
    const f = fauxClient();
    const s = signauxPrisma(f.client, battements(), {
      projetId: PROJET,
      canaux: ["SMS"],
    });

    await s.envois!(DEPUIS, MAINTENANT);

    expect(f.appels.filter((a) => a.table === "relance")).toHaveLength(1);
  });
});

describe("les paiements non comptés", () => {
  it("cherche un versement réussi que rien n'a compté", async () => {
    const f = fauxClient({ versement: [3] });
    const s = signauxPrisma(f.client, battements(), { projetId: PROJET });

    expect(await s.paiementsNonComptes!(DEPUIS)).toBe(3);
    expect(f.appels[0]!.args.where).toMatchObject({
      etat: "REUSSI",
      compteLe: null,
    });
  });

  it("borne sur `regleLe`, et non sur `creeLe`", async () => {
    // Ce qu'on cherche est un paiement arrivé récemment et resté sans effet.
    // Un versement créé il y a un mois et réglé ce matin est exactement le cas
    // qui doit remonter — et `creeLe` le manquerait.
    const f = fauxClient();
    const s = signauxPrisma(f.client, battements(), { projetId: PROJET });

    await s.paiementsNonComptes!(DEPUIS);

    expect(f.appels[0]!.args.where.regleLe).toEqual({ gte: DEPUIS });
    expect(f.appels[0]!.args.where.creeLe).toBeUndefined();
  });
});

describe("les signatures refusées", () => {
  it("compte les webhooks rejetés de la période", async () => {
    const f = fauxClient({ webhookRecu: [7] });
    const s = signauxPrisma(f.client, battements(), { projetId: PROJET });

    expect(await s.signaturesRefusees!(DEPUIS)).toBe(7);
    expect(f.appels[0]!.args.where).toEqual({
      projetId: PROJET,
      signatureValide: false,
      recuLe: { gte: DEPUIS },
    });
  });
});

describe("les injoignables", () => {
  it("les reprend de la trace, sans refaire la requête", async () => {
    // Le moteur vient de parcourir exactement les abonnements concernés, avec
    // sa propre définition de « à relancer ». Une seconde requête écrite ici
    // finirait par répondre autre chose le jour où l'échelle change.
    const f = fauxClient();
    const s = signauxPrisma(f.client, battements(trace({ injoignables: 4 })), {
      projetId: PROJET,
    });

    expect(await s.injoignables!()).toBe(4);
    expect(f.appels).toHaveLength(0);
  });

  it("rend zéro quand aucun passage n'a tourné", async () => {
    const f = fauxClient();
    const s = signauxPrisma(f.client, battements(null), { projetId: PROJET });

    expect(await s.injoignables!()).toBe(0);
  });
});

describe("branchés sur le bilan, d'un bout à l'autre", () => {
  it("ne crie pas au canal mort un jour ordinaire", async () => {
    // C'est la régression que l'arbitrage de ce fichier évite : si « tentés »
    // venait du journal, ce cas-là — quarante courriels partis, deux ratés —
    // donnerait « aucun courriel n'est parti ».
    const f = fauxClient({ relance: [40, 30, 0], evenement: [2, 1, 0] });
    const s = signauxPrisma(f.client, battements(), { projetId: PROJET });

    const constats = await bilan(s, {}, MAINTENANT);

    expect(constats.find((c) => c.quoi === "CANAL_MORT")).toBeUndefined();
    expect(constats.find((c) => c.quoi === "ENVOIS")?.titre).toBe(
      "3 relances sur 73 n'ont pas pu partir.",
    );
  });

  it("crie quand un canal ne passe vraiment plus", async () => {
    const f = fauxClient({ relance: [40, 0, 0], evenement: [2, 30, 0] });
    const s = signauxPrisma(f.client, battements(), { projetId: PROJET });

    const constats = await bilan(s, {}, MAINTENANT);
    const mort = constats.find((c) => c.quoi === "CANAL_MORT");

    expect(mort?.gravite).toBe("ALERTE");
    expect(mort?.titre).toBe("Aucun SMS n'est parti : 30 tentatives, 30 échecs.");
  });

  it("rend une page entière de phrases lisibles", async () => {
    const f = fauxClient({
      relance: [40, 0, 0],
      evenement: [2, 30, 0],
      versement: [1],
      webhookRecu: [5],
    });
    const s = signauxPrisma(
      f.client,
      battements(trace({ injoignables: 2, echecs: 3, lotPlein: true })),
      { projetId: PROJET },
    );

    const constats = await bilan(s, {}, MAINTENANT);

    expect(constats.map((c) => c.quoi)).toEqual([
      "CANAL_MORT",
      "PAIEMENTS_NON_COMPTES",
      "SIGNATURES_REFUSEES",
      "ECHECS_PASSAGE",
      "LOT_PLEIN",
      "ENVOIS",
      "INJOIGNABLES",
      "MOTEUR",
    ]);

    for (const c of constats) {
      expect(c.titre.trim().endsWith(".")).toBe(true);
      expect(c.quoiFaire.length).toBeGreaterThan(10);
    }
  });
});
