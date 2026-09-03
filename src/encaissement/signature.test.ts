import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifierFlutterwave, verifierMtn, verifierPaystack } from "./signature";

/**
 * Ce que ces tests protègent : l'unique endroit où Ndank accepte quelque chose
 * de l'extérieur. Le corps d'un webhook raconte qu'un abonnement vient d'être
 * payé — sans vérification, ouvrir un accès payant se réduit à connaître l'URL.
 */

const CORPS = JSON.stringify({
  event: "charge.success",
  data: { reference: "2026-02-09", amount: 2000, currency: "XOF" },
});

describe("Paystack — HMAC-SHA512 du corps brut", () => {
  const cle = "sk_test_secret";
  const bonne = createHmac("sha512", cle).update(CORPS, "utf8").digest("hex");

  it("accepte une signature juste", () => {
    expect(verifierPaystack(CORPS, bonne, cle)).toBe(true);
  });

  it("refuse une signature fabriquée avec une autre clé", () => {
    const fausse = createHmac("sha512", "sk_autre").update(CORPS, "utf8").digest("hex");
    expect(verifierPaystack(CORPS, fausse, cle)).toBe(false);
  });

  it("refuse quand le corps a changé d'un seul caractère", () => {
    // Le cas qui compte : quelqu'un rejoue un webhook légitime en changeant le
    // montant. La signature ne suit pas.
    const trafique = CORPS.replace('"amount":2000', '"amount":1');
    expect(verifierPaystack(trafique, bonne, cle)).toBe(false);
  });

  it("refuse une signature absente", () => {
    expect(verifierPaystack(CORPS, undefined, cle)).toBe(false);
    expect(verifierPaystack(CORPS, "", cle)).toBe(false);
  });

  it("tolère la casse et les espaces autour de l'en-tête", () => {
    expect(verifierPaystack(CORPS, `  ${bonne.toUpperCase()}  `, cle)).toBe(true);
  });

  it("refuse une signature de la bonne forme mais du mauvais contenu", () => {
    // Même longueur, même alphabet : c'est le cas qu'une comparaison naïve de
    // longueur laisserait passer.
    const memeLongueur = "0".repeat(bonne.length);
    expect(verifierPaystack(CORPS, memeLongueur, cle)).toBe(false);
  });
});

describe("Flutterwave — HMAC-SHA256, et l'ancien en-tête", () => {
  const secret = "mon-secret-webhook";
  const bonne = createHmac("sha256", secret).update(CORPS, "utf8").digest("hex");

  it("accepte la signature moderne", () => {
    expect(
      verifierFlutterwave(CORPS, { "flutterwave-signature": bonne }, secret),
    ).toBe(true);
  });

  it("accepte l'ancien en-tête quand le moderne est absent", () => {
    // Beaucoup de comptes marchands émettent encore `verif-hash`, et un hôte
    // qui migre ne contrôle pas la date de bascule côté fournisseur. Refuser
    // reviendrait à ignorer des paiements réels le jour de la migration.
    expect(verifierFlutterwave(CORPS, { "verif-hash": secret }, secret)).toBe(true);
  });

  it("ne se replie PAS sur l'ancien en-tête quand le moderne est faux", () => {
    // Le test qui compte vraiment. Accepter `verif-hash` en repli d'une
    // signature moderne invalide donnerait à un attaquant le choix de
    // l'algorithme le plus faible.
    expect(
      verifierFlutterwave(
        CORPS,
        { "flutterwave-signature": "0".repeat(64), "verif-hash": secret },
        secret,
      ),
    ).toBe(false);
  });

  it("refuse quand aucun des deux en-têtes n'est là", () => {
    expect(verifierFlutterwave(CORPS, {}, secret)).toBe(false);
  });

  it("refuse un ancien en-tête qui ne vaut pas le secret", () => {
    expect(verifierFlutterwave(CORPS, { "verif-hash": "autre" }, secret)).toBe(false);
  });
});

describe("MTN — rien à vérifier, et c'est le problème", () => {
  it("refuse toujours, parce que les rappels MTN n'arrivent pas signés", () => {
    // Ce n'est pas une lacune de ce module : MTN poste sur l'adresse déclarée
    // sans en-tête d'authenticité. La seule conduite sûre est de traiter le
    // rappel comme un signal et d'aller relire l'état par un appel authentifié.
    expect(verifierMtn()).toBe(false);
  });
});
