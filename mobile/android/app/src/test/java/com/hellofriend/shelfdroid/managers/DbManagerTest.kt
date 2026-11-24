package com.hellofriend.shelfdroid.managers

import com.hellofriend.shelfdroid.data.LocalLibraryItem
import com.hellofriend.shelfdroid.device.FolderScanner
import com.hellofriend.shelfdroid.models.DownloadItem
import com.hellofriend.shelfdroid.models.DownloadItemPart
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

private fun download(id: String, state: String) = DownloadItem(
    id = id,
    libraryItemId = "item-$id",
    title = "Title $id",
    serverConnectionId = "conn-1",
    bytesDownloaded = 10,
    totalBytes = 100,
    state = state
)

private fun localItem(libraryItemId: String) = LocalLibraryItem(
    libraryItemId = libraryItemId,
    serverConnectionId = "conn-1",
    folderUri = "/fake/local/$libraryItemId",
    manifestJson = """{"id":"$libraryItemId"}""",
    completedAt = 1_000L
)

class DbManagerTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private fun testDatabase(): DbManager = DbManager(tempFolder.root)

    @Test
    fun queueAndLocalItemRoundTripAcrossDatabaseReopen() {
        val first = testDatabase()
        first.saveDownload(download("b1", "running"))
        first.saveLocalItem(localItem("b2"))
        first.close()

        // "Reopen" = a fresh DbManager instance over the same directory -- nothing is cached in
        // memory between instances, matching the file-backed (not connection-backed) design.
        val reopened = testDatabase()
        assertEquals("running", reopened.downloads().single().state)
        assertEquals("b2", reopened.localItems().single().libraryItemId)
    }

    @Test
    fun schemaCreationStartsEmptyRatherThanFailing() {
        // No prior writes at all -- a fresh baseDir must not throw and must report empty
        // collections (the JSON-file equivalent of "schema created, no rows yet").
        val db = testDatabase()
        assertTrue(db.downloads().isEmpty())
        assertTrue(db.localItems().isEmpty())
    }

    @Test
    fun removingADownloadDropsOnlyThatRowAcrossReopen() {
        val first = testDatabase()
        first.saveDownload(download("b1", "running"))
        first.saveDownload(download("b2", "queued"))
        first.removeDownload("b1")
        first.close()

        val reopened = testDatabase()
        assertEquals(listOf("b2"), reopened.downloads().map { it.id })
    }

    @Test
    fun savingADownloadWithPartsPreservesThemAcrossReopen() {
        val part = DownloadItemPart(
            id = "p1",
            downloadItemId = "b1",
            trackIndex = 0,
            filename = "track-0.mp3",
            serverPath = "/api/items/item-b1/file/0",
            finalDestinationPath = File(tempFolder.root, "track-0.mp3").absolutePath,
            bytesDownloaded = 50,
            completed = false
        )
        val first = testDatabase()
        first.saveDownload(download("b1", "running").copy(parts = mutableListOf(part)))
        first.close()

        val reopened = testDatabase().downloads().single()
        assertEquals(1, reopened.parts.size)
        assertEquals("track-0.mp3", reopened.parts.single().filename)
        assertEquals(50L, reopened.parts.single().bytesDownloaded)
    }

    @Test
    fun presentationMetadataRoundTripsAndOlderRowsLoadWithDefaults() {
        val part = DownloadItemPart(
            id = "p1", downloadItemId = "b1", trackIndex = 0, filename = "track-0.mp3", serverPath = "/x",
            finalDestinationPath = File(tempFolder.root, "track-0.mp3").absolutePath, duration = 61.5
        )
        val rich = download("b1", "complete").copy(
            author = "Andy Weir", narrator = "Ray Porter", duration = 120.0, coverServerPath = "/api/items/b1/cover",
            coverPath = "/data/cover.jpg", chaptersJson = "[{\"id\":0,\"start\":0,\"end\":60,\"title\":\"One\"}]", parts = mutableListOf(part)
        )
        val first = testDatabase()
        first.saveDownload(rich)
        first.saveDownload(download("old", "queued"))
        first.close()

        val reopened = testDatabase().downloads().associateBy { it.id }
        val loaded = reopened.getValue("b1")
        assertEquals("Andy Weir", loaded.author)
        assertEquals("Ray Porter", loaded.narrator)
        assertEquals(120.0, loaded.duration, 0.0)
        assertEquals("/api/items/b1/cover", loaded.coverServerPath)
        assertEquals("/data/cover.jpg", loaded.coverPath)
        assertEquals(rich.chaptersJson, loaded.chaptersJson)
        assertEquals(61.5, loaded.parts.single().duration, 0.0)
        val plain = reopened.getValue("old")
        assertEquals(null, plain.author)
        assertEquals(null, plain.coverPath)
        assertEquals(0.0, plain.duration, 0.0)
    }

    // ---- FolderScanner: path confinement (security-relevant, per the dispatch's instructions) ----

    @Test
    fun finalInternalPathConfinesTraversalAttemptsUnderDownloadsRoot() {
        val filesDir = tempFolder.newFolder("files")
        val path = FolderScanner.finalInternalPath(filesDir, "../../etc", "../../passwd")

        val downloadsRoot = File(filesDir, "downloads").canonicalFile
        assertTrue(
            "expected $path to be confined under $downloadsRoot",
            path.canonicalFile.path.startsWith(downloadsRoot.path)
        )
        // Sanitization strips path separators/dots entirely rather than merely rejecting them.
        assertFalse(path.path.contains(".."))
    }

    @Test
    fun finalInternalPathIsStableForTheSameIds() {
        val filesDir = tempFolder.newFolder("files2")
        val a = FolderScanner.finalInternalPath(filesDir, "conn-1", "item-1")
        val b = FolderScanner.finalInternalPath(filesDir, "conn-1", "item-1")
        assertEquals(a, b)
    }

    // ---- FolderScanner: folder scan / missing file ----

    @Test
    fun scanInternalFolderFindsAudioFilesAndIgnoresOthers() {
        val dir = tempFolder.newFolder("scan")
        File(dir, "track-01.mp3").writeText("fake-audio")
        File(dir, "track-02.m4b").writeText("fake-audio-2")
        File(dir, "cover.jpg").writeText("fake-image")

        val found = FolderScanner.scanInternalFolder(dir)

        assertEquals(listOf("track-01.mp3", "track-02.m4b"), found.map { it.filename })
    }

    @Test
    fun scanInternalFolderOnMissingDirectoryReturnsEmpty() {
        val missing = File(tempFolder.root, "does-not-exist")
        assertTrue(FolderScanner.scanInternalFolder(missing).isEmpty())
    }

    @Test
    fun isPartFileMissingDetectsAnAbsentDownloadedFile() {
        val presentFile = tempFolder.newFile("present.mp3")
        val presentPart = DownloadItemPart(
            id = "p1",
            downloadItemId = "b1",
            trackIndex = 0,
            filename = "present.mp3",
            serverPath = "/x",
            finalDestinationPath = presentFile.absolutePath,
            completed = true
        )
        val missingPart = presentPart.copy(id = "p2", filename = "missing.mp3", finalDestinationPath = File(tempFolder.root, "missing.mp3").absolutePath)

        assertFalse(FolderScanner.isPartFileMissing(presentPart))
        assertTrue(FolderScanner.isPartFileMissing(missingPart))
    }

    // ---- Local library listing: missing / truncated files are not "downloaded" ----

    private fun localItemWithTrack(dir: File, size: Long?): LocalLibraryItem {
        val track = org.json.JSONObject().put("trackIndex", 0).put("filename", "track-0.mp3").put("path", File(dir, "track-0.mp3").absolutePath)
        if (size != null) track.put("size", size)
        val manifest = org.json.JSONObject().put("tracks", org.json.JSONArray().put(track)).toString()
        return LocalLibraryItem("item-x", "conn-1", dir.absolutePath, manifest, 1L)
    }

    @Test
    fun localItemWithAllFilesPresentIsIntact() {
        val dir = tempFolder.newFolder("intact")
        File(dir, "track-0.mp3").writeText("12345")
        assertTrue(FolderScanner.isLocalItemIntact(localItemWithTrack(dir, 5L)))
    }

    @Test
    fun localItemWithAMissingFileIsNotIntact() {
        val dir = tempFolder.newFolder("gone")
        assertFalse(FolderScanner.isLocalItemIntact(localItemWithTrack(dir, 5L)))
    }

    @Test
    fun localItemWithATruncatedFileIsNotIntact() {
        val dir = tempFolder.newFolder("truncated")
        File(dir, "track-0.mp3").writeText("123")
        assertFalse(FolderScanner.isLocalItemIntact(localItemWithTrack(dir, 5L)))
    }

    @Test
    fun localItemWithAnEmptyFileIsNotIntactEvenWhenSizeIsUnknown() {
        val dir = tempFolder.newFolder("empty")
        File(dir, "track-0.mp3").writeText("")
        assertFalse(FolderScanner.isLocalItemIntact(localItemWithTrack(dir, null)))
    }

    @Test
    fun localItemWithoutATrackListFallsBackToTheFolderContents() {
        val dir = tempFolder.newFolder("legacy")
        val legacy = LocalLibraryItem("item-y", "conn-1", dir.absolutePath, """{"title":"x"}""", 1L)
        assertFalse(FolderScanner.isLocalItemIntact(legacy))
        File(dir, "a.m4b").writeText("audio")
        assertTrue(FolderScanner.isLocalItemIntact(legacy))
    }

    // ---- Index durability: corrupt file, atomic write, concurrent writers ----

    @Test
    fun corruptDownloadsFileIsTreatedAsEmptyAndPreservedNotThrown() {
        File(tempFolder.root, "downloads.json").writeText("[{\"id\":\"b1\",")
        val db = testDatabase()

        assertTrue(db.downloads().isEmpty())
        assertTrue("a copy of the corrupt file must be kept", File(tempFolder.root, "downloads.json.corrupt").exists())

        // And the database is usable again afterwards.
        db.saveDownload(download("b2", "queued"))
        assertEquals(listOf("b2"), db.downloads().map { it.id })
    }

    @Test
    fun corruptLocalItemsFileIsTreatedAsEmpty() {
        File(tempFolder.root, "local_library_items.json").writeText("not json at all")
        assertTrue(testDatabase().localItems().isEmpty())
    }

    @Test
    fun oneMalformedRowDoesNotDiscardItsSiblings() {
        val good = org.json.JSONObject(
            """{"id":"ok","libraryItemId":"item-ok","title":"T","serverConnectionId":"c","bytesDownloaded":1,"totalBytes":2,"state":"queued","parts":[]}"""
        )
        File(tempFolder.root, "downloads.json").writeText("""[{"id":"broken"},$good]""")

        assertEquals(listOf("ok"), testDatabase().downloads().map { it.id })
    }

    @Test
    fun writesLeaveNoTempFileBehindAndReplaceTheTarget() {
        val db = testDatabase()
        db.saveDownload(download("b1", "running"))
        db.saveDownload(download("b1", "paused"))

        assertFalse(File(tempFolder.root, "downloads.json.tmp").exists())
        assertEquals("paused", testDatabase().downloads().single().state)
    }

    @Test
    fun concurrentWritersThroughSeparateInstancesLoseNoRows() {
        val threads = 8
        val perThread = 15
        val start = java.util.concurrent.CountDownLatch(1)
        val errors = java.util.concurrent.ConcurrentLinkedQueue<Throwable>()
        val workers = (0 until threads).map { t ->
            Thread {
                try {
                    start.await()
                    val db = testDatabase() // a fresh instance per writer, like the plugin layer does
                    repeat(perThread) { i ->
                        db.saveDownload(download("t$t-$i", "queued"))
                        db.saveLocalItem(localItem("t$t-$i"))
                        db.downloads() // interleave reads with writes
                    }
                } catch (e: Throwable) {
                    errors.add(e)
                }
            }.also { it.start() }
        }
        start.countDown()
        workers.forEach { it.join() }

        assertTrue("writers threw: $errors", errors.isEmpty())
        val db = testDatabase()
        assertEquals(threads * perThread, db.downloads().size)
        assertEquals(threads * perThread, db.localItems().size)
        assertFalse(File(tempFolder.root, "downloads.json.corrupt").exists())
    }
}
