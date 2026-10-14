# Eval samples

Each sample is a scanned card crop (`<id>.jpg`) plus `<id>.json` with the correct label:

```json
{ "id": "…", "label": { "title": "Counterspell", "printingId": "<scryfall or JustTCG id>", "game": "Magic: The Gathering" }, "app": { …the app's response when saved… } }
```

Collect them in development with **Save as test sample** under a scan result, then run
`npx tsx scripts/eval.ts` (see the script header for options). Samples are git-ignored by default.
