import { describe, expect, it } from "vitest";

import { ajouterJours, cleDeCycle, cycleApresPaiement } from "../cycle";
import { passer } from "../moteur";
import type { Canal, Coordonnees, Message, Ports } from "../ports";
import { abonnementDe, portsPrisma } from "./adaptateur";
import type { ClientNdank, LigneAbonnement } from "./client";

const DEPART = new Date("2026-01-10T00:00:00Z");
const PROJET = "prj-1";

/**
 * Un faux client Prisma, en mémoire.
 *
 * Il enregistre tout ce qu'on lui demande. C'est ce qui permet de vérifier non
 * seulement ce que l'adaptateur rend, mais **les clauses qu'il envoie** — le
 * cloisonnement par projet, les exclusions du lot, l'idempotence des écritures.
 * Ces clauses-là ne se voient pas dans le résultat ; elles ne se voient que là.
 */
function fauxClient(abonnements: LigneAbonnement[] = []) {
  const appels: Array<{ table: string; methode: string; args: any }> = [];
  const relances = new Map<string, { canaux: string[] }>();
  const evenements = new Map<string, unknown>();
  const versements: Array<{ id: string; identifiantFournisseur: string; compteLe: Date | null }> = [];
  const abonnes = new Map<string, { nom: string | null; courriel: string | null; telephone: string | null; appareils: string[] }>();

  const noter = (table: string, methode: string, args: any) => {
    appels.push({ table, methode, args });
  };

  const client: ClientNdank = {
    abonnement: {
      async findMany(args) {
        noter("abonnement", "findMany", args);
        const w = args?.where ?? {};
        return abonnements
          .filter((a) => {
            if (w.closLe === null && a.closLe !== null) return false;
            if (w.resilieeLe === null && a.resilieeLe !== null) return false;
            if (w.echeance?.lte && a.echeance > w.echeance.lte) return false;
            return true;
          })
          .sort((x, y) => x.echeance.getTime() - y.echeance.getTime())
          .slice(0, args?.take ?? undefined);
      },
      async findUnique(args) {
        noter("abonnement", "findUnique", args);
        return abonnements.find((a) => a.id === args.where.id) ?? null;
      },
      async findFirst() {
        return null;
      },
      async update(args) {
        noter("abonnement", "update", args);
        return {};
      },
      async updateMany(args) {
        noter("abonnement", "updateMany", args);
        const w = args.where;
        for (const a of abonnements) {
          if (a.id !== w.id) continue;
          if (w.projetId && w.projetId !== PROJET) continue;
          if (w.closLe === null && a.closLe !== null) continue;
          Object.assign(a, args.data);
        }
        return {};
      },
      async upsert(args) {
        noter("abonnement", "upsert", args);
        return {};
      },
      async create(args) {
        noter("abonnement", "create", args);
        return {};
      },
    },

    abonne: {
      async findUnique(args) {
        noter("abonne", "findUnique", args);
        return abonnes.get(args.where.id) ?? null;
      },
      async findMany() {
        return [];
      },
      async findFirst() {
        return null;
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
    },

    relance: {
      async findMany(args) {
        noter("relance", "findMany", args);
        const prefixe = args?.where?.cle?.startsWith ?? "";
        return [...relances.keys()]
          .filter((k) => k.startsWith(`${args.where.abonnementId}|`))
          .map((k) => ({ cle: k.split("|")[1]! }))
          .filter((r) => r.cle.startsWith(prefixe));
      },
      async upsert(args) {
        noter("relance", "upsert", args);
        const { abonnementId, cle } = args.where.abonnementId_cle;
        const k = `${abonnementId}|${cle}`;
        // L'unicité : la première écriture fait foi.
        if (!relances.has(k)) relances.set(k, { canaux: args.create.canaux });
        return {};
      },
      async findUnique() {
        return null;
      },
      async findFirst() {
        return null;
      },
      async update() {
        return {};
      },
      async updateMany() {
        return {};
      },
      async create() {
        return {};
      },
    },

    versement: {
      async findFirst(args) {
        noter("versement", "findFirst", args);
        const w = args?.where ?? {};
        const t = versements.find(
          (v) =>
            v.identifiantFournisseur === w.identifiantFournisseur &&
            (w.compteLe?.not === null ? v.compteLe !== null : true),
        );
        return t ? { id: t.id } : null;
      },
      async findMany() {
        return [];
      },
      async findUnique() {
        return null;
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
    },

    evenement: {
      async upsert(args) {
        noter("evenement", "upsert", args);
        const { abonnementId, type, cle } = args.where.abonnementId_type_cle;
        const k = `${abonnementId}|${type}|${cle}`;
        if (!evenements.has(k)) evenements.set(k, args.create);
        return {};
      },
      async findMany() {
        return [];
      },
      async findUnique() {
        return null;
      },
      async findFirst() {
        return null;
      },
      async update() {
        return {};
      },
      async updateMany() {
        return {};
      },
      async create() {
        return {};
      },
    },
  };

  return { client, appels, relances, evenements, versements, abonnes, abonnements };
}

function ligne(partiel: Partial<LigneAbonnement> = {}): LigneAbonnement {
  const c = cycleApresPaiement(DEPART, "MENSUEL");
  return {
    id: "ab-1",
    abonneId: "usr-1",
    libelle: "Pass Créateur",
    montant: 2000,
    devise: "XOF",
    cadence: "MENSUEL",
    debut: c.debut,
    echeance: c.echeance,
    accesJusquA: c.accesJusquA,
    repriseJusquA: c.repriseJusquA,
    resilieeLe: null,
    closLe: null,
    verse: 0,
    joursAccordes: 0,
    versements: 0,
    ...partiel,
  };
}

describe("la ligne ramenée à ce que le moteur lit", () => {
  it("rassemble les quatre dates en un cycle", () => {
    const l = ligne();
    const a = abonnementDe(l);

    expect(a.cycle.debut).toBe(l.debut);
    expect(a.cycle.echeance).toBe(l.echeance);
    expect(a.cycle.accesJusquA).toBe(l.accesJusquA);
    expect(a.cycle.repriseJusquA).toBe(l.repriseJusquA);
  });

  it("refuse une cadence inconnue plutôt que de la deviner", () => {
    // La deviner « mensuelle » ferait facturer au mauvais rythme, sans que
    // rien ne le dise.
    expect(() => abonnementDe(ligne({ cadence: "BIMESTRIEL" }))).toThrow(/Cadence inconnue/);
  });
});

describe("le lot du passage quotidien", () => {
  it("est cloisonné par projet", async () => {
    // L'oublier une seule fois ferait relancer l'abonné d'un autre projet.
    const f = fauxClient([ligne()]);
    await portsPrisma(f.client, { projetId: PROJET }).lecture.aRelancer(DEPART, 500);

    const requete = f.appels.find((a) => a.methode === "findMany")!;
    expect(requete.args.where.projetId).toBe(PROJET);
  });

  it("écarte les abonnements clos", async () => {
    // Le moteur ne peut pas savoir qu'ils le sont : il redirait `clore` chaque
    // jour, indéfiniment.
    const f = fauxClient([
      ligne({ id: "vivant" }),
      ligne({ id: "clos", closLe: DEPART }),
    ]);

    const lot = await portsPrisma(f.client, { projetId: PROJET }).lecture.aRelancer(
      ajouterJours(DEPART, 60),
      500,
    );

    expect(lot.map((a) => a.id)).toEqual(["vivant"]);
  });

  it("écarte les abonnements résiliés", async () => {
    // Le cas retors : `etatDe` rend RESILIEE avant de regarder les dates, donc
    // `gesteDuJour` rend RIEN — pour toujours. Le moteur ne clôt jamais un
    // résilié, qui resterait donc dans le lot aussi longtemps que la base.
    const f = fauxClient([
      ligne({ id: "vivant" }),
      ligne({ id: "resilie", resilieeLe: DEPART }),
    ]);

    const lot = await portsPrisma(f.client, { projetId: PROJET }).lecture.aRelancer(
      ajouterJours(DEPART, 60),
      500,
    );

    expect(lot.map((a) => a.id)).toEqual(["vivant"]);
  });

  it("prend les plus en retard d'abord, et respecte la limite", async () => {
    // Si le lot déborde, ce sont eux qu'il faut avoir traités.
    const f = fauxClient([
      ligne({ id: "tard", echeance: ajouterJours(DEPART, 50) }),
      ligne({ id: "tot", echeance: ajouterJours(DEPART, 10) }),
      ligne({ id: "milieu", echeance: ajouterJours(DEPART, 30) }),
    ]);

    const lot = await portsPrisma(f.client, { projetId: PROJET }).lecture.aRelancer(
      ajouterJours(DEPART, 60),
      2,
    );

    expect(lot.map((a) => a.id)).toEqual(["tot", "milieu"]);
  });
});

describe("les relances déjà parties", () => {
  it("ne demande que celles du cycle en cours", async () => {
    // Après trois ans d'abonnement mensuel, tout rendre ferait charger une
    // centaine de clés chaque matin pour n'en regarder qu'une poignée.
    const f = fauxClient([ligne()]);
    await portsPrisma(f.client, { projetId: PROJET }).lecture.relancesEnvoyees(
      "ab-1",
      "2026-02-09",
    );

    const requete = f.appels.find((a) => a.table === "relance")!;
    expect(requete.args.where.cle.startsWith).toBe("2026-02-09:");
  });

  it("n'écrit qu'une fois la même relance", async () => {
    // L'idempotence est une contrainte de la base, pas une intention du code.
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    await p.ecriture.noterRelance("ab-1", "2026-02-09:0", ["courriel"]);
    await p.ecriture.noterRelance("ab-1", "2026-02-09:0", ["sms"]);

    expect(f.relances.size).toBe(1);
    // La première écriture fait foi : réécrire les canaux ferait croire à un
    // second envoi qui n'a pas eu lieu.
    expect(f.relances.get("ab-1|2026-02-09:0")!.canaux).toEqual(["courriel"]);
  });
});

describe("les coordonnées", () => {
  it("rend un abonné vide plutôt que de lever quand il est introuvable", async () => {
    // Ce n'est pas une panne : c'est quelqu'un qu'on ne sait plus joindre. Le
    // moteur comptera un `injoignable`, ne notera pas la relance, et réessaiera.
    const f = fauxClient([ligne()]);
    const ou = await portsPrisma(f.client, { projetId: PROJET }).lecture.coordonnees("inconnu");

    expect(ou).toEqual({ nom: null, courriel: null, telephone: null, appareils: [] });
  });

  it("rend la liste des appareils telle quelle", async () => {
    const f = fauxClient([ligne()]);
    f.abonnes.set("usr-1", {
      nom: "Awa",
      courriel: "awa@ndank.test",
      telephone: "+2250700000000",
      appareils: ["tel", "ordi"],
    });

    const ou = await portsPrisma(f.client, { projetId: PROJET }).lecture.coordonnees("usr-1");
    expect(ou.appareils).toEqual(["tel", "ordi"]);
  });
});

describe("les écritures du moteur", () => {
  it("ne journalise la suspension qu'une fois, malgré trente appels", async () => {
    // Le moteur redit `suspendre` chaque jour de la fenêtre de reprise.
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    for (let i = 0; i < 30; i += 1) await p.ecriture.suspendre("ab-1");

    expect(f.evenements.size).toBe(1);
  });

  it("clôt une seule fois, et retire l'abonnement du lot", async () => {
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    await p.ecriture.clore("ab-1");
    const premiere = f.abonnements[0]!.closLe;
    expect(premiere).not.toBeNull();

    // Le second appel ne doit rien changer : le filtre `closLe: null` ne
    // correspond plus. `update` aurait levé ; le contrat dit que clore un
    // dossier déjà clos est un geste normal.
    await p.ecriture.clore("ab-1");
    expect(f.abonnements[0]!.closLe).toBe(premiere);

    // Et il ne remonte plus dans le lot.
    const lot = await p.lecture.aRelancer(ajouterJours(DEPART, 60), 500);
    expect(lot).toHaveLength(0);
  });

  it("écrit les quatre dates du nouveau cycle", async () => {
    const f = fauxClient([ligne()]);
    const suivant = cycleApresPaiement(ajouterJours(DEPART, 30), "MENSUEL");

    await portsPrisma(f.client, { projetId: PROJET }).ecriture.renouveler("ab-1", suivant);

    const ecrit = f.appels.find((a) => a.methode === "updateMany")!;
    expect(ecrit.args.data).toEqual({
      debut: suivant.debut,
      echeance: suivant.echeance,
      accesJusquA: suivant.accesJusquA,
      repriseJusquA: suivant.repriseJusquA,
    });
    // Cloisonné, là aussi.
    expect(ecrit.args.where.projetId).toBe(PROJET);
  });
});

describe("les créances", () => {
  it("lit l'ardoise depuis l'abonnement", async () => {
    const f = fauxClient([ligne({ verse: 1200, joursAccordes: 18, versements: 1 })]);
    const etat = await portsPrisma(f.client, { projetId: PROJET }).creances.etat("ab-1");

    expect(etat).toEqual({ verse: 1200, joursAccordes: 18, versements: 1 });
  });

  it("rend une ardoise vierge sur un abonnement introuvable", async () => {
    const f = fauxClient([]);
    const etat = await portsPrisma(f.client, { projetId: PROJET }).creances.etat("fantome");

    expect(etat).toEqual({ verse: 0, joursAccordes: 0, versements: 0 });
  });

  it("ne compte que les versements réellement comptés", async () => {
    // Une invitation crée un versement EN_ATTENTE bien avant qu'il ne compte.
    // Confondre les deux ferait ignorer le paiement au moment où il arrive.
    const f = fauxClient([ligne()]);
    f.versements.push({ id: "v1", identifiantFournisseur: "chg_1", compteLe: null });
    f.versements.push({ id: "v2", identifiantFournisseur: "chg_2", compteLe: DEPART });

    const c = portsPrisma(f.client, { projetId: PROJET }).creances;

    expect(await c.dejaCompte("chg_1")).toBe(false);
    expect(await c.dejaCompte("chg_2")).toBe(true);
    expect(await c.dejaCompte("inconnu")).toBe(false);
  });
});

describe("le moteur tourne contre ces ports, sans rien changer", () => {
  it("relance un abonné dont l'échéance approche", async () => {
    // Le test qui compte : le passage quotidien du niveau 1, branché tel quel
    // sur le niveau 2. Aucune ligne du cœur ne change.
    const c = cycleApresPaiement(DEPART, "MENSUEL");
    const f = fauxClient([ligne()]);
    f.abonnes.set("usr-1", {
      nom: "Awa",
      courriel: "awa@ndank.test",
      telephone: "+2250700000000",
      appareils: [],
    });

    const envois: Array<{ canal: Canal; message: Message }> = [];
    const p = portsPrisma(f.client, { projetId: PROJET });

    const ports: Ports = {
      lecture: p.lecture,
      ecriture: p.ecriture,
      envoi: {
        disponible: (canal: Canal, ou: Coordonnees) =>
          canal === "courriel" ? ou.courriel !== null : false,
        async envoyer(canal, _ou, message) {
          envois.push({ canal, message });
          return true;
        },
      },
    };

    const bilan = await passer(
      ports,
      {
        lien: (a) => `https://exemple.ci/valider/${a.id}`,
        montant: (a) => `${a.montant} ${a.devise}`,
      },
      ajouterJours(c.echeance, -7),
    );

    expect(bilan.vus).toBe(1);
    expect(bilan.relances).toBe(1);
    expect(bilan.echecs).toHaveLength(0);
    expect(envois[0]!.canal).toBe("courriel");
    expect(envois[0]!.message.destinataire).toBe("Awa");

    // Et la relance est notée avec la clé du cycle.
    expect([...f.relances.keys()][0]).toBe(`ab-1|${cleDeCycle(c.echeance)}:0`);
  });

  it("ne relance pas deux fois, même en repassant", async () => {
    const c = cycleApresPaiement(DEPART, "MENSUEL");
    const f = fauxClient([ligne()]);
    f.abonnes.set("usr-1", {
      nom: "Awa",
      courriel: "awa@ndank.test",
      telephone: null,
      appareils: [],
    });

    const envois: Array<{ canal: Canal }> = [];
    const p = portsPrisma(f.client, { projetId: PROJET });
    const ports: Ports = {
      lecture: p.lecture,
      ecriture: p.ecriture,
      envoi: {
        disponible: (canal: Canal, ou: Coordonnees) =>
          canal === "courriel" ? ou.courriel !== null : false,
        async envoyer(canal) {
          envois.push({ canal });
          return true;
        },
      },
    };

    const reglages = {
      lien: () => "https://exemple.ci/valider",
      montant: () => "2000 XOF",
    };

    await passer(ports, reglages, ajouterJours(c.echeance, -7));
    await passer(ports, reglages, ajouterJours(c.echeance, -7));
    await passer(ports, reglages, ajouterJours(c.echeance, -6));

    expect(envois).toHaveLength(1);
  });
});
