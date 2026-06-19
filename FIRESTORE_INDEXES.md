# Firestore Composite Indexes

This file documents all composite indexes required by Kreddlo's backend functions.
If a query fails with a "missing index" error, Firebase will print a direct link
in the server logs to auto-create the index — click it and it provisions in minutes.

---

## Required Composite Index — Auto-Approval Query

Used by: `netlify/functions/scheduled-subscriptions.js`

| Field       | Collection | Order |
|-------------|------------|-------|
| `status`    | projects   | ASC   |
| `deliveredAt` | projects | ASC   |

**Query scope:** Collection

### How to create manually

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project → **Firestore Database** → **Indexes** tab
3. Click **Composite** → **Add Index**
4. Set:
   - Collection ID: `projects`
   - Field 1: `status` — Ascending
   - Field 2: `deliveredAt` — Ascending
   - Query scope: **Collection**
5. Click **Create** and wait ~1–2 minutes for it to build

### How to create via Firebase CLI

Add the following to `firestore.indexes.json` (create it if it doesn't exist):

```json
{
  "indexes": [
    {
      "collectionGroup": "projects",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status",      "order": "ASCENDING" },
        { "fieldPath": "deliveredAt", "order": "ASCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

Then deploy:

```bash
firebase deploy --only firestore:indexes
```

---

## Required Composite Index — Browse Freelancers Query

Used by: `browse.html` (Freelancers tab)

| Field        | Collection | Order |
|--------------|------------|-------|
| `role`       | users      | ASC   |
| `kycStatus`  | users      | ASC   |

**Query scope:** Collection

```json
{
  "collectionGroup": "users",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "role",      "order": "ASCENDING" },
    { "fieldPath": "kycStatus", "order": "ASCENDING" }
  ]
}
```

Note: `browse.html` now falls back to a role-only query and filters
`kycStatus` client-side if this index is missing or still building, so the
page will not silently show "no freelancers found" — but creating this index
is still recommended for performance once you have many users.

## Required Composite Index — Browse / Store Products Query

Used by: `browse.html` (Products tab) and `store.html`

| Field    | Collection | Order |
|----------|------------|-------|
| `uid`    | products   | ASC   |
| `status` | products   | ASC   |

(`browse.html`'s Products tab only filters on `status`, which is single-field
and always indexed automatically; the `uid` + `status` compound index is
needed for `store.html`, which filters a single seller's products by status.)

```json
{
  "collectionGroup": "products",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "uid",    "order": "ASCENDING" },
    { "fieldPath": "status", "order": "ASCENDING" }
  ]
}
```

Note: both `browse.html` and `store.html` fall back to an unfiltered/partial
fetch with client-side filtering if this index is missing, so a product that
exists will not incorrectly show as "not found" — but creating this index is
still recommended for performance.

## Symptom if index is missing

The `scheduled-subscriptions` function will log an error like:

```
scheduled-subscriptions: delivery query failed (may need composite index): 9 FAILED_PRECONDITION: ...
```

Firebase will also print a URL in the same log line that you can click to
auto-create the index directly from the console.

---

## Required Composite Index — Product Earnings Clearing Query

Used by: `netlify/functions/scheduled-clear-earnings.js` (Item 9 — earnings holding period)

| Field      | Collection       | Order |
|------------|------------------|-------|
| `cleared`  | product-earnings | ASC   |
| `clearsAt` | product-earnings | ASC   |

**Query scope:** Collection

```json
{
  "collectionGroup": "product-earnings",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "cleared",  "order": "ASCENDING" },
    { "fieldPath": "clearsAt", "order": "ASCENDING" }
  ]
}
```

## Required Composite Index — Affiliate Earnings Clearing Query

Used by: `netlify/functions/scheduled-clear-earnings.js` (Item 9 — earnings holding period)

| Field      | Collection         | Order |
|------------|---------------------|-------|
| `cleared`  | affiliate-earnings | ASC   |
| `clearsAt` | affiliate-earnings | ASC   |

**Query scope:** Collection

```json
{
  "collectionGroup": "affiliate-earnings",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "cleared",  "order": "ASCENDING" },
    { "fieldPath": "clearsAt", "order": "ASCENDING" }
  ]
}
```

Note: if either of these indexes is missing, `scheduled-clear-earnings.js`
logs the error and simply skips that half of the job on that run (non-fatal
to the other one) — it will catch up automatically once the index finishes
building, since `clearsAt` only ever moves further into the past for
already-existing unfulfilled records.
