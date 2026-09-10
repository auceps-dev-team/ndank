import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ErreurFournisseur,
  SignatureInvalide,
  type Demande,
  type Http,
  type Requete,
} from "../port";
import { lomi, verifierLomi } from "./lomi";

/**
 * Les fausses réponses de ce fichier ne sont pas inventées.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CETTE PRÉCISION IMPORTE
 *
 * La leçon de la semaine est qu'un test contre un faux qu'on a écrit soi-même
 * ne peut pas contredire son auteur. Trois adaptateurs de ce dépôt ont passé
 * des centaines de tests avant qu'un vrai compte ne montre qu'ils se trompaient
 * de convention, d'API, ou de chemin.
 *
 * Ici, les corps rejoués sont **recopiés de vraies réponses**, obtenues le
 * 10 septembre 2026 contre `sandbox.api.lomi.africa`. Ce qu'ils vérifient,
 * c'est donc que l'adaptateur lit correctement ce que lomi. envoie réellement —
 * pas ce que je crois qu'il envoie.
 *
 * Ce qui reste non éprouvé est écrit dans `docs/lomi.md` : aucun canal de
 * paiement n'est raccordé au compte, donc aucun paiement n'a pu aboutir.
 */

function fauxHttp(reponses: Array<{ statut?: number; corps: unknown }>) {
  const vues: Requete[] = [];
  let i = 0;

  const http: Http = async (requete) => {
    vues.push(requete);
    const r = reponses[i++] ?? { corps: { data: [] } };
    return {
      statut: r.statut ?? 200,
      corps: typeof r.corps === "string" ? r.corps : JSON.stringify(r.corps),
    };
  };

  return { http, vues };
}

// Inventée de toutes pièces. Seul le préfixe `_test_` compte ici : c'est lui
// que le garde-fou de démarrage inspecte.
const CLE = "lomi_sk_test_0000000000000000000000000000000000000000";
const SECRET = "whsec_essai";

const DEMANDE: Demande = {
  reference: "20261010-1-abonnement7",
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

/** Recopié de la réponse à `POST /payment-links`. */
const LIEN = {
  link_id: "6344f3dd-d3b7-408d-a82e-601199142716",
  link_type: "instant",
  title: "Pass Créateur",
  currency_code: "XOF",
  amount: 2000,
  expires_at: "2026-11-16T23:59:59+00:00",
  is_active: true,
  environment: "test",
  url: "https://pay.lomi.africa/WU5GJKLDWUD7RA",
  metadata: { ndank_reference: "20261010-1-abonnement7" },
};

/** Recopié du modèle `Transaction` de leur documentation. */
const TRANSACTION = {
  transaction_id: "123e4567-e89b-12d3-a456-426614174000",
  gross_amount: 2000,
  fee_amount: 258,
  net_amount: 1742,
  currency_code: "XOF",
  transaction_type: "payment",
  status: "completed",
  provider_code: "WAVE",
  payment_method_code: "MOBILE_MONEY",
  metadata: { ndank_reference: "20261010-1-abonnement7" },
  created_at: "2026-10-10T10:31:04.000Z",
};

// ══════════════════════════════════════════════════════════════════════════

describe("lomi. — le garde-fou de démarrage", () => {
  it("refuse une clé qui ne porte pas le marqueur de test", () => {
    expect(() =>
      lomi({ cleSecrete: "lomi_sk_live_x", secretWebhook: SECRET }),
    ).toThrow(ErreurFournisseur);
  });

  it("accepte cette même clé quand la production est assumée", () => {
    expect(
      lomi({
        cleSecrete: "lomi_sk_live_x",
        secretWebhook: SECRET,
        production: true,
      }).nom,
    ).toBe("lomi");
  });

  /**
   * C'est le cas qui a motivé le garde-fou, et il a été rencontré pour de vrai.
   *
   * Le portail lomi. délivre des clés `lomi_pk_` sans segment `test_` ni
   * `live_` — un format que leur documentation ne décrit pas. Mesuré : une
   * écriture faite avec une telle clé, **contre l'hôte `sandbox`**, est
   * ressortie marquée `"environment":"live"` et visible sur l'hôte de
   * production. Le nom d'hôte n'isole rien ; seule la clé décide.
   */
  it("refuse une clé sans marqueur, celle qui écrit en production sans le dire", () => {
    expect(() =>
      lomi({ cleSecrete: "lomi_pk_aaaaaaaaaaaa", secretWebhook: SECRET }),
    ).toThrow(/environnement/i);
  });
});

describe("lomi. — inviter", () => {
  it("crée un lien durable, et transmet le montant sans le convertir", async () => {
    const { http, vues } = fauxHttp([
      { corps: { object: "list", data: [] } },
      { statut: 201, corps: LIEN },
    ]);

    const invitation = await lomi({
      cleSecrete: CLE,
      secretWebhook: SECRET,
      http,
    }).inviter(DEMANDE);

    const creation = JSON.parse(vues[1]!.corps as string) as Record<string, unknown>;

    // Le XOF n'a pas de décimale et lomi. compte en unités mineures ISO :
    // `versFournisseur` est l'identité. 2 000 F se transmet `2000`.
    expect(creation["amount"]).toBe(2000);
    expect(creation["currency_code"]).toBe("XOF");
    expect(creation["metadata"]).toEqual({
      ndank_reference: "20261010-1-abonnement7",
    });

    // La référence sert aussi de clé d'idempotence — même si lomi. ne
    // l'honore pas sur cette route, la poser coûte zéro et le jour où ils la
    // réparent, la protection devient double.
    expect(vues[1]!.entetes?.["Idempotency-Key"]).toBe(
      "pl-20261010-1-abonnement7",
    );

    expect(invitation.url).toBe("https://pay.lomi.africa/WU5GJKLDWUD7RA");
    expect(invitation.identifiantFournisseur).toBe(LIEN.link_id);
    expect(invitation.expireLe?.toISOString()).toBe("2026-11-16T23:59:59.000Z");
  });

  it("ne demande pas soixante jours quand on lui en demande quarante-cinq", async () => {
    const { http, vues } = fauxHttp([
      { corps: { data: [] } },
      { statut: 201, corps: LIEN },
    ]);

    await lomi({
      cleSecrete: CLE,
      secretWebhook: SECRET,
      joursDeValidite: 45,
      http,
    }).inviter(DEMANDE);

    const creation = JSON.parse(vues[1]!.corps as string) as Record<string, unknown>;
    const dans = Math.round(
      (new Date(creation["expires_at"] as string).getTime() - Date.now()) /
        86_400_000,
    );

    expect(dans).toBe(45);
  });

  /**
   * Le cœur de cet adaptateur.
   *
   * Mesuré trois fois : trois `POST /payment-links` avec la même
   * `Idempotency-Key` et le même corps ont rendu trois liens distincts. Le port
   * suppose pourtant qu'« un passage rejoué produit la même référence, et le
   * fournisseur reconnaît la demande au lieu d'en créer une seconde ».
   *
   * Sans cette recherche préalable, un `inviter` rejoué après une coupure
   * réseau enverrait deux liens à l'abonné pour un seul cycle.
   */
  it("rend le lien déjà créé plutôt que d'en fabriquer un second", async () => {
    const { http, vues } = fauxHttp([
      { corps: { object: "list", data: [LIEN] } },
    ]);

    const invitation = await lomi({
      cleSecrete: CLE,
      secretWebhook: SECRET,
      http,
    }).inviter(DEMANDE);

    expect(invitation.identifiantFournisseur).toBe(LIEN.link_id);

    // Un seul appel : la liste. Aucune création.
    expect(vues).toHaveLength(1);
    expect(vues[0]!.methode).toBe("GET");
  });

  it("ignore un lien expiré et en crée un neuf", async () => {
    const perime = { ...LIEN, expires_at: "2020-01-01T00:00:00+00:00" };
    const { http, vues } = fauxHttp([
      { corps: { data: [perime] } },
      { statut: 201, corps: LIEN },
    ]);

    await lomi({ cleSecrete: CLE, secretWebhook: SECRET, http }).inviter(DEMANDE);

    expect(vues).toHaveLength(2);
    expect(vues[1]!.methode).toBe("POST");
  });

  it("ignore un lien désactivé, et celui d'un autre cycle", async () => {
    const eteint = { ...LIEN, is_active: false };
    const autre = {
      ...LIEN,
      link_id: "autre",
      metadata: { ndank_reference: "20260910-1-abonnement7" },
    };

    const { http, vues } = fauxHttp([
      { corps: { data: [eteint, autre] } },
      { statut: 201, corps: LIEN },
    ]);

    await lomi({ cleSecrete: CLE, secretWebhook: SECRET, http }).inviter(DEMANDE);

    expect(vues).toHaveLength(2);
    expect(vues[1]!.methode).toBe("POST");
  });

  /**
   * Le mur qu'on rencontre en premier chez lomi., et qui n'a rien à voir avec
   * le code. Mesuré : `POST /charge/wave` répond « Wave provider not configured
   * for this organization (missing Aggregated Merchant ID) ».
   */
  it("explique qu'un canal non raccordé ne se répare pas dans le code", async () => {
    const { http } = fauxHttp([
      { corps: { data: [] } },
      {
        statut: 400,
        corps: {
          error: {
            code: "bad_request",
            message:
              "Wave provider not configured for this organization (missing Aggregated Merchant ID)",
          },
        },
      },
    ]);

    await expect(
      lomi({ cleSecrete: CLE, secretWebhook: SECRET, http }).inviter(DEMANDE),
    ).rejects.toThrow(/compte marchand|demander à lomi/i);
  });
});

describe("lomi. — constater", () => {
  it("va droit au but quand l'appelant a retenu l'identifiant", async () => {
    const { http, vues } = fauxHttp([{ corps: TRANSACTION }]);

    const issue = await lomi({
      cleSecrete: CLE,
      secretWebhook: SECRET,
      http,
    }).constater(DEMANDE.reference, TRANSACTION.transaction_id);

    expect(vues).toHaveLength(1);
    expect(vues[0]!.url).toContain(`/transactions/${TRANSACTION.transaction_id}`);
    expect(issue.etat).toBe("REUSSI");
    expect(issue.montant).toBe(2000);
    expect(issue.devise).toBe("XOF");
    expect(issue.regleLe?.toISOString()).toBe("2026-10-10T10:31:04.000Z");
  });

  /**
   * lomi. ne sait pas chercher par notre référence : sa liste de transactions
   * ne filtre ni par référence ni par métadonnée. On balaie donc — mais borné
   * par la date que la référence porte elle-même.
   */
  it("balaie à partir de la date que porte la référence, et pas avant", async () => {
    const { http, vues } = fauxHttp([
      { corps: { data: [TRANSACTION], has_more: false } },
    ]);

    const issue = await lomi({
      cleSecrete: CLE,
      secretWebhook: SECRET,
      http,
    }).constater(DEMANDE.reference);

    expect(vues[0]!.url).toContain("startDate=2026-10-10");
    expect(issue.etat).toBe("REUSSI");
    expect(issue.identifiantFournisseur).toBe(TRANSACTION.transaction_id);
  });

  it("ne s'arrête pas à la première page", async () => {
    const { http, vues } = fauxHttp([
      { corps: { data: [{ metadata: { ndank_reference: "autre" } }], has_more: true } },
      { corps: { data: [TRANSACTION], has_more: false } },
    ]);

    const issue = await lomi({
      cleSecrete: CLE,
      secretWebhook: SECRET,
      http,
    }).constater(DEMANDE.reference);

    expect(vues).toHaveLength(2);
    expect(vues[1]!.url).toContain("page=2");
    expect(issue.etat).toBe("REUSSI");
  });

  /**
   * Ne rien trouver n'est pas un échec.
   *
   * L'abonné n'a peut-être pas encore payé. Rendre `ECHOUE` clorait un cycle
   * qui n'a rien décidé, et couperait un accès sur une absence de nouvelle.
   */
  it("rend EN_ATTENTE quand il ne trouve rien, jamais ECHOUE", async () => {
    const { http } = fauxHttp([{ corps: { data: [], has_more: false } }]);

    const issue = await lomi({
      cleSecrete: CLE,
      secretWebhook: SECRET,
      http,
    }).constater(DEMANDE.reference);

    expect(issue.etat).toBe("EN_ATTENTE");
    expect(issue.regleLe).toBeNull();
  });

  it("borne le balayage plutôt que de tourner sans fin", async () => {
    const page = { corps: { data: [{ metadata: {} }], has_more: true } };
    const { http, vues } = fauxHttp(Array.from({ length: 30 }, () => page));

    await lomi({ cleSecrete: CLE, secretWebhook: SECRET, http }).constater(
      DEMANDE.reference,
    );

    expect(vues.length).toBeLessThanOrEqual(10);
  });
});

describe("lomi. — les états", () => {
  const casDeFigure: Array<[string, string]> = [
    ["completed", "REUSSI"],
    ["pending", "EN_ATTENTE"],
    ["failed", "ECHOUE"],
    ["expired", "EXPIRE"],
    ["quelque chose de neuf", "INCONNU"],
  ];

  for (const [chez, chezNous] of casDeFigure) {
    it(`traduit « ${chez} » en ${chezNous}`, async () => {
      const { http } = fauxHttp([{ corps: { ...TRANSACTION, status: chez } }]);

      const issue = await lomi({
        cleSecrete: CLE,
        secretWebhook: SECRET,
        http,
      }).constater(DEMANDE.reference, "id");

      expect(issue.etat).toBe(chezNous);
    });
  }

  /**
   * `held` est une transaction retenue — contrôle de risque, vérification.
   * L'abonné a payé, mais l'argent n'est pas acquis. Ouvrir un accès sur des
   * fonds qui peuvent être rendus est une perte sèche.
   */
  it("ne conclut pas au succès sur une transaction retenue", async () => {
    const { http } = fauxHttp([{ corps: { ...TRANSACTION, status: "held" } }]);

    const issue = await lomi({
      cleSecrete: CLE,
      secretWebhook: SECRET,
      http,
    }).constater(DEMANDE.reference, "id");

    expect(issue.etat).toBe("EN_ATTENTE");
    expect(issue.regleLe).toBeNull();
  });

  it("ne prend pas un remboursement pour un paiement", async () => {
    const { http } = fauxHttp([{ corps: { ...TRANSACTION, status: "refunded" } }]);

    const issue = await lomi({
      cleSecrete: CLE,
      secretWebhook: SECRET,
      http,
    }).constater(DEMANDE.reference, "id");

    expect(issue.etat).toBe("ECHOUE");
  });

  it("lit le brut et non le net : les frais ne regardent pas l'abonné", async () => {
    const { http } = fauxHttp([{ corps: TRANSACTION }]);

    const issue = await lomi({
      cleSecrete: CLE,
      secretWebhook: SECRET,
      http,
    }).constater(DEMANDE.reference, "id");

    // 2 000 payés, 258 de frais, 1 742 nets. L'abonné s'est acquitté de 2 000.
    expect(issue.montant).toBe(2000);
  });
});

describe("lomi. — le webhook", () => {
  const enveloppe = JSON.stringify({
    id: "evt_test_a5aaa868",
    data: { object: TRANSACTION },
  });

  const signer = (corps: string, secret = SECRET): Record<string, string> => ({
    "x-lomi-signature": createHmac("sha256", secret)
      .update(corps, "utf8")
      .digest("hex"),
  });

  it("lit un événement signé", () => {
    const issue = lomi({
      cleSecrete: CLE,
      secretWebhook: SECRET,
    }).lireWebhook(enveloppe, signer(enveloppe));

    expect(issue?.etat).toBe("REUSSI");
    expect(issue?.reference).toBe("20261010-1-abonnement7");
    expect(issue?.montant).toBe(2000);
  });

  it("refuse une signature fabriquée avec un autre secret", () => {
    expect(() =>
      lomi({ cleSecrete: CLE, secretWebhook: SECRET }).lireWebhook(
        enveloppe,
        signer(enveloppe, "whsec_autre"),
      ),
    ).toThrow(SignatureInvalide);
  });

  /**
   * Le test qui distingue lomi. de Flutterwave.
   *
   * Le 9 septembre 2026, un vrai webhook Flutterwave a été rejoué avec son
   * montant réécrit de 2 000 à 200 000 : la vérification l'a **accepté**, parce
   * que `verif-hash` est un secret partagé qui n'authentifie pas le corps.
   *
   * Ici, un seul octet modifié fait tomber la signature.
   */
  it("refuse un corps modifié en route", () => {
    const altere = enveloppe.replace('"gross_amount":2000', '"gross_amount":200000');
    expect(altere).not.toBe(enveloppe);

    expect(() =>
      lomi({ cleSecrete: CLE, secretWebhook: SECRET }).lireWebhook(
        altere,
        signer(enveloppe),
      ),
    ).toThrow(SignatureInvalide);
  });

  it("refuse une signature absente", () => {
    expect(() =>
      lomi({ cleSecrete: CLE, secretWebhook: SECRET }).lireWebhook(enveloppe, {}),
    ).toThrow(SignatureInvalide);
  });

  it("ignore poliment un événement qui ne porte pas notre référence", () => {
    const autre = JSON.stringify({
      id: "evt_test_x",
      data: { object: { ...TRANSACTION, metadata: { source: "webhook_test" } } },
    });

    expect(
      lomi({ cleSecrete: CLE, secretWebhook: SECRET }).lireWebhook(
        autre,
        signer(autre),
      ),
    ).toBeNull();
  });

  it("lève sur un corps signé mais illisible", () => {
    const cassé = "{ceci n'est pas du JSON";

    expect(() =>
      lomi({ cleSecrete: CLE, secretWebhook: SECRET }).lireWebhook(
        cassé,
        signer(cassé),
      ),
    ).toThrow(ErreurFournisseur);
  });
});

describe("verifierLomi", () => {
  it("ne se laisse pas piéger par une signature de mauvaise longueur", () => {
    // `timingSafeEqual` lève quand les longueurs diffèrent. Laisser remonter
    // cette exception ferait passer une signature tronquée pour une panne.
    expect(verifierLomi("x", { "x-lomi-signature": "court" }, SECRET)).toBe(false);
  });

  it("refuse quand le secret est vide plutôt que de comparer du vide à du vide", () => {
    const corps = "x";
    const vraie = createHmac("sha256", "").update(corps, "utf8").digest("hex");

    expect(verifierLomi(corps, { "x-lomi-signature": vraie }, "")).toBe(false);
  });
});
