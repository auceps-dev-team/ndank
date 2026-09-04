import { describe, expect, it } from "vitest";

import { PALIERS } from "../etats";
import type { Coordonnees, Message } from "../ports";
import { envoiCompose, envoiMuet, type Redacteur } from "./compose";
import {
  enE164,
  joignable,
  type FaitEnvoi,
  type Remise,
  type TransporteurCourriel,
  type TransporteurPush,
  type TransporteurSms,
} from "./port";
import type { Sms } from "./redaction";

const OU: Coordonnees = {
  nom: "Awa",
  courriel: "awa@ndank.test",
  telephone: "+2250700000000",
  appareils: ["appareil-1"],
};

function message(sur: Partial<Message> = {}): Message {
  return {
    cle: "2026-02-09:3",
    destinataire: "Awa",
    offre: "Pass Créateur",
    montant: "2 000 F CFA",
    lien: "https://ndank.test/valider/ab-1",
    joursRestants: 1,
    dernier: true,
    ...sur,
  };
}

/** Une passerelle qui accepte tout et retient ce qu'on lui a donné. */
function fausseSms(remise: Partial<Remise> = {}) {
  const recus: Sms[] = [];

  const transporteur: TransporteurSms = {
    nom: "faux-sms",
    canal: "sms",
    async envoyer(_ou, contenu) {
      recus.push(contenu);
      return { parti: true, reference: "ref-1", ...remise };
    },
  };

  return { transporteur, recus };
}

describe("un canal sans passerelle", () => {
  it("n'est pas disponible, plutôt que d'échouer à l'envoi", () => {
    // La nuance décide de vraies coupures d'accès. Au dernier palier, il n'y a
    // pas de canal suivant : l'échelle sort le SMS parce que l'accès va tomber.
    // Un « disponible » menteur ferait couper quelqu'un qu'on n'a jamais
    // prévenu, sans que rien ne le signale.
    const envoi = envoiCompose({ sms: fausseSms().transporteur });

    expect(envoi.disponible("sms", OU)).toBe(true);
    expect(envoi.disponible("courriel", OU)).toBe(false);
    expect(envoi.disponible("push", OU)).toBe(false);
  });

  it("laisse quand même le dernier palier joignable quand le SMS est branché", () => {
    // Le vrai garde-fou : le dernier palier de l'échelle ne propose que le SMS.
    // Un hôte qui n'aurait branché que le courriel serait muet là où cela
    // compte le plus — ce test dit que le cas est connu et vérifié.
    const dernier = PALIERS[PALIERS.length - 1]!;
    expect(dernier.canaux).toContain("sms");

    const sansSms = envoiCompose({
      courriel: {
        nom: "faux",
        canal: "courriel",
        async envoyer() {
          return { parti: true, reference: null };
        },
      },
    });

    expect(dernier.canaux.some((c) => sansSms.disponible(c, OU))).toBe(false);
  });

  it("rend faux à l'envoi, et le raconte au journal", async () => {
    const faits: FaitEnvoi[] = [];
    const envoi = envoiCompose({}, { journal: (f) => faits.push(f) });

    expect(await envoi.envoyer("courriel", OU, message())).toBe(false);
    expect(faits).toHaveLength(1);
    expect(faits[0]!.transporteur).toBeNull();
    expect(faits[0]!.parti).toBe(false);
    expect(faits[0]!.cle).toBe("2026-02-09:3");
  });
});

describe("une passerelle qui lève", () => {
  it("ne laisse pas remonter l'exception jusqu'au moteur", async () => {
    // Sinon le moteur ferait de l'abonné un incident et n'essaierait aucun
    // autre canal du palier : le push, gratuit et disponible, ne partirait pas
    // parce que la passerelle SMS était lente.
    const envoi = envoiCompose({
      sms: {
        nom: "sms-en-panne",
        canal: "sms",
        async envoyer() {
          throw new Error("délai d'attente dépassé");
        },
      },
    });

    await expect(envoi.envoyer("sms", OU, message())).resolves.toBe(false);
  });

  it("journalise la cause, parce qu'un booléen ne dit pas pourquoi", async () => {
    // Une clé d'API expirée et un abonné sans téléphone donnent le même
    // « injoignable » dans le bilan. Le premier se répare en une minute — quand
    // on le sait.
    const faits: FaitEnvoi[] = [];

    const envoi = envoiCompose(
      {
        sms: {
          nom: "sms-en-panne",
          canal: "sms",
          async envoyer() {
            throw new Error("clé d'API révoquée");
          },
        },
      },
      { journal: (f) => faits.push(f) },
    );

    await envoi.envoyer("sms", OU, message());

    expect(faits[0]!.transporteur).toBe("sms-en-panne");
    expect((faits[0]!.cause as Error).message).toContain("révoquée");
  });

  it("survit à un journal qui lève lui-même", async () => {
    // Le journal observe, il ne participe pas. Le faire tomber emporterait
    // l'envoi qu'il était censé raconter.
    const envoi = envoiCompose(
      { sms: fausseSms().transporteur },
      {
        journal: () => {
          throw new Error("disque plein");
        },
      },
    );

    await expect(envoi.envoyer("sms", OU, message())).resolves.toBe(true);
  });
});

describe("la rédaction traverse la composition", () => {
  it("donne au transporteur un SMS déjà replié et déjà mesuré", async () => {
    const { transporteur, recus } = fausseSms();
    const envoi = envoiCompose({ sms: transporteur });

    await envoi.envoyer("sms", OU, message({ offre: "Fête à Abidjan" }));

    // « ê » se replie, « à » reste : il est dans l'alphabet GSM-7.
    expect(recus[0]!.texte).toContain("Fete à Abidjan");
    expect(recus[0]!.segments).toBe(1);
    expect(recus[0]!.perdus).toEqual([]);
  });

  it("respecte le budget de segments que l'hôte a fixé", async () => {
    const long = "Abonnement intégral à la plateforme des créateurs indépendants";

    const un = fausseSms();
    await envoiCompose({ sms: un.transporteur }, { segmentsMax: 1 }).envoyer(
      "sms",
      OU,
      message({ offre: long }),
    );

    const deux = fausseSms();
    await envoiCompose({ sms: deux.transporteur }, { segmentsMax: 2 }).envoyer(
      "sms",
      OU,
      message({ offre: long }),
    );

    expect(un.recus[0]!.segments).toBe(1);
    expect(deux.recus[0]!.texte.length).toBeGreaterThanOrEqual(
      un.recus[0]!.texte.length,
    );
  });

  it("accepte une rédaction de remplacement, pour traduire sans toucher au reste", async () => {
    // La promesse de l'en-tête de `redaction.ts` : l'hôte qui a besoin d'une
    // autre langue ne fournit pas un gabarit, il fournit ceci — et garde les
    // paliers, les clés, la reprise et le budget de segments.
    const { transporteur, recus } = fausseSms();

    const enWolof: Redacteur = {
      courriel: () => ({ sujet: "s", texte: "t", html: "<p>t</p>" }),
      sms: () => ({ texte: "Fajal sa abonemaa", segments: 1, perdus: [], tronque: false }),
      push: () => ({ titre: "t", corps: "c", lien: "l", identifiant: "i" }),
    };

    await envoiCompose({ sms: transporteur }, { redacteur: enWolof }).envoyer(
      "sms",
      OU,
      message(),
    );

    expect(recus[0]!.texte).toBe("Fajal sa abonemaa");
  });
});

describe("la disponibilité", () => {
  it("exige une arobase, et pas seulement une chaîne non vide", () => {
    // Un champ rempli avec « aucun » ou « - » arrive dans toute base qui a
    // vécu. Le prendre pour une adresse ferait dépenser l'appel, puis compter
    // un échec — au lieu de passer au canal suivant tout de suite.
    expect(joignable("courriel", { ...OU, courriel: "aucun" })).toBe(false);
    expect(joignable("courriel", { ...OU, courriel: "-" })).toBe(false);
    expect(joignable("courriel", { ...OU, courriel: "a@b.ci" })).toBe(true);
  });

  it("suit la liste d'appareils, et non sa seule présence", () => {
    expect(joignable("push", { ...OU, appareils: [] })).toBe(false);
    expect(joignable("push", { ...OU, appareils: ["a", "b"] })).toBe(true);
  });

  it("laisse un transporteur poser sa propre exigence", () => {
    // Twilio refuse un numéro qui n'est pas au format international. Mieux vaut
    // le savoir avant de dépenser l'appel.
    const strict: TransporteurSms = {
      nom: "strict",
      canal: "sms",
      disponible: (ou) => ou.telephone?.startsWith("+") === true,
      async envoyer() {
        return { parti: true, reference: null };
      },
    };

    const envoi = envoiCompose({ sms: strict });

    expect(envoi.disponible("sms", OU)).toBe(true);
    expect(envoi.disponible("sms", { ...OU, telephone: "0700000000" })).toBe(false);
  });
});

describe("le format international", () => {
  it("promeut un numéro local quand on lui donne l'indicatif", () => {
    // Une base d'abonnés de la zone franc contient « 07 00 00 00 00 » bien plus
    // souvent que « +2250700000000 » : c'est ce que les gens tapent.
    expect(enE164("07 00 00 00 00", "225")).toBe("+2250700000000");
    expect(enE164("07.00.00.00.00", "+225")).toBe("+2250700000000");
  });

  it("ne retire PAS le zéro de tête, parce qu'en Côte d'Ivoire il compte", () => {
    // La première version le retirait, par analogie avec la France. La Côte
    // d'Ivoire est passée à dix chiffres en 2021 : ce zéro fait partie du
    // numéro. Le retirer donnait +225700000000, douze chiffres, un numéro qui
    // n'existe pas — donc un SMS refusé, sur le marché prioritaire, au dernier
    // palier de l'échelle.
    expect(enE164("0700000000", "225")).toBe("+2250700000000");

    // Le Sénégal, le Mali, le Burkina, le Cameroun n'ont pas de zéro de tête du
    // tout : la question ne se pose que pour ceux qui en ont un.
    expect(enE164("771234567", "221")).toBe("+221771234567");
  });

  it("le retire quand l'hôte le demande, et seulement alors", () => {
    // Une supposition qui efface un chiffre coûte plus cher qu'une option à
    // cocher.
    expect(enE164("06 12 34 56 78", "33", { retirerZeroDeTete: true })).toBe(
      "+33612345678",
    );
    expect(enE164("06 12 34 56 78", "33")).toBe("+330612345678");
  });

  it("laisse tel quel ce qui est déjà international", () => {
    expect(enE164("+225 07 00 00 00 00")).toBe("+2250700000000");
    expect(enE164("00225 0700000000")).toBe("+2250700000000");
  });

  it("refuse plutôt que de deviner, quand il n'a pas d'indicatif", () => {
    // Préfixer au hasard enverrait le SMS dans un autre pays, à quelqu'un
    // d'autre, et l'hôte paierait pour ça.
    expect(enE164("0700000000")).toBeNull();
    expect(enE164("")).toBeNull();
    expect(enE164("—")).toBeNull();
  });
});

describe("l'envoi muet", () => {
  it("rédige vraiment, et n'expédie rien", async () => {
    // C'est tout l'intérêt : un faux qui se contenterait de compter ne dirait
    // rien du contenu, et c'est le contenu qui surprend.
    const { envoi, retenus } = envoiMuet();

    await envoi.envoyer("sms", OU, message({ offre: "Pass Créateur" }));
    await envoi.envoyer("courriel", OU, message());

    expect(retenus).toHaveLength(2);
    expect((retenus[0]!.contenu as Sms).texte).toContain("Pass Créateur");
    expect((retenus[0]!.contenu as Sms).segments).toBe(1);
    expect(retenus[1]!.canal).toBe("courriel");
  });

  it("juge joignable tout ce qui a des coordonnées", async () => {
    const { envoi } = envoiMuet();

    expect(envoi.disponible("push", OU)).toBe(true);
    expect(envoi.disponible("push", { ...OU, appareils: [] })).toBe(false);
  });
});
