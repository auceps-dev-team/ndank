import { describe, expect, it } from "vitest";

import { ajouterJours, cycleApresPaiement, joursEntre } from "./cycle";
import type { Creances, EtatCreance } from "./encaissement/reconciliation";
import { accesOuvert, etatDe } from "./etats";
import {
  marquerPaye,
  relancerMaintenant,
  resilier,
  retablir,
  suspendre,
  type FaitIntervention,
  type Interventions,
  type PortsIntervention,
} from "./intervention";
import type {
  AbonnementLu,
  Canal,
  Coordonnees,
  Ecriture,
  Envoi,
  Lecture,
  Message,
} from "./ports";

const MAINTENANT = new Date("2026-02-09T10:00:00Z");

function abonnement(sur: Partial<AbonnementLu> = {}): AbonnementLu {
  return {
    id: "ab-1",
    abonneId: "usr-1",
    cadence: "MENSUEL",
    cycle: cycleApresPaiement(ajouterJours(MAINTENANT, -20), "MENSUEL"),
    resilieeLe: null,
    suspenduLe: null,
    montant: 2000,
    devise: "XOF",
    libelle: "Pass Créateur",
    ...sur,
  };
}

const REDACTION = {
  lien: (a: AbonnementLu) => `https://p.test/v/${a.id}`,
  montant: (a: AbonnementLu) => `${a.montant} ${a.devise}`,
};

/** Tout en mémoire, et qui retient ce qu'on lui a demandé. */
function monter(
  options: {
    abonnement?: AbonnementLu;
    creance?: Partial<EtatCreance>;
    comptes?: string[];
    relancesDeja?: string[];
    coordonnees?: Coordonnees;
    canauxQuiMarchent?: Canal[];
  } = {},
) {
  const a = options.abonnement ?? abonnement();

  const journal: FaitIntervention[] = [];
  const suspensions: Array<Date | null> = [];
  const resiliations: Date[] = [];
  const versements: Array<{ identifiant: string; montant: number; moyen: string }> = [];
  const renouvelements: Array<{ id: string }> = [];
  const envois: Array<{ canal: Canal; message: Message }> = [];
  const notees: Array<{ cle: string; canaux: readonly Canal[] }> = [];

  const etat: EtatCreance = {
    verse: 0,
    joursAccordes: 0,
    versements: 0,
    ...options.creance,
  };
  const vus = new Set(options.comptes ?? []);

  const interventions: Interventions = {
    async suspendre(_id, quand) {
      suspensions.push(quand);
      a.suspenduLe = quand;
    },
    async resilier(_id, quand) {
      resiliations.push(quand);
      a.resilieeLe = quand;
    },
    async versementManuel(v) {
      versements.push({ identifiant: v.identifiant, montant: v.montant, moyen: v.moyen });
      vus.add(v.identifiant);
    },
    async journaliser(fait) {
      journal.push(fait);
    },
  };

  const creances: Creances = {
    async etat() {
      return etat;
    },
    async dejaCompte(id) {
      return vus.has(id);
    },
  };

  const ou: Coordonnees = options.coordonnees ?? {
    nom: "Awa",
    courriel: "awa@ndank.test",
    telephone: "+2250700000000",
    appareils: ["appareil-1"],
  };

  const marchent = options.canauxQuiMarchent ?? ["courriel", "sms", "push"];

  const lecture: Lecture = {
    async aRelancer() {
      return [];
    },
    async relancesEnvoyees() {
      return [...(options.relancesDeja ?? []), ...notees.map((n) => n.cle)];
    },
    async coordonnees() {
      return ou;
    },
  };

  const ecriture: Ecriture = {
    async noterRelance(_id, cle, canaux) {
      notees.push({ cle, canaux });
    },
    async suspendre() {},
    async clore() {},
    async renouveler(id) {
      renouvelements.push({ id });
    },
  };

  const envoi: Envoi = {
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
  };

  const ports: PortsIntervention = {
    dossier: {
      async abonnement(id) {
        return id === a.id ? a : null;
      },
    },
    interventions,
    lecture,
    ecriture,
    envoi,
    creances,
  };

  return {
    ports,
    abonnement: a,
    journal,
    suspensions,
    resiliations,
    versements,
    renouvelements,
    envois,
    notees,
  };
}

describe("suspendre et rétablir", () => {
  it("coupe l'accès sur-le-champ, sans toucher à l'échéance", async () => {
    // À la différence de la résiliation : on suspend pour un litige, et
    // attendre la fin du cycle viderait le geste de son sens.
    const m = monter();
    const avant = m.abonnement.cycle.echeance;

    expect(accesOuvert(m.abonnement, MAINTENANT)).toBe(true);

    const suite = await suspendre(m.ports, "ab-1", { auteur: "awa@baobart.ci" }, MAINTENANT);

    expect(suite.faire).toBe("FAIT");
    expect(accesOuvert(m.abonnement, MAINTENANT)).toBe(false);
    expect(etatDe(m.abonnement, MAINTENANT)).toBe("SUSPENDUE");
    // Une suspension n'est pas une remise : le temps continue de courir.
    expect(m.abonnement.cycle.echeance).toBe(avant);
  });

  it("ne suspend pas deux fois, et ne traite pas cela comme une erreur", async () => {
    const m = monter({ abonnement: abonnement({ suspenduLe: MAINTENANT }) });

    const suite = await suspendre(m.ports, "ab-1", { auteur: "a" }, MAINTENANT);

    expect(suite.faire).toBe("RIEN");
    expect(m.suspensions).toHaveLength(0);
  });

  it("refuse de suspendre un abonnement résilié", async () => {
    const m = monter({ abonnement: abonnement({ resilieeLe: MAINTENANT }) });

    expect((await suspendre(m.ports, "ab-1", { auteur: "a" }, MAINTENANT)).faire).toBe(
      "REFUSE",
    );
  });

  it("rétablit sans déplacer les dates", async () => {
    // Si l'échéance est passée pendant la suspension, l'abonné se retrouve à
    // relancer — ce qui est juste : la suspension n'a jamais été une remise.
    const m = monter({ abonnement: abonnement({ suspenduLe: MAINTENANT }) });

    const suite = await retablir(m.ports, "ab-1", { auteur: "a" }, MAINTENANT);

    expect(suite.faire).toBe("FAIT");
    expect(m.suspensions).toEqual([null]);
    expect(accesOuvert(m.abonnement, MAINTENANT)).toBe(true);
  });
});

describe("résilier", () => {
  it("ne coupe pas l'accès déjà payé, et le dit à l'appelant", async () => {
    // Le point de tout ce chantier. Un abonné qui résilie le 3 a payé jusqu'au
    // 30 : lui couper le service à l'instant du clic, c'est garder son argent
    // et lui retirer ce qu'il a acheté.
    const m = monter();
    const jusqua = m.abonnement.cycle.accesJusquA;

    const suite = await resilier(m.ports, "ab-1", { auteur: "awa" }, MAINTENANT);

    expect(suite.faire).toBe("FAIT");
    expect(suite.accesJusquA).toBe(jusqua);
    expect(accesOuvert(m.abonnement, MAINTENANT)).toBe(true);
    expect(accesOuvert(m.abonnement, jusqua)).toBe(true);
    // Mais pas au-delà : aucune grâce pour qui a dit non.
    expect(accesOuvert(m.abonnement, ajouterJours(jusqua, 1))).toBe(false);
  });

  it("ne résilie pas deux fois", async () => {
    const m = monter({ abonnement: abonnement({ resilieeLe: MAINTENANT }) });

    expect((await resilier(m.ports, "ab-1", { auteur: "a" }, MAINTENANT)).faire).toBe(
      "RIEN",
    );
    expect(m.resiliations).toHaveLength(0);
  });
});

describe("marquer payé", () => {
  it("avance le cycle comme le ferait un vrai paiement", async () => {
    // Il passe par `reconcilier`, donc par la politique de règlement, le cumul
    // des versements partiels et le contrôle de devise. Un chemin séparé aurait
    // produit deux arithmétiques pour un seul fait.
    const m = monter();

    const suite = await marquerPaye(m.ports, "ab-1", {
      montant: 2000,
      piece: "RECU-0042",
      recuLe: MAINTENANT,
      moyen: "espèces",
      auteur: "awa@baobart.ci",
    });

    expect(suite.faire).toBe("FAIT");
    expect(suite.jours).toBe(30);
    expect(m.renouvelements).toHaveLength(1);
    expect(m.versements[0]!.identifiant).toBe("manuel:RECU-0042");
  });

  it("compte une seule fois la même pièce", async () => {
    // C'est le second effet de la pièce obligatoire : l'identifiant du
    // versement en dérive, donc réenregistrer le même reçu ne fait rien.
    const m = monter();

    const paiement = {
      montant: 2000,
      piece: "RECU-0042",
      recuLe: MAINTENANT,
      moyen: "espèces",
      auteur: "a",
    };

    await marquerPaye(m.ports, "ab-1", paiement);
    const second = await marquerPaye(m.ports, "ab-1", paiement);

    expect(second.faire).toBe("RIEN");
    expect(m.renouvelements).toHaveLength(1);
    expect(m.versements).toHaveLength(1);
  });

  it("exige une pièce justificative", async () => {
    // « Marquer payé » enregistre de l'argent que Ndank n'a jamais vu passer.
    // Sans pièce, l'écriture n'est vérifiable par personne.
    const m = monter();

    const suite = await marquerPaye(m.ports, "ab-1", {
      montant: 2000,
      piece: "   ",
      recuLe: MAINTENANT,
      moyen: "espèces",
      auteur: "a",
    });

    expect(suite.faire).toBe("REFUSE");
    expect(suite.faire === "REFUSE" && suite.motif).toContain("pièce");
  });

  it("refuse un montant qui n'est pas un entier positif", async () => {
    const m = monter();

    for (const montant of [0, -100, 12.5]) {
      const suite = await marquerPaye(m.ports, "ab-1", {
        montant,
        piece: `P-${montant}`,
        recuLe: MAINTENANT,
        moyen: "espèces",
        auteur: "a",
      });

      expect(suite.faire).toBe("REFUSE");
    }

    expect(m.versements).toHaveLength(0);
  });

  it("crédite sans avancer quand le versement est partiel", async () => {
    const m = monter();

    const suite = await marquerPaye(m.ports, "ab-1", {
      montant: 800,
      piece: "RECU-0043",
      recuLe: MAINTENANT,
      moyen: "espèces",
      auteur: "a",
    });

    expect(suite.faire).toBe("FAIT");
    expect(suite.jours).toBeUndefined();
    expect(m.renouvelements).toHaveLength(0);
    // Le versement est bien enregistré : l'argent est arrivé.
    expect(m.versements).toHaveLength(1);
  });

  it("enregistre le versement avant d'avancer le cycle", async () => {
    // Si la seconde écriture tombe, on a une pièce enregistrée et un cycle non
    // avancé — ce qui se rattrape en rejouant. L'inverse offrirait un mois.
    const m = monter();
    const ordre: string[] = [];

    m.ports.interventions.versementManuel = async () => void ordre.push("versement");
    m.ports.ecriture!.renouveler = async () => void ordre.push("cycle");

    await marquerPaye(m.ports, "ab-1", {
      montant: 2000,
      piece: "RECU-0044",
      recuLe: MAINTENANT,
      moyen: "espèces",
      auteur: "a",
    });

    expect(ordre).toEqual(["versement", "cycle"]);
  });
});

describe("relancer maintenant", () => {
  it("envoie tout de suite, par le canal du palier applicable", async () => {
    const m = monter();

    const suite = await relancerMaintenant(
      m.ports,
      "ab-1",
      REDACTION,
      { auteur: "awa" },
      MAINTENANT,
    );

    expect(suite.faire).toBe("FAIT");
    expect(m.envois).toHaveLength(1);
    expect(m.envois[0]!.message.offre).toBe("Pass Créateur");
  });

  it("n'en envoie qu'une par jour, quel que soit le nombre de clics", async () => {
    // Un bouton se clique cinq fois quand rien ne semble se passer. Cinq SMS
    // partent alors, ils sont facturés, et l'abonné les reçoit tous.
    const m = monter();

    for (let i = 0; i < 5; i += 1) {
      await relancerMaintenant(m.ports, "ab-1", REDACTION, { auteur: "a" }, MAINTENANT);
    }

    expect(m.envois).toHaveLength(1);
    expect(m.notees).toHaveLength(1);
    expect(m.notees[0]!.cle).toContain(":manuel:");
  });

  it("laisse repartir une relance le lendemain", async () => {
    const m = monter();

    await relancerMaintenant(m.ports, "ab-1", REDACTION, { auteur: "a" }, MAINTENANT);
    await relancerMaintenant(
      m.ports,
      "ab-1",
      REDACTION,
      { auteur: "a" },
      ajouterJours(MAINTENANT, 1),
    );

    expect(m.envois).toHaveLength(2);
  });

  it("choisit le canal gratuit quand l'échéance est encore loin", async () => {
    // Laisser choisir le canal aurait fait cliquer « SMS » par défaut — c'est
    // celui dont on est sûr qu'il arrive — et rendu chaque relance payante.
    const loin = abonnement({ cycle: cycleApresPaiement(MAINTENANT, "MENSUEL") });
    const m = monter({ abonnement: loin });

    await relancerMaintenant(m.ports, "ab-1", REDACTION, { auteur: "a" }, MAINTENANT);

    expect(m.envois[0]!.canal).toBe("courriel");
  });

  it("sort le SMS quand l'accès va tomber", async () => {
    const tard = abonnement({
      cycle: cycleApresPaiement(ajouterJours(MAINTENANT, -35), "MENSUEL"),
    });
    const m = monter({ abonnement: tard, canauxQuiMarchent: ["sms"] });

    await relancerMaintenant(m.ports, "ab-1", REDACTION, { auteur: "a" }, MAINTENANT);

    expect(m.envois[0]!.canal).toBe("sms");
    expect(m.envois[0]!.message.dernier).toBe(true);
  });

  it("refuse de relancer un abonné qui a résilié", async () => {
    // La règle vaut pour le passage quotidien ; elle vaut aussi pour un bouton.
    const m = monter({ abonnement: abonnement({ resilieeLe: MAINTENANT }) });

    const suite = await relancerMaintenant(
      m.ports,
      "ab-1",
      REDACTION,
      { auteur: "a" },
      MAINTENANT,
    );

    expect(suite.faire).toBe("REFUSE");
    expect(m.envois).toHaveLength(0);
  });

  it("ne note rien quand aucun canal n'a abouti", async () => {
    // Même règle que le passage quotidien : réessayer demain doit rester
    // possible.
    const m = monter({
      coordonnees: { nom: null, courriel: null, telephone: null, appareils: [] },
    });

    const suite = await relancerMaintenant(
      m.ports,
      "ab-1",
      REDACTION,
      { auteur: "a" },
      MAINTENANT,
    );

    expect(suite.faire).toBe("RIEN");
    expect(m.notees).toHaveLength(0);
  });
});

describe("le journal", () => {
  it("porte l'auteur de chaque geste", async () => {
    // Une base qu'on peut modifier sans laisser de trace est une base dont on
    // ne peut plus rien reconstituer.
    const m = monter();

    await suspendre(m.ports, "ab-1", { auteur: "awa@baobart.ci", motif: "litige" }, MAINTENANT);
    await retablir(m.ports, "ab-1", { auteur: "moussa@baobart.ci" }, MAINTENANT);

    expect(m.journal.map((f) => `${f.geste}:${f.auteur}`)).toEqual([
      "suspendre:awa@baobart.ci",
      "retablir:moussa@baobart.ci",
    ]);
    expect(m.journal[0]!.detail?.["motif"]).toBe("litige");
  });

  it("consigne le montant et la pièce d'un paiement manuel", async () => {
    const m = monter();

    await marquerPaye(m.ports, "ab-1", {
      montant: 2000,
      piece: "VIR-991",
      recuLe: MAINTENANT,
      moyen: "virement",
      auteur: "awa",
    });

    const fait = m.journal.find((f) => f.geste === "paiement-manuel")!;
    expect(fait.detail).toMatchObject({
      montant: 2000,
      piece: "VIR-991",
      moyen: "virement",
    });
  });

  it("ne fait pas échouer le geste s'il ne peut pas écrire", async () => {
    // Un geste posé et non consigné vaut mieux qu'un geste refusé parce que le
    // journal était plein — surtout « suspendre », qu'on pose rarement sans
    // raison.
    const m = monter();
    m.ports.interventions.journaliser = async () => {
      throw new Error("journal indisponible");
    };

    const suite = await suspendre(m.ports, "ab-1", { auteur: "a" }, MAINTENANT);

    expect(suite.faire).toBe("FAIT");
    expect(m.suspensions).toEqual([MAINTENANT]);
  });
});

describe("un abonnement introuvable", () => {
  it("lève, parce que ce n'est pas un cas normal du tableau de bord", async () => {
    const m = monter();

    await expect(
      suspendre(m.ports, "ab-999", { auteur: "a" }, MAINTENANT),
    ).rejects.toThrow(/introuvable/);
  });
});

describe("les jours accordés", () => {
  it("partent bien du cycle et non du jour du geste", async () => {
    const m = monter();
    const avant = m.abonnement.cycle.echeance;

    await marquerPaye(m.ports, "ab-1", {
      montant: 2000,
      piece: "RECU-1",
      recuLe: MAINTENANT,
      moyen: "espèces",
      auteur: "a",
    });

    // `reconcilier` a rendu le cycle suivant ; on vérifie qu'il enchaîne sur
    // l'échéance, comme partout ailleurs.
    expect(joursEntre(avant, m.abonnement.cycle.echeance)).toBe(0);
    expect(m.renouvelements).toHaveLength(1);
  });
});
