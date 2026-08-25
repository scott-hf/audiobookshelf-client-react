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
    override fun saveLocalItem(item: LocalLibraryItem) { localItems.add(item) }
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
        refreshToken: (String) -> String? = { token }
    ) = DownloadItemManager(
        repository = repository,
        httpClient = client,
        tokenProvider = { token },
        refreshToken = refreshToken,
        connectivity = connectivity,
        diskSpace = diskSpace,
        scope = CoroutineScope(SupervisorJob())
    )

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
}
