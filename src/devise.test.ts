import { describe, expect, it } from "vitest";

import {
  depuisFournisseur,
  exposant,
  formater,
  SANS_DECIMALE,
  versFournisseur,
} from "./devise";

/** Ce que Paystack fait, mesuré en bac à sable. */
const PAYSTACK = 2;
/** Ce qu'on lit de la documentation Flutterwave — non vérifié. */
const FLUTTERWAVE = 0;

describe("l'exposant d'une devise", () => {
  it("donne zéro au franc CFA, deux au reste", () => {
    expect(exposant("XOF")).toBe(0);
    expect(exposant("XAF")).toBe(0);
    expect(exposant("GHS")).toBe(2);
    expect(exposant("NGN")).toBe(2);
  });

  it("suppose deux décimales quand il ne connaît pas", () => {
    // Se tromper dans ce sens SOUS-facture. L'erreur inverse débiterait cent
    // fois trop, sur le téléphone d'une vraie personne, et Ndank ne rembourse
    // pas : il n'a jamais touché l'argent.
    expect(exposant("ZZZ")).toBe(2);
  });

  it("ne dépend pas de la casse", () => {
    expect(exposant("xof")).toBe(0);
  });

  it("couvre les francs de la zone, et pas seulement le CFA", () => {
    for (const d of ["XOF", "XAF", "GNF", "RWF", "BIF", "DJF", "KMF", "UGX"]) {
      expect(SANS_DECIMALE).toContain(d);
    }
  });
});

describe("la conversion vers Paystack", () => {
  it("multiplie le franc CFA par cent, parce que Paystack compte en centièmes", () => {
    // Relevé dans le tableau de bord, en mode test :
    //   envoyé « amount: 2000 »    → affiché « XOF 20.00 »
    //   envoyé « amount: 200000 »  → affiché « XOF 2,000.00 »
    expect(versFournisseur(2000, "XOF", PAYSTACK)).toBe(200_000);
    expect(versFournisseur(5000, "XOF", PAYSTACK)).toBe(500_000);
  });

  it("ne touche pas aux devises que Paystack compte déjà comme la norme", () => {
    // Kobo, pesewas : là, Paystack et l'ISO 4217 coïncident — et c'est
    // exactement pourquoi l'erreur est restée invisible si longtemps.
    expect(versFournisseur(2000, "NGN", PAYSTACK)).toBe(2000);
    expect(versFournisseur(2000, "GHS", PAYSTACK)).toBe(2000);
  });

  it("fait l'aller-retour sans rien perdre", () => {
    for (const [montant, devise] of [
      [2000, "XOF"],
      [1, "XOF"],
      [123_456, "XAF"],
      [2000, "GHS"],
    ] as const) {
      expect(depuisFournisseur(versFournisseur(montant, devise, PAYSTACK), devise, PAYSTACK)).toBe(
        montant,
      );
    }
  });
});

describe("la conversion vers Flutterwave", () => {
  it("laisse le franc CFA intact — les deux lectures y coïncident", () => {
    // C'est ce qui fait que le doute sur Flutterwave ne peut pas mordre le
    // marché principal : l'ISO donne zéro décimale au XOF, et des unités
    // majeures aussi.
    expect(versFournisseur(2000, "XOF", FLUTTERWAVE)).toBe(2000);
  });

  it("ramène une devise à deux décimales en unités majeures", () => {
    // 2 000 pesewas = 20 cedis.
    expect(versFournisseur(2000, "GHS", FLUTTERWAVE)).toBe(20);
    expect(depuisFournisseur(20, "GHS", FLUTTERWAVE)).toBe(2000);
  });

  it("arrondit au supérieur plutôt que de facturer moins que le prix affiché", () => {
    // 2 050 pesewas ne se disent pas en cedis entiers. Arrondir vers le bas
    // ferait encaisser moins que ce que l'offre annonce, et l'écart se
    // répéterait à chaque cycle.
    expect(versFournisseur(2050, "GHS", FLUTTERWAVE)).toBe(21);
  });
});

describe("l'arithmétique", () => {
  it("reste entière, dans les deux sens", () => {
    // Un flottant sur de l'argent réel est la seule erreur qu'on ne rattrape
    // jamais.
    for (const m of [1, 7, 999, 100_003]) {
      expect(Number.isInteger(versFournisseur(m, "XOF", PAYSTACK))).toBe(true);
      expect(Number.isInteger(depuisFournisseur(m, "GHS", FLUTTERWAVE))).toBe(true);
    }
  });
});

describe("le montant écrit pour un humain", () => {
  it("n'ajoute pas de décimales au franc CFA", () => {
    const ecrit = formater(2000, "XOF");

    expect(ecrit).toContain("2");
    expect(ecrit).not.toContain(",00");
    expect(ecrit).not.toContain(".00");
  });

  it("en met deux au cedi", () => {
    expect(formater(2000, "GHS")).toMatch(/20[.,]00/);
  });

  it("ne fait pas tomber une page sur une devise inconnue", () => {
    // Une page de paiement qui lève parce qu'`Intl` ne connaît pas un code
    // laisse l'abonné devant un écran blanc.
    expect(formater(2000, "ZZZ")).toContain("ZZZ");
  });
});
