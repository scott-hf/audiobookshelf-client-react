# Correlation Note — acquisition record → staged tree → ABS item

**Status:** authoritative for Plan 3 (import handoff + ABS resolution).
Written before implementation of WI-1496 t400. Where this note and the
handoff package's plan documents disagree, **this note wins** — it is
derived from the live source cited inline, per the item rule that verified
corrections override the handoff package.

Librarr source citations are pinned to the authoritative checkout the
droplet runs:
`E:\stremio_for_audiobooks_project\claude-audiobookshelf-torbox-review\work\librarr`
@ `1b86eb1`. (`G:\tools\ABS\librarr` and the handoff package's
`reference/librarr` are stale — they predate `abb_url` and the submit
response hash.)

Audiobookshelf citations are pinned to the reference-only server checkout
`G:\tools\ABS\audiobookshelf` (never modified by this work).

---

## 1. Why path convention must NOT be the correlation key

The handoff plan assumes a knowable staging layout. It is not knowable, and
both the plan document *and* FND-00411 state it wrongly-but-differently.
The reconciliation:

`internal/organize/pipeline.go:124` `OrganizeAudiobook(filePath, title, author)`
computes its destination as

```go
safeAuthor := sanitizePath(author, 80)
safeTitle  := sanitizePath(title, 80)
destDir, err := joinUnder(o.cfg.AudiobookDir, filepath.Join(safeAuthor, safeTitle))
```

so the *nominal* contract is `AUDIOBOOK_DIR/<author>/<title>/` — matching the
doc comment at `pipeline.go:123`, and contradicting FND-00411's observed
`<Title>/<Author>/`.

Both observations are correct, because the caller decides which string is
"author". `internal/download/watcher.go:487-499` derives the two arguments
from the **torrent name** with a positional heuristic:

```go
title := t.Name
if strings.Contains(title, " - ") {
    parts := strings.SplitN(title, " - ", 2)
    author = strings.TrimSpace(parts[0])   // first segment assumed to be the author
    title  = strings.TrimSpace(parts[1])
}
if author == "" { author = "Unknown" }
```

AudioBookBay release names are frequently `Title - Author`, not
`Author - Title`. When they are, `author` receives the real title and
`title` receives the real author, and the tree lands on disk as
`AUDIOBOOK_DIR/<Title>/<Author>/` — exactly what FND-00411 observed live.
When the release name has no ` - ` at all, the whole name becomes the
"title" and the tree lands under `AUDIOBOOK_DIR/Unknown/<whole name>/`.

**Consequence (the load-bearing conclusion of this note):** the staged path
is a *function of an unreliable string heuristic over the release name*, not
of the book's real metadata. The gateway must never construct, guess, or
pattern-match a staged path from an acquisition's title/author. Any design
that globs `AUDIOBOOK_DIR/<Author>/<Title>` — or `<Title>/<Author>` — is
wrong for a predictable fraction of real releases.

## 2. Primary correlation: Librarr's own library row

Librarr records the destination it actually chose. `internal/download/watcher.go:549`
`recordTorrentItem` writes a `models.LibraryItem` (`internal/models/book.go:104`)
with, notably:

| Field | Value written | JSON key |
|---|---|---|
| `FilePath` | the real organized destination returned by `OrganizeAudiobook` | `file_path` |
| `OriginalPath` | the pre-organize download path | `original_path` |
| `SourceID` | **`t.Hash`** — the torrent hash (`watcher.go:562`) | `source_id` |
| `Source` | downloader/source name | `source` |
| `MediaType` | `"audiobook"` | `media_type` |

`internal/db/library.go:456` `ItemToJSON` confirms `file_path`, `source_id`,
`original_path`, `media_type`, `added_at` are all present in the API
representation.

Because `source_id` **is the torrent hash**, it joins directly to the
gateway's existing tracking key. Plan 2 already implements the precedence
`submit hash > job_id > nzo_id > search-result info_hash`
(`src/domain/librarrTrackingKey.ts`); for torrent acquisitions — the only
requestable kind in this stack, since SABnzbd is not configured — that key
IS a torrent hash and IS comparable to `source_id` (case-insensitively;
compare lowercased hex).

**Primary strategy.** On a `DownloadStatus` completion for acquisition `A`:

1. Fetch Librarr's local library listing:
   `GET /api/library/audiobooks` (`internal/api/router.go:308`). With ABS
   unset — which our deployment contract mandates (`ABS_URL`/`ABS_TOKEN`/
   `ABS_LIBRARY_ID` unset in Librarr) — this serves the **local DB
   fallback**, `serveLocalLibraryByMediaType(w, r, "audiobook")`
   (`internal/api/library_external.go:56-64` → `internal/api/library.go:99`),
   paginated at 100/page with `{items,total,page,pages}`.
2. Select the item whose `source_id` equals `A`'s tracking key
   (lowercased-hex compare).
3. Take that item's `file_path` as the staged tree root — resolve it under
   the configured staging root (`resolveUnder`) and reject anything that
   escapes. `file_path` may be a **file** (single-file release) or a
   **directory** (multi-file release); `OrganizeAudiobook` returns
   `destDir` for directory sources and `destDir/<basename>` for file
   sources. Normalize to the containing directory for a single file.
4. Record `librarr_library_item_id` (the row's `id`) on the acquisition —
   it is required for the cleanup step in §6 and must survive restarts.

Exactly one match → proceed. Zero or more than one match → §3.

## 3. Fallback: new-tree stability scan + metadata match

Used only when §2 yields no unique match (Librarr row not yet written,
scanner-registered pre-existing row, hash mismatch after a
`download_uncached` resubmission, etc.).

1. Enumerate immediate subtrees of the staging root and diff against the
   set recorded when the acquisition entered `downloading`. Only trees that
   are **new since that snapshot** are candidates.
2. Require the stability rule from settled decisions: two identical
   fingerprints (sorted relative path + size + `mtimeMs`) separated by
   `STAGING_STABILITY_SECONDS` (default 30).
3. Score candidates on metadata evidence — normalized title and author
   matched against **both** path segments in **either order**, because §1
   proves the order is not fixed. Never accept a title-only match.

A unique stable, above-threshold candidate proceeds. **Zero candidates, a
tie, or a sub-threshold best candidate → `needs_attention`. Never guess.**
This is the same "never guess" rule the settled decisions apply to ABS item
resolution, applied one stage earlier.

## 4. File modes on the final tree

Configurable, **default preserve**. Librarr writes `0644` files inside
`0755` directories (FND-00413; `os.MkdirAll(destDir, 0755)` at
`internal/organize/pipeline.go`). Preserving those modes yields a tree ABS
can read without further intervention, so the gateway does not chmod by
default. An explicit override env var may force modes where a deployment's
ABS runs as a different uid; it is off unless set.

## 5. Destination naming is GATEWAY-owned — do not mirror staging

The final tree under the mapped ABS library root is
**sanitized `Author/Title`**, per settled decisions
(`02-SETTLED-DECISIONS.md`, "Filesystem handoff"), built from the
**acquisition record's** metadata — not from the staged path's segments,
which §1 shows are unreliable and possibly transposed.

A deterministic ` [<acquisition-id-prefix>]` suffix is appended **only**
when the unsuffixed destination already exists and is not this acquisition.
Never merge into a pre-existing unrelated directory; never expose the
hidden `.importing-<acquisitionId>` tree to ABS.

Librarr's `<author-slot>/<title-slot>` staging layout is a *staging*
convention only. It is deliberately not mirrored downstream.

## 6. ABS scan trigger, resolution, and cleanup policy

**Scan.** `POST /api/libraries/:id/scan` with the gateway's ABS service
token (verified: ABS `server/routers/ApiRouter.js:91`). Items list for
resolution: `GET /api/libraries/:id/items`.

**Resolution.** Exact final path first; otherwise the unique evidence score
from Plan 3 task 5. Title-only never qualifies. Tie, sub-threshold, or
timeout → `needs_attention`.

**Cleanup — stated explicitly, as required.** After — and only after — an
import is *confirmed* (a single ABS item ID resolved and persisted, state
`available`), the gateway performs BOTH of the following, promptly:

1. **Delete the staged tree** under the staging root.
2. **Delete the stale Librarr library row**:
   `DELETE /api/library/audiobook/{id}` (`internal/api/router.go:311`),
   using the `librarr_library_item_id` captured in §2 step 4.

Both are required. Deleting only the tree is insufficient: the Librarr row
persists and its `in_library` dedupe will reject a future acquisition of the
same book. Deleting only the row is insufficient: Librarr's **startup folder
scanner auto-registers everything remaining under `AUDIOBOOK_DIR` into its
own DB** (FND-00414), so a leftover tree silently recreates the row on the
next Librarr restart.

That auto-registration is also why cleanup must be **prompt, not deferred to
a batch job**: the window between a confirmed import and Librarr's next
restart is the window in which cleanup is cheap and unambiguous.

Cleanup is best-effort with respect to the acquisition's terminal state: a
failure to delete either the tree or the row is logged and surfaced, and may
raise `needs_attention`, but never regresses an already-`available`
acquisition (settled decisions: never regress a persisted lifecycle state).

## 7. Summary of correlation precedence

| Rank | Key | Source |
|---|---|---|
| 1 | Librarr `LibraryItem.source_id` == acquisition tracking key → `file_path` | `watcher.go:562`, `book.go:104` |
| 2 | New-since-download stable tree + title/author match in either segment order | §3 |
| 3 | — | nothing else; anything ambiguous is `needs_attention` |

Path-shape inference is **not** on this list at any rank.
