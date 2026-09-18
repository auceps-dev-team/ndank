import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ErreurFournisseur,
  SignatureInvalide,
  type Demande,
  type Http,
  type Requete,
} from "../port";
import { bictorys, lireHorodatage, verifierBictorys } from "./bictorys";

/**
 * Ce que ces tests couvrent, et ce qu'ils ne couvrent pas.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE BAC À SABLE FAIT LE RESTE
 *
 * `npm run bac-a-sable-bictorys` a couru contre la vraie API le 14 septembre
 * 2026 : dix-huit vérifications, zéro échec. Les corps rejoués ici en sont
 * recopiés.
 *
 * Ce fichier couvre donc ce que le bac à sable **ne peut pas** atteindre : les
 * chemins d'erreur, les états qu'aucune charge de test n'a produits, et les
 * décisions de traduction. Pas les mêmes choses deux fois.
 */

function fauxHttp(reponses: Array<{ statut?: number; corps: unknown }>) {
  const vues: Requete[] = [];
  let i = 0;

  const http: Http = async (requete) => {
    vues.push(requete);
    const r = reponses[i++] ?? { corps: {} };
    return {
      statut: r.statut ?? 200,
      corps: typeof r.corps === "string" ? r.corps : JSON.stringify(r.corps),
    };
  };

  return { http, vues };
}

// Inventées. Seul le préfixe `test_` compte pour le garde-fou.
const PUBLIQUE = "test_public-0000-0000.aaaa";
const PRIVEE = "test_secret-0000-0000.bbbb";
const SECRET = "secret-de-webhook";

const CONFIG = {
  clePublique: PUBLIQUE,
  clePrivee: PRIVEE,
  secretWebhook: SECRET,
};

const DEMANDE: Demande = {
  reference: "20260914-1-abonnement7",
  montant: 2000,
  devise: "XOF",
  libelle: "Pass Créateur",
  abonne: {
    nom: "Awa",
    courriel: "awa@ndank.test",
    telephone: "+2250718350482",
  },
  retour: "https://exemple.ci/ndank/retour",
};

/** Recopié de la réponse réelle à `POST /pay/v1/charges`. */
const CHARGE_202 = {
  type: "CheckoutLinkObject",
  link: "https://pay.test.bictorys.com/payment/v1/checkout?charge_id=dcb0b0f9&op_token=x",
  chargeId: "dcb0b0f9-1d3f-4ce9-a419-7b34d8f63e04",
  opToken: "0gRmM7nLvsprksyUCKpLreRYq4c1fxtq",
};

// ══════════════════════════════════════════════════════════════════════════

describe("bictorys — le garde-fou de démarrage", () => {
  it("refuse des clés sans préfixe de test", () => {
    expect(() =>
      bictorys({ ...CONFIG, clePublique: "public-x", clePrivee: "secret-x" }),
    ).toThrow(ErreurFournisseur);
  });

  it("refuse aussi quand une seule des deux est de production", () => {
    expect(() => bictorys({ ...CONFIG, clePrivee: "secret-x" })).toThrow(
      ErreurFournisseur,
    );
  });

  it("accepte quand la production est assumée", () => {
    expect(
      bictorys({
        ...CONFIG,
        clePublique: "public-x",
        clePrivee: "secret-x",
        production: true,
      }).nom,
    ).toBe("bictorys");
  });
});

describe("bictorys — inviter", () => {
  it("omet `payment_type`, et reçoit donc un lien hébergé", async () => {
    const { http, vues } = fauxHttp([{ statut: 202, corps: CHARGE_202 }]);

    const invitation = await bictorys({ ...CONFIG, http }).inviter(DEMANDE);
    const envoye = JSON.parse(vues[0]!.corps as string) as Record<string, unknown>;

    // Le piège documenté par `afrotools` : `payment_type` est un paramètre
    // d'URL. En le posant, on choisirait l'opérateur à la place de l'abonné.
    expect(vues[0]!.url).not.toContain("payment_type");

    expect(envoye["amount"]).toBe(2000);
    expect(envoye["paymentReference"]).toBe("20260914-1-abonnement7");
    expect(invitation.url).toBe(CHARGE_202.link);
    expect(invitation.identifiantFournisseur).toBe(CHARGE_202.chargeId);
  });

  it("emploie la clé publique pour créer, jamais la privée", async () => {
    const { http, vues } = fauxHttp([{ statut: 202, corps: CHARGE_202 }]);
    await bictorys({ ...CONFIG, http }).inviter(DEMANDE);

    expect(vues[0]!.entetes?.["X-Api-Key"]).toBe(PUBLIQUE);
  });

  it("traite aussi le paiement direct, qui rend 201 et une autre forme", async () => {
    const { http } = fauxHttp([
      {
        statut: 201,
        corps: {
          transactionId: "aaaa-bbbb",
          redirectUrl: "https://pay.test.bictorys.com/direct/aaaa",
        },
      },
    ]);

    const invitation = await bictorys({ ...CONFIG, http }).inviter(DEMANDE);

    expect(invitation.url).toBe("https://pay.test.bictorys.com/direct/aaaa");
    expect(invitation.identifiantFournisseur).toBe("aaaa-bbbb");
  });

  it("lève plutôt que de rendre une invitation sans lien", async () => {
    const { http } = fauxHttp([{ statut: 202, corps: { chargeId: "x" } }]);

    await expect(
      bictorys({ ...CONFIG, http }).inviter(DEMANDE),
    ).rejects.toThrow(/aucun lien/i);
  });

  it("déduit le pays de l'indicatif, parce que le champ est obligatoire", async () => {
    for (const [tel, pays] of [
      ["+2250718350482", "CI"],
      ["+221784001288", "SN"],
      ["+237690000000", "CM"],
      ["+999000000000", "SN"], // inconnu → le marché principal
    ] as const) {
      const { http, vues } = fauxHttp([{ statut: 202, corps: CHARGE_202 }]);
      await bictorys({ ...CONFIG, http }).inviter({
        ...DEMANDE,
        abonne: { ...DEMANDE.abonne, telephone: tel },
      });

      const envoye = JSON.parse(vues[0]!.corps as string) as Record<string, unknown>;
      const client = envoye["customerObject"] as Record<string, unknown>;
      expect(client["country"]).toBe(pays);
    }
  });

  /**
   * Mesuré par `afrotools` en production : un `403` avec un corps HTML vient du
   * pare-feu applicatif d'AWS, pas de Bictorys. Sans cette traduction, on
   * cherche une erreur d'autorisation là où il faut simplement ralentir.
   */
  it("distingue le pare-feu d'un refus d'autorisation", async () => {
    const { http } = fauxHttp([
      { statut: 403, corps: "<html><body>Forbidden</body></html>" },
    ]);

    await expect(
      bictorys({ ...CONFIG, http }).inviter(DEMANDE),
    ).rejects.toThrow(/pare-feu|débit/i);
  });
});

describe("bictorys — constater", () => {
  it("va droit au but avec l'identifiant, et emploie la clé privée", async () => {
    const { http, vues } = fauxHttp([
      { corps: { id: "dcb0b0f9", status: "succeeded", amount: 2000, currency: "XOF" } },
    ]);

    const issue = await bictorys({ ...CONFIG, http }).constater(
      DEMANDE.reference,
      "dcb0b0f9",
    );

    expect(vues[0]!.url).toContain("/transactions/dcb0b0f9/status");
    expect(vues[0]!.entetes?.["X-Api-Key"]).toBe(PRIVEE);
    expect(issue.etat).toBe("REUSSI");
    expect(issue.montant).toBe(2000);
  });

  /**
   * Mesuré : le bac à sable rend `{"id": null, "status": "pending"}`. Propager
   * ce `null` ferait perdre le fil d'une transaction qu'on vient de nommer.
   */
  it("reprend l'identifiant demandé quand Bictorys rend `id: null`", async () => {
    const { http } = fauxHttp([{ corps: { id: null, status: "pending" } }]);

    const issue = await bictorys({ ...CONFIG, http }).constater(
      DEMANDE.reference,
      "dcb0b0f9",
    );

    expect(issue.identifiantFournisseur).toBe("dcb0b0f9");
  });

  it("balaie la liste quand aucun identifiant n'est donné", async () => {
    const { http, vues } = fauxHttp([
      {
        corps: [
          { paymentReference: "un-autre", status: "succeeded" },
          {
            paymentReference: DEMANDE.reference,
            status: "succeeded",
            amount: 2000,
            currency: "XOF",
            id: "trouve",
          },
        ],
      },
    ]);

    const issue = await bictorys({ ...CONFIG, http }).constater(DEMANDE.reference);

    expect(vues[0]!.url).toContain("/pay/v1/transactions");
    expect(issue.identifiantFournisseur).toBe("trouve");
    expect(issue.etat).toBe("REUSSI");
  });

  /**
   * Trouvé par un vrai paiement, le 14 septembre 2026, et par rien d'autre.
   *
   * `/status` rend `{id, status}` et rien de plus — ni montant ni horodatage.
   * Un `REUSSI` en sortirait donc avec `montant: 0`.
   *
   * Ce commentaire ajoutait, jusqu'à la 0.24.4, que « `reconcilier` achète du
   * temps avec ce montant ». C'était faux : `reconcilier` refuse un montant nul
   * depuis la 0.3.0 et rend un `INCIDENT`. L'abonné qui a payé n'est donc pas
   * ignoré — il est **refusé**, ce qui est plus visible et tout aussi cassé.
   */
  it("complète par la liste un succès rendu sans montant", async () => {
    const { http, vues } = fauxHttp([
      // la route d'état, minimale, telle qu'elle répond vraiment
      { corps: { id: "aa8aeb74", status: "succeeded" } },
      // la liste, qui porte tout
      {
        corps: [
          {
            id: "aa8aeb74",
            paymentReference: "20260914-1-abonnement7",
            status: "succeeded",
            amount: 100,
            currency: "XOF",
            timestamp: "2026-09-14 22:39:53.823",
          },
        ],
      },
    ]);

    const issue = await bictorys({ ...CONFIG, http }).constater(
      DEMANDE.reference,
      "aa8aeb74",
    );

    expect(vues).toHaveLength(2);
    expect(issue.etat).toBe("REUSSI");
    expect(issue.montant).toBe(100);
    expect(issue.regleLe?.toISOString()).toBe("2026-09-14T22:39:53.823Z");
  });

  it("ne va pas chercher la liste quand l'état suffit", async () => {
    const { http, vues } = fauxHttp([
      { corps: { id: "x", status: "succeeded", amount: 2000, currency: "XOF" } },
    ]);

    await bictorys({ ...CONFIG, http }).constater(DEMANDE.reference, "x");
    expect(vues).toHaveLength(1);
  });

  it("ne va pas chercher la liste quand rien n'est conclu", async () => {
    const { http, vues } = fauxHttp([{ corps: { id: null, status: "pending" } }]);

    await bictorys({ ...CONFIG, http }).constater(DEMANDE.reference, "x");
    expect(vues).toHaveLength(1);
  });

  it("rend EN_ATTENTE quand il ne trouve rien, jamais ECHOUE", async () => {
    const { http } = fauxHttp([{ corps: [] }]);

    const issue = await bictorys({ ...CONFIG, http }).constater(DEMANDE.reference);

    expect(issue.etat).toBe("EN_ATTENTE");
    expect(issue.regleLe).toBeNull();
  });

  /**
   * Leur documentation prévient que cette route rend `500` par intermittence en
   * bac à sable. La levée doit remonter : l'appelant traite un fournisseur
   * injoignable comme une attente. La traduire en `ECHOUE` couperait l'accès de
   * quelqu'un qui a peut-être payé.
   */
  it("laisse remonter un 500 plutôt que de conclure à l'échec", async () => {
    const { http } = fauxHttp([{ statut: 500, corps: { details: "boom" } }]);

    await expect(
      bictorys({ ...CONFIG, http }).constater(DEMANDE.reference, "x"),
    ).rejects.toThrow(ErreurFournisseur);
  });
});

describe("bictorys — les états", () => {
  const cas: Array<[string, string]> = [
    ["succeeded", "REUSSI"],
    ["pending", "EN_ATTENTE"],
    ["processing", "EN_ATTENTE"],
    ["failed", "ECHOUE"],
    ["cancelled", "ECHOUE"],
    ["expired", "EXPIRE"],
    ["quelque chose de neuf", "INCONNU"],
  ];

  for (const [chez, chezNous] of cas) {
    it(`traduit « ${chez} » en ${chezNous}`, async () => {
      const { http } = fauxHttp([{ corps: { id: "x", status: chez } }]);
      const issue = await bictorys({ ...CONFIG, http }).constater("r", "x");
      expect(issue.etat).toBe(chezNous);
    });
  }

  /**
   * Les fonds sont réservés, pas capturés. Ouvrir un accès sur une réservation
   * qui peut se relâcher est une perte sèche.
   */
  it("ne conclut pas au succès sur des fonds seulement réservés", async () => {
    const { http } = fauxHttp([{ corps: { id: "x", status: "authorized" } }]);
    const issue = await bictorys({ ...CONFIG, http }).constater("r", "x");

    expect(issue.etat).toBe("EN_ATTENTE");
    expect(issue.regleLe).toBeNull();
  });

  /**
   * Le cas manquait : il tombait dans `INCONNU`, donc on ne concluait rien
   * d'une charge pourtant close. Trouvé en relisant la documentation
   * officielle, qui donne le seuil : deux heures d'attente et la transaction
   * est expirée d'office.
   */
  it("conclut sur une charge expirée plutôt que de rester perplexe", async () => {
    const { http } = fauxHttp([{ corps: { id: "x", status: "expired" } }]);
    const issue = await bictorys({ ...CONFIG, http }).constater("r", "x");

    expect(issue.etat).toBe("EXPIRE");
    expect(issue.regleLe).toBeNull();
  });

  it("ne prend pas un paiement repris pour un paiement", async () => {
    const { http } = fauxHttp([{ corps: { id: "x", status: "reversed" } }]);
    expect((await bictorys({ ...CONFIG, http }).constater("r", "x")).etat).toBe(
      "ECHOUE",
    );
  });

  it("lit le payé et non le net : les frais ne regardent pas l'abonné", async () => {
    const { http } = fauxHttp([
      {
        corps: {
          id: "x",
          status: "succeeded",
          amount: 2000,
          settledAmount: 1942,
          currency: "XOF",
        },
      },
    ]);

    expect((await bictorys({ ...CONFIG, http }).constater("r", "x")).montant).toBe(
      2000,
    );
  });
});

describe("bictorys — le webhook", () => {
  const corps = JSON.stringify({
    id: "1111",
    paymentReference: "20260914-1-abonnement7",
    status: "succeeded",
    amount: 2000,
    currency: "XOF",
    timestamp: "2026-09-14 18:45:44.10254",
  });

  const signer = (horodatage: string, contenu = corps, secret = SECRET) => ({
    "x-webhook-signature": createHmac("sha256", secret)
      .update(`${horodatage}.${contenu}`, "utf8")
      .digest("hex"),
    "x-webhook-timestamp": horodatage,
  });

  it("lit un événement signé", () => {
    const issue = bictorys(CONFIG).lireWebhook(corps, signer(String(Date.now())));

    expect(issue?.etat).toBe("REUSSI");
    expect(issue?.reference).toBe("20260914-1-abonnement7");
    expect(issue?.regleLe?.toISOString()).toBe("2026-09-14T18:45:44.102Z");
  });

  it("refuse un corps modifié en route", () => {
    const h = String(Date.now());
    expect(() =>
      bictorys(CONFIG).lireWebhook(
        corps.replace('"amount":2000', '"amount":200000'),
        signer(h),
      ),
    ).toThrow(SignatureInvalide);
  });

  /**
   * Le seul des cinq fournisseurs du dépôt à protéger du rejeu.
   *
   * Sans cette borne, un webhook capté une fois se rejouerait indéfiniment — et
   * chaque rejeu prolongerait un abonnement. `dejaCompte` l'attraperait en
   * aval ; mieux vaut ne pas y arriver.
   */
  it("refuse un événement rejoué au-delà de cinq minutes", () => {
    const vieux = String(Date.now() - 6 * 60 * 1000);
    expect(() => bictorys(CONFIG).lireWebhook(corps, signer(vieux))).toThrow(
      SignatureInvalide,
    );
  });

  it("refuse aussi un horodatage venu du futur", () => {
    const futur = String(Date.now() + 10 * 60 * 1000);
    expect(() => bictorys(CONFIG).lireWebhook(corps, signer(futur))).toThrow(
      SignatureInvalide,
    );
  });

  it("refuse un horodatage illisible", () => {
    expect(() =>
      bictorys(CONFIG).lireWebhook(corps, {
        "x-webhook-signature": "peu importe",
        "x-webhook-timestamp": "hier",
      }),
    ).toThrow(SignatureInvalide);
  });

  it("accepte le repli par secret partagé, faute de mieux", () => {
    expect(
      bictorys(CONFIG).lireWebhook(corps, { "x-secret-key": SECRET })?.etat,
    ).toBe("REUSSI");
  });

  it("refuse un secret partagé qui n'est pas le bon", () => {
    expect(() =>
      bictorys(CONFIG).lireWebhook(corps, { "x-secret-key": "autre" }),
    ).toThrow(SignatureInvalide);
  });

  it("refuse quand aucune preuve n'accompagne l'événement", () => {
    expect(() => bictorys(CONFIG).lireWebhook(corps, {})).toThrow(
      SignatureInvalide,
    );
  });

  it("ignore poliment un événement qui ne porte pas notre référence", () => {
    const autre = JSON.stringify({ id: "x", type: "refund", status: "succeeded" });
    expect(
      bictorys(CONFIG).lireWebhook(autre, { "x-secret-key": SECRET }),
    ).toBeNull();
  });
});

describe("lireHorodatage", () => {
  /**
   * Le piège n'est pas que la chaîne soit illisible — `new Date()` l'accepte.
   * C'est qu'il l'interprète en heure **locale du serveur**, faute de fuseau.
   */
  it("lit en UTC une date sans fuseau, et non en heure du serveur", () => {
    expect(lireHorodatage("2026-08-08 18:45:44.10254")?.toISOString()).toBe(
      "2026-08-08T18:45:44.102Z",
    );
  });

  it("ne décale pas une seconde fois ce qui porte déjà un fuseau", () => {
    expect(lireHorodatage("2026-08-08T18:45:44.102Z")?.toISOString()).toBe(
      "2026-08-08T18:45:44.102Z",
    );
    expect(lireHorodatage("2026-08-08T20:45:44.102+02:00")?.toISOString()).toBe(
      "2026-08-08T18:45:44.102Z",
    );
  });

  it("rend null sur ce qui n'est pas une date", () => {
    expect(lireHorodatage(undefined)).toBeNull();
    expect(lireHorodatage("")).toBeNull();
    expect(lireHorodatage("pas une date")).toBeNull();
  });
});

describe("verifierBictorys", () => {
  it("refuse quand le secret est vide plutôt que de comparer du vide à du vide", () => {
    expect(verifierBictorys("x", { "x-secret-key": "" }, "")).toBe(false);
  });

  it("ne se laisse pas piéger par une signature de mauvaise longueur", () => {
    expect(
      verifierBictorys("x", {
        "x-webhook-signature": "court",
        "x-webhook-timestamp": String(Date.now()),
      }, SECRET),
    ).toBe(false);
  });
});
