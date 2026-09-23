# Restore the original filled-in email flow

The user rejected repeated pasting and recalled that the old app opened Mail with the order already present. Inspection of the initial v9 commit `9f0cb42` confirmed `emailOutput()` URL-encoded `_currentOutputText()` into a `mailto` body. It did not transfer HTML styling. Restore this behavior with the current formatted list rather than requiring a helper app.

The primary **Email order** button opens Mail synchronously from the user click, with fixed warehouse recipient, store-only subject, and complete text body. Preserve literal bullets, ordered categories, two empty lines above and below `...`, alphabetical flavors, notes and quantities. Encode CRLF newlines per RFC6068 and encode subject/body independently. No list truncation, clipboard permission, second paste dialog or automatic send. Keep optional rich copying available and preserve identity guards.

Mail controls typography and wrapping; neither source inspection nor intercepted browser tests proves identical rich rendering on an iPhone. Validate the actual handoff data and document that limit. Use synthetic orders only, intercept all email navigation, and do not open or send real mail. Run targeted regressions, full tests/build, mobile/desktop browser checks, review, CI, production deployment and anonymous release verification.
