import { describe, expect, it } from "vitest";

import type { Http } from "../http";
import { envoiCompose } from "./compose";
import {
  CANAL_PASSERELLE,
  CHAMPS_PASSERELLE,
  ConfigurationEnvoiIncomplete,
  PasserelleInconnue,
  cataloguePasserelles,
  champsManquants,
  transporteurCourriel,
  transporteurPush,
  transporteurSms,
  verifierEnvoi,
} from "./registre";

const RIEN: Http = async () => ({ statut: 200, corps: "{}" });

describe("la configuration d'une passerelle", () => {
  it("nomme le champ qui manque, plutôt que de laisser la passerelle répondre 401", () => {
    expect(() => transporteurCourriel("resend", { cleApi: "re_x" }, RIEN)).toThrow(
      ConfigurationEnvoiIncomplete,
    );

    try {
      transporteurCourriel("resend", { cleApi: "re_x" }, RIEN);
    } catch (e) {
      expect((e as Error).message).toContain("expediteur");
    }
  });

  it("traite une chaîne vide comme un champ manquant", () => {
    // Le cas réel : la variable existe dans le fichier, mais sa valeur a été
    // effacée. Elle est présente et inutilisable.
    expect(champsManquants("twilio", { sid: "AC1", jeton: "   " })).toEqual([
      "jeton",
    ]);
  });

  it("refuse un nom qu'il ne connaît pas, et dit lesquels il connaît", () => {
    expect(() =>
      transporteurCourriel("sendgrid" as never, {}, RIEN),
    ).toThrow(PasserelleInconnue);

    try {
      transporteurCourriel("sendgrid" as never, {}, RIEN);
    } catch (e) {
      expect((e as Error).message).toContain("resend");
    }
  });

  it("construit les quatre passerelles branchées", () => {
    expect(
      transporteurCourriel("resend", { cleApi: "k", expediteur: "a@b.ci" }, RIEN)
        .nom,
    ).toBe("resend");

    expect(
      transporteurCourriel("brevo", { cleApi: "k", expediteur: "a@b.ci" }, RIEN)
        .nom,
    ).toBe("brevo");

    expect(
      transporteurSms(
        "twilio",
        { sid: "AC1", jeton: "j", expediteur: "+15550001111" },
        RIEN,
      ).nom,
    ).toBe("twilio");

    // Expo n'a aucun champ requis : le jeton d'accès est facultatif.
    expect(transporteurPush("expo", {}, RIEN).nom).toBe("expo");
  });

  it("rend une fondation pour ce qui n'est pas branché, sans lever tout de suite", () => {
    // Elle se construit, elle se dit indisponible, et elle explique si l'on
    // force. C'est ce qui permet à un hôte de câbler sa configuration complète
    // avant que l'adaptateur n'existe.
    const orange = transporteurSms(
      "orange-sms",
      { identifiantClient: "c", secretClient: "s", expediteur: "+225..." },
      RIEN,
    );

    expect(orange.nom).toBe("orange-sms");
    expect(orange.disponible!({ nom: null, courriel: null, telephone: "+225", appareils: [] })).toBe(
      false,
    );
  });
});

describe("la vérification au démarrage", () => {
  it("ne dit rien quand tout est en place", () => {
    expect(
      verifierEnvoi({
        courriel: { passerelle: "resend", identifiants: { cleApi: "k", expediteur: "a@b.ci" } },
        sms: { passerelle: "twilio", identifiants: { sid: "AC1", jeton: "j" } },
      }),
    ).toEqual([]);
  });

  it("attrape une clé absente, que le passage quotidien rendrait muette", () => {
    // C'est la raison d'être de cette fonction. Une clé de paiement absente se
    // découvre au premier abonné qui clique. Une clé d'envoi absente ne se
    // découvre pas : le passage tourne, l'erreur est rattrapée, le bilan compte
    // un « injoignable » de plus, et ce chiffre n'alerte personne un mardi
    // matin. La panne se voit au troisième jour, quand l'accès tombe pour
    // quelqu'un qui n'a rien reçu.
    const problemes = verifierEnvoi({
      courriel: { passerelle: "resend", identifiants: { cleApi: "k" } },
    });

    expect(problemes).toHaveLength(1);
    expect(problemes[0]).toContain("expediteur");
  });

  it("attrape une passerelle branchée sur le mauvais canal", () => {
    // Le cas est banal et coûteux : une ligne de configuration recopiée d'un
    // canal à l'autre. La passerelle existe, ses champs sont remplis, et elle
    // ne saura pas envoyer ce qu'on lui donnera.
    const problemes = verifierEnvoi({
      sms: { passerelle: "resend", identifiants: { cleApi: "k", expediteur: "a@b.ci" } },
    });

    expect(problemes[0]).toContain("passerelle courriel");
  });

  it("dit qu'une fondation n'est pas branchée, plutôt que de la laisser passer", () => {
    const problemes = verifierEnvoi({
      push: { passerelle: "fcm", identifiants: { projetId: "p", courrielCompteService: "c", clePriveeCompteService: "k" } },
    });

    expect(problemes[0]).toContain("fondation");
  });

  it("signale un nom inconnu", () => {
    expect(
      verifierEnvoi({ sms: { passerelle: "nexmo", identifiants: {} } })[0],
    ).toContain("inconnue");
  });
});

describe("le catalogue", () => {
  it("est dérivé du registre, pas recopié à côté", () => {
    // Même règle que `catalogue()` du côté des paiements et que
    // `relancesAnnoncees` dans le cœur : un écran qui décrit le code doit être
    // fabriqué à partir du code, sinon il finit par mentir.
    const lignes = cataloguePasserelles();

    expect(lignes).toHaveLength(Object.keys(CHAMPS_PASSERELLE).length);

    for (const ligne of lignes) {
      expect(ligne.canal).toBe(CANAL_PASSERELLE[ligne.nom]);
      expect(ligne.champs).toEqual(CHAMPS_PASSERELLE[ligne.nom]);
    }
  });

  it("distingue ce qui est branché de ce qui ne l'est pas", () => {
    const branchees = cataloguePasserelles()
      .filter((l) => l.branche)
      .map((l) => l.nom);

    expect(branchees.sort()).toEqual(["brevo", "expo", "resend", "twilio"]);
  });

  it("dit où obtenir les identifiants d'une fondation", () => {
    const fcm = cataloguePasserelles().find((l) => l.nom === "fcm")!;

    expect(fcm.branche).toBe(false);
    expect(fcm.aObtenir).toContain("Firebase");
  });
});

describe("du registre au port du cœur", () => {
  it("compose un « Envoi » complet à partir de deux lignes de configuration", async () => {
    // C'est la promesse de la couche, bout à bout : deux noms, quelques clés,
    // et le moteur a son port.
    const env = {
      cleApi: "re_test",
      expediteur: "Baobart <no-reply@baobart.ci>",
      sid: "AC1",
      jeton: "secret",
      indicatifParDefaut: "225",
    };

    const envoi = envoiCompose({
      courriel: transporteurCourriel("resend", env, RIEN),
      sms: transporteurSms("twilio", { ...env, expediteur: "+15550001111" }, RIEN),
    });

    const ou = {
      nom: "Awa",
      courriel: "awa@ndank.test",
      telephone: "07 00 00 00 00",
      appareils: [],
    };

    expect(envoi.disponible("courriel", ou)).toBe(true);
    expect(envoi.disponible("sms", ou)).toBe(true);
    // Rien n'est branché sur le push : le moteur descendra au canal suivant.
    expect(envoi.disponible("push", ou)).toBe(false);
  });
});
