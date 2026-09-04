import { describe, expect, it } from "vitest";

import { ajouterJours, cycleApresPaiement } from "../cycle";
import type { Creances, EtatCreance } from "../encaissement/reconciliation";
import type {
  FaitIntervention,
  Interventions,
  PortsIntervention,
} from "../intervention";
import type {
  AbonnementLu,
  Canal,
  Coordonnees,
  Ecriture,
  Envoi,
  Lecture,
} from "../ports";
import type { RequeteWeb } from "../web";
import { routeurGestes } from "./gestes";

const JETON = "jeton-du-serveur-de-l-hote";
const AUTEUR = "awa@baobart.ci";
const MAINTENANT = new Date();

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

function monter(a: AbonnementLu = abonnement()) {
  const journal: FaitIntervention[] = [];
  const suspensions: Array<Date | null> = [];
  const versements: Array<{ identifiant: string }> = [];
  const envois: Canal[] = [];
  const notees: string[] = [];

  const etat: EtatCreance = { verse: 0, joursAccordes: 0, versements: 0 };
  const vus = new Set<string>();

  const interventions: Interventions = {
    async suspendre(_id, quand) {
      suspensions.push(quand);
      a.suspenduLe = quand;
    },
    async resilier(_id, quand) {
      a.resilieeLe = quand;
    },
    async versementManuel(v) {
      versements.push({ identifiant: v.identifiant });
      vus.add(v.identifiant);
    },
    async journaliser(fait) {
      journal.push(fait);
    },
  };

  const ou: Coordonnees = {
    nom: "Awa",
    courriel: "awa@ndank.test",
    telephone: "+2250700000000",
    appareils: [],
  };

  const lecture: Lecture = {
    async aRelancer() {
      return [];
    },
    async relancesEnvoyees() {
      return [...notees];
    },
    async coordonnees() {
      return ou;
    },
  };

  const ecriture: Ecriture = {
    async noterRelance(_id, cle) {
      notees.push(cle);
    },
    async suspendre() {},
    async clore() {},
    async renouveler() {},
  };

  const envoi: Envoi = {
    disponible: (canal, coord) =>
      canal === "courriel" ? coord.courriel !== null : canal === "sms" ? coord.telephone !== null : false,
    async envoyer(canal) {
      envois.push(canal);
      return true;
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

  const routeur = routeurGestes({
    ports,
    jeton: JETON,
    redaction: {
      lien: (x) => `https://p.test/v/${x.id}`,
      montant: (x) => `${x.montant} ${x.devise}`,
    },
  });

  return { routeur, abonnement: a, journal, suspensions, versements, envois, notees };
}

function poste(chemin: string, sur: Partial<RequeteWeb> = {}): RequeteWeb {
  return {
    methode: "POST",
    chemin,
    parametres: {},
    corps: "",
    entetes: {
      authorization: `Bearer ${JETON}`,
      "x-ndank-auteur": AUTEUR,
    },
    ...sur,
  };
}

const lire = (corps: string) => JSON.parse(corps) as Record<string, unknown>;

describe("l'accès aux gestes", () => {
  it("refuse tout ce qui n'est pas POST", async () => {
    // Un verbe unique rend la règle lisible d'un coup d'œil : sur cette
    // adresse, tout écrit.
    const m = monter();

    for (const methode of ["GET", "PUT", "DELETE", "PATCH"]) {
      expect((await m.routeur(poste("/abonnements/ab-1/suspendre", { methode }))).statut).toBe(
        405,
      );
    }
  });

  it("refuse un jeton absent ou faux", async () => {
    const m = monter();

    expect(
      (await m.routeur(poste("/abonnements/ab-1/suspendre", { entetes: {} }))).statut,
    ).toBe(401);
  });

  it("refuse de se construire avec un jeton vide", () => {
    const m = monter();
    expect(() =>
      routeurGestes({
        ports: { dossier: { async abonnement() { return null; } }, interventions: {} as never },
        jeton: "  ",
        redaction: { lien: () => "", montant: () => "" },
      }),
    ).toThrow(/DIFFÉRENT/);
    expect(m).toBeTruthy();
  });

  it("refuse d'écrire sans auteur, plutôt que d'écrire « inconnu »", async () => {
    // Un journal qui dit « inconnu » à la moitié de ses lignes ne sert plus à
    // rien, et c'est le jour où l'on cherche qui a fait quoi qu'on s'en
    // aperçoit.
    const m = monter();

    const r = await m.routeur(
      poste("/abonnements/ab-1/suspendre", {
        entetes: { authorization: `Bearer ${JETON}` },
      }),
    );

    expect(r.statut).toBe(400);
    expect(String(lire(r.corps)["erreur"])).toContain("X-Ndank-Auteur");
    expect(m.suspensions).toHaveLength(0);
  });

  it("prend l'auteur dans l'en-tête, jamais dans le corps", async () => {
    // Un auteur que l'appelant remplit à sa guise serait déclaratif, donc
    // inutile le jour où l'on cherche à comprendre.
    const m = monter();

    await m.routeur(
      poste("/abonnements/ab-1/suspendre", {
        corps: JSON.stringify({ auteur: "quelqu-un-d-autre" }),
      }),
    );

    expect(m.journal[0]!.auteur).toBe(AUTEUR);
  });
});

describe("les cinq gestes", () => {
  it("suspend, puis rétablit", async () => {
    const m = monter();

    expect((await m.routeur(poste("/abonnements/ab-1/suspendre"))).statut).toBe(200);
    expect((await m.routeur(poste("/abonnements/ab-1/retablir"))).statut).toBe(200);

    expect(m.suspensions).toHaveLength(2);
    expect(m.suspensions[1]).toBeNull();
  });

  it("résilie, et dit jusqu'à quand l'accès tient", async () => {
    // Le taire ferait croire à une coupure immédiate — le malentendu exact que
    // cette version corrige.
    const m = monter();

    const r = await m.routeur(poste("/abonnements/ab-1/resilier"));
    const corps = lire(r.corps);

    expect(r.statut).toBe(200);
    expect(corps["accesJusquA"]).toBe(
      m.abonnement.cycle.accesJusquA.toISOString(),
    );
  });

  it("enregistre un paiement manuel", async () => {
    const m = monter();

    const r = await m.routeur(
      poste("/abonnements/ab-1/paiement", {
        corps: JSON.stringify({
          montant: 2000,
          piece: "RECU-7",
          moyen: "espèces",
          recuLe: MAINTENANT.toISOString(),
        }),
      }),
    );

    expect(r.statut).toBe(200);
    expect(m.versements[0]!.identifiant).toBe("manuel:RECU-7");
  });

  it("relance tout de suite", async () => {
    const m = monter();

    expect((await m.routeur(poste("/abonnements/ab-1/relancer"))).statut).toBe(200);
    expect(m.envois).toHaveLength(1);
  });

  it("refuse un geste qu'il ne connaît pas", async () => {
    const m = monter();
    expect((await m.routeur(poste("/abonnements/ab-1/effacer"))).statut).toBe(404);
  });
});

describe("les codes de réponse", () => {
  it("rend 200 sur « rien à faire », pas une erreur", async () => {
    // Le geste a été reçu et compris, il n'y avait rien à poser. Un 4xx ferait
    // afficher une erreur à quelqu'un qui a cliqué deux fois.
    const m = monter();

    await m.routeur(poste("/abonnements/ab-1/suspendre"));
    const second = await m.routeur(poste("/abonnements/ab-1/suspendre"));

    expect(second.statut).toBe(200);
    expect(lire(second.corps)["faire"]).toBe("RIEN");
  });

  it("rend 409 sur un refus", async () => {
    const m = monter(abonnement({ resilieeLe: MAINTENANT }));

    const r = await m.routeur(poste("/abonnements/ab-1/suspendre"));

    expect(r.statut).toBe(409);
    expect(lire(r.corps)["faire"]).toBe("REFUSE");
  });

  it("rend 404 sur un abonnement introuvable, et non 500", async () => {
    // C'est un lien mort, pas une panne du serveur.
    const m = monter();

    expect((await m.routeur(poste("/abonnements/ab-999/suspendre"))).statut).toBe(404);
  });

  it("refuse une date de paiement illisible", async () => {
    const m = monter();

    const r = await m.routeur(
      poste("/abonnements/ab-1/paiement", {
        corps: JSON.stringify({ montant: 2000, piece: "P", moyen: "x", recuLe: "hier" }),
      }),
    );

    expect(r.statut).toBe(400);
  });
});
