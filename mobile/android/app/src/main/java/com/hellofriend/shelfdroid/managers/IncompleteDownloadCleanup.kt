package com.hellofriend.shelfdroid.managers

import java.io.File

/**
 * Removes terminally failed downloads once their retention window elapses (WI-1496 t800 Task 3),
 * adapted from the donor app's WorkManager-scheduled `IncompleteDownloadCleanup` down to a
 * synchronous sweep run at `DownloadItemManager.restoreQueue()` time -- `androidx.work` isn't a
 * project dependency (same class of finding as Task 2's DbManager/FolderScanner "donor dependency
 * mismatch" writeup) and this milestone has no background-work infra to schedule a delayed sweep
 * against. A failed item is removed the next time the app restores its queue and 24h has elapsed
 * since it failed, rather than via an exact 24h-later scheduled job -- a deliberately looser but
 * still-real retention guarantee.
 */
object IncompleteDownloadCleanup {
    const val RETENTION_MS = 24L * 60L * 60L * 1000L

    fun sweep(repository: DownloadRepository, now: Long = System.currentTimeMillis()) {
        repository.downloads()
            .filter { item -> isEligible(item, now) }
            .forEach { item ->
                item.parts.forEach { part -> File(part.stagingPath).delete() }
                repository.remove(item.id)
            }
    }

    private fun isEligible(item: com.hellofriend.shelfdroid.models.DownloadItem, now: Long): Boolean {
        val failedAt = item.terminalFailureAt ?: return false
        return now - failedAt >= RETENTION_MS
    }
}
