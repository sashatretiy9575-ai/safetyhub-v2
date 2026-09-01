# Staged multilingual content batch

This document describes the repository-only RU → KK/EN/ZH localization batch. It is a reproducible offline receipt, not evidence that content has been published to linked Supabase.

## Safety boundary

- Hosted Supabase remains the operational source of truth. Before starting this batch, `npm run content:pull:linked -- --check` returned the catalog checksum `9d34b6b4f106b6886a540e0b67c2f7be27ffa6b1e3e4656013e6192ed39c228a` with no differences.
- The batch contains no users, profiles, attempts, certificates, legal acceptances, sessions, identities, or audit records.
- Assessment localization files contain stable variant/question/option IDs and translated learner text only. They never contain a correct option ID or answer key.
- The source answer mapping is represented only by an irreversible SHA-256 receipt so topology can be reconciled without disclosing the mapping.
- This workflow never calls the service import RPC unless an operator explicitly selects `--apply` and supplies the required server-only credentials and confirmation receipt.
- Presentation assets are new content-addressed objects; an existing published object must never be overwritten.

## Artifact layout

The generated batch lives under `content/localizations/staged-2026-09-01/`:

- `courses/<slug>/<locale>/course-draft.json` — draft metadata, policy and import sequencing;
- `courses/<slug>/<locale>/assessment-import.json` — strict service-only assessment import payload;
- `articles/<slug>/<locale>.json` — localized article document;
- `legal/<document-type>/<historical-version>/<locale>.json` — retained historical 1.2/2.2 localization receipt;
- `legal/<document-type>/<current-version>/stage-rpc.json` — additive version-stage RPC payload for Privacy 1.3 or Terms 2.3;
- `legal/<document-type>/<current-version>/<locale>/save-rpc.json` — exact service-side save RPC payload for RU/KK/EN/ZH, with `p_body_hash: null` so PostgreSQL computes the canonical `jsonb::text` digest;
- `legal/<document-type>/<current-version>/<locale>/artifact-receipt.json` — source/body/topology/file hashes and automated-only risk;
- `legal/<document-type>/<current-version>/publication-receipt.json` — four-locale rolling-release gate; its paired `publish-rpc.json` is explicitly unexecuted;
- `presentations/<slug>/<locale>/text-map.json` — resolved source element IDs and localized text;
- `presentations/<slug>/<locale>/assets/pptx/<sha256>/presentation.pptx` — immutable editable deck;
- `presentations/<slug>/<locale>/assets/pdf/<sha256>/presentation.pdf` — immutable learner presentation;
- `qa/text-unit-review.json` — hash-only per-unit automated translation receipt;
- `qa/independent-semantic-review.json` — independent-provider semantic, terminology and legal review receipt required before freeze;
- `qa/automated-review-receipt.json` — source counts, review method, invariant results and artifact hashes.

Temporary full-slide renders, layout JSON, contact sheets, starter decks and frame maps live under `tmp/stage6/` and are intentionally not publication inputs.

## Deterministic generation and checks

Use the project-pinned Node 24 runtime:

```powershell
npm run content:localizations:build
npm run content:localizations:validate
npm run content:localizations:verify
npm run content:localizations:validate:release
```

The build performs two forward translation executions, two RU back-translations, terminology protection with the checked-in glossary, invariant-preserving reconciliation, and hash manifest generation. The validator checks:

- exactly 5 courses, 15 variants, 150 questions and 600 options;
- exact stable-ID/order topology for every target locale;
- exactly 10 articles, retained historical Privacy 1.2/Terms 2.2 copies, and current Privacy 1.3/Terms 2.3 SQL-compatible payloads for all four locales;
- exactly 5 presentation text maps and 198 slides per locale;
- number/date/URL/contact/platform-token invariants;
- absence of answer-key fields;
- artifact sizes and SHA-256 hashes.

`content:localizations:validate:release` additionally requires the independent semantic-review receipt and exactly one canonical PPTX plus one canonical PDF for every `5 decks × 3 target locales`. Each presentation `artifact-receipt.json` must bind both binaries, their content-addressed parent hashes, source/text-map hashes, byte sizes, source-equivalent slide/page counts, all-slide/all-page render counts, zero overflow, zero missing-glyph sentinels and PDF safety checks.

To validate one assessment import without writing anything:

```powershell
node scripts/import-course-assessment-localization.mjs --check --file <assessment-import.json>
```

## Presentation authoring and QA

Each localized deck must use its current RU PPTX as the template source. The template workflow creates `template-audit.txt`, `template-frame-map.json`, `deviation-log.txt`, a one-to-one starter deck, source/final layout exports, slide PNGs and contact sheets. Final text edits are applied to resolved inherited text elements with `@oai/artifact-tool`; Python PPTX libraries and direct OOXML mutation are prohibited.

Every final PPTX must pass template-plan validation, template fidelity, placeholder and overflow checks. Every final PDF must retain the source slide count and 16:9 page size, contain extractable target-locale glyphs without replacement characters, and be rendered page-by-page for visual review.

## Controlled publication sequence

Publication is deliberately deferred to the release stage:

1. deploy a backward-compatible application/database read path;
2. stage Privacy 1.3 and Terms 2.3, save all four complete immutable localizations, verify their distinct hashes and equal topology, then rotate each current version transactionally; never activate application current pointers ahead of this gate;
3. upload each localized presentation as a new immutable Storage object and record its ID;
4. save the corresponding localized course draft through the Russian admin application;
5. run the service-only assessment localization importer for the same course/locale;
6. complete the admin draft with the immutable presentation reference;
7. publish the complete four-locale revision atomically only after the `4 × 3 × 10 × 4` validator succeeds;
8. run `npm run content:pull:linked`, review the deterministic diff, then run `npm run content:parity:check`;
9. commit the refreshed snapshot receipt without operational personal data.

The automated-only receipt explicitly records that there was no human linguistic or legal approval. That residual semantic/legal risk is accepted by the owner for this release, but it must remain visible in the release record.
