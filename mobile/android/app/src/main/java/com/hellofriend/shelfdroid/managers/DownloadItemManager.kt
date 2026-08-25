package com.hellofriend.shelfdroid.managers

import com.hellofriend.shelfdroid.data.LocalLibraryItem
import com.hellofriend.shelfdroid.models.DownloadItem
import com.hellofriend.shelfdroid.models.DownloadItemPart
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
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
}

class DbManagerDownloadRepository(private val dbManager: DbManager) : DownloadRepository {
    override fun downloads(): List<DownloadItem> = dbManager.downloads()
    override fun save(item: DownloadItem) = dbManager.saveDownload(item)
    override fun remove(id: String) = dbManager.removeDownload(id)
    override fun saveLocalItem(item: LocalLibraryItem) = dbManager.saveLocalItem(item)
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

/** Wi-Fi-only download policy seam -- the real implementation (wired by `AbsDownloader`) checks
 * `ConnectivityManager`; tests substitute a controllable fake so "waiting_for_network" gating is
 * exercised without a `Context`. */
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
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
) {
    private val transfer = InternalDownloadManager(httpClient)
    private val queue = ConcurrentHashMap<String, DownloadItem>()
    private val jobs = ConcurrentHashMap<String, Job>()
    private val activeCalls = ConcurrentHashMap<String, Call>()
    private val lastPersist = ConcurrentHashMap<String, Long>()
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
        IncompleteDownloadCleanup.sweep(repository)
        repository.downloads().forEach { item ->
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

    @Synchronized
    fun enqueue(item: DownloadItem) {
        if (queue.containsKey(item.id)) return
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
        item.parts.filter { !it.completed && it.state == "paused" }.forEach { it.state = "queued" }
        item.state = "running"
        repository.save(item)
        listener.onItemUpdated(item)
        startNextParts(item)
    }

    @Synchronized
    fun cancel(id: String) {
        cancelledIds.add(id)
        val item = queue.remove(id) ?: return
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
            finishItem(item)
            return
        }
        item.parts.filter { !it.completed && it.state != "paused" && it.state != "failed" }.forEach { part ->
            if (jobs.containsKey(part.id)) return@forEach
            jobs[part.id] = scope.launch { runPart(item, part) }
        }
    }

    private suspend fun runPart(item: DownloadItem, part: DownloadItemPart) {
        try {
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

            part.state = "running"
            item.state = "running"
            persist(item, force = true)

            val url = resolveUrl(item.serverUrl, part.serverPath)
            var token = tokenProvider(item.id) ?: ""
            var outcome = transferOnIo(url, token, stagingFile, part, item)

            if (outcome is InternalDownloadManager.Outcome.Unauthorized) {
                val refreshed = refreshToken(item.id)
                if (refreshed != null && refreshed != token) {
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
                is InternalDownloadManager.Outcome.Success -> completePart(item, part, result.bytesDownloaded, result.contentLength)
                is InternalDownloadManager.Outcome.Unauthorized -> failPart(item, part, "Authentication failed")
                is InternalDownloadManager.Outcome.Failure -> failPart(item, part, result.message)
            }
        } finally {
            jobs.remove(part.id)
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
                onProgress = { bytes ->
                    part.bytesDownloaded = bytes
                    persistThrottled(item)
                }
            )
        } finally {
            activeCalls.remove(part.id)
        }
    }

    private fun completePart(item: DownloadItem, part: DownloadItemPart, bytes: Long, contentLength: Long) {
        val staging = File(part.stagingPath)
        val final = File(part.finalDestinationPath)
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
        if (part.contentLength <= 0L) part.contentLength = contentLength
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
        part.state = state
        persist(item, force = true)
        listener.onItemUpdated(item)
        notifyQueueChanged()
    }

    private fun finishItem(item: DownloadItem) {
        item.state = "complete"
        item.error = null
        item.terminalFailureAt = null
        refreshAggregates(item)
        persist(item, force = true)
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
        listener.onItemComplete(item)
        notifyQueueChanged()
    }

    private fun refreshAggregates(item: DownloadItem) {
        item.bytesDownloaded = item.parts.sumOf { it.bytesDownloaded }
        val knownTotal = item.parts.sumOf { if (it.contentLength > 0L) it.contentLength else 0L }
        if (item.parts.all { it.contentLength > 0L }) item.totalBytes = knownTotal
    }

    private fun manifestJsonFor(item: DownloadItem): String {
        val tracks = org.json.JSONArray()
        item.parts.sortedBy { it.trackIndex }.forEach { part ->
            tracks.put(
                org.json.JSONObject()
                    .put("trackIndex", part.trackIndex)
                    .put("filename", part.filename)
                    .put("path", part.finalDestinationPath)
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

    private companion object {
        const val PERSIST_INTERVAL_MS = 500L
        val RESUMABLE_WAIT_STATES = setOf("waiting_for_network", "waiting_for_space", "paused", "failed")
    }
}
