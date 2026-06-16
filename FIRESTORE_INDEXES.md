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

## Symptom if index is missing

The `scheduled-subscriptions` function will log an error like:

```
scheduled-subscriptions: delivery query failed (may need composite index): 9 FAILED_PRECONDITION: ...
```

Firebase will also print a URL in the same log line that you can click to
auto-create the index directly from the console.
