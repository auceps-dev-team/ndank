import { describe, expect, it } from "vitest";

import { ajouterJours, cleDeCycle, cycleApresPaiement } from "../cycle";
import { passer } from "../moteur";
import type { Canal, Coordonnees, Message, Ports } from "../ports";
import { routeurApi } from "../api/routeur";
import { bornesDe } from "../api/tableau";
import { offresActives } from "../offre";
import { abonnementDe, portsPrisma } from "./adaptateur";
import type {
  ClientNdank,
  LigneAbonne,
  LigneAbonnement,
  LigneOffre,
  LignePassage,
  LigneVersement,
} from "./client";

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
function fauxClient(
  abonnements: LigneAbonnement[] = [],
  offres: LigneOffre[] = [],
) {
  const appels: Array<{ table: string; methode: string; args: any }> = [];
  const relances = new Map<string, { canaux: string[] }>();
  const evenements = new Map<string, unknown>();
  const versements: Array<LigneVersement & { identifiantFournisseur: string }> =
    [];
  const abonnes = new Map<string, LigneAbonne>();
  const passages: LignePassage[] = [];

  const noter = (table: string, methode: string, args: any) => {
    appels.push({ table, methode, args });
  };

  /** Applique les clauses que l'adaptateur envoie réellement. */
  const garde = (a: LigneAbonnement, w: any = {}): boolean => {
    if (w.id !== undefined && a.id !== w.id) return false;
    if (w.projetId !== undefined && w.projetId !== PROJET) return false;

    if (w.closLe === null && a.closLe !== null) return false;
    if (w.closLe?.not === null && a.closLe === null) return false;
    if (w.resilieeLe === null && a.resilieeLe !== null) return false;
    if (w.resilieeLe?.not === null && a.resilieeLe === null) return false;

    if (w.echeance?.lte && a.echeance > w.echeance.lte) return false;
    if (w.echeance?.lt && !(a.echeance < w.echeance.lt)) return false;
    if (w.echeance?.gte && !(a.echeance >= w.echeance.gte)) return false;
    if (w.accesJusquA?.lt && !(a.accesJusquA < w.accesJusquA.lt)) return false;
    if (w.accesJusquA?.gte && !(a.accesJusquA >= w.accesJusquA.gte)) return false;
    if (w.repriseJusquA?.lt && !(a.repriseJusquA < w.repriseJusquA.lt)) return false;
    if (w.repriseJusquA?.gte && !(a.repriseJusquA >= w.repriseJusquA.gte)) return false;

    return true;
  };

  const client: ClientNdank = {
    abonnement: {
      async findMany(args) {
        noter("abonnement", "findMany", args);
        const gardees = abonnements
          .filter((a) => garde(a, args?.where))
          .sort((x, y) => x.echeance.getTime() - y.echeance.getTime());

        const depuis = args?.skip ?? 0;
        return gardees.slice(
          depuis,
          args?.take === undefined ? undefined : depuis + args.take,
        );
      },
      async findUnique(args) {
        noter("abonnement", "findUnique", args);
        return abonnements.find((a) => a.id === args.where.id) ?? null;
      },
      async findFirst(args) {
        noter("abonnement", "findFirst", args);
        return abonnements.find((a) => garde(a, args?.where)) ?? null;
      },
      async count(args) {
        noter("abonnement", "count", args);
        return abonnements.filter((a) => garde(a, args?.where)).length;
      },
      async groupBy(args) {
        noter("abonnement", "groupBy", args);
        const cles = new Map<string, { total: number; nombre: number }>();
        for (const a of abonnements) {
          if (args?.where?.projetId !== undefined && args.where.projetId !== PROJET) continue;
          if (args?.where?.resilieeLe === null && a.resilieeLe !== null) continue;
          if (args?.where?.suspenduLe === null && a.suspenduLe !== null) continue;
          if (args?.where?.closLe === null && a.closLe !== null) continue;
          if (args?.where?.accesJusquA?.gte && a.accesJusquA < args.where.accesJusquA.gte) continue;
          const k = `${a.devise}|${a.cadence}`;
          const v = cles.get(k) ?? { total: 0, nombre: 0 };
          v.total += a.montant;
          v.nombre += 1;
          cles.set(k, v);
        }
        return [...cles].map(([k, v]) => ({
          devise: k.split("|")[0],
          cadence: k.split("|")[1],
          _sum: { montant: v.total },
          _count: { _all: v.nombre },
        }));
      },
      async createMany() {
        return {};
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
        // Le vrai client rend la ligne créée : l'adaptateur la relit pour la
        // ramener à ce que le moteur sait lire.
        const creee = { id: `abo-${abonnements.length + 1}`, ...args.data };
        abonnements.push(creee);
        return creee;
      },
    },

    abonne: {
      async count() {
        return 0;
      },
      async createMany(args) {
        noter("?", "createMany", args);
        return {};
      },
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
      async upsert(args) {
        noter("abonne", "upsert", args);
        const reference = args.where.projetId_reference.reference;
        const id = `usr-${reference}`;
        abonnes.set(id, { id, ...args.create, ...args.update });
        return { id };
      },
      async create() {
        return {};
      },
    },

    offre: {
      async findMany(args) {
        noter("offre", "findMany", args);
        return offres.filter(
          (o) => args?.where?.projetId === undefined || args.where.projetId === PROJET,
        );
      },
      async count() {
        return offres.length;
      },
      async createMany() {
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
      async upsert() {
        return {};
      },
      async create() {
        return {};
      },
    },

    relance: {
      async count() {
        return 0;
      },
      async createMany(args) {
        noter("?", "createMany", args);
        return {};
      },
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
      async count() {
        return 0;
      },
      async createMany(args) {
        noter("?", "createMany", args);
        return {};
      },
      async groupBy(args) {
        noter("versement", "groupBy", args);
        const comptes = new Map<string, number>();
        for (const v of versements) {
          comptes.set(v.etat, (comptes.get(v.etat) ?? 0) + 1);
        }
        return [...comptes].map(([etat, n]) => ({ etat, _count: { _all: n } }));
      },
      async findFirst(args) {
        noter("versement", "findFirst", args);
        const w = args?.where ?? {};
        const t = versements.find(
          (v) =>
            v.identifiantFournisseur === w.identifiantFournisseur &&
            (w.compteLe?.not === null ? v.compteLe !== null : true),
        );
        // `dejaCompte` interroge avec `select: { id: true }` : la ligne qui
        // revient n'a bien qu'un champ, et c'est ce que le vrai client rend.
        return t ? ({ id: t.id } as LigneVersement) : null;
      },
      async findMany(args) {
        noter("versement", "findMany", args);
        return versements
          .filter((v) => v.abonnementId === args?.where?.abonnementId)
          .slice(args?.skip ?? 0, (args?.skip ?? 0) + (args?.take ?? 25));
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
      async upsert(args) {
        noter("versement", "upsert", args);
        return {};
      },
      async create() {
        return {};
      },
    },

    webhookRecu: {
      async createMany(args) {
        noter("webhookRecu", "createMany", args);
        return {};
      },
      async findMany() {
        return [];
      },
      async count() {
        return 0;
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
      async upsert() {
        return {};
      },
      async create() {
        return {};
      },
    },

    passage: {
      async create(args) {
        noter("passage", "create", args);
        const p: LignePassage = {
          id: `pas-${passages.length + 1}`,
          commenceLe: args.data.commenceLe,
          termineLe: null,
          vus: 0,
          relances: 0,
          suspendus: 0,
          clos: 0,
          injoignables: 0,
          echecs: 0,
          lotPlein: false,
          erreur: null,
        };
        passages.push(p);
        return p;
      },
      async updateMany(args) {
        noter("passage", "updateMany", args);
        for (const p of passages) {
          if (p.id === args.where.id) Object.assign(p, args.data);
        }
        return {};
      },
      async findFirst(args) {
        noter("passage", "findFirst", args);
        return [...passages].reverse()[0] ?? null;
      },
      async findMany() {
        return passages;
      },
      async count() {
        return passages.length;
      },
      async createMany() {
        return {};
      },
      async findUnique() {
        return null;
      },
      async update() {
        return {};
      },
      async upsert() {
        return {};
      },
    },

    evenement: {
      async count() {
        return 0;
      },
      async createMany(args) {
        noter("?", "createMany", args);
        return {};
      },
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
    suspenduLe: null,
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
      id: "usr-1",
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
    f.versements.push(versement({ id: "v1", identifiantFournisseur: "chg_1" }));
    f.versements.push(
      versement({ id: "v2", identifiantFournisseur: "chg_2", compteLe: DEPART }),
    );

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
      id: "usr-1",
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
      id: "usr-1",
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

describe("le dossier, pour la page et le webhook", () => {
  it("lit un abonnement par son identifiant", async () => {
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    const a = await p.dossier.abonnement("ab-1");

    expect(a?.libelle).toBe("Pass Créateur");
    expect(a?.cadence).toBe("MENSUEL");
  });

  it("cloisonne par projet, et n'emploie pas `findUnique`", async () => {
    // L'identifiant vient du dehors : d'un jeton de lien, d'une référence de
    // webhook. `findUnique` rendrait la ligne d'un autre projet aussi
    // volontiers que la sienne — et la page afficherait le montant dû par
    // l'abonné de quelqu'un d'autre.
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    await p.dossier.abonnement("ab-1");

    const appel = f.appels.find((a) => a.methode === "findFirst")!;
    expect(appel.args.where.projetId).toBe(PROJET);
    expect(f.appels.some((a) => a.methode === "findUnique" && a.table === "abonnement")).toBe(
      false,
    );
  });

  it("rend null sur un identifiant inconnu, sans lever", async () => {
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    expect(await p.dossier.abonnement("ab-999")).toBeNull();
  });
});

describe("le tableau, pour l'API du tableau de bord", () => {
  it("traduit les bornes d'un état en clauses de date", async () => {
    // Il n'y a pas de colonne `etat` : une requête filtre sur des dates. Le
    // test vérifie que la traduction arrive intacte jusqu'à la clause envoyée.
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    await p.tableau.compter(bornesDe("SUSPENDUE", new Date()));

    const appel = f.appels.find((a) => a.methode === "count")!;
    expect(appel.args.where.projetId).toBe(PROJET);
    expect(appel.args.where.resilieeLe).toBeNull();
    expect(appel.args.where.accesJusquA.lt).toBeInstanceOf(Date);
    expect(appel.args.where.repriseJusquA.gte).toBeInstanceOf(Date);
  });

  it("compte sans charger les lignes", async () => {
    // Le tableau de bord demande cinq comptes à chaque ouverture. Les obtenir
    // en chargeant les lignes ferait passer cent mille abonnements par le
    // réseau, cinq fois, pour rendre cinq nombres.
    const f = fauxClient([ligne(), ligne({ id: "ab-2" })]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    expect(await p.tableau.compter({ resiliee: false })).toBe(2);
    expect(f.appels.some((a) => a.methode === "findMany" && a.table === "abonnement")).toBe(
      false,
    );
  });

  it("pagine, et rend les plus urgents d'abord", async () => {
    const c = cycleApresPaiement(DEPART, "MENSUEL");
    const f = fauxClient([
      ligne({ id: "tard", echeance: ajouterJours(c.echeance, 10) }),
      ligne({ id: "tot", echeance: ajouterJours(c.echeance, -10) }),
    ]);

    const p = portsPrisma(f.client, { projetId: PROJET });
    const lignes = await p.tableau.lister({ resiliee: false }, { depuis: 0, combien: 1 });

    expect(lignes).toHaveLength(1);
    expect(lignes[0]!.id).toBe("tot");
  });

  it("donne à l'API de quoi retrouver le même état que le moteur", async () => {
    // Le bout du fil : une ligne écrite en base, comptée par les bornes d'un
    // état, et rendue par l'API avec cet état-là. Si la traduction dérivait,
    // c'est ici que cela se verrait.
    const paiement = ajouterJours(new Date(), -40);
    const c = cycleApresPaiement(paiement, "MENSUEL");

    const f = fauxClient([
      ligne({
        debut: c.debut,
        echeance: c.echeance,
        accesJusquA: c.accesJusquA,
        repriseJusquA: c.repriseJusquA,
      }),
    ]);

    const p = portsPrisma(f.client, { projetId: PROJET });
    const api = routeurApi({ tableau: p.tableau, jeton: "jeton" });

    const r = await api({
      methode: "GET",
      chemin: "/abonnements",
      parametres: { etat: "SUSPENDUE" },
      corps: "",
      entetes: { authorization: "Bearer jeton" },
    });

    const corps = JSON.parse(r.corps) as { lignes: { etat: string }[] };
    expect(corps.lignes).toHaveLength(1);
    expect(corps.lignes[0]!.etat).toBe("SUSPENDUE");
  });
});

describe("la souscription, contre le schéma", () => {
  it("crée l'abonné par upsert, pour que deux clics n'en fassent pas deux", async () => {
    // L'idempotence est une contrainte de la base — l'unicité
    // `(projetId, reference)` — et non une intention du code.
    const f = fauxClient([]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    const id = await p.souscriptions.abonne("usr-9", {
      nom: "Awa",
      courriel: "awa@ndank.test",
      telephone: "+2250700000000",
      appareils: [],
    });

    expect(id).toBe("usr-usr-9");

    const appel = f.appels.find((a) => a.table === "abonne" && a.methode === "upsert")!;
    expect(appel.args.where.projetId_reference).toEqual({
      projetId: PROJET,
      reference: "usr-9",
    });
    // Les coordonnées sont rafraîchies : quelqu'un qui souscrit à une seconde
    // offre a pu changer de numéro, et garder l'ancien ferait partir la
    // relance sur une ligne résiliée.
    expect(appel.args.update.telephone).toBe("+2250700000000");
  });

  it("cherche un abonnement en cours avant d'en ouvrir un second", async () => {
    const f = fauxClient([ligne({ id: "abo-1" })]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    await p.souscriptions.enCours("usr-1", "createur");

    const appel = f.appels.find(
      (a) => a.table === "abonnement" && a.methode === "findFirst",
    )!;

    expect(appel.args.where).toMatchObject({
      projetId: PROJET,
      abonneId: "usr-1",
      offreId: "createur",
      resilieeLe: null,
      closLe: null,
    });
  });

  it("recopie le prix et le libellé dans l'abonnement, sans jointure", async () => {
    // Décision du schéma : augmenter un tarif ne doit pas changer
    // rétroactivement ce que doivent les abonnés en cours.
    const f = fauxClient([]);
    const p = portsPrisma(f.client, { projetId: PROJET });
    const c = cycleApresPaiement(DEPART, "MENSUEL");

    await p.souscriptions.ouvrir({
      abonneId: "usr-1",
      offre: {
        id: "createur",
        libelle: "Pass Créateur",
        montant: 2000,
        devise: "XOF",
        cadence: "MENSUEL",
      },
      cycle: c,
    });

    const appel = f.appels.find(
      (a) => a.table === "abonnement" && a.methode === "create",
    )!;

    expect(appel.args.data).toMatchObject({
      projetId: PROJET,
      abonneId: "usr-1",
      offreId: "createur",
      libelle: "Pass Créateur",
      montant: 2000,
      devise: "XOF",
      cadence: "MENSUEL",
      echeance: c.echeance,
      repriseJusquA: c.repriseJusquA,
    });
  });
});

describe("la grille lue en base", () => {
  it("est vérifiée, et non rendue telle quelle", async () => {
    // Une devise mal saisie dans un tableau d'administration passerait sinon
    // jusqu'au fournisseur, qui la refuserait avec un message parlant du
    // compte marchand.
    const f = fauxClient([], [
      { id: "o1", libelle: "Pass", montant: 2000, devise: "CFA", cadence: "MENSUEL", actif: true },
    ]);

    const p = portsPrisma(f.client, { projetId: PROJET });

    await expect(p.offres()).rejects.toThrow(/XOF/);
  });

  it("rend les offres du projet, actives comme retirées", async () => {
    const f = fauxClient([], [
      { id: "o1", libelle: "Pass", montant: 2000, devise: "XOF", cadence: "MENSUEL", actif: true },
      { id: "o2", libelle: "Ancien", montant: 1000, devise: "XOF", cadence: "MENSUEL", actif: false },
    ]);

    const p = portsPrisma(f.client, { projetId: PROJET });
    const g = await p.offres();

    expect(g).toHaveLength(2);
    expect(offresActives(g).map((o) => o.id)).toEqual(["o1"]);

    const appel = f.appels.find((a) => a.table === "offre")!;
    expect(appel.args.where.projetId).toBe(PROJET);
  });
});

/** Un versement en mémoire, avec l'identifiant fournisseur que le faux indexe. */
function versement(
  sur: Partial<LigneVersement> & { identifiantFournisseur: string },
): LigneVersement & { identifiantFournisseur: string } {
  return {
    id: "v-1",
    abonnementId: "abo-1",
    fournisseur: "paystack",
    reference: "20260209-1-abo-1",
    montant: 2000,
    devise: "XOF",
    etat: "REUSSI",
    regleLe: DEPART,
    compteLe: null,
    creeLe: DEPART,
    ...sur,
  };
}

describe("les versements, pour le tableau de bord", () => {
  it("les rend du plus récent au plus ancien, par date de création", async () => {
    // Par `creeLe` et non `regleLe` : un versement jamais réglé n'a pas de
    // seconde date, et trier dessus le ferait disparaître — alors que c'est
    // précisément celui qu'on cherche quand un abonné dit avoir payé.
    const f = fauxClient([ligne({ id: "abo-1" })]);
    f.versements.push(versement({ id: "v1", identifiantFournisseur: "c1" }));

    const p = portsPrisma(f.client, { projetId: PROJET });
    const lignes = await p.tableau.versements!("abo-1", { depuis: 0, combien: 10 });

    expect(lignes).toHaveLength(1);
    expect(lignes[0]!.etat).toBe("REUSSI");

    const appel = f.appels.find(
      (a) => a.table === "versement" && a.methode === "findMany",
    )!;
    expect(appel.args.orderBy).toEqual({ creeLe: "desc" });
    // Cloisonné par projet, à travers la relation.
    expect(appel.args.where.abonnement).toEqual({ projetId: PROJET });
  });

  it("compte par état en une requête, et non cinq", async () => {
    // Les états ne sont pas connus d'avance — un fournisseur peut en rendre un
    // qu'on traduit en INCONNU — et cinq requêtes rendraient quatre zéros pour
    // un chiffre qui manquerait.
    const f = fauxClient([ligne()]);
    f.versements.push(versement({ id: "v1", identifiantFournisseur: "c1" }));
    f.versements.push(versement({ id: "v2", identifiantFournisseur: "c2" }));
    f.versements.push(
      versement({ id: "v3", identifiantFournisseur: "c3", etat: "ECHOUE" }),
    );

    const p = portsPrisma(f.client, { projetId: PROJET });
    const comptes = await p.tableau.compterVersements!(DEPART);

    expect(comptes).toEqual({ REUSSI: 2, ECHOUE: 1 });
    expect(
      f.appels.filter((a) => a.table === "versement" && a.methode === "groupBy"),
    ).toHaveLength(1);
  });

  it("joint l'abonné à la liste : on relance quelqu'un, pas un identifiant", async () => {
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    await p.tableau.lister({ resiliee: false }, { depuis: 0, combien: 10 });

    const appel = f.appels.find(
      (a) => a.table === "abonnement" && a.methode === "findMany",
    )!;

    // `select` et non `include` tout court : les jetons d'appareil sont des
    // poignées opaques qui n'ont rien à faire dans un écran.
    expect(appel.args.include.abonne.select).toEqual({
      reference: true,
      nom: true,
      courriel: true,
      telephone: true,
    });
    expect(appel.args.include.abonne.select.appareils).toBeUndefined();
  });
});

describe("les gestes manuels, contre le schéma", () => {
  it("suspend et rétablit en cloisonnant par projet", async () => {
    // L'identifiant vient d'un tableau de bord, donc du dehors : `update`
    // toucherait la ligne d'un autre projet aussi volontiers que la sienne.
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    await p.interventions.suspendre("ab-1", DEPART);
    await p.interventions.suspendre("ab-1", null);

    const appels = f.appels.filter(
      (a) => a.table === "abonnement" && a.methode === "updateMany",
    );

    expect(appels[0]!.args.where.projetId).toBe(PROJET);
    expect(appels[0]!.args.data.suspenduLe).toBe(DEPART);
    expect(appels[1]!.args.data.suspenduLe).toBeNull();
  });

  it("ne déplace pas la date d'une résiliation déjà posée", async () => {
    // Un second clic effacerait le moment où l'abonné a vraiment dit non.
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    await p.interventions.resilier("ab-1", DEPART);

    const appel = f.appels.find(
      (a) => a.table === "abonnement" && a.methode === "updateMany",
    )!;

    expect(appel.args.where.resilieeLe).toBeNull();
  });

  it("fait de la pièce justificative la clé d'idempotence du versement", async () => {
    // Même unicité que pour les versements d'opérateur : le même reçu ne peut
    // pas entrer deux fois.
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    await p.interventions.versementManuel({
      abonnementId: "ab-1",
      identifiant: "manuel:RECU-42",
      reference: "20260209-1-ab-1",
      montant: 2000,
      devise: "XOF",
      recuLe: DEPART,
      moyen: "espèces",
      auteur: "awa",
    });

    const appel = f.appels.find(
      (a) => a.table === "versement" && a.methode === "upsert",
    )!;

    expect(appel.args.where.fournisseur_identifiantFournisseur).toEqual({
      fournisseur: "manuel",
      identifiantFournisseur: "manuel:RECU-42",
    });
    // Un versement manuel n'attend aucun webhook : il est compté tout de suite.
    expect(appel.args.create.compteLe).toBeInstanceOf(Date);
    // La première écriture fait foi.
    expect(appel.args.update).toEqual({});
  });

  it("garde deux gestes successifs du même type, sans les écraser", async () => {
    // L'inverse du journal du moteur, où la clé de cycle sert à n'en garder
    // qu'un — parce que là, c'est le même fait redit trente fois. Deux
    // suspensions dans un même cycle sont deux faits distincts.
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    await p.interventions.journaliser({
      abonnementId: "ab-1",
      geste: "suspendre",
      auteur: "awa",
      quand: DEPART,
    });
    await p.interventions.journaliser({
      abonnementId: "ab-1",
      geste: "suspendre",
      auteur: "moussa",
      quand: ajouterJours(DEPART, 3),
    });

    const appels = f.appels.filter((a) => a.table === "evenement");
    const cles = appels.map((a) => a.args.where.abonnementId_type_cle.cle);

    expect(new Set(cles).size).toBe(2);
    expect(appels[0]!.args.create.type).toBe("manuel.suspendre");
    expect(appels[0]!.args.create.detail.auteur).toBe("awa");
  });
});

describe("la transaction du paiement manuel", () => {
  it("construit les écritures contre le client transactionnel, jamais l'extérieur", async () => {
    // Le piège que ce correctif évite : `client.$transaction(() => travail())`
    // ouvre bien une transaction, mais les écritures passent par le client
    // extérieur — donc hors d'elle. La transaction s'ouvre, se ferme, tout
    // paraît normal, et rien n'est atomique.
    const f = fauxClient([ligne()]);
    const interieur = fauxClient([ligne()]);

    f.client.$transaction = async (fn) => fn(interieur.client);

    const p = portsPrisma(f.client, { projetId: PROJET });

    await p.interventions.ensemble!(async (ecritures) => {
      await ecritures.versementManuel({
        abonnementId: "ab-1",
        identifiant: "manuel:R-1",
        reference: "20260209-1-ab-1",
        montant: 2000,
        devise: "XOF",
        recuLe: DEPART,
        moyen: "espèces",
        auteur: "awa",
      });
      await ecritures.renouveler("ab-1", cycleApresPaiement(DEPART, "MENSUEL"));
    });

    // Les deux écritures sont allées au client INTÉRIEUR.
    expect(
      interieur.appels.filter((a) => a.methode === "upsert" && a.table === "versement"),
    ).toHaveLength(1);
    expect(
      interieur.appels.filter((a) => a.methode === "updateMany" && a.table === "abonnement"),
    ).toHaveLength(1);

    // Et aucune n'est passée par l'extérieur.
    expect(f.appels.filter((a) => a.table === "versement")).toHaveLength(0);
    expect(f.appels.filter((a) => a.methode === "updateMany")).toHaveLength(0);
  });

  it("n'expose pas `ensemble` quand le client n'a pas de transaction", async () => {
    // Un faux, une base sans transaction : Ndank enchaîne alors les écritures,
    // en le disant plutôt qu'en promettant une atomicité qu'il n'a pas.
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    expect(p.interventions.ensemble).toBeUndefined();
  });

  it("cloisonne par projet jusque dans la transaction", async () => {
    const f = fauxClient([ligne()]);
    f.client.$transaction = async (fn) => fn(f.client);

    const p = portsPrisma(f.client, { projetId: PROJET });

    await p.interventions.ensemble!(async (e) => {
      await e.renouveler("ab-1", cycleApresPaiement(DEPART, "MENSUEL"));
    });

    const appel = f.appels.find(
      (a) => a.table === "abonnement" && a.methode === "updateMany",
    )!;

    expect(appel.args.where.projetId).toBe(PROJET);
  });
});

describe("le battement, contre le schéma", () => {
  it("ouvre une trace par passage, sans jamais en écraser une", async () => {
    // `create` et non `upsert` : deux passages lancés dans la même minute sont
    // deux faits distincts. En écraser un masquerait précisément le cas qu'on
    // veut voir — deux processus qui tournent en parallèle.
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    const un = await p.battements.commencer(DEPART);
    const deux = await p.battements.commencer(DEPART);

    expect(un).not.toBe(deux);
    expect(f.appels.filter((a) => a.table === "passage" && a.methode === "create")).toHaveLength(2);
    expect(
      f.appels.find((a) => a.table === "passage")!.args.data.projetId,
    ).toBe(PROJET);
  });

  it("rend le dernier passage par date de DÉBUT, pas de fin", async () => {
    // Un passage encore ouvert n'a pas de seconde date, et trier dessus le
    // ferait disparaître — alors que c'est précisément celui qu'on cherche
    // quand le processus est bloqué.
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    await p.battements.commencer(DEPART);
    const trace = await p.battements.dernier();

    expect(trace?.termineLe).toBeNull();

    const appel = f.appels.find(
      (a) => a.table === "passage" && a.methode === "findFirst",
    )!;
    expect(appel.args.orderBy).toEqual({ commenceLe: "desc" });
    expect(appel.args.where.projetId).toBe(PROJET);
  });

  it("garde les compteurs du bilan, et le compte des échecs", async () => {
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    const id = await p.battements.commencer(DEPART);
    await p.battements.terminer(
      id,
      {
        vus: 12,
        relances: 3,
        suspendus: 1,
        clos: 0,
        injoignables: 2,
        echecs: [{ abonnementId: "ab-9", cause: new Error("x") }],
        lotPlein: true,
      },
      ajouterJours(DEPART, 0),
    );

    const trace = await p.battements.dernier();

    expect(trace).toMatchObject({ vus: 12, relances: 3, echecs: 1, lotPlein: true });
    expect(trace?.termineLe).not.toBeNull();
  });

  it("ferme la trace sur l'erreur qui a emporté le passage", async () => {
    const f = fauxClient([ligne()]);
    const p = portsPrisma(f.client, { projetId: PROJET });

    const id = await p.battements.commencer(DEPART);
    await p.battements.echouer(id, "Error: base injoignable", DEPART);

    const trace = await p.battements.dernier();

    expect(trace?.erreur).toContain("injoignable");
    expect(trace?.termineLe).not.toBeNull();
  });
});
