# Asset IDs, QR labels and scanning

How an asset gets its identity and how that identity travels from the register to a physical label and back:

**Asset ID format → register asset → Asset ID assigned → QR code → print label → attach → scan → asset page → assign / transfer / verify → retire**

## Asset ID format (Administration › Asset IDs & labels)

| Setting | Meaning | Default |
|---|---|---|
| Prefix | Fixed text at the start, 1–10 letters or digits | `AST` |
| Separator | `-` or none | `-` |
| Include category code | Adds the category's short code (Categories & departments › Code, 1–6 letters or digits) | off |
| Number of digits | Zero-padded width; numbers grow past it rather than wrap | 6 |
| Numbering | One running number for all assets, or a separate running number per prefix (and category code) | one running number |
| Next number / start new prefixes at | Shared number can only move forward; per-prefix counters start here | — |

With the defaults the format is the FRD's `AST-000001`. Examples: `IT-LAP-00001` (prefix IT, category code LAP, 5 digits, separate numbering), `AST000123` (no separator).

Guarantees, all enforced in PostgreSQL so every path (form, bulk add, import, approvals, verification finds, raw SQL) behaves the same:

- The `assets_assign_code` trigger assigns the Asset ID on insert from the saved format and ignores any value a caller sends.
- IDs stay unique: the number comes from `asset_code_seq` or a locked row in `asset_code_counters`; a new per-prefix counter starts above the highest number already used under that prefix; a number whose ID already exists is skipped.
- IDs never change (`assets_guard_update`) and are never reused (assets cannot be deleted; counters only move forward).
- Changing the format affects only assets created afterwards. Existing Asset IDs, printed labels and references are untouched. An asset that later changes category keeps its ID.

Location is deliberately not part of the ID: assets move between branches through transfers, and an immutable ID that names the old branch would be wrong on the label.

## QR codes and labels

- The QR code is generated on demand from the Asset ID; nothing extra is stored, so it can never drift from the asset and there is nothing to regenerate.
- **QR content** (setting): the bare Asset ID (default; works with any scanner), or a link `APP_URL/scan/<Asset ID>` that a phone's camera opens directly after sign-in. Every scanning path accepts both, so labels printed either way keep working.
- **Asset page › QR code and label**: preview, download PNG, print label. After registering an asset the page offers to print its label straight away.
- **Asset register**: select assets › Print labels. **Bulk add**: Print labels for the batch just created.
- **Layouts**: A4 sheet with 24 labels (3 × 8), with "start at label position" to reuse a partly used sheet; or a label printer, one label per page at a configured size in mm. Labels at least 1.5× as wide as high show branch, make/model and serial beside the code; narrower labels show the Asset ID under it.
- **Barcode** (setting, on by default): a Code 128 barcode of the bare Asset ID runs along the bottom of every label, for handheld laser / 1D scanners that cannot read QR codes. The QR code is always printed too.
- The print dialog shows a live, to-scale preview of the label for the chosen stock (and, on A4, which sheet positions will be used). The PDF and the preview share one layout (`src/lib/label-layout.ts`), so what you see is what prints. The PDF opens in a new tab to print. Label generation is audited (`LABELS_GENERATED`).

## Scanning

| Where | How |
|---|---|
| Assets › Scan asset (`/scan`), and the camera button in the top bar | Phone or laptop camera, or typing / USB scanner. A match opens the asset page straight away, with a Scan next button. |
| Global search box (all screens) | USB / Bluetooth scanner reading the QR code or the barcode (both carry the Asset ID), or typing; opens the asset |
| Verification task | Scan or type, or "Scan with camera"; marks the line present |
| Phone camera app | With link-style QR content, opens `/scan/<Asset ID>`, which redirects to the asset |

The camera reader uses the browser's BarcodeDetector where available (Android Chrome, which also reads the barcode) and the bundled `jsqr` decoder elsewhere (iPhone, desktop), which reads the QR code. A handheld scanner reads either code and types the Asset ID into the focused box. The camera needs HTTPS (or localhost); the `Permissions-Policy` header allows the camera for this site only. Clear messages cover a denied permission, no camera, a camera in use, an insecure connection, an unknown code and an out-of-scope asset.

## Permissions

| Action | Who |
|---|---|
| Change the Asset ID format and label settings | Administrator |
| Set category codes | Administrator |
| View QR, print labels, scan, look up | Any signed-in user, for assets in their own scope only (out-of-scope assets give "not found") |

## What was compared

The reference project mentioned in the request was not available, so this feature set was derived from the request itself and the FRD (FR-REG-09/10/11, OPEN-1).

| Requested capability | Already in the app | Change | Where |
|---|---|---|---|
| Asset ID / code configuration | Fixed `AST-000001` sequence | Configurable prefix, category code, digits, numbering, next number; DB-assigned | Administration › Asset IDs & labels; Categories › Code |
| QR generation and preview | QR only inside the label PDF | QR card with preview and PNG download | Asset page |
| QR printing, single and batch | A4 3 × 8 PDF, downloaded | Print dialog, print preview in a new tab, label-printer layout, start position, from bulk add and after registration | Asset page, register, bulk add |
| Scanner | Keyboard-wedge scanning in search and verification | Camera scanner page, camera in verification, scan links | Assets › Scan asset, top bar, verification |
| Asset lookup by scan | Global search by ID, serial, legacy tag | Also accepts scan links | Everywhere a code is scanned |
| Assignment, transfer, history, retire | Present | Reached from the scan result and asset page | — |
