# Gemini chat and product photos

Add a dedicated Gemini conversation button in the existing orange/ivory app header and a Workspace tile. Keep the order proposal tool separate. Chat uses the signed-in user's Firebase AI Logic transport, shared per-user AI limits, selected store name, and a bounded relevant catalog selection. It has no action tools. Conversation text lives only in the open session and is cleared on identity/store changes.

Preserve existing catalog photos. Queue active products without photos transactionally on product save; backfill existing missing photos through the owner-only Product photos manager. A scheduled server worker claims durable jobs, finds candidate manufacturer/supplier pages with Gemini, fetches public HTTPS sources independently, and asks Gemini to compare actual image pixels and page evidence against the product identity. It uploads only confident matches to the app's existing product-media store. Ambiguous products remain visibly in review; an owner can provide a source page or upload a photo.

The source fetcher pins validated public DNS addresses, revalidates redirects, bounds time and compressed/decompressed size, and accepts only supported image signatures. Google Search grounding is not used as an image-harvesting source. The worker uses a dedicated restricted server API key and a separate scheduling token. Neither is exposed in public Firebase configuration.

Jobs use expiring claims, at most three interrupted attempts, a daily attempt limit, and fresh product fingerprint/image checks before committing. Concurrent edits retain current product fields; manual photos win. Record source provenance and an audit event with each applied image. Product metadata, not customer/order/payment records, is sent to the photo model.

Verification: backend authorization/quota tests, queue races and replay/rollback tests, safe source transport/parser tests, provider rejection and bounded-response tests, mobile Chromium/WebKit chat and manager checks, build and existing regression suite. Verify deployed health, assets, worker authentication, source-backed photo provenance and queue status.
