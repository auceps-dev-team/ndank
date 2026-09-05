import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ErreurFournisseur, SignatureInvalide, type Demande, type Http, type Requete } from "../port";
import { decouperNumero, flutterwave } from "./flutterwave";
import { paystack } from "./paystack";
import { mtn, uuidDeterministe } from "./mtn";

/**
 * Éprouver un flux d'encaissement complet sans compte marchand.
 *
 * C'est ce que `Http` en port rend possible, et c'est la raison pour laquelle
 * il est un port. Ouvrir un compte marchand Orange prend des semaines ; on ne
 * demande pas cela à quelqu'un qui veut essayer une bibliothèque.
 */

/** Un faux transport qui enregistre ce qu'on lui demande et rejoue des réponses. */
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

const DEMANDE: Demande = {
  reference: "2026-02-09",
  montant: 2000,
  devise: "XOF",
  libelle: "Pass Créateur",
  abonne: {
    nom: "Awa",
    courriel: "awa@ndank.test",
    telephone: "+2250700000000",
  },
  retour: "https://exemple.ci/ndank/retour",
};

// ───────────────────────────────────────────────────────── flutterwave ──

describe("Flutterwave", () => {
  it("découpe un numéro international en indicatif et numéro national", () => {
    // Du plus long au plus court : `225` doit gagner sur `22`, sinon on
    // couperait au mauvais endroit et le fournisseur refuserait sans dire pourquoi.
    expect(decouperNumero("+225 07 00 00 00 00")).toEqual({
      indicatif: "225",
      numero: "0700000000",
    });
    expect(decouperNumero("+233240000000")?.indicatif).toBe("233");
    expect(decouperNumero("12")).toBeNull();
  });

  it("charge en un seul appel, et transmet notre référence en `tx_ref`", async () => {
    // La v3 fait d'un coup ce que la v4 demandait en trois — client, moyen de
    // paiement, charge. Sur un passage de cinq cents abonnés, c'est mille
    // allers-retours de moins.
    const f = fauxHttp([
      {
        corps: {
          status: "success",
          message: "Charge initiated",
          data: { id: 10472878, tx_ref: "2026-02-09", status: "pending" },
          meta: {
            authorization: {
              mode: "redirect",
              redirect_url: "https://ravesandboxapi.flutterwave.com/…",
            },
          },
        },
      },
    ]);

    const invitation = await flutterwave({
      cleSecrete: "FLWSECK_TEST-essai",
      secretWebhook: "h",
      http: f.http,
    }).inviter(DEMANDE);

    expect(f.vues).toHaveLength(1);
    expect(f.vues[0]!.url).toBe(
      "https://api.flutterwave.com/v3/charges?type=mobile_money_franco",
    );

    const corps = JSON.parse(f.vues[0]!.corps!);

    // `tx_ref` est notre clé de cycle : rejouer le passage retombe dessus, et
    // Flutterwave refuse le doublon au lieu d'ouvrir une seconde charge.
    expect(corps.tx_ref).toBe("2026-02-09");

    // Le numéro part sans indicatif, le pays à côté — c'est ce que la v3 veut.
    expect(corps.phone_number).toBe("0700000000");
    expect(corps.country).toBe("CI");

    // Unités majeures, mesurées le 5 septembre 2026 : `amount: 2000` en XOF a
    // produit `charged_amount: 2000` et `app_fee: 40`, soit 2 % de deux mille
    // francs. Une lecture en unités mineures aurait donné une commission de
    // 0,4.
    expect(corps.amount).toBe(2000);
    expect(corps.currency).toBe("XOF");

    expect(invitation.etat).toBe("EN_ATTENTE");
    expect(invitation.url).toContain("ravesandboxapi");
    expect(invitation.identifiantFournisseur).toBe("10472878");
  });

  it("réclame le réseau au Ghana, et nulle part ailleurs", async () => {
    // Le seul marché où la v3 l'exige, et il ne se déduit pas du préfixe : la
    // portabilité y est effective, donc un 024 n'est plus forcément MTN.
    const f = fauxHttp([{ corps: { status: "success", data: {}, meta: {} } }]);

    await flutterwave({
      cleSecrete: "FLWSECK_TEST-essai",
      secretWebhook: "h",
      reseauGhana: "VODAFONE",
      http: f.http,
    }).inviter({
      ...DEMANDE,
      devise: "GHS",
      abonne: { ...DEMANDE.abonne, telephone: "+233200000000" },
    });

    expect(f.vues[0]!.url).toContain("type=mobile_money_ghana");
    expect(JSON.parse(f.vues[0]!.corps!).network).toBe("VODAFONE");
  });

  it("traite un 200 qui dit `status: error` comme un refus", async () => {
    // La v3 répond 200 sur des refus. Ne regarder que le code HTTP ferait
    // prendre un refus pour une charge ouverte — et l'abonné attendrait une
    // invite qui ne viendra jamais.
    const f = fauxHttp([
      { corps: { status: "error", message: "Invalid phone number" } },
    ]);

    await expect(
      flutterwave({
        cleSecrete: "FLWSECK_TEST-essai",
        secretWebhook: "h",
        http: f.http,
      }).inviter(DEMANDE),
    ).rejects.toThrow(/Invalid phone number/);
  });

  it("refuse de démarrer sur une clé de production non assumée", async () => {
    // La v3 n'a qu'une seule adresse : c'est le préfixe de la clé qui décide
    // si l'on éprouve ou si l'on débite. Une clé recopiée du mauvais onglet
    // prélèverait de l'argent réel sans qu'aucune configuration ne change
    // d'apparence.
    expect(() =>
      flutterwave({ cleSecrete: "FLWSECK-vraie", secretWebhook: "h" }),
    ).toThrow(/n'est pas une clé de test/);

    // Assumée, elle passe.
    expect(() =>
      flutterwave({
        cleSecrete: "FLWSECK-vraie",
        secretWebhook: "h",
        production: true,
      }),
    ).not.toThrow();
  });

  it("refuse tôt quand la devise ne peut pas correspondre au moyen de paiement", async () => {
    // Leur règle : « the charge currency must match the currency_code used when
    // creating the payment method ». Un numéro ivoirien paie en XOF ; laisser
    // partir un abonnement en GHS ferait échouer au troisième appel, avec un
    // message qui ne nomme pas la vraie cause.
    const f = fauxHttp([]);

    await expect(
      flutterwave({ cleSecrete: "FLWSECK_TEST-essai", secretWebhook: "h", http: f.http }).inviter({
        ...DEMANDE,
        devise: "GHS",
      }),
    ).rejects.toThrow(/XOF/);

    // Et surtout : rien n'est parti.
    expect(f.vues).toHaveLength(0);
  });

  it("refuse un abonné sans numéro, en le disant", async () => {
    const f = fauxHttp([]);
    await expect(
      flutterwave({ cleSecrete: "FLWSECK_TEST-essai", secretWebhook: "h", http: f.http }).inviter({
        ...DEMANDE,
        abonne: { ...DEMANDE.abonne, telephone: null },
      }),
    ).rejects.toThrow(/numéro/);
  });

  it("lit un webhook signé et le ramène à une issue", async () => {
    const secret = "h";
    const corps = JSON.stringify({
      type: "charge.completed",
      data: {
        id: "chg_1",
        reference: "2026-02-09",
        status: "succeeded",
        amount: 2000,
        currency: "XOF",
      },
    });
    const signature = createHmac("sha256", secret).update(corps, "utf8").digest("hex");

    const issue = flutterwave({
      cleSecrete: "FLWSECK_TEST-essai",
      secretWebhook: secret,
      http: fauxHttp([]).http,
    }).lireWebhook(corps, { "flutterwave-signature": signature });

    expect(issue).not.toBeNull();
    expect(issue!.etat).toBe("REUSSI");
    expect(issue!.montant).toBe(2000);
    expect(issue!.devise).toBe("XOF");
  });

  it("lève sur une signature invalide, plutôt que d'ignorer poliment", () => {
    // Ignorer serait pire que lever : un webhook non signé qui n'ouvre rien
    // ressemble à un webhook perdu, et personne n'irait voir.
    expect(() =>
      flutterwave({
        cleSecrete: "FLWSECK_TEST-essai",
        secretWebhook: "h",
        http: fauxHttp([]).http,
      }).lireWebhook("{}", { "flutterwave-signature": "0".repeat(64) }),
    ).toThrow(SignatureInvalide);
  });

  it("ignore un événement signé qui ne parle pas d'une charge", () => {
    const secret = "h";
    const corps = JSON.stringify({ type: "transfer.completed", data: {} });
    const signature = createHmac("sha256", secret).update(corps, "utf8").digest("hex");

    expect(
      flutterwave({
        cleSecrete: "FLWSECK_TEST-essai",
        secretWebhook: secret,
        http: fauxHttp([]).http,
      }).lireWebhook(corps, { "flutterwave-signature": signature }),
    ).toBeNull();
  });

  it("ne conclut pas à l'échec sur un statut qu'il ne connaît pas", async () => {
    // Traiter un état inconnu comme un échec couperait l'accès de quelqu'un qui
    // a peut-être payé.
    const f = fauxHttp([
      { corps: { access_token: "jwt-de-test", expires_in: 600 } },
      { corps: { data: { status: "quelque_chose_de_neuf" } } },
    ]);

    const issue = await flutterwave({
      cleSecrete: "FLWSECK_TEST-essai",
      secretWebhook: "h",
      http: f.http,
    }).constater("2026-02-09");

    expect(issue.etat).toBe("INCONNU");
  });
});

// ──────────────────────────────────────────────────────────── paystack ──

describe("Paystack", () => {
  it("initialise en un appel et rend l'URL d'autorisation", async () => {
    const f = fauxHttp([
      {
        corps: {
          status: true,
          data: {
            authorization_url: "https://checkout.paystack.com/abc",
            access_code: "abc",
            reference: "2026-02-09",
          },
        },
      },
    ]);

    const invitation = await paystack({ cleSecrete: "sk", http: f.http }).inviter(DEMANDE);

    expect(f.vues).toHaveLength(1);
    const envoye = JSON.parse(f.vues[0]!.corps!);
    expect(envoye.reference).toBe("2026-02-09");
    // On ne propose que le mobile money par défaut : c'est la raison d'être de Ndank.
    expect(envoye.channels).toEqual(["mobile_money"]);
    expect(envoye.callback_url).toBe(DEMANDE.retour);

    expect(invitation.url).toBe("https://checkout.paystack.com/abc");
    expect(invitation.etat).toBe("EN_ATTENTE");
  });

  it("laisse ajouter la carte, pour un hôte qui la veut aussi", async () => {
    const f = fauxHttp([{ corps: { status: true, data: {} } }]);
    await paystack({
      cleSecrete: "sk",
      canaux: ["mobile_money", "card"],
      http: f.http,
    }).inviter(DEMANDE);

    expect(JSON.parse(f.vues[0]!.corps!).channels).toEqual(["mobile_money", "card"]);
  });

  it("traite un 200 avec status:false comme un refus", async () => {
    // Paystack porte l'échec dans le corps autant que dans le statut HTTP. Le
    // lire comme un succès ferait ouvrir un accès sur une transaction inexistante.
    const f = fauxHttp([
      { statut: 200, corps: { status: false, message: "Invalid key" } },
    ]);

    await expect(
      paystack({ cleSecrete: "sk", http: f.http }).inviter(DEMANDE),
    ).rejects.toThrow(ErreurFournisseur);
  });

  it("refuse un abonné sans courriel, parce que Paystack identifie par là", async () => {
    const f = fauxHttp([]);
    await expect(
      paystack({ cleSecrete: "sk", http: f.http }).inviter({
        ...DEMANDE,
        abonne: { ...DEMANDE.abonne, courriel: null },
      }),
    ).rejects.toThrow(/courriel/);
    expect(f.vues).toHaveLength(0);
  });

  it("constate en relisant montant et devise, pas seulement le statut", async () => {
    const f = fauxHttp([
      {
        corps: {
          status: true,
          data: {
            id: 12345,
            reference: "2026-02-09",
            status: "success",
            // Ce que Paystack rapporte pour deux mille francs : des centièmes,
            // quelle que soit la devise. Relevé dans leur tableau de bord —
            // `amount: 2000` s'y affiche « XOF 20.00 ».
            amount: 200_000,
            currency: "XOF",
            paid_at: "2026-02-09T10:00:00.000Z",
          },
        },
      },
    ]);

    const issue = await paystack({ cleSecrete: "sk", http: f.http }).constater("2026-02-09");

    expect(f.vues[0]!.url).toContain("/transaction/verify/2026-02-09");
    expect(issue.etat).toBe("REUSSI");
    // Ramené à l'unité de Ndank : deux mille francs, et non deux cent mille.
    expect(issue.montant).toBe(2000);
    expect(issue.devise).toBe("XOF");
    expect(issue.regleLe?.toISOString()).toBe("2026-02-09T10:00:00.000Z");
  });

  it("multiplie par cent avant d'envoyer, sinon l'abonné paie vingt francs", async () => {
    // Le défaut que le bac à sable a trouvé. Ndank compte en unités mineures
    // ISO — `2000` vaut deux mille francs — mais Paystack applique deux
    // décimales à tout. Sans conversion, un abonnement à 2 000 F prélevait
    // vingt francs : une erreur qui va dans le sens de l'abonné, donc que
    // personne ne signale, et que le marchand découvre sur son relevé.
    const f = fauxHttp([
      {
        corps: {
          status: true,
          data: { authorization_url: "https://checkout.paystack.com/x", access_code: "x", reference: "r" },
        },
      },
    ]);

    await paystack({ cleSecrete: "sk", http: f.http }).inviter(DEMANDE);

    const envoye = JSON.parse(f.vues[0]!.corps!) as { amount: number; currency: string };
    expect(envoye.currency).toBe("XOF");
    expect(envoye.amount).toBe(200_000);
  });

  it("reformule le refus de devise, qui parle du compte et non de la requête", async () => {
    // « Currency not supported by merchant » : rien dans la phrase ne dit que
    // c'est le compte marchand qui n'active pas cette devise. On cherche donc
    // du côté du code envoyé.
    const f = fauxHttp([
      { statut: 403, corps: { status: false, message: "Currency not supported by merchant" } },
    ]);

    await expect(
      paystack({ cleSecrete: "sk", http: f.http }).inviter(DEMANDE),
    ).rejects.toThrow(/compte marchand/);
  });

  it("lit « abandoned » comme EN_ATTENTE, et surtout pas comme EXPIRE", async () => {
    // Relevé du bac à sable, trois secondes après l'initialisation :
    //
    //   status "abandoned", gateway_response "The transaction was not
    //   completed", paid_at null
    //
    // Paystack marque `abandoned` dès qu'une transaction existe et n'est pas
    // réglée — donc pendant tout le temps où l'abonné est en train de payer.
    //
    // Le traduire en EXPIRE faisait annoncer « la demande a expiré avant que
    // vous ne la validiez » cinq secondes après le clic sur « Régler », alors
    // que l'abonné saisissait son code sur l'écran du fournisseur.
    const f = fauxHttp([
      {
        corps: {
          status: true,
          data: {
            id: 1,
            reference: "20260209-1-ab-1",
            status: "abandoned",
            gateway_response: "The transaction was not completed",
            amount: 200_000,
            currency: "XOF",
            paid_at: null,
          },
        },
      },
    ]);

    const issue = await paystack({ cleSecrete: "sk", http: f.http }).constater(
      "20260209-1-ab-1",
    );

    expect(issue.etat).toBe("EN_ATTENTE");
    expect(issue.regleLe).toBeNull();
  });

  it("lit un webhook signé, et ignore les événements qui ne sont pas des charges", () => {
    const cle = "sk_test";
    const adaptateur = paystack({ cleSecrete: cle, http: fauxHttp([]).http });

    const charge = JSON.stringify({
      event: "charge.success",
      data: { reference: "2026-02-09", status: "success", amount: 200_000, currency: "XOF" },
    });
    const sigCharge = createHmac("sha512", cle).update(charge, "utf8").digest("hex");
    expect(adaptateur.lireWebhook(charge, { "x-paystack-signature": sigCharge })!.etat).toBe(
      "REUSSI",
    );

    const litige = JSON.stringify({ event: "charge.dispute.create", data: {} });
    const sigLitige = createHmac("sha512", cle).update(litige, "utf8").digest("hex");
    expect(adaptateur.lireWebhook(litige, { "x-paystack-signature": sigLitige })).toBeNull();

    const virement = JSON.stringify({ event: "transfer.success", data: {} });
    const sigVirement = createHmac("sha512", cle).update(virement, "utf8").digest("hex");
    expect(adaptateur.lireWebhook(virement, { "x-paystack-signature": sigVirement })).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── mtn ──

describe("MTN MoMo", () => {
  it("dérive un UUID stable de la clé de cycle", async () => {
    // MTN veut un UUID et le traite comme clé d'idempotence ; Ndank a une clé
    // de cycle qui est une date. Les faire correspondre par un hachage garde
    // les deux propriétés — sans quoi rejouer un passage enverrait une seconde
    // demande de paiement au même abonné.
    const a = await uuidDeterministe("mtn:2026-02-09");
    const b = await uuidDeterministe("mtn:2026-02-09");
    const autre = await uuidDeterministe("mtn:2026-03-11");

    expect(a).toBe(b);
    expect(a).not.toBe(autre);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("prend un jeton, puis demande le paiement, et accepte le 202", async () => {
    const f = fauxHttp([
      { corps: { access_token: "jeton", expires_in: 3600 } },
      { statut: 202, corps: "" },
    ]);

    const invitation = await mtn({
      utilisateurApi: "u",
      cleApi: "k",
      cleAbonnement: "s",
      environnement: "sandbox",
      http: f.http,
    }).inviter(DEMANDE);

    expect(f.vues[0]!.url).toContain("/collection/token/");
    expect(f.vues[0]!.entetes["Authorization"]).toMatch(/^Basic /);

    const paiement = f.vues[1]!;
    expect(paiement.url).toContain("/requesttopay");
    expect(paiement.entetes["Authorization"]).toBe("Bearer jeton");
    expect(paiement.entetes["X-Target-Environment"]).toBe("sandbox");
    // La clé d'idempotence, dérivée de notre référence.
    expect(paiement.entetes["X-Reference-Id"]).toBe(
      await uuidDeterministe("mtn:2026-02-09"),
    );
    expect(JSON.parse(paiement.corps!).externalId).toBe("2026-02-09");

    // Aucune page : la demande apparaît sur le téléphone.
    expect(invitation.url).toBeNull();
    expect(invitation.instruction).toContain("+2250700000000");
    expect(invitation.etat).toBe("EN_ATTENTE");
  });

  it("ne redemande pas un jeton tant que le précédent vaut", async () => {
    // Un passage qui relance trois cents abonnés ne doit pas demander trois
    // cents jetons.
    const f = fauxHttp([
      { corps: { access_token: "jeton", expires_in: 3600 } },
      { statut: 202, corps: "" },
      { statut: 202, corps: "" },
    ]);

    const adaptateur = mtn({
      utilisateurApi: "u",
      cleApi: "k",
      cleAbonnement: "s",
      environnement: "sandbox",
      http: f.http,
    });

    await adaptateur.inviter(DEMANDE);
    await adaptateur.inviter({ ...DEMANDE, reference: "2026-03-11" });

    expect(f.vues.filter((r) => r.url.includes("/token/"))).toHaveLength(1);
  });

  it("rend INCONNU sur un rappel, parce qu'un rappel MTN n'est pas signé", () => {
    // On n'en tire qu'une référence. Conclure « payé » sur un corps que
    // n'importe qui peut poster reviendrait à offrir l'accès à qui connaît l'URL.
    const issue = mtn({
      utilisateurApi: "u",
      cleApi: "k",
      cleAbonnement: "s",
      environnement: "sandbox",
      http: fauxHttp([]).http,
    }).lireWebhook(
      JSON.stringify({ externalId: "2026-02-09", status: "SUCCESSFUL", amount: "2000" }),
      // Aucun en-tête : c'est précisément le sujet. MTN n'en envoie pas.
      {},
    );

    expect(issue).not.toBeNull();
    expect(issue!.reference).toBe("2026-02-09");
    // Surtout pas REUSSI, malgré ce que le corps prétend.
    expect(issue!.etat).toBe("INCONNU");
  });

  it("constate par un appel authentifié, lui", async () => {
    const f = fauxHttp([
      { corps: { access_token: "jeton", expires_in: 3600 } },
      { corps: { status: "SUCCESSFUL", amount: "2000", currency: "XOF" } },
    ]);

    const issue = await mtn({
      utilisateurApi: "u",
      cleApi: "k",
      cleAbonnement: "s",
      environnement: "sandbox",
      http: f.http,
    }).constater("2026-02-09");

    expect(f.vues[1]!.entetes["Authorization"]).toBe("Bearer jeton");
    expect(issue.etat).toBe("REUSSI");
    expect(issue.montant).toBe(2000);
  });
});
