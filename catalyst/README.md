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
