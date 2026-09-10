# lomi. — ce que le bac à sable a répondu

**Statut : éprouvé contre l'API réelle, le 10 septembre 2026.**
Compte `auceps-digita`, environnement `test`, clé `lomi_sk_test_…`.

Tout ce qui suit a été **mesuré**, pas lu. Quand la documentation et l'API se
contredisent, c'est l'API qui est rapportée ici, et la contradiction est notée.

lomi. est un PSP ouest-africain. Il nous intéresse à deux titres : comme
candidat `Encaissement` (Wave, MTN, Orange, carte, en XOF), et comme **porte
d'entrée vers π-SPI** — leur modèle de webhook porte déjà des champs
`supports_spi` et `spi_event_types`. Le bac à sable de la BCEAO, lui, est
injoignable : `sandbox.api.pi-bceao.com` et `sandbox.api.pi-spi.bceao.int`
n'ouvrent même pas de connexion.

---

## Ce que lomi. confirme, et qui vaut plus que le reste

Leur documentation d'exploitation, écrite par des gens qui font tourner ces
rails en production :

> « Mobile money does not expose a saved off-session token like cards. When no
> card payment method exists, lomi. **does not auto-debit** the wallet. […]
> This matches how async mobile-money rails work in production (PIN approval,
> **no standing mandate**). **It is intentional, not a missing card feature.** »

C'est le postulat de Ndank, confirmé par un tiers qui n'avait aucune raison de
nous faire plaisir. Et leur solution de repli est notre conception, trait pour
trait : **crons de notification → lien de renouvellement hébergé → webhook de
confirmation → traitement du retard** (`past_due`, `paused`, `cancelled`).

À savoir, en contrepartie : **lomi. a donc déjà un produit d'abonnement** qui
recouvre une partie de Ndank. Ce n'est pas un adversaire technique, c'est un
fait de marché à connaître.

---

## Les unités : `DECIMALES_LOMI = 0`

> « Integer amount in the smallest currency unit. For `XOF`, `5000` means
> 5 000 XOF. »

Vraies unités mineures ISO 4217. Mesuré : `amount: 2000` envoyé, `2000` relu.
`versFournisseur` est l'identité pour le XOF — **aucune conversion**.

**Et cela contredit leur propre SDK π-SPI**, dont le README annonce des
centimes (`1 500 XOF → 150000`). Deux conventions dans la même maison. C'est
exactement pourquoi `devise.ts` existe.

| Fournisseur | `decimalesFournisseur` |
|---|---|
| Flutterwave | `0` |
| Paystack | `2` |
| π-SPI (d'après lomi.) | `2` |
| **lomi.** | **`0`** — mesuré |

---

## Les trois routes qui pourraient porter `inviter`

Aucune ne fait les trois choses à la fois. C'est la trouvaille structurante.

| Route | URL pour l'abonné | Idempotente | Durée de vie |
|---|---|---|---|
| `POST /payment-requests` | **✗** — `payment_link: null` | ✓ | `expiry_date`, choisie |
| `POST /checkout-sessions` | ✓ | ✓ | **60 min, figée** |
| `POST /payment-links` | ✓ | **✗** | `expires_at`, choisie |

### La session meurt en 60 minutes

Documenté (« Sessions expire after **60 minutes** by default ») et mesuré :
créée à 10:33, `expires_at` à 11:33.

**C'est incompatible avec Ndank.** Une relance part par SMS et se lit le
lendemain matin. Un abonné qui ouvre le lien à 8 h trouve une page morte, et
conclut que le service ne marche pas. La session est faite pour un tunnel
d'achat ouvert dans l'instant, pas pour une échéance.

### Le lien durable ne respecte pas l'idempotence

`POST /payment-links` accepte `expires_at` : mesuré à `2026-11-16`, soit toute
la fenêtre de reprise. C'est ce qu'il nous faut.

Mais **trois appels avec la même `Idempotency-Key` et le même corps ont créé
trois liens distincts** :

```
6344f3dd-d3b7-408d-a82e-601199142716
679ea515-2152-4a92-a035-190cbc5ddd7c
c878b294-25fa-481f-b144-17d3fe720a75
```

Aucun `Idempotency-Cache-Hit`. Sur `POST /payment-requests`, le même en-tête
**fonctionne** : même `request_id` rendu, `Idempotency-Cache-Hit: true`. Le
même en-tête, exigé sur les deux routes, honoré sur une seule — et c'est
l'autre dont nous avons besoin.

Détail qui compte : **`Idempotency-Key` est obligatoire**. Sans lui, `400
idempotency_key_required`. La documentation le présente pourtant comme
facultatif (« *send an idempotency key when your flow supports it* »).

---

## Trois endroits où le port de Ndank ne colle pas

Ce sont les vraies trouvailles de l'intégration. Elles ne concernent pas
l'adaptateur : elles touchent le **port**.

### 1. Le port suppose que la référence suffit à ne pas dupliquer

`src/encaissement/port.ts`, sur `Demande.reference` :

> « Un passage rejoué produit donc la même référence, et le fournisseur
> **reconnaît la demande au lieu d'en créer une seconde**. »

**Faux pour `POST /payment-links`.** Mesuré trois fois. Un `inviter` rejoué
après une coupure réseau produirait deux liens pour le même cycle.

*Sortie possible* : lister les liens avant d'en créer un, et retenir celui qui
porte déjà `metadata.ndank_reference`. Mais voir le point 3.

### 2. `constater(reference)` n'est pas implémentable

Le port donne :

```ts
constater(reference: string): Promise<Issue>
```

lomi. ne retrouve un objet que par **son propre UUID** :

```
GET /payment-requests/20261010-1-testndank6365   → 404 not found
GET /payment-requests/c599f357-19e7-…            → 200, payment_reference intacte
```

Et `GET /transactions` ne filtre ni par référence ni par métadonnée — ses
paramètres sont `isPos`, `startDate`, `endDate`, `page`, `pageSize`,
`paymentMethod`, `currency`, `type`, `status`, `provider`.

Il n'existe donc **aucun chemin** de notre référence vers l'état d'un paiement,
sinon un balayage paginé de toutes les transactions.

`Invitation.identifiantFournisseur` existe précisément pour retenir l'identifiant
du fournisseur — mais `constater` ne le reçoit pas. Flutterwave et Paystack
savent chercher par référence marchande ; lomi. non. **C'est le port qui a
présumé, pas l'adaptateur qui manque.**

### 3. Le filtre par métadonnée est ignoré

```
GET /payment-links?metadata[ndank_reference]=…   → les 3 liens, sans filtrer
GET /payment-links?search=testndank6365          → les 3 liens, sans filtrer
```

La sortie du point 1 coûte donc un listage complet, paginé, à chaque `inviter`.

---

## Les webhooks

### La signature couvre le corps

```js
crypto.createHmac('sha256', secret).update(payload).digest('hex')
```

En-tête `X-Lomi-Signature`, secret `whsec_…`, comparaison en temps constant.
C'est une **vraie signature liante** — contrairement au `verif-hash` de
Flutterwave, qui est un secret partagé et laisse passer un corps réécrit (voir
`signature.ts`, 0.20.3).

**Mais le secret n'est pas exposé par l'API.** L'objet webhook ne le porte ni à
la création ni à la relecture — vérifié champ par champ. Le marchand doit le
recopier depuis le tableau de bord. À prévoir dans la configuration de Ndank.

### L'enveloppe d'un événement

Relue dans `last_payload` après un déclenchement réel :

```json
{ "id": "evt_test_…",
  "data": { "object": { "id": "obj_test_…", "amount": 1000,
                        "currency": "XOF", "status": "success",
                        "metadata": { … } } } }
```

Un seul événement par livraison — pas un lot, contrairement à π-SPI.

### Ce qui ne marche pas

- **`GET /webhooks/deliveries` rend `500 internal_error`.** Route documentée,
  cassée. Les journaux de livraison sont donc inaccessibles ; seul
  `last_payload` sur l'objet webhook renseigne, et il n'garde que le dernier.
- Quand la destination répond mal, lomi. **recopie son corps brut dans l'erreur
  d'API**. Une page HTML entière nous est revenue dans un `bad_request`.
- `retry_count` monte : lomi. réessaie. Bonne nouvelle.
- Pas d'événement d'expiration de session : « There is **no** separate
  `checkout.session.*` event ». Il faut interroger.

---

## Deux points de sécurité à remonter à lomi.

### `GET /api-keys` rend toutes les clés en clair

Appelée avec la clé secrète, cette route a rendu **les trois clés de
l'organisation en texte clair**, y compris une clé antérieure. Une clé secrète
compromise ne donne donc pas seulement ses propres droits : elle livre tout le
trousseau, et la rotation d'une seule clé ne suffit pas à refermer.

### Le nom d'hôte « sandbox » n'isole rien

Mesuré : un objet créé contre `sandbox.api.lomi.africa` est visible sur
`api.lomi.africa`, avec le même identifiant.

**C'est la clé qui décide de l'environnement, pas l'hôte.** `GET /me` le dit
(`"environment":"test"`), et les écritures faites avec `lomi_sk_test_…`
ressortent bien en `"environment":"test"`.

Corollaire dangereux : une clé **sans** segment `test_`/`live_` (format non
documenté, mais qui existe) écrit en `live` même quand on appelle l'hôte
`sandbox`. Et la liste ne filtre pas : **une clé de test lit les objets de
production.**

Pour Ndank, cela donne la règle du garde-fou, la même que pour Flutterwave :
**regarder la clé, jamais l'URL.**

---

## Ce qui reste à éprouver

- [ ] **Un paiement réel de bout en bout.** `GET /providers` est vide : aucun
      opérateur n'est raccordé sur ce compte. Il faut en activer un dans le
      tableau de bord avant de pouvoir payer un lien.
- [ ] **La vérification de signature contre une vraie livraison**, une fois le
      secret `whsec_` récupéré au tableau de bord.
- [ ] **Le rejeu d'un webhook** — deux fois le même événement ne doit prolonger
      qu'une fois. C'est `dejaCompte` qui répond, mais il faut le voir.

---

## Traces laissées dans le bac à sable

À nettoyer si besoin, tout est en `environment: test` :

| Objet | Identifiant |
|---|---|
| demande de paiement | `c599f357-19e7-4e98-9115-08369d7bc06a` |
| sessions de tunnel | `ed106a48-…`, `5b4a27d8-…` |
| liens de paiement | `6344f3dd-…`, `679ea515-…`, `c878b294-…` |
| webhook actif | `f1dfbd67-…` → `ndank.auceps-digital.agency` (404 à chaque envoi) |
| client créé d'office | `09fc0a82-…` (`+2250718350482`, pays `CI` déduit) |

Un objet reste en `environment: live` : la demande de paiement
`09fd2d9e-0a0c-4513-8d56-4e9fffa8a5ec`, créée avant que le mode test ne soit
disponible. Elle est `pending`, sans lien et sans client — elle ne peut rien
débiter. lomi. n'expose pas de route de suppression pour cet objet.

---

# Ce que l'API expose réellement

Balayage des 132 routes documentées, avec la clé `lomi_sk_test_…`, le
10 septembre 2026. **36 routes de lecture sur 42 répondent.**

## Le mur : aucun canal de paiement n'est ouvert

C'est le fait qui commande tout le reste. Les bascules grisées du tableau de
bord ne sont pas un défaut d'affichage : **l'API refuse pour la même raison.**

```
POST /charge/wave  → 400  « Wave provider not configured for this
                            organization (missing Aggregated Merchant ID) »
POST /charge/mtn   → 400  « MTN provider is not connected for this organization »
POST /charge/card  → 503  « Card payments are temporarily unavailable »
GET  /providers    → 200  liste vide
```

Et **il n'existe aucune route pour y remédier.** Sur 132 routes, pas un
`POST /providers`, pas un `PATCH`, pas de `/settings/channels`. Le raccordement
d'un canal est un acte que lomi. pose du côté de son propre système —
identification du marchand, obtention d'un *Aggregated Merchant ID* chez Wave.
C'est une démarche commerciale, pas une case à cocher.

**Conséquence pratique : aucun paiement ne peut aboutir aujourd'hui, même en
test.** Le bac à sable de lomi. marque pourtant les paiements MTN `completed`
sans appeler MTN, et crédite le solde de test dès la création chez Wave — donc
le jour où un canal s'ouvre, la boucle complète sera éprouvable en quelques
minutes.

**Ce qu'il faut demander à lomi.** : le raccordement d'au moins un canal sur
l'organisation `auceps-digita`. Wave ou MTN suffit.

## Six routes documentées rendent `500`

| Route | |
|---|---|
| `GET /invoices` | `internal_error` |
| `GET /payout-methods` | `internal_error` |
| `GET /usage/entitlements` | `internal_error` |
| `GET /usage/revenue` | `internal_error` |
| `GET /webhooks/deliveries` | `internal_error` |
| `POST /customers/{id}/portal` | `internal_error` |

La dernière est celle du **portail client** — connexion par lien magique ou code
SMS, exactement le terrain de notre `code.ts`. Elle est hors service.

## La grille tarifaire, et pourquoi elle change la donne

Relevée dans le tableau de bord, `Facturation → Frais de transaction` :

| Méthode | Frais |
|---|---|
| **Instant payment (PI-SPI)** | **1,5 %** |
| Point of Sale | 1,5 % |
| **Mobile Money** | **2,9 % + 200 F CFA** |
| GIM-UEMOA cards | 3,15 % + 250 F |
| Cartes | 4,5 % + 250 F |
| BNPL | 8 % + 500 F |

Et dans « Autres frais » : **paiements d'abonnement 0,5 %**, remboursement total
gratuit, *chargeback* 10 000 F.

**Sur un abonnement à 2 000 F :**

| | Frais | Part du montant |
|---|---|---|
| Mobile Money | 58 + 200 = **258 F** | **12,9 %** |
| PI-SPI | **30 F** | 1,5 % |

Le forfait de 200 F est ce qui tue les petits montants. C'est l'argument
économique de π-SPI pour Ndank, et il est plus fort que l'argument technique :
**un abonnement de 2 000 F par mobile money laisse 12,9 % sur la table.**

À vérifier auprès de lomi. : si les 0,5 % « subscription payments » remplacent
les frais de canal ou s'y ajoutent. La grille ne le dit pas, et l'écart entre
les deux lectures est considérable.

## SPI chez lomi. : hébergé seulement

> « Direct vs hosted : **Hosted only** »
> « Use hosted checkout or payment links. SPI-specific UX (operator selection,
> USSD, app redirect) is handled on the hosted page. »

Pas de charge directe. SPI n'apparaît que sur la page de paiement hébergée, où
l'abonné choisit son opérateur, l'USSD ou son application.

**Cela convient à Ndank sans rien changer** : nous envoyons déjà un lien, et
c'est la page de lomi. qui porte le choix de l'opérateur. Le lien de paiement
durable est donc bien la bonne route pour `inviter`, quel que soit le canal
derrière.

Note : les versements SPI ne sont pas encore en service — « SPI beneficiary
payouts are ledger-only **until SPI execution ships** ».

## Le recouvrement avec Ndank, chiffré

Réglages lus dans `GET /settings/checkout` :

```
renewal_days_before      : 3
renewal_max_attempts     : 3
payment_link_duration    : 1        ← en jours
customer_notifications   : courriel ✓ , whatsapp ✗ (partout)
```

L'échelle de lomi. est donc : **J-3, J-1, J0, trois courriels au maximum, un
seul canal.** Celle de Ndank est plus longue, va au-delà de l'échéance, et
passe par SMS, courriel et push.

Deux choses à en retenir :

- **`payment_link_duration: 1`** — un lien vit **un jour** par défaut. Notre
  `expires_at` explicite l'écrase (mesuré : 16 novembre), mais un adaptateur
  qui l'oublierait produirait des liens morts le lendemain.
- **WhatsApp existe comme canal chez eux** (`whatsapp: false` partout, mais le
  champ est là). Ndank n'a pas ce barreau.

## Ce qui marche, et qui suffit à construire

Tout ce qui **décrit et prépare** répond : clients, produits, liens de
paiement, demandes de paiement, sessions, abonnements (lecture), webhooks,
réglages, finance, transactions, organisations, équipe, clés.

Seul l'**encaissement** est fermé. C'est un mur d'exploitation, pas un mur
d'intégration : l'adaptateur peut s'écrire et se tester contre tout le reste.
