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

---

# Stamp, signatures and the editor's controls

Date: 2026-09-17

## Scope and evidence

Local development build, Docker/Supabase, Chromium. Editor checked at 240, 320, 390, 768, 1024 and 1440 px in the light and the dark theme, fields and preview, both halves of the booklet. The owner's stamp and signature were cut out of his scan with `scripts/build-facsimile-png.mjs` and uploaded through the editor itself; they are stored in the database only, because this repository is public.

## Changes

- The stamp and the signatures are drawn again: the stamp over «М.П.» and the chairman's signature across his line in the booklet, the stamp at its real 38 mm beside the protocol's own signature in the protocol. A picture is its own save and stays until it is replaced; removing one is confirmed first.
- An uploaded scan or phone photograph loses its paper in the browser (`lib/pdf/facsimile-image.ts`): uneven light is measured around every pixel, the ink keeps its hue, a small scan is enlarged with smooth edges. A PNG that already has a cut-out background is left as drawn. The server decodes and re-encodes whatever arrives before it is stored.
- Three rows of buttons became switches (`components/ui/segmented-control.tsx`): document, fields or preview, left or right half. The half also follows a swipe.
- What is set once is one line until opened — pictures, organization and commission, texts, insert size — and each document shows only its own settings. Open sections survive a reload.
- Actions are icons with a word where there is room: in the top row on a desktop, in a floating bar under the thumb on a phone. A download saves unsaved edits first instead of refusing.
- The preview is drawn as sharp as the screen shows it, keeps the previous pages while the next ones are prepared, and is not drawn at all while hidden behind the fields.
- No border sits inside another border: sections are divided by lines, fields carry the only outlines, the preview frame is a tinted surface. Paper and ink tiles stay white in the dark theme on purpose.

## Results

- No horizontal overflow and no clipped button label at any tested width; the five Chrome integration tests of `e2e/document-editor.spec.ts` pass, including the upload, replacement and removal of a photographed stamp.
- A booklet with both pictures renders in about 230 ms (170 ms without) and weighs about 200 KB (26 KB without a photograph or pictures).

