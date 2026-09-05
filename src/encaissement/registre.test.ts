import { describe, expect, it } from "vitest";

import {
  CHAMPS_REQUIS,
  ConfigurationIncomplete,
  FournisseurInconnu,
  catalogue,
  champsManquants,
  fournisseur,
} from "./registre";
import type { Http } from "./port";

const RIEN: Http = async () => ({ statut: 200, corps: "{}" });

describe("la configuration d'un fournisseur", () => {
  it("nomme le champ qui manque, plutôt que de laisser le fournisseur répondre 401", () => {
    // C'est tout l'intérêt du registre. Une clé absente d'un fichier
    // d'environnement vaut `undefined`, part dans un en-tête vide, et revient
    // en « autorisation refusée » — un message qui ne parle jamais de la ligne
    // manquante dans la configuration.
    expect(() => fournisseur("flutterwave", { cleSecrete: "sk" }, RIEN)).toThrow(
      ConfigurationIncomplete,
    );

    try {
      fournisseur("flutterwave", { cleSecrete: "sk" }, RIEN);
    } catch (e) {
      expect((e as Error).message).toContain("secretWebhook");
    }
  });

  it("traite une chaîne vide comme un champ manquant", () => {
    // Le cas réel : la variable existe dans le fichier, mais sa valeur a été
    // effacée. Elle est présente et inutilisable.
    expect(champsManquants("paystack", { cleSecrete: "   " })).toEqual(["cleSecrete"]);
  });

  it("rend une liste vide quand tout est là", () => {
    expect(champsManquants("paystack", { cleSecrete: "sk_test_x" })).toEqual([]);
  });

  it("refuse un nom qu'il ne connaît pas, et dit lesquels il connaît", () => {
    expect(() => fournisseur("stripe" as never, {}, RIEN)).toThrow(FournisseurInconnu);

    try {
      fournisseur("stripe" as never, {}, RIEN);
    } catch (e) {
      expect((e as Error).message).toContain("flutterwave");
    }
  });

  it("construit les trois adaptateurs branchés", () => {
    expect(
      fournisseur(
        "flutterwave",
        { clientId: "id", clientSecret: "sk", secretWebhook: "h" },
        RIEN,
      ).nom,
    ).toBe("flutterwave");

    expect(fournisseur("paystack", { cleSecrete: "sk" }, RIEN).nom).toBe("paystack");

    expect(
      fournisseur(
        "mtn",
        {
          utilisateurApi: "u",
          cleApi: "k",
          cleAbonnement: "s",
          environnement: "sandbox",
        },
        RIEN,
      ).nom,
    ).toBe("mtn");
  });
});

describe("les opérateurs pas encore branchés", () => {
  const config = {
    orange: {
      cleMarchand: "m",
      identifiantClient: "i",
      secretClient: "s",
      codeMarchand: "c",
    },
    wave: { cleApi: "k", secretWebhook: "s" },
  };

  it("se construisent, pour que la configuration soit vérifiable dès aujourd'hui", () => {
    // Un hôte qui prévoit Wave dans trois mois doit pouvoir valider ses champs
    // maintenant : ouvrir un compte marchand prend des semaines.
    expect(fournisseur("orange", config.orange, RIEN).nom).toBe("orange");
    expect(fournisseur("wave", config.wave, RIEN).nom).toBe("wave");
  });

  it("exigent quand même leurs champs", () => {
    expect(() => fournisseur("orange", { cleMarchand: "m" }, RIEN)).toThrow(
      ConfigurationIncomplete,
    );
  });

  it("lèvent un message qui dit quoi faire, plutôt que de faire semblant", async () => {
    // Le pire serait un adaptateur inventé qui échoue au premier vrai paiement,
    // en production, sur un abonné réel.
    const orange = fournisseur("orange", config.orange, RIEN);

    await expect(
      orange.inviter({
        reference: "2026-02-09",
        montant: 2000,
        devise: "XOF",
        libelle: "Pass",
        abonne: { nom: "Awa", courriel: null, telephone: "+2250700000000" },
        retour: "https://exemple.ci/retour",
      }),
    ).rejects.toThrow(/n'est pas encore branché/);

    try {
      await orange.constater("2026-02-09");
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain("orange");
      expect(m).toContain("XOF");
      // Et surtout : par quoi le remplacer en attendant.
      expect(m).toContain("flutterwave");
    }
  });
});

describe("le catalogue", () => {
  it("se dérive du registre plutôt que d'être recopié", () => {
    // Même règle que `relancesAnnoncees` dans le cœur : un écran qui décrit le
    // code doit être fabriqué à partir du code.
    const c = catalogue();
    expect(c).toHaveLength(Object.keys(CHAMPS_REQUIS).length);
  });

  it("distingue ce qui est branché de ce qui ne l'est pas", () => {
    const c = catalogue();
    const branches = c.filter((f) => f.branche).map((f) => f.nom).sort();

    expect(branches).toEqual(["flutterwave", "mtn", "paystack"]);
  });

  it("porte les champs à remplir, pour que l'écran les affiche", () => {
    const wave = catalogue().find((f) => f.nom === "wave")!;
    expect(wave.champs).toContain("cleApi");
    expect(wave.devises).toContain("XOF");
  });
});
