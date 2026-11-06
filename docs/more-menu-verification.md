# More menu and store tools

The More page groups account tools, ordering shortcuts, settings, support and
recovery in a searchable menu. It retains the five mobile tabs and the existing
staff and owner permissions. Overview no longer selects the More tab.

## Included

- Quick access to Overview and existing favorite products.
- Account and payments, an invoice and credit-memo hub, returns and delivery
  issues, reusable product lists, and the existing store inventory workflow.
- Notifications and preferences together; appearance and builder size in App
  settings; the notes-only templates renamed Saved instructions.
- Help with ordering guides, assigned store contact details when available, and
  the existing assistant.
- Save status and draft backup, with owner administration and team access in a
  separate expandable section. Warehouse operations remain available to staff.
- Smaller Overview introduction and explicit metric action labels.

## Saved lists

Lists belong to one account and one authorized store. Create them from a current
draft or saved order, edit quantities, remove rows, and delete lists. Reusing a
list reviews current catalog prices and validates product, variant and pack
availability before adding anything. Existing draft items are preserved. The
server stores product intent without frozen prices or picked allocations; Mix,
Each and exclusions are preserved. The normal submit flow verifies final prices
and stock. Optimistic versions and command receipts protect edits and retries.

## Delivery issues and documents

Delivered-order reports support missing, wrong and damaged items, affected
quantities, a reason, and up to three raster photos. The browser reduces each
photo to at most 200 KB. The server checks types, signatures, canonical base64,
sizes and quantities. Bytes are stored in separate private records and served
through authenticated routes that recheck current store membership and parent
references. Only photo metadata enters workspace state. Missing goods cannot be
picked up, received or restocked. Submitting a report does not post credit;
existing staff approval and credit limits remain authoritative.

The document hub filters loaded invoice history by number, type and dates, pages
back explicitly, and downloads the existing server-generated PDFs. It includes
only confirmed invoices and approved credit memos, scoped to the selected store.
Historical records without verified prices retain their existing order-history
access rather than being presented as confirmed invoices.

## Validation

- Node 22: 864 automated tests pass; `npm run build` passes.
- Tests cover list ownership, cross-store denial, versions, replay, intent-only
  storage, flavor choices, photo validation, private photo authorization,
  revoked membership, no-store responses, role visibility and menu search.
- Chromium: list reuse merges into a draft, list creation survives reload,
  deep links reload correctly, genuine invoice PDFs download, and a missing-item
  report with a private photo can be submitted and opened.
- WebKit: the same flows, dark appearance and owner administration are checked
  with the local synthetic preview. This is browser-engine validation, not a
  physical iPhone installation or production acceptance.
- A deliberate WebKit reload logs an interrupted background `/api/commands`
  fetch as an access-control cancellation. The preserved draft retries after
  navigation and the request is confirmed; the browser report records this
  separately from unexpected page errors.
- `npm audit --omit=dev`: zero vulnerabilities.
- More layout checked at 320, 390, 412, 768 and 1147 CSS pixels without horizontal
  page overflow. Documents checked at 390 pixels. No live business data is used
  or changed by the preview.

Later delivery schedules/cutoffs and business-document uploads remain outside
this implementation because they need confirmed operational data and a review
workflow. Production deployment is separate from this branch.
