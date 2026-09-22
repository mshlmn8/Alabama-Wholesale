# Large order capacity

Orders have no application limit on the number of lines. The editor, autosave,
backup restore, submission, returns, PDF generation and device copies retain all
lines. Draft validation loads each distinct product once.

The current storage model keeps an order (including its frozen invoice lines) in
one Firestore document and its idempotent command result in a separate document.
The repository validates every pending write before committing any of them:

- Each record must fit Firestore's 1 MiB document capacity, including field names,
  UTF-8 text, nested maps and the document path. Both stored and encoded sizes are
  checked.
- Transactions must fit the 10 MiB encoded request capacity. The preflight check
  reserves 1 KiB for the transaction token and protocol metadata.
- HTTP request bodies retain the existing 9 MiB transport capacity.

These are byte capacities, not line-count substitutes. The repository's former
450-write restriction was removed: Firestore removed its write-count restriction
on March 29, 2023. Financial changes remain one atomic transaction; they are never
split into independent batches. A capacity error preserves the previous online
draft, the working device draft and its export, without posting an invoice charge,
incrementing the invoice sequence or reserving inventory.

Supporting records larger than 1 MiB would require a separate design to partition
order lines and command receipts while preserving atomic financial updates and
idempotent retries. The current change intentionally retains the storage format.
Firestore also retains index and transaction-time limits.
Explicit backend size/index-capacity rejections are returned as actionable 413
errors because the server also counts modified index entries and deleted record
bytes. Ordinary quotas, timeouts and network failures retain their original
uncertain-result handling and must not be reported as uncommitted writes.

Verification covers 1,101 distinct tracked products through submission and a full
return, 1,200-line draft sync and backup restore, and every line of a 1,001-line
invoice PDF. Firestore emulator coverage submits 601 distinct tracked products
in one transaction and verifies that an oversized 1,200-line frozen invoice leaves
the saved draft and finances unchanged.

Sources:

- [Firestore quotas](https://firebase.google.com/docs/firestore/quotas)
- [Stored size calculations](https://firebase.google.com/docs/firestore/storage-size)
- [March 29, 2023 write-count change](https://docs.cloud.google.com/firestore/docs/release-notes#March_29_2023)
- [Atomic transaction failures and index bytes](https://firebase.google.com/docs/firestore/manage-data/transactions#transaction_failure)
