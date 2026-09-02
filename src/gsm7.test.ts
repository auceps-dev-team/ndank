import { describe, expect, it } from "vitest";

import { replier, segments, tientEnGsm7 } from "./gsm7";

/**
 * Le défaut que ces tests attrapent ne se voit pas : le message part, il est
 * lu, et il coûte deux à trois fois son prix. Rien dans le journal ne le dit,
 * rien dans le rendu ne le montre — seule la facture, un mois plus tard.
 */

describe("ce qui fait basculer un message en UCS-2", () => {
  it("l'espace fine insécable que les formateurs de montant insèrent", () => {
    // C'est LE cas réel : `Intl.NumberFormat` en français sépare le montant de
    // sa devise par une espace fine insécable. Chaque relance porte un montant,
    // donc chaque relance basculerait en UCS-2 si on ne repliait pas.
    const montant = "2 000 F";
    expect(tientEnGsm7(montant)).toBe(false);
    expect(tientEnGsm7(replier(montant))).toBe(true);
  });

  it("l'apostrophe courbe, qu'on écrit partout ailleurs dans Baobart", () => {
    expect(tientEnGsm7("l’accès")).toBe(false);
    expect(replier("l’accès")).toBe("l'accès");
  });

  it("les accents circonflexes et le ç minuscule", () => {
    // Le `Ç` majuscule est dans la norme, le `ç` minuscule non. C'est le genre
    // de détail qu'aucune relecture ne rattrape.
    expect(tientEnGsm7("ç")).toBe(false);
    // Le `à`, lui, reste : le replier appauvrirait le texte sans rien gagner.
    expect(replier("çà et là, un coût")).toBe("cà et là, un cout");
  });

  it("les tirets et points de suspension typographiques", () => {
    expect(replier("un jour — et puis…")).toBe("un jour - et puis...");
  });

  it("un émoji, qui à lui seul ferait tomber le segment à 70", () => {
    expect(replier("Bonjour 👋")).toBe("Bonjour ");
  });
});

describe("ce qui passe tel quel", () => {
  it("les accents que la norme connaît", () => {
    // é è à ù ì ò ä ö ñ ü sont dans l'alphabet : les replier appauvrirait le
    // texte sans rien économiser.
    expect(replier("échéance dépassée, à régler")).toBe("échéance dépassée, à régler");
    expect(tientEnGsm7("échéance dépassée, à régler")).toBe(true);
  });

  it("la ponctuation ordinaire et les chiffres", () => {
    const t = "Renouvelle pour 2000 XOF : https://baobart.ci/a/abc123";
    expect(replier(t)).toBe(t);
    expect(tientEnGsm7(t)).toBe(true);
  });
});

describe("le compte des segments", () => {
  it("un message court tient en un segment", () => {
    expect(segments("Bonjour")).toBe(1);
    expect(segments("")).toBe(0);
  });

  it("bascule à deux segments au-delà de 160, et non de 161", () => {
    expect(segments("a".repeat(160))).toBe(1);
    // L'en-tête de concaténation mange six septets : chaque segment tombe à
    // 153, donc 161 caractères en coûtent deux et non « un et un peu ».
    expect(segments("a".repeat(161))).toBe(2);
    expect(segments("a".repeat(306))).toBe(2);
    expect(segments("a".repeat(307))).toBe(3);
  });

  it("compte double les caractères de la table d'extension", () => {
    // L'euro coûte deux septets. Quatre-vingts euros suffisent à remplir un
    // segment que sa longueur laisserait croire à moitié vide.
    expect(segments("€".repeat(80))).toBe(1);
    expect(segments("€".repeat(81))).toBe(2);
  });

  it("compte en 70 dès qu'un caractère sort de l'alphabet", () => {
    // La démonstration chiffrée du coût : le même texte, à un caractère près.
    expect(segments("a".repeat(100))).toBe(1);
    expect(segments("👋" + "a".repeat(100))).toBe(2);
  });
});
