package com.hellofriend.shelfdroid.managers

import com.hellofriend.shelfdroid.data.LocalLibraryItem
import com.hellofriend.shelfdroid.device.FolderScanner
import com.hellofriend.shelfdroid.models.DownloadItem
import com.hellofriend.shelfdroid.models.DownloadItemPart
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.logging.Level
import java.util.logging.Logger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.OkHttpClient

/** Raw catalog persistence [DownloadItemManager] needs -- `DbManagerDownloadRepository` wraps
 * Task 2's `DbManager`; a fake implementation backs unit tests without touching the filesystem
 * through a real `DbManager` unless a test wants to (both are fine; `DbManagerDownloadRepository`
 * over a temp dir is used in `DownloadItemManagerTest` for realism, matching `DbManagerTest`'s
 * "reopen a real DbManager over the same dir" pattern). */
interface DownloadRepository {
    fun downloads(): List<DownloadItem>
    fun save(item: DownloadItem)
    fun remove(id: String)
    fun saveLocalItem(item: LocalLibraryItem)
    fun localItems(): List<LocalLibraryItem>
    fun removeLocalItem(libraryItemId: String)
}

class DbManagerDownloadRepository(private val dbManager: DbManager) : DownloadRepository {
    override fun downloads(): List<DownloadItem> = dbManager.downloads()
    override fun save(item: DownloadItem) = dbManager.saveDownload(item)
    override fun remove(id: String) = dbManager.removeDownload(id)
    override fun saveLocalItem(item: LocalLibraryItem) = dbManager.saveLocalItem(item)
    override fun localItems(): List<LocalLibraryItem> = dbManager.localItems()
    override fun removeLocalItem(libraryItemId: String) = dbManager.removeLocalItem(libraryItemId)
}

/** Notified as the queue changes -- `AbsDownloader` (the Capacitor bridge) and `DownloadService`
 * (the foreground notification) both implement this to forward to JS listeners / update the
 * notification, matching the donor app's `DownloadEventEmitter` split. */
interface DownloadEventListener {
    fun onItemUpdated(item: DownloadItem) {}
    fun onItemComplete(item: DownloadItem) {}
    fun onQueueChanged(hasWork: Boolean) {}

    companion object {
        val NOOP: DownloadEventListener = object : DownloadEventListener {}
    }
}

/** Network download policy seam -- the real implementation (`DownloadServiceHost`) checks
 * `ConnectivityManager` and the user's `wifiOnly` preference; tests substitute a controllable
 * fake so "waiting_for_network" gating is exercised without a `Context`. */
fun interface ConnectivityPolicy {
    fun isTransferAllowed(): Boolean
}

/** Free-space policy seam -- the real implementation checks `StatFs`; tests substitute a
 * controllable fake so "waiting_for_space" gating and mid-transfer disk exhaustion are exercised
 * without a `Context`. */
fun interface DiskSpacePolicy {
    fun hasAvailableSpace(target: File): Boolean
}

private val ALWAYS_ALLOWED = ConnectivityPolicy { true }
private val ALWAYS_AVAILABLE = DiskSpacePolicy { true }

/**
 * Foreground-download queue orchestrator (WI-1496 t800 Task 3), adapted from the donor app's
 * `DownloadItemManager` down to a coroutine-driven design built directly on OkHttp
 * (`InternalDownloadManager`) rather than the donor's `Call`-callback + WorkManager-adjacent
 * pattern -- `androidx.work` isn't a project dependency (see `IncompleteDownloadCleanup`'s design
 * note) and this milestone doesn't need cross-process durability beyond what `DbManager`'s
 * JSON-file persistence + `restoreQueue()` already provide. Every part transition is persisted via
 * [repository] so a process death mid-transfer resumes from the `.part` file's actual on-disk
 * length the next time `restoreQueue()` runs (see [restoreQueue]'s doc).
 *
 * No access token is ever persisted: [tokenProvider] is asked for the current token per item id
 * at transfer start, and [refreshToken] is asked once more after a 401 before giving up -- both
 * are plain callbacks so the production wiring (`AbsDownloader`, backed by the token supplied at
 * `enqueue()` time) and tests (a fixed/one-shot fake) can each decide what "refresh" means without
 * this class knowing about `SecureSessionPlugin` or the ABS auth model at all.
 */
class DownloadItemManager(
    private val repository: DownloadRepository,
    httpClient: OkHttpClient = OkHttpClient(),
    private val tokenProvider: (itemId: String) -> String?,
    private val refreshToken: (itemId: String) -> String? = tokenProvider,
    private val connectivity: ConnectivityPolicy = ALWAYS_ALLOWED,
    private val diskSpace: DiskSpacePolicy = ALWAYS_AVAILABLE,
    private val listener: DownloadEventListener = DownloadEventListener.NOOP,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    maxConcurrentParts: Int = MAX_CONCURRENT_PARTS
) {
    private val transfer = InternalDownloadManager(httpClient)
    private val queue = ConcurrentHashMap<String, DownloadItem>()
    private val jobs = ConcurrentHashMap<String, Job>()
    private val activeCalls = ConcurrentHashMap<String, Call>()
    private val lastPersist = ConcurrentHashMap<String, Long>()
    private val lastEmit = ConcurrentHashMap<String, Long>()
    // Caps simultaneous part transfers across the whole manager: a 50-file book would otherwise
    // open 50 connections at once. Parts waiting on a permit stay `queued`.
    private val transferGate = Semaphore(maxConcurrentParts.coerceAtLeast(1))
    // Guards the (enqueue-races-cancel) window between `scope.launch { runPart(...) }` being
    // scheduled and actually starting to run: `cancel()` removes `id` from `queue` synchronously,
    // but a `runPart` coroutine captured `item`/`part` object references directly and would
    // otherwise still perform the transfer against a cancelled/removed item once it gets a
    // thread. Checked at every stage boundary in `runPart` below.
    private val cancelledIds = java.util.Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())

    /** Reloads the persisted queue (e.g. after process death) and resumes every unfinished part.
     * Trusts the `.part` staging file's actual on-disk length over whatever byte count was last
     * persisted -- a process can die mid-`FileOutputStream.write` between a chunk landing on disk
     * and the throttled progress persist that would have recorded it, so the file itself is the
     * only source of truth for "how much do we actually have". Also runs
     * [IncompleteDownloadCleanup.sweep] first, mirroring the donor's `init { cleanupExpired() }`. */
    @Synchronized
    fun restoreQueue() {
        val persisted = try {
            IncompleteDownloadCleanup.sweep(repository)
            repository.downloads()
        } catch (e: Exception) {
            LOG.log(Level.SEVERE, "Could not load the persisted download queue; starting empty", e)
            emptyList()
        }
        val localIds = try {
            repository.localItems().map { it.libraryItemId }.toSet()
        } catch (e: Exception) {
            LOG.log(Level.WARNING, "Could not load local library items while restoring the queue", e)
            emptySet()
        }
        persisted.forEach { item ->
            if (isStaleCompletedRow(item, localIds)) {
                // Every part is complete but there is no local library row for it: the book was
                // deleted (or never finished being registered) -- restoring it would re-register
                // an item with no files, so drop the row instead of resurrecting it.
                runCatching { repository.remove(item.id) }
                return@forEach
            }
            item.parts.forEach { part ->
                if (!part.completed) {
                    part.bytesDownloaded = File(part.stagingPath).takeIf(File::exists)?.length() ?: 0L
                    if (part.state !in RESUMABLE_WAIT_STATES) part.state = "queued"
                }
            }
            queue[item.id] = item
            listener.onItemUpdated(item)
        }
        queue.values.toList().forEach { startNextParts(it) }
        notifyQueueChanged()
    }

    /** All parts complete, no matching local row, and not the "crashed between the last part
     * landing and the local row being written" case (state not yet `complete` with every file
     * still present, which `startNextParts` legitimately finishes). */
    private fun isStaleCompletedRow(item: DownloadItem, localIds: Set<String>): Boolean {
        if (item.parts.isEmpty() || !item.parts.all { it.completed }) return false
        if (item.libraryItemId in localIds) return false
        val interruptedFinish = item.state != "complete" && item.parts.none { FolderScanner.isPartFileMissing(it) }
        return !interruptedFinish
    }

    @Synchronized
    fun enqueue(item: DownloadItem) {
        val existing = queue[item.id]
        if (existing != null) {
            if (existing.state != "complete") {
                // Already queued: the caller has just supplied a fresh token (the host stores it
                // before calling), so revive a stuck/failed item instead of silently ignoring
                // the request. A user-paused item stays paused.
                if (existing.state == "failed" || existing.parts.any { it.state == "failed" }) resume(existing.id) else startNextParts(existing)
                return
            }
            // A completed row whose files are gone (or are being replaced) -- start over.
            queue.remove(item.id)
            repository.remove(item.id)
        }
        cancelledIds.remove(item.id)
        queue[item.id] = item
        repository.save(item)
        listener.onItemUpdated(item)
        startNextParts(item)
        notifyQueueChanged()
    }

    fun listQueue(): List<DownloadItem> = queue.values.toList()

    fun item(id: String): DownloadItem? = queue[id]

    fun part(id: String): DownloadItemPart? = queue.values.flatMap { it.parts }.find { it.id == id }

    @Synchronized
    fun pause(id: String) {
        val item = queue[id] ?: return
        item.parts.filter { !it.completed }.forEach { part ->
            activeCalls.remove(part.id)?.cancel()
            jobs.remove(part.id)?.cancel()
            part.state = "paused"
        }
        item.state = "paused"
        repository.save(item)
        listener.onItemUpdated(item)
        notifyQueueChanged()
    }

    @Synchronized
    fun resume(id: String) {
        val item = queue[id] ?: return
        item.parts.filter { !it.completed && it.state in RESUMABLE_FROM_STATES }.forEach {
            it.state = "queued"
            it.failed = false
        }
        item.error = null
        item.terminalFailureAt = null
        item.state = "running"
        repository.save(item)
        listener.onItemUpdated(item)
        startNextParts(item)
        notifyQueueChanged()
    }

    /** Re-evaluates parts parked on `waiting_for_network`/`waiting_for_space` -- the host calls
     * this when a network becomes available or the Wi-Fi-only preference is relaxed. A part
     * that is still not allowed to run simply parks again (without re-emitting). */
    @Synchronized
    fun retryWaiting() {
        queue.values.toList().forEach { item ->
            if (item.parts.any { !it.completed && it.state in WAIT_STATES && !jobs.containsKey(it.id) }) startNextParts(item)
        }
    }

    @Synchronized
    fun cancel(id: String) {
        cancelledIds.add(id)
        val item = queue.remove(id)
        if (item == null) {
            // Not in memory, but a persisted row may still exist (e.g. skipped at restore).
            repository.remove(id)
            return
        }
        item.parts.forEach { part ->
            activeCalls.remove(part.id)?.cancel()
            jobs.remove(part.id)?.cancel()
            File(part.stagingPath).delete()
        }
        repository.remove(id)
        item.state = "cancelled"
        listener.onItemUpdated(item)
        notifyQueueChanged()
    }

    /** Forgets everything about a downloaded (or partially downloaded) book: stops any transfer,
     * drops the in-memory and persisted queue rows (so a restart cannot resurrect it and a
     * re-download is not blocked by a stale id), deletes its files and removes its local library
     * row. Matches by queue id or `libraryItemId`. The caller deletes the item's folder. */
    @Synchronized
    fun removeDownloaded(libraryItemId: String) {
        val matches = LinkedHashMap<String, DownloadItem>()
        queue.values.filter { it.id == libraryItemId || it.libraryItemId == libraryItemId }.forEach { matches[it.id] = it }
        runCatching { repository.downloads() }.getOrDefault(emptyList())
            .filter { it.id == libraryItemId || it.libraryItemId == libraryItemId }
            .forEach { matches.putIfAbsent(it.id, it) }
        matches.values.forEach { item ->
            cancel(item.id)
            item.parts.forEach { part ->
                File(part.finalDestinationPath).delete()
                File(part.stagingPath).delete()
            }
        }
        repository.removeLocalItem(libraryItemId)
    }

    fun hasWork(): Boolean = queue.values.any { item ->
        item.parts.any { !it.completed && it.state != "paused" && it.state != "failed" }
    }

    /** Test-only convenience: suspends until every in-flight part transfer has finished (success,
     * failure, or a gated wait state that never started a job). Mirrors the plan's
     * `manager.awaitIdle()` step. */
    suspend fun awaitIdle() {
        while (true) {
            val active = jobs.values.toList()
            if (active.isEmpty()) return
            active.forEach { it.join() }
        }
    }

    fun destroy() {
        jobs.values.forEach { it.cancel() }
        jobs.clear()
        scope.cancel()
    }

    private fun startNextParts(item: DownloadItem) {
        if (item.parts.isNotEmpty() && item.parts.all { it.completed }) {
            // An item already registered as complete (restored alongside its local row) needs no
            // second finish -- that would rewrite the local row and re-fire onItemComplete.
            if (item.state != "complete") finishItem(item)
            return
        }
        item.parts.filter { !it.completed && it.state != "paused" && it.state != "failed" }.forEach { part ->
            if (jobs.containsKey(part.id)) return@forEach
            // Lazy start: the job must be in `jobs` before it can run, otherwise a part that
            // returns immediately (e.g. parked on the network) removes a not-yet-inserted entry
            // and leaves a dead job registered forever.
            val job = scope.launch(start = CoroutineStart.LAZY) { runPart(item, part) }
            jobs[part.id] = job
            job.start()
        }
    }

    private suspend fun runPart(item: DownloadItem, part: DownloadItemPart) {
        val self = currentCoroutineContext()[Job]
        try {
            transferGate.withPermit { transferPartOnce(item, part) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            LOG.log(Level.WARNING, "Part ${part.id} failed unexpectedly", e)
            if (!cancelledIds.contains(item.id)) failPart(item, part, e.message ?: "Download failed")
        } finally {
            if (self != null) jobs.remove(part.id, self) else jobs.remove(part.id)
        }
    }

    private suspend fun transferPartOnce(item: DownloadItem, part: DownloadItemPart) {
        if (cancelledIds.contains(item.id)) return
        if (!connectivity.isTransferAllowed()) {
            setWaitState(item, part, "waiting_for_network")
            return
        }
        val stagingFile = File(part.stagingPath)
        if (!diskSpace.hasAvailableSpace(stagingFile)) {
            setWaitState(item, part, "waiting_for_space")
            return
        }
        if (cancelledIds.contains(item.id)) return

        var token = tokenProvider(item.id)
        if (token.isNullOrBlank()) {
            // Nothing to authenticate with (e.g. process restart with no signed-in session):
            // fail fast rather than sending `Bearer ` and waiting for a 401.
            failPart(item, part, "Authentication failed")
            return
        }

        part.state = "running"
        item.state = "running"
        persist(item, force = true)
        listener.onItemUpdated(item)

        val url = resolveUrl(item.serverUrl, part.serverPath)
        var outcome = transferOnIo(url, token, stagingFile, part, item)

        if (outcome is InternalDownloadManager.Outcome.Unauthorized) {
            val refreshed = refreshToken(item.id)
            if (!refreshed.isNullOrBlank() && refreshed != token) {
                token = refreshed
                outcome = transferOnIo(url, token, stagingFile, part, item)
            }
        }

        if (cancelledIds.contains(item.id)) {
            // A cancel() landed while the transfer was in flight -- the call was already
            // asked to cancel via activeCalls, but the response may have raced it to
            // completion. Undo any file it managed to write instead of finalizing/failing
            // a part that no longer belongs to a queued item.
            stagingFile.delete()
            return
        }

        when (val result = outcome) {
            is InternalDownloadManager.Outcome.Success -> completePart(item, part, result.bytesDownloaded, result.contentLength, result.sizeVerified)
            is InternalDownloadManager.Outcome.Unauthorized -> failPart(item, part, "Authentication failed")
            is InternalDownloadManager.Outcome.Failure -> failPart(item, part, result.message)
        }
    }

    private suspend fun transferOnIo(
        url: String,
        token: String,
        stagingFile: File,
        part: DownloadItemPart,
        item: DownloadItem
    ): InternalDownloadManager.Outcome = withContext(Dispatchers.IO) {
        try {
            transfer.transferPart(
                url,
                token,
                stagingFile,
                part.contentLength,
                { diskSpace.hasAvailableSpace(stagingFile) },
                onCallCreated = { call -> activeCalls[part.id] = call },
                onTotalKnown = { total -> if (part.contentLength <= 0L) part.contentLength = total },
                onProgress = { bytes ->
                    part.bytesDownloaded = bytes
                    persistThrottled(item)
                    emitProgressThrottled(item)
                }
            )
        } finally {
            activeCalls.remove(part.id)
        }
    }

    private fun completePart(item: DownloadItem, part: DownloadItemPart, bytes: Long, contentLength: Long, sizeVerified: Boolean = true) {
        val staging = File(part.stagingPath)
        val final = File(part.finalDestinationPath)
        val onDisk = if (staging.exists()) staging.length() else -1L
        if (onDisk != bytes) {
            failPart(item, part, "Downloaded file size mismatch: expected $bytes got $onDisk")
            return
        }
        if (bytes <= 0L) {
            failPart(item, part, "Empty response")
            return
        }
        final.parentFile?.mkdirs()
        if (final.exists()) final.delete()
        if (!staging.renameTo(final)) {
            failPart(item, part, "Could not finalize downloaded file")
            return
        }
        part.completed = true
        part.failed = false
        part.state = "complete"
        part.bytesDownloaded = bytes
        // Only a size somebody actually supplied counts as known: an unverified part keeps
        // `contentLength = -1` so "never checked against an expected size" stays explicit.
        if (part.contentLength <= 0L && sizeVerified) part.contentLength = contentLength
        if (!sizeVerified) LOG.warning("Part ${part.id} finished with no expected size to verify against ($bytes bytes)")
        refreshAggregates(item)
        persist(item, force = true)
        listener.onItemUpdated(item)
        if (item.parts.all { it.completed }) finishItem(item) else startNextParts(item)
    }

    private fun failPart(item: DownloadItem, part: DownloadItemPart, message: String) {
        part.failed = true
        part.state = "failed"
        part.retryCount += 1
        item.error = message
        item.state = "failed"
        item.terminalFailureAt = item.terminalFailureAt ?: System.currentTimeMillis()
        persist(item, force = true)
        listener.onItemUpdated(item)
        notifyQueueChanged()
    }

    private fun setWaitState(item: DownloadItem, part: DownloadItemPart, state: String) {
        val unchanged = part.state == state && item.state == state
        part.state = state
        if (item.parts.none { it.state == "running" }) item.state = state
        if (unchanged) return
        persist(item, force = true)
        listener.onItemUpdated(item)
        notifyQueueChanged()
    }

    private fun finishItem(item: DownloadItem) {
        item.state = "complete"
        item.error = null
        item.terminalFailureAt = null
        refreshAggregates(item)
        if (item.totalBytes <= 0L || item.totalBytes < item.bytesDownloaded) item.totalBytes = item.bytesDownloaded
        val folder = item.parts.firstOrNull()?.let { File(it.finalDestinationPath).parentFile }
        repository.saveLocalItem(
            LocalLibraryItem(
                libraryItemId = item.libraryItemId,
                serverConnectionId = item.serverConnectionId,
                folderUri = folder?.absolutePath ?: "",
                manifestJson = manifestJsonFor(item),
                completedAt = System.currentTimeMillis()
            )
        )
        // Persisted only after the local row exists, so a persisted `complete` row always has
        // one (restoreQueue relies on that to tell "deleted" from "finished").
        persist(item, force = true)
        listener.onItemComplete(item)
        notifyQueueChanged()
    }

    private fun refreshAggregates(item: DownloadItem) {
        item.bytesDownloaded = item.parts.sumOf { it.bytesDownloaded }
        val known = item.parts.filter { it.contentLength > 0L }
        val knownTotal = known.sumOf { it.contentLength }
        val unknownCount = item.parts.size - known.size
        when {
            unknownCount == 0 && known.isNotEmpty() -> item.totalBytes = knownTotal
            // Some sizes are not known yet (the response headers of later parts have not
            // arrived): estimate them from the known ones so the percentage is determinate
            // instead of absent until the very last part. Never below what already arrived.
            known.isNotEmpty() -> item.totalBytes = maxOf(knownTotal + (knownTotal / known.size) * unknownCount, item.bytesDownloaded)
        }
    }

    private fun emitProgressThrottled(item: DownloadItem) {
        val now = System.currentTimeMillis()
        if (now - (lastEmit[item.id] ?: 0L) < PROGRESS_EMIT_INTERVAL_MS) return
        lastEmit[item.id] = now
        refreshAggregates(item)
        listener.onItemUpdated(item)
    }

    private fun manifestJsonFor(item: DownloadItem): String {
        val tracks = org.json.JSONArray()
        item.parts.sortedBy { it.trackIndex }.forEach { part ->
            tracks.put(
                org.json.JSONObject()
                    .put("trackIndex", part.trackIndex)
                    .put("filename", part.filename)
                    .put("path", part.finalDestinationPath)
                    .put("size", File(part.finalDestinationPath).takeIf { it.isFile }?.length() ?: part.bytesDownloaded)
                    .put("sizeVerified", part.contentLength > 0L)
            )
        }
        return org.json.JSONObject()
            .put("libraryItemId", item.libraryItemId)
            .put("title", item.title)
            .put("tracks", tracks)
            .toString()
    }

    private fun persist(item: DownloadItem, force: Boolean = false) {
        if (!force) return persistThrottled(item)
        lastPersist[item.id] = System.currentTimeMillis()
        repository.save(item)
    }

    private fun persistThrottled(item: DownloadItem) {
        val now = System.currentTimeMillis()
        if (now - (lastPersist[item.id] ?: 0L) < PERSIST_INTERVAL_MS) return
        lastPersist[item.id] = now
        repository.save(item)
    }

    private fun notifyQueueChanged() = listener.onQueueChanged(hasWork())

    private fun resolveUrl(serverUrl: String, path: String): String =
        if (path.startsWith("http://") || path.startsWith("https://")) path else "$serverUrl$path"

    companion object {
        const val MAX_CONCURRENT_PARTS = 3
        private const val PERSIST_INTERVAL_MS = 500L
        private const val PROGRESS_EMIT_INTERVAL_MS = 750L
        private val LOG: Logger = Logger.getLogger("DownloadItemManager")
        private val WAIT_STATES = setOf("waiting_for_network", "waiting_for_space")
        private val RESUMABLE_FROM_STATES = setOf("paused", "failed")
        private val RESUMABLE_WAIT_STATES = setOf("waiting_for_network", "waiting_for_space", "paused", "failed")
    }
}
