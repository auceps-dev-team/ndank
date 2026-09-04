import { describe, expect, it } from "vitest";

import type { ClientNdank } from "./client";
import { journalPrisma } from "./journal";

const PROJET = "prj-1";

/** Un client qui retient les lots écrits. */
function fauxClient(quiCasse = false) {
  const evenements: Record<string, unknown>[] = [];
  const recus: Record<string, unknown>[] = [];
  const lots: number[] = [];

  const vide = {
    async findMany() {
      return [];
    },
    async findFirst() {
      return null;
    },
    async findUnique() {
      return null;
    },
    async count() {
      return 0;
    },
    async createMany() {
      return {};
    },
    async update() {
      return {};
    },
    async updateMany() {
      return {};
    },
    async upsert() {
      return {};
    },
    async create() {
      return {};
    },
  };

  const client = {
    ...({} as ClientNdank),
    abonnement: vide,
    abonne: vide,
    offre: vide,
    relance: vide,
    versement: { ...vide, async groupBy() { return []; } },
    passage: vide,
    evenement: {
      ...vide,
      async createMany(args: { data: Record<string, unknown>[] }) {
        if (quiCasse) throw new Error("base indisponible");
        lots.push(args.data.length);
        evenements.push(...args.data);
        return {};
      },
    },
    webhookRecu: {
      ...vide,
      async createMany(args: { data: Record<string, unknown>[] }) {
        recus.push(...args.data);
        return {};
      },
    },
  } as unknown as ClientNdank;

  return { client, evenements, recus, lots };
}

describe("ce que le journal garde", () => {
  it("jette les envois réussis — ils sont déjà dans « Relance »", async () => {
    // Cinq cents lignes par jour qui n'apprennent rien, et qui noieraient les
    // quelques échecs qui, eux, demandent une action.
    const f = fauxClient();
    const j = journalPrisma(f.client, { projetId: PROJET });

    j.envoi({ canal: "sms", transporteur: "twilio", cle: "c1", parti: true, reference: "SM1" });
    await j.vider();

    expect(f.evenements).toHaveLength(0);
  });

  it("garde les envois qui ont échoué, avec leur cause", async () => {
    const f = fauxClient();
    const j = journalPrisma(f.client, { projetId: PROJET });

    j.envoi({
      canal: "sms",
      transporteur: "twilio",
      cle: "c1",
      parti: false,
      reference: null,
      cause: new Error("clé révoquée"),
    });
    await j.vider();

    expect(f.evenements).toHaveLength(1);
    expect(f.evenements[0]!["type"]).toBe("envoi.echoue");
    expect(String((f.evenements[0]!["detail"] as Record<string, unknown>)["cause"])).toContain(
      "révoquée",
    );
  });

  it("garde les jetons d'appareil morts, qu'on ne voit nulle part ailleurs", async () => {
    // Ce sont eux qui disent qu'un abonné n'est plus joignable en push alors
    // que sa liste d'appareils n'est pas vide.
    const f = fauxClient();
    const j = journalPrisma(f.client, { projetId: PROJET });

    j.envoi({
      canal: "push",
      transporteur: "expo",
      cle: "c1",
      parti: true,
      reference: "t-1",
      aRetirer: ["ExponentPushToken[b]"],
    });
    await j.vider();

    // Réussi, donc normalement jeté — mais on le garde parce qu'il porte des
    // jetons morts. Expo répond 200 avec un refus par appareil : la
    // notification part vers un téléphone et est refusée par l'autre, dont
    // l'application a été désinstallée.
    expect(f.evenements).toHaveLength(1);
    expect(f.evenements[0]!["type"]).toBe("envoi.parti");
    expect((f.evenements[0]!["detail"] as Record<string, unknown>)["aRetirer"]).toEqual([
      "ExponentPushToken[b]",
    ]);
  });

  it("garde toutes les étapes de la page, ouvertures comprises", async () => {
    // C'est le seul endroit qui puisse dire combien de gens ouvrent la page et
    // ne vont pas au bout — la moitié de la raison d'héberger cette page.
    const f = fauxClient();
    const j = journalPrisma(f.client, { projetId: PROJET });

    j.page({ quoi: "OUVERTE", abonnementId: "ab-1", fournisseur: null, reference: null });
    j.page({ quoi: "INVITEE", abonnementId: "ab-1", fournisseur: "paystack", reference: "r-1" });
    await j.vider();

    expect(f.evenements.map((e) => e["type"])).toEqual(["page.OUVERTE", "page.INVITEE"]);
    expect(f.evenements[0]!["abonnementId"]).toBe("ab-1");
  });

  it("jette les lectures d'API réussies, garde les refus", async () => {
    // Un tableau de bord qui interroge toutes les trente secondes produit deux
    // mille huit cents lectures par jour. Les garder inonderait la table en une
    // nuit, et l'on n'y trouverait plus les quelques 401.
    const f = fauxClient();
    const j = journalPrisma(f.client, { projetId: PROJET });

    j.api({ route: "/resume", statut: 200 });
    j.api({ route: "/abonnements", statut: 401 });
    await j.vider();

    expect(f.evenements).toHaveLength(1);
    expect((f.evenements[0]!["detail"] as Record<string, unknown>)["statut"]).toBe(401);
  });

  it("jette les gestes posés, garde les refus", async () => {
    // Les gestes posés sont déjà dans `Evenement` avec leur auteur, écrits par
    // `interventions.journaliser`. Ce qui manque, ce sont ceux qui n'ont pas
    // abouti : ceux-là ne laissent aucune trace ailleurs.
    const f = fauxClient();
    const j = journalPrisma(f.client, { projetId: PROJET });

    j.gestes({ route: "/abonnements/ab-1/suspendre", auteur: "awa", statut: 200 });
    j.gestes({ route: "/abonnements/ab-1/paiement", auteur: null, statut: 400 });
    await j.vider();

    expect(f.evenements).toHaveLength(1);
    expect((f.evenements[0]!["detail"] as Record<string, unknown>)["auteur"]).toBeNull();
  });

  it("laisse l'hôte tout garder s'il le veut", async () => {
    const f = fauxClient();
    const j = journalPrisma(f.client, {
      projetId: PROJET,
      envoisReussis: true,
      lecturesReussies: true,
    });

    j.envoi({ canal: "sms", transporteur: "twilio", cle: "c1", parti: true, reference: "x" });
    j.api({ route: "/resume", statut: 200 });
    await j.vider();

    expect(f.evenements).toHaveLength(2);
  });
});

describe("la table WebhookRecu, enfin écrite", () => {
  it("garde le corps brut sur le fait terminal", async () => {
    // Déclarée dans le schéma depuis la 0.4.0, jamais écrite une seule fois.
    // C'est pourtant la seule chose qui permette de comprendre le jour où un
    // opérateur change un code sans prévenir.
    const f = fauxClient();
    const j = journalPrisma(f.client, { projetId: PROJET });

    j.webhook({
      quoi: "TRAITE",
      fournisseur: "paystack",
      reference: "20260209-1-ab-1",
      abonnementId: "ab-1",
      corps: '{"event":"charge.success"}',
      signatureValide: true,
    });
    await j.vider();

    expect(f.recus).toHaveLength(1);
    expect(f.recus[0]).toMatchObject({
      fournisseur: "paystack",
      signatureValide: true,
      reference: "20260209-1-ab-1",
      issue: "TRAITE",
    });
  });

  it("n'écrit rien sur « RECU », qui précède la vérification de signature", async () => {
    // `WebhookRecu.signatureValide` n'accepte pas de doute, et `RECU` est émis
    // avant qu'on sache.
    const f = fauxClient();
    const j = journalPrisma(f.client, { projetId: PROJET });

    j.webhook({ quoi: "RECU", fournisseur: "paystack", reference: null, abonnementId: null });
    await j.vider();

    expect(f.recus).toHaveLength(0);
    // L'événement, lui, est bien noté.
    expect(f.evenements).toHaveLength(1);
  });

  it("conserve une signature invalide, qui est précisément ce qu'on veut voir", async () => {
    const f = fauxClient();
    const j = journalPrisma(f.client, { projetId: PROJET });

    j.webhook({
      quoi: "SIGNATURE",
      fournisseur: "paystack",
      reference: null,
      abonnementId: null,
      corps: "{}",
      signatureValide: false,
    });
    await j.vider();

    expect(f.recus[0]!["signatureValide"]).toBe(false);
  });

  it("tronque un corps démesuré plutôt que de faire grossir la table", async () => {
    const f = fauxClient();
    const j = journalPrisma(f.client, { projetId: PROJET });

    j.webhook({
      quoi: "TRAITE",
      fournisseur: "x",
      reference: null,
      abonnementId: null,
      corps: "a".repeat(100_000),
      signatureValide: true,
    });
    await j.vider();

    expect(String(f.recus[0]!["corps"]).length).toBe(20_000);
  });
});

describe("le tampon", () => {
  it("écrit par lots, et non un fait à la fois", async () => {
    // Cinq cents insertions lancées une par une sont une rafale sur la base,
    // au moment précis où elle sert à autre chose.
    const f = fauxClient();
    const j = journalPrisma(f.client, { projetId: PROJET, parLot: 1000 });

    for (let i = 0; i < 30; i += 1) {
      j.api({ route: `/r${i}`, statut: 500 });
    }

    expect(j.enAttente()).toBe(30);
    await j.vider();

    expect(f.lots).toEqual([30]);
  });

  it("se vide tout seul quand le lot déborde, pour borner la mémoire", async () => {
    const f = fauxClient();
    const j = journalPrisma(f.client, { projetId: PROJET, parLot: 5 });

    for (let i = 0; i < 5; i += 1) j.api({ route: `/r${i}`, statut: 500 });

    // Le débordement part sans attendre : on laisse la microtâche s'exécuter.
    await Promise.resolve();
    await Promise.resolve();

    expect(j.enAttente()).toBe(0);
  });

  it("ne lève jamais, et raconte son propre échec", async () => {
    // Un journal qui fait tomber ce qu'il observe ne sert à rien. Mais une base
    // qui refuse les écritures le rendrait silencieusement inutile — ce qui est
    // exactement la panne qu'il existe pour révéler ailleurs.
    const f = fauxClient(true);
    const causes: unknown[] = [];

    const j = journalPrisma(f.client, {
      projetId: PROJET,
      surErreur: (c) => causes.push(c),
    });

    j.api({ route: "/x", statut: 500 });

    await expect(j.vider()).resolves.toBeUndefined();
    expect(causes).toHaveLength(1);
  });

  it("ne réécrit pas ce qu'il a déjà vidé", async () => {
    const f = fauxClient();
    const j = journalPrisma(f.client, { projetId: PROJET });

    j.api({ route: "/x", statut: 500 });
    await j.vider();
    await j.vider();

    expect(f.evenements).toHaveLength(1);
  });
});
