package com.hellofriend.shelfdroid.managers

import com.hellofriend.shelfdroid.data.LocalLibraryItem
import com.hellofriend.shelfdroid.models.DownloadItem
import com.hellofriend.shelfdroid.models.DownloadItemPart
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** In-memory [DownloadRepository] fake -- gives tests direct assertion access to persisted rows
 * without depending on `DbManager`'s JSON round trip (that round trip is `DbManagerTest`'s job,
 * Task 2). */
private class FakeRepository : DownloadRepository {
    val items = LinkedHashMap<String, DownloadItem>()
    val localItems = mutableListOf<LocalLibraryItem>()
    override fun downloads(): List<DownloadItem> = items.values.toList()
    override fun save(item: DownloadItem) { items[item.id] = item }
    override fun remove(id: String) { items.remove(id) }
    override fun saveLocalItem(item: LocalLibraryItem) {
        localItems.removeAll { it.libraryItemId == item.libraryItemId }
        localItems.add(item)
    }
    override fun localItems(): List<LocalLibraryItem> = localItems.toList()
    override fun removeLocalItem(libraryItemId: String) { localItems.removeAll { it.libraryItemId == libraryItemId } }
}

class DownloadItemManagerTest {
    private lateinit var server: MockWebServer
    private lateinit var tempDir: File
    private lateinit var repository: FakeRepository
    private lateinit var client: OkHttpClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        tempDir = File.createTempFile("download-manager-test", "").apply {
            delete()
            mkdirs()
        }
        repository = FakeRepository()
        client = OkHttpClient()
    }

    @After
    fun tearDown() {
        server.shutdown()
        tempDir.deleteRecursively()
    }

    private fun manager(
        token: String? = "token-1",
        connectivity: ConnectivityPolicy = ConnectivityPolicy { true },
        diskSpace: DiskSpacePolicy = DiskSpacePolicy { true },
        refreshToken: (String) -> String? = { token },
        tokenProvider: ((String) -> String?)? = null,
        listener: DownloadEventListener = DownloadEventListener.NOOP,
        maxConcurrentParts: Int = DownloadItemManager.MAX_CONCURRENT_PARTS
    ) = DownloadItemManager(
        repository = repository,
        httpClient = client,
        tokenProvider = tokenProvider ?: { token },
        refreshToken = refreshToken,
        connectivity = connectivity,
        diskSpace = diskSpace,
        listener = listener,
        scope = CoroutineScope(SupervisorJob()),
        maxConcurrentParts = maxConcurrentParts
    )

    private fun completedPart(id: String): DownloadItemPart {
        val final = File(tempDir, "final/$id.mp3").apply {
            parentFile?.mkdirs()
            writeText("audio")
        }
        return part(id, contentLength = 5L, state = "complete").copy(completed = true, bytesDownloaded = 5L, finalDestinationPath = final.absolutePath)
    }

    private fun part(id: String, existingBytes: Long = 0L, contentLength: Long = -1L, state: String = "queued"): DownloadItemPart {
        val staging = File(tempDir, "$id.mp3.part")
        if (existingBytes > 0L) staging.writeBytes(ByteArray(existingBytes.toInt()) { 1 })
        return DownloadItemPart(
            id = id,
            downloadItemId = "item-1",
            trackIndex = 0,
            filename = "$id.mp3",
            serverPath = "/track/$id",
            finalDestinationPath = File(tempDir, "final/$id.mp3").absolutePath,
            stagingPath = staging.absolutePath,
            bytesDownloaded = existingBytes,
            contentLength = contentLength,
            state = state
        )
    }

    private fun item(vararg parts: DownloadItemPart) = DownloadItem(
        id = "item-1",
        libraryItemId = "lib-1",
        title = "Test Book",
        serverConnectionId = "conn-1",
        serverUrl = server.url("/").toString().trimEnd('/'),
        parts = parts.toMutableList()
    )

    @Test
    fun interruptedPartResumesFromPersistedByteOffset() = runTest {
        val remaining = "REST-OF-BODY"
        server.enqueue(
            MockResponse().setResponseCode(206)
                .setHeader("Content-Range", "bytes 1024-${1024 + remaining.length - 1}/${1024 + remaining.length}")
                .setBody(remaining)
        )
        val p = part("p1", existingBytes = 1024L, contentLength = (1024 + remaining.length).toLong())
        repository.save(item(p))

        val manager = manager()
        manager.restoreQueue()
        manager.awaitIdle()

        val request = server.takeRequest()
        assertEquals("bytes=1024-", request.getHeader("Range"))
        assertEquals("complete", manager.item("item-1")?.parts?.first { it.id == "p1" }?.state)
    }

    @Test
    fun unauthorizedResponseRefreshesTokenAndRetries() = runTest {
        server.enqueue(MockResponse().setResponseCode(401))
        server.enqueue(MockResponse().setResponseCode(200).setBody("full-body"))
        val p = part("p1", contentLength = "full-body".length.toLong())

        val manager = manager(token = "stale", refreshToken = { "fresh" })
        manager.enqueue(item(p))
        manager.awaitIdle()

        assertEquals(2, server.requestCount)
        assertEquals("Bearer stale", server.takeRequest().getHeader("Authorization"))
        assertEquals("Bearer fresh", server.takeRequest().getHeader("Authorization"))
        assertEquals("complete", manager.item("item-1")?.parts?.first()?.state)
    }

    @Test
    fun repeatedUnauthorizedFailsAfterOneRefreshAttempt() = runTest {
        server.enqueue(MockResponse().setResponseCode(401))
        server.enqueue(MockResponse().setResponseCode(401))
        val p = part("p1", contentLength = 10L)

        val manager = manager(token = "stale", refreshToken = { "still-stale" })
        manager.enqueue(item(p))
        manager.awaitIdle()

        assertEquals("failed", manager.item("item-1")?.parts?.first()?.state)
        assertEquals("Authentication failed", manager.item("item-1")?.error)
    }

    @Test
    fun byteCountMismatchIsDetectedAndFailsThePart() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("short"))
        val p = part("p1", contentLength = 999L)

        val manager = manager()
        manager.enqueue(item(p))
        manager.awaitIdle()

        val updated = manager.item("item-1")?.parts?.first()
        assertEquals("failed", updated?.state)
        assertTrue(updated?.let { manager.item("item-1")?.error }?.contains("Byte count mismatch") == true)
    }

    @Test
    fun processRestoreReloadsPersistedQueueAndResumesTransfers() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("hello"))
        val p = part("p1", contentLength = "hello".length.toLong())
        repository.save(item(p))

        val manager = manager()
        manager.restoreQueue()
        manager.awaitIdle()

        assertEquals("complete", repository.items["item-1"]?.parts?.first()?.state)
        assertEquals(1, repository.localItems.size)
        assertEquals("lib-1", repository.localItems.first().libraryItemId)
    }

    @Test
    fun cancelStopsTransferAndDeletesStagingFile() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("body").setBodyDelay(2, java.util.concurrent.TimeUnit.SECONDS))
        val p = part("p1", contentLength = 4L)
        val stagingFile = File(p.stagingPath)

        val manager = manager()
        manager.enqueue(item(p))
        manager.cancel("item-1")

        assertFalse(stagingFile.exists())
        assertEquals(null, manager.item("item-1"))
        assertTrue(repository.downloads().isEmpty())
    }

    @Test
    fun diskExhaustionBeforeStartWaitsForSpaceInsteadOfFailing() = runTest {
        val p = part("p1", contentLength = 10L)
        val manager = manager(diskSpace = DiskSpacePolicy { false })
        manager.enqueue(item(p))
        manager.awaitIdle()

        assertEquals("waiting_for_space", manager.item("item-1")?.parts?.first()?.state)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun wifiOnlyPolicyGatesTransferInsteadOfFailing() = runTest {
        val p = part("p1", contentLength = 10L)
        val manager = manager(connectivity = ConnectivityPolicy { false })
        manager.enqueue(item(p))
        manager.awaitIdle()

        assertEquals("waiting_for_network", manager.item("item-1")?.parts?.first()?.state)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun completionRenamesStagingFileIntoFinalDestination() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("final-bytes"))
        val p = part("p1", contentLength = "final-bytes".length.toLong())
        val stagingFile = File(p.stagingPath)
        val finalFile = File(p.finalDestinationPath)

        val manager = manager()
        manager.enqueue(item(p))
        manager.awaitIdle()

        assertFalse(stagingFile.exists())
        assertTrue(finalFile.exists())
        assertEquals("final-bytes", finalFile.readText())
    }

    // ---- Fix 1: deleted books must not resurrect ----

    @Test
    fun restoreSkipsAllCompletedRowWithNoLocalItem() = runTest {
        repository.save(item(completedPart("p1")).also { it.state = "complete" })

        val manager = manager()
        manager.restoreQueue()
        manager.awaitIdle()

        assertEquals(null, manager.item("item-1"))
        assertTrue("stale row must be dropped from the persisted queue", repository.items.isEmpty())
        assertTrue("restore must not re-register a book with no files", repository.localItems.isEmpty())
    }

    @Test
    fun restoreKeepsCompletedRowThatHasALocalItemWithoutFinishingItTwice() = runTest {
        repository.save(item(completedPart("p1")).also { it.state = "complete" })
        repository.saveLocalItem(LocalLibraryItem("lib-1", "conn-1", tempDir.absolutePath, "{}", 1L))
        var completeEvents = 0

        val manager = manager(listener = object : DownloadEventListener {
            override fun onItemComplete(item: DownloadItem) {
                completeEvents++
            }
        })
        manager.restoreQueue()
        manager.awaitIdle()

        assertEquals("complete", manager.item("item-1")?.state)
        assertEquals(0, completeEvents)
        assertEquals(1, repository.localItems.size)
    }

    @Test
    fun restoreStillFinishesAnItemInterruptedBetweenLastPartAndLocalRow() = runTest {
        // Every file landed but the process died before finishItem ran: state is not "complete".
        repository.save(item(completedPart("p1")))

        val manager = manager()
        manager.restoreQueue()
        manager.awaitIdle()

        assertEquals("complete", manager.item("item-1")?.state)
        assertEquals(1, repository.localItems.size)
    }

    @Test
    fun removeDownloadedThenRestartDoesNotResurrectAndRedownloadWorks() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("hello"))
        val first = part("p1", contentLength = 5L)
        val manager = manager()
        manager.enqueue(item(first))
        manager.awaitIdle()
        assertEquals(1, repository.localItems.size)
        assertTrue(File(first.finalDestinationPath).exists())

        manager.removeDownloaded("lib-1")

        assertEquals(null, manager.item("item-1"))
        assertTrue(repository.items.isEmpty())
        assertTrue(repository.localItems.isEmpty())
        assertFalse(File(first.finalDestinationPath).exists())

        // "Restart": a fresh manager over the same persisted state sees nothing to restore.
        val restarted = manager()
        restarted.restoreQueue()
        restarted.awaitIdle()
        assertEquals(null, restarted.item("item-1"))
        assertTrue(repository.localItems.isEmpty())

        // Re-download of the same id is no longer blocked by a stale queue entry.
        server.enqueue(MockResponse().setResponseCode(200).setBody("hello"))
        restarted.enqueue(item(part("p1", contentLength = 5L)))
        restarted.awaitIdle()
        assertEquals("complete", restarted.item("item-1")?.state)
        assertEquals(1, repository.localItems.size)
    }

    @Test
    fun enqueueOverACompletedRowStartsOver() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("hello"))
        val manager = manager()
        manager.enqueue(item(part("p1", contentLength = 5L)))
        manager.awaitIdle()

        server.enqueue(MockResponse().setResponseCode(200).setBody("again"))
        manager.enqueue(item(part("p1", contentLength = 5L)))
        manager.awaitIdle()

        assertEquals(2, server.requestCount)
        assertEquals("complete", manager.item("item-1")?.state)
    }

    // ---- Fix 4: resume of a failed item ----

    @Test
    fun resumeRequeuesAFailedPartAndClearsTheFailure() = runTest {
        server.enqueue(MockResponse().setResponseCode(500))
        server.enqueue(MockResponse().setResponseCode(200).setBody("hello"))
        val manager = manager()
        manager.enqueue(item(part("p1", contentLength = 5L)))
        manager.awaitIdle()
        assertEquals("failed", manager.item("item-1")?.state)
        assertTrue(manager.item("item-1")?.terminalFailureAt != null)

        manager.resume("item-1")
        manager.awaitIdle()

        val resumed = manager.item("item-1")!!
        assertEquals("complete", resumed.state)
        assertEquals(null, resumed.error)
        assertEquals(null, resumed.terminalFailureAt)
        assertEquals(1, repository.localItems.size)
    }

    // ---- Fix 5: tokens after a restart ----

    @Test
    fun noTokenFailsFastWithoutSendingABearerlessRequest() = runTest {
        val manager = manager(tokenProvider = { null })
        manager.enqueue(item(part("p1", contentLength = 5L)))
        manager.awaitIdle()

        assertEquals(0, server.requestCount)
        assertEquals("failed", manager.item("item-1")?.state)
        assertEquals("Authentication failed", manager.item("item-1")?.error)
    }

    @Test
    fun reEnqueueOfAFailedItemPicksUpTheFreshTokenAndCompletes() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("hello"))
        var token: String? = null
        val manager = manager(tokenProvider = { token }, refreshToken = { token })
        manager.enqueue(item(part("p1", contentLength = 5L)))
        manager.awaitIdle()
        assertEquals("failed", manager.item("item-1")?.state)

        token = "fresh"
        manager.enqueue(item(part("p1", contentLength = 5L)))
        manager.awaitIdle()

        assertEquals("Bearer fresh", server.takeRequest().getHeader("Authorization"))
        assertEquals("complete", manager.item("item-1")?.state)
    }

    @Test
    fun restoredQueueUsesTheTokenProviderNotAPersistedToken() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("hello"))
        repository.save(item(part("p1", contentLength = 5L)))

        val manager = manager(tokenProvider = { "from-vault" })
        manager.restoreQueue()
        manager.awaitIdle()

        assertEquals("Bearer from-vault", server.takeRequest().getHeader("Authorization"))
    }

    // ---- Fix 6: parked parts retry when the network comes back ----

    @Test
    fun retryWaitingRestartsPartsParkedOnTheNetwork() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("hello"))
        var online = false
        val manager = manager(connectivity = ConnectivityPolicy { online })
        manager.enqueue(item(part("p1", contentLength = 5L)))
        manager.awaitIdle()
        assertEquals("waiting_for_network", manager.item("item-1")?.state)

        online = true
        manager.retryWaiting()
        manager.awaitIdle()

        assertEquals("complete", manager.item("item-1")?.state)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun retryWaitingKeepsPartsParkedWhileStillOffline() = runTest {
        val manager = manager(connectivity = ConnectivityPolicy { false })
        manager.enqueue(item(part("p1", contentLength = 5L)))
        manager.awaitIdle()
        manager.retryWaiting()
        manager.awaitIdle()

        assertEquals("waiting_for_network", manager.item("item-1")?.parts?.first()?.state)
        assertEquals(0, server.requestCount)
    }

    // ---- Fix 7: progress during a transfer ----

    @Test
    fun progressIsEmittedWhileAPartIsStillTransferring() = runTest {
        val body = ByteArray(200_000) { 7 }
        server.enqueue(MockResponse().setResponseCode(200).setBody(okio.Buffer().write(body)))
        val seen = java.util.Collections.synchronizedList(mutableListOf<Triple<String, Long, Long>>())
        val manager = manager(listener = object : DownloadEventListener {
            override fun onItemUpdated(item: DownloadItem) {
                seen.add(Triple(item.state, item.bytesDownloaded, item.totalBytes))
            }
        })
        // contentLength unknown up front: the percentage must come from the response header.
        manager.enqueue(item(part("p1")))
        manager.awaitIdle()

        assertTrue(
            "expected a running update with a known total before completion, saw $seen",
            seen.any { (state, bytes, total) -> state == "running" && bytes > 0L && total == body.size.toLong() }
        )
    }

    // ---- Fix 8: concurrency cap, size verification ----

    @Test
    fun concurrentPartTransfersAreCapped() = runTest {
        val active = java.util.concurrent.atomic.AtomicInteger(0)
        val peak = java.util.concurrent.atomic.AtomicInteger(0)
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                val now = active.incrementAndGet()
                peak.updateAndGet { maxOf(it, now) }
                Thread.sleep(150)
                active.decrementAndGet()
                return MockResponse().setResponseCode(200).setBody("hello")
            }
        }
        val parts = (1..6).map { part("p$it", contentLength = 5L) }.toTypedArray()
        val manager = manager(maxConcurrentParts = 2)
        manager.enqueue(item(*parts))
        manager.awaitIdle()

        assertEquals("complete", manager.item("item-1")?.state)
        assertTrue("peak concurrency ${peak.get()} exceeded the cap", peak.get() <= 2)
    }

    @Test
    fun responseWithNoSizeAnywhereCompletesButStaysMarkedUnverified() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setChunkedBody("chunked-body", 4))
        val manager = manager()
        manager.enqueue(item(part("p1")))
        manager.awaitIdle()

        val done = manager.item("item-1")!!
        assertEquals("complete", done.state)
        assertEquals("part keeps contentLength -1 so the lack of a check stays explicit", -1L, done.parts.first().contentLength)
        assertTrue(repository.localItems.first().manifestJson.contains("\"sizeVerified\":false"))
        assertEquals(done.bytesDownloaded, done.totalBytes)
    }
}
