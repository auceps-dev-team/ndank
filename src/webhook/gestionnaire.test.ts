import { describe, expect, it } from "vitest";

import { cycleApresPaiement } from "../cycle";
import {
  SignatureInvalide,
  type Encaissement,
  type Issue,
} from "../encaissement/port";
import { referenceDeVersement } from "../encaissement/reconciliation";
import type { AbonnementLu } from "../ports";
import type { RequeteWeb } from "../web";
import { gestionnaireWebhook, type FaitWebhook } from "./gestionnaire";

const DEPART = new Date("2026-01-10T00:00:00Z");

function abonnement(): AbonnementLu {
  return {
    id: "ab-1",
    abonneId: "user-1",
    cadence: "MENSUEL",
    cycle: cycleApresPaiement(DEPART, "MENSUEL"),
    resilieeLe: null,
    montant: 2000,
    devise: "XOF",
    libelle: "Pass Créateur",
  };
}

const REFERENCE = referenceDeVersement("ab-1", abonnement().cycle.echeance, 0);

function issue(sur: Partial<Issue> = {}): Issue {
  return {
    reference: REFERENCE,
    etat: "REUSSI",
    montant: 2000,
    devise: "XOF",
    identifiantFournisseur: "chg_1",
    regleLe: null,
    brut: {},
    ...sur,
  };
}

/** Un adaptateur dont on décide ce que `lireWebhook` fait. */
function fauxAdaptateur(
  lecture: () => Issue | null,
): Encaissement & { corpsVus: string[] } {
  const corpsVus: string[] = [];

  return {
    nom: "faux",
    devises: ["XOF"],
    corpsVus,
    async inviter() {
      throw new Error("pas ici");
    },
    async constater() {
      throw new Error("pas ici");
    },
    lireWebhook(corps) {
      corpsVus.push(corps);
      return lecture();
    },
  };
}

function monter(
  options: {
    lecture?: () => Issue | null;
    abonnement?: AbonnementLu | null;
    lectureLeve?: boolean;
    surIssue?: (issue: Issue, a: AbonnementLu) => Promise<void>;
  } = {},
) {
  const a = options.abonnement === undefined ? abonnement() : options.abonnement;
  const faits: FaitWebhook[] = [];
  const adaptateur = fauxAdaptateur(options.lecture ?? (() => issue()));

  const recevoir = gestionnaireWebhook({
    fournisseurs: { faux: adaptateur },
    dossier: {
      async abonnement(id) {
        if (options.lectureLeve) throw new Error("base indisponible");
        return a !== null && a.id === id ? a : null;
      },
    },
    surIssue: options.surIssue,
    journal: (fait) => faits.push(fait),
  });

  return { recevoir, faits, adaptateur };
}

function poste(chemin: string, corps = "{}"): RequeteWeb {
  return {
    methode: "POST",
    chemin,
    parametres: {},
    corps,
    entetes: { "x-paystack-signature": "abc" },
  };
}

describe("le code de réponse, qui est une instruction", () => {
  it("rend 200 quand le paiement est traité : le fournisseur n'y revient pas", async () => {
    const vus: Issue[] = [];
    const m = monter({ surIssue: async (i) => void vus.push(i) });

    const r = await m.recevoir(poste("/faux"));

    expect(r.statut).toBe(200);
    expect(vus).toHaveLength(1);
  });

  it("rend 500 quand le crochet de l'hôte lève, pour que le rejeu nous sauve", async () => {
    // C'est le seul cas où le rejeu sert à quelque chose. Rendre 200 ici
    // perdrait le paiement pour de bon : le fournisseur considère l'événement
    // comme remis, et ne le renverra jamais.
    const m = monter({
      surIssue: async () => {
        throw new Error("base indisponible");
      },
    });

    const r = await m.recevoir(poste("/faux"));

    expect(r.statut).toBe(500);
    expect(m.faits.some((f) => f.detail === "surIssue a levé")).toBe(true);
  });

  it("rend 500 quand la lecture de l'abonnement échoue", async () => {
    const m = monter({ lectureLeve: true });
    expect((await m.recevoir(poste("/faux"))).statut).toBe(500);
  });

  it("rend 200 sur un événement qui ne nous concerne pas", async () => {
    // Les fournisseurs émettent des remboursements, des virements, des
    // changements d'abonnement. Rendre 500 les ferait rejouer pendant trois
    // jours, puis désactiver le point de terminaison.
    const m = monter({ lecture: () => null });

    const r = await m.recevoir(poste("/faux"));

    expect(r.statut).toBe(200);
    expect(m.faits.some((f) => f.quoi === "IGNORE")).toBe(true);
  });

  it("rend 401 sur une signature invalide, et rien n'est rejoué", async () => {
    // Le vrai fournisseur ne verra jamais ce code : sa signature est bonne.
    // Celui qui le voit n'a rien à rejouer.
    const m = monter({
      lecture: () => {
        throw new SignatureInvalide("faux");
      },
    });

    const r = await m.recevoir(poste("/faux"));

    expect(r.statut).toBe(401);
    expect(m.faits.some((f) => f.quoi === "SIGNATURE")).toBe(true);
  });

  it("rend 200 sur un corps illisible : le rejeu ne changerait rien", async () => {
    const m = monter({
      lecture: () => {
        throw new SyntaxError("Unexpected token <");
      },
    });

    const r = await m.recevoir(poste("/faux", "<html>502</html>"));

    expect(r.statut).toBe(200);
    expect(m.faits.some((f) => f.detail === "corps illisible")).toBe(true);
  });

  it("rend 404 sur un fournisseur inconnu, sans rien faire", async () => {
    const m = monter();
    expect((await m.recevoir(poste("/stripe"))).statut).toBe(404);
    expect(m.adaptateur.corpsVus).toHaveLength(0);
  });

  it("refuse une autre méthode que POST", async () => {
    const m = monter();
    const r = await m.recevoir({ ...poste("/faux"), methode: "GET" });
    expect(r.statut).toBe(405);
  });
});

describe("ce qui n'est pas à nous", () => {
  it("ignore une référence étrangère, sans rien inventer", async () => {
    // Un autre système poste sur la même adresse, ou le marchand encaisse
    // aussi en dehors de Ndank.
    const m = monter({ lecture: () => issue({ reference: "REF-EXTERNE-42" }) });

    const r = await m.recevoir(poste("/faux"));

    expect(r.statut).toBe(200);
    expect(m.faits.some((f) => f.quoi === "ETRANGER")).toBe(true);
  });

  it("signale un paiement sur un abonnement introuvable, sans faire rejouer", async () => {
    // Rejouer n'y changerait rien. Mais c'est un paiement réel sur un dossier
    // qu'on ne retrouve pas : cela mérite l'attention de quelqu'un.
    const m = monter({ abonnement: null });

    const r = await m.recevoir(poste("/faux"));

    expect(r.statut).toBe(200);
    expect(m.faits.some((f) => f.quoi === "INTROUVABLE")).toBe(true);
  });
});

describe("le corps brut", () => {
  it("arrive à l'adaptateur tel qu'il a été reçu", async () => {
    // La signature porte sur les octets envoyés. `JSON.parse` puis
    // `JSON.stringify` rend un texte différent — ordre des clés, espaces,
    // notation des nombres — et la signature ne correspond plus. C'est le
    // piège le plus courant, et il se manifeste par un « ça marche chez moi ».
    const brut = '{"event":"charge.success","data":{"amount":2000}}';
    const m = monter();

    await m.recevoir(poste("/faux", brut));

    expect(m.adaptateur.corpsVus[0]).toBe(brut);
  });
});

describe("le même paiement par les deux chemins", () => {
  it("appelle le même crochet que la page, avec la même issue", async () => {
    // Les deux chemins doivent pouvoir conclure : un webhook se perd, et les
    // rappels de MTN ne sont même pas signés. C'est `dejaCompte`, dans le
    // crochet de l'hôte, qui rend le doublon inoffensif.
    const appels: string[] = [];
    const m = monter({
      surIssue: async (i, a) => {
        appels.push(`${a.id}:${i.identifiantFournisseur}`);
      },
    });

    await m.recevoir(poste("/faux"));
    await m.recevoir(poste("/faux"));

    expect(appels).toEqual(["ab-1:chg_1", "ab-1:chg_1"]);
  });
});
