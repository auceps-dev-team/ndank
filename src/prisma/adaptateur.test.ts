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
  const versements: Array<{ id: string; identifiantFournisseur: string; compteLe: Date | null }> = [];
  const abonnes = new Map<string, LigneAbonne>();

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
      async count() {
        return 0;
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
