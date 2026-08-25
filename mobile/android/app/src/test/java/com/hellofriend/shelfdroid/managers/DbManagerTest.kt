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
}
