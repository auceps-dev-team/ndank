import { describe, expect, it } from "vitest";

import { enE164 } from "./envoi/port";
import { empreinte, normaliserIdentifiant } from "./identite";

const POIVRE = "un-poivre-partage-par-tous-les-hotes";

describe("normaliser un identifiant", () => {
  it("recolle deux écritures du même numéro", () => {
    // Sans cela, la vue multi-sites — dont c'est toute la raison d'être — ne
    // recollerait rien.
    for (const forme of [
      "+225 07 00 00 00 00",
      "+2250700000000",
      "+225-07-00-00-00-00",
      "  +225 (07) 00 00 00 00  ",
    ]) {
      expect(normaliserIdentifiant(forme)).toBe("+2250700000000");
    }
  });

  it("recolle deux écritures de la même adresse", () => {
    expect(normaliserIdentifiant("  Awa@Baobart.CI ")).toBe("awa@baobart.ci");
  });

  it("lève sur un numéro local, plutôt que d'en fabriquer un autre", () => {
    // C'est la panne qu'on ne voit jamais : un hôte range « 0700000000 », un
    // autre « +2250700000000 », et la même personne a deux identités. Sans
    // erreur, sans trace, sans que personne ne sache quoi chercher.
    expect(() => normaliserIdentifiant("0700000000")).toThrow(/E\.164/);
    expect(() => normaliserIdentifiant("07 00 00 00 00")).toThrow(/E\.164/);
  });

  it("dit quoi faire dans le message, et non juste que c'est faux", () => {
    expect(() => normaliserIdentifiant("0700000000")).toThrow(/enE164/);
  });

  it("lève sur un numéro trop court pour être international", () => {
    expect(() => normaliserIdentifiant("+225070")).toThrow(/trop court/);
  });

  it("accepte ce que `enE164` produit", () => {
    // Les deux fonctions doivent s'emboîter : c'est `enE164` qui est censée
    // être la porte d'entrée, et il serait absurde qu'elle rende une forme que
    // la normalisation refuse.
    const e164 = enE164("07 00 00 00 00", "225")!;

    expect(e164).toBe("+2250700000000");
    expect(() => normaliserIdentifiant(e164)).not.toThrow();
  });

  it("ne confond pas une adresse avec un numéro", () => {
    // Réduire « awa@x.ci » à ses chiffres donnerait la chaîne vide, et tous les
    // abonnés inscrits par courriel partageraient une seule identité.
    expect(normaliserIdentifiant("awa@x.ci")).not.toBe(
      normaliserIdentifiant("kofi@x.ci"),
    );
  });
});

describe("l'empreinte", () => {
  it("change avec le poivre, donc le poivre doit être le même partout", () => {
    expect(empreinte("+2250700000000", "a")).not.toBe(
      empreinte("+2250700000000", "b"),
    );
  });

  it("ne rend pas le numéro lisible, sans prétendre l'anonymiser", () => {
    // Ce n'est pas de l'anonymisation : un numéro vit dans un espace minuscule,
    // et quiconque tient le poivre en dresse la table complète. Ce qu'elle
    // fait, c'est qu'une copie de base prise sans le poivre ne livre pas un
    // annuaire.
    const e = empreinte("+2250700000000", POIVRE);

    expect(e).not.toContain("2250700000000");
    expect(e).not.toContain("0700000000");
  });

  it("tient dans une URL sans échappement", () => {
    // `base64url` et non `base64` : l'empreinte finit dans des clés, des
    // chemins et des paramètres, et un « + » ou un « / » y devient autre chose.
    expect(empreinte("+2250700000000", POIVRE)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hérite du refus de la normalisation", () => {
    expect(() => empreinte("0700000000", POIVRE)).toThrow(/E\.164/);
  });
});
