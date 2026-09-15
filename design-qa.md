# Document editor design QA

Date: 2026-09-15

## Scope and evidence

Local production build, Docker/Supabase, real Chrome channel. Editor fields and previews checked at 240, 320, 375, 390, 768 and 1440 px. A reduced viewport height with focused inputs exercises constrained editing space; a physical phone keyboard and physical printer were not tested.

Screenshot evidence is generated under `test-results/playwright/document-editor-company-pr-b1102-sistence-and-mobile-preview-chromium/`: `fields-240.png`, `editor-240.png`, corresponding other widths, `booklet-desktop.png`, `protocol-desktop.png`, and the downloaded `booklet.pdf`.

Normalized side-by-side source comparisons: `test-results/document-editor-layout/compare-left.png`, `compare-right.png`, `compare-protocol.png`. The source images and the supplied protocol PDF were visually inspected alongside the rendered document. These ignored test artifacts can be regenerated with `scripts/document-visual-comparison.mjs` and the document tests.

## Findings resolved

- P1: Inline preview CSS was blocked by CSP. Moved it into an external stylesheet imported by the global stylesheet; verified no CSP console errors and actual right-half translation.
- P2: The preview control and commission action overflowed at 240 px. Reduced switch padding, allowed action height to grow and checked button text bounds in Chrome.
- P2: Certificate right-side heading did not match the sans-serif reference. Added the correct font character while keeping serif body text.
- P2: Long protocol organization headings wrapped prematurely. Added bounded font sizing without clipping or truncation.
- P2: Certificate photo border intersected a personal-data rule. Adjusted the photo zone and increased BIN legibility.

## Results

- One-layer fields, internal names/placeholders, clear add/remove controls; no horizontal page overflow at tested widths.
- One PDF spread with a shared central fold, actual private profile image, both mobile half views, signature/seal labels, no signature or stamp scans.
- Preview and download use the same renderer. Failed/cancelled refreshes do not silently replace a correct preview with an incomplete official download.
- Five-column company protocol; long names and a 130-person, 18-page fixture render without clipping. Database tests cover a company with 1,101 participants, actual results and unknown education.
- Four Chrome integration tests pass: private photograph, editor persistence/conflict/export/mobile flow, pending navigation circle, authorization boundaries.
- Explicit test dimensions are checked in PDF points; production physical dimensions remain unset until supplied by an administrator. Actual 100% print size requires a printer check after those dimensions are entered.

Intentional differences from blank reference forms: filled participant data and variable-length organization names, selected-program text instead of copying the fire-safety wording into other programs, dynamic commission membership, and the required verification QR. No examination result or personal photograph is fabricated.

Local implementation final result: passed.

Production deployment and the real Nursultan Zhussipov case are verified separately after publication; this local QA record does not assert production rollout completion.
