# Drama Eval Report — test-run-2026-05-10

| Field | Value |
| --- | --- |
| Started | 2026-05-10T12:00:00.000Z |
| Completed | 2026-05-10T12:15:00.000Z |
| Model | gemini-2.5-flash |
| Profiles | v1, v2 |
| Transcripts | rbb-hiring |
| Prod profile | v1 |

## Promotion Criteria

A profile may replace the production prompt iff, across ≥3 trials per transcript:

- Tier match in ≥ 67% of trials (`minTierMatchFraction = 2/3`)
- Total category MAE ≤ prod profile MAE (`maeComparator = <=prod`)
- Zero empty-output trials (`maxEmptyOutputs = 0`)
- No drift events crossing the off-the-rails boundary (`maxOffTheRailsBoundaryDrift = 0`)

## Cells

| Profile | Transcript | GT Tier | Tier Mode | Tier Range | σ | MAE | Drift | OTR Drift | Empty | Tier Match | Trials | Promote? |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | :---: | :---: | :---: |
| v1 | rbb-hiring | Off the Rails | Off the Rails | Off the Rails | 0.00 | 0.00 | 0 | 0 | 0 | 3/3 | 3/3 | ✓ |
| v2 | rbb-hiring | Off the Rails | Heated | Bumpy–Off the Rails | 3.09 | 4.50 | 1 | 1 | 0 | 1/3 | 3/3 | ✗ |
