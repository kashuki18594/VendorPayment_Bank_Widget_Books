# Widget persistence — Catalyst `appstate`

The widget no longer uses `localStorage`. All three stores are kept in Catalyst:

| Key (widget) | Shape | Written when |
|---|---|---|
| `indusindPaymentStatus` | `{ [paymentId]: { state, label, statusDesc, ... } }` | any payment submit / status enquiry (draft + manual) |
| `indusindManualPayments` | `[ { id, custRefNo, tranType, amount, benName, benIFSC, benAcctNo, ... } ]` | manual payment submitted |
| `bankFilterSettings` | `{ maker, authorizer, bank }` | Settings card Apply / Reset |

## Where the code lives

Integrated into the existing function
`project-rainfall/function_17717000000242010/index.js`
(routes `GET /appstate` and `POST /appstate`, plus `findAppStateRow` helper).
**Deployed** to the Development environment.

```
GET  {fn-url}/appstate?key=<key>          -> 200 { "key": "<key>", "value": <stored JSON | null> }
POST {fn-url}/appstate  { key, value }    -> 200 { "key": "<key>", "saved": true }   (value:null clears)
```

`{fn-url}` = `https://project-rainfall-60040525184.development.catalystserverless.in/server/project_rainfall_function`

## Remaining one-time step — create the Data Store table

The function cannot create tables; do this once in the **Catalyst console**:

**project-rainfall → Data Store → New Table**

| Column | Type | Notes |
|---|---|---|
| `StateKey` | Varchar (255) | tick **Unique** and **Mandatory** |
| `StateValue` | Text | max size; holds a JSON string |

Table name: `AppState` (`ROWID` is added automatically).

Until the table exists the endpoint returns
`{"status":"error","message":"No such Table with the given name exists."}`
and the widget just starts with empty state.

## Verify

```bash
BASE=https://project-rainfall-60040525184.development.catalystserverless.in/server/project_rainfall_function
curl -s "$BASE/appstate?key=bankFilterSettings"
# after the table exists -> {"key":"bankFilterSettings","value":null}

curl -s -X POST "$BASE/appstate" -H "Content-Type: application/json" \
  -d '{"key":"bankFilterSettings","value":{"maker":"NAS002","authorizer":"SAN006","bank":"200003169036"}}'
curl -s "$BASE/appstate?key=bankFilterSettings"
```

## Redeploy after code changes

```bash
cd project-rainfall
catalyst deploy --only functions
```

## Notes

- Store is org-wide (one project = one org here). Writes replace the whole blob,
  so two people editing at the same time can overwrite each other — fine at this volume.
- `ZFAPPS.request` proxies server-side, so no CSP / `whiteListedDomains` change is
  needed in `plugin-manifest.json` (same as the existing Catalyst calls).
- Moving to Production: `catalyst deploy --only functions --production`, then change
  `CATALYST_BASE_URL` (and the existing payment/enquiry URLs) in `app/widget.html`
  from `.development.` to `.production.`.

---

# Paid payments — Catalyst NoSQL (`paidpayments`)

A second, separate store for the **Paid** workflow in both tabs. Deliberately
**not** part of `AppState` above — every row here is written only when a user
explicitly marks a payment Paid, and Catalyst deletes each row on its own
**~1 day** after it's written (native NoSQL table TTL — no cron job needed).

| Field | Type | Notes |
|---|---|---|
| `Source` | String | Partition key — `"draft"` or `"manual"` |
| `PaymentId` | String | Sort key — the Zoho payment_id (draft) or manual record id |
| `PaymentNumber` | String | display only |
| `VendorName` | String | display only |
| `Amount` | String | display only |
| `UTR` | String | bank UTR, if the status enquiry returned one |
| `PaidAt` | String | ISO timestamp, when marked Paid |
| `ExpireAt` | Number | epoch **seconds** = PaidAt + 86400 — the TTL attribute |

## One-time step — create the NoSQL table

Not creatable from code or the CLI (no `nosql` CLI command exists). Do this once
in the **Catalyst console**:

**project-rainfall → NoSQL → Create Table**

1. Table name: `PaidPayments`
2. Partition key: `Source` — type **String**
3. Sort key: `PaymentId` — type **String**
4. Enable **TTL** (may be labelled "Time To Live" / "Auto Expiry") → TTL attribute: `ExpireAt`
5. Create.

⚠️ **Verify the TTL unit** when you enable it — the code writes epoch
**seconds** (`Math.floor(Date.now() / 1000) + 86400`), matching DynamoDB-style
TTL, which is the common convention. If the console says the TTL attribute
expects **milliseconds** instead, change that one line in
`project-rainfall/function_17717000000242010/index.js` (`POST /paidpayments`)
to `Date.now() + PAID_TTL_SECONDS * 1000`, then redeploy.

TTL sweeps are periodic, not instant — an expired row can take a while (up to
a few hours, sometimes) to actually disappear; that's normal.

## Endpoints

```
POST /paidpayments          { source, paymentId, paymentNumber, vendorName, amount, utr }
                             -> { status: "success", source, paymentId, paidAt, expireAt }
                             (upsert — calling it again for the same source+paymentId just refreshes it)

GET  /paidpayments?source=  -> { status: "success", source, items: [...] }

POST /paidpayments/delete   { source, paymentId }
                             -> { status: "success", source, paymentId, deleted: true }
```

## Verify

```bash
BASE=https://project-rainfall-60040525184.development.catalystserverless.in/server/project_rainfall_function

curl -s "$BASE/paidpayments?source=draft"
# before the table exists -> {"status":"error","message":"No such table with the given id exists"}
# after                    -> {"status":"success","source":"draft","items":[]}

curl -s -X POST "$BASE/paidpayments" -H "Content-Type: application/json" \
  -d '{"source":"draft","paymentId":"TEST123","paymentNumber":"PMT-1","vendorName":"Test Vendor","amount":"1000","utr":"UTR12345"}'

curl -s "$BASE/paidpayments?source=draft"
# -> should list the TEST123 row

curl -s -X POST "$BASE/paidpayments/delete" -H "Content-Type: application/json" \
  -d '{"source":"draft","paymentId":"TEST123"}'
```

## What the widget does with it

- **Books Draft Payments tab**: once a row's bank status is `success`, a
  **Mark Paid** button appears in place of the Pay/Submitted button. Clicking
  it (after a confirm) appends a note to the Zoho Books vendor payment's
  **Description** (`Paid via IndusInd Bank — UTR: <utr> on <date>`; existing
  description is kept, never overwritten) — best-effort, a failure there is
  toasted but does **not** block the Catalyst write — then writes the
  `PaidPayments` row. The row then shows a green **✓ Paid** badge instead of
  a button. If you revisit after the ~1 day TTL has cleared that row, the
  badge/button state just reverts to whatever the bank status still says.
- **Manual Payment tab**: same Mark Paid button on `success` rows, **Catalyst
  only** (no Books record exists for a manual payment). Once Paid, the row
  shows **✓ Paid** + a **Delete** button that removes that `PaidPayments` row
  immediately (`POST /paidpayments/delete`) instead of waiting for the TTL.
