# Handoff package (imported)

This directory is a copy of material from
`G:\tools\ABS\claude-audiobookshelf-mobile-acquisition-handoff` (the
WI-1486/WI-1496 handoff package), imported for reference during
implementation of the mobile acquisition stack (WI-1496).

**This material is guidance, not gospel.** Authority order when documents
conflict:

1. `02-SETTLED-DECISIONS.md` (this directory)
2. `spec/` (this directory)
3. `plans/2026-08-24-mobile-acquisition-master-implementation-plan.md` (master plan)
4. Individual child plans under `plans/`

WI-1496's base-instruction "Verified corrections" section (design pass
2026-08-24, live source cited against `work/librarr @ 1b86eb1`) overrides
this handoff package wherever they conflict. In particular:

1. The authoritative Librarr source for adapters/fixtures is
   `E:\stremio_for_audiobooks_project\claude-audiobookshelf-torbox-review\work\librarr @ 1b86eb1`
   (what the droplet runs) — not `G:\tools\ABS\librarr` and not this
   package's `reference/librarr`, both of which are stale (missing
   `abb_url` and the submit-response `hash`).
2. AudioBookBay search results carry no `info_hash`/magnet at search time —
   only `abb_url` (detail-page href); Librarr resolves the magnet at
   download time. Torrent requestability must accept `abb_url`, and
   raw-snapshot resubmission must preserve it (FND-00434).
3. Torrent submit response shape is
   `{success, title, error[, warning][, hash]}` — correlate by that hash,
   falling back to the search result's `info_hash`. Torrents have no
   `job_id` (job_id is direct-download jobs only); `nzo_id` requires
   SABnzbd, which this stack does not run — surface Librarr's 400
   "SABnzbd not configured" as a stable non-retryable error.
4. Librarr organizes staging as `<Title>/<Author>/`, not
   `<Author>/<Title>/` (FND-00411). Its startup folder scanner
   auto-registers everything under `AUDIOBOOK_DIR` into its own DB
   (FND-00414).
5. TorBox `download_uncached` accepts any hash and can sit at 0 B forever
   (FND-00410) — the gateway reconciler needs a stall timeout to
   `failed`/`needs_attention`; the handoff specifies none.

See `docs/implementation-status.md` at the repo root for the live
implementation status, deviations, and gate results.
