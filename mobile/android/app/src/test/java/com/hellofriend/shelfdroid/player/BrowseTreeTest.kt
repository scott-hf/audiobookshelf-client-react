package com.hellofriend.shelfdroid.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** In-memory [BrowseRepository] fixture -- mirrors [DownloadItemManagerTest]'s `FakeRepository`
 * pattern (WI-1496 t900 Task 1). */
private fun repositoryFixture(): BrowseRepository = object : BrowseRepository {
    override fun continueListening() = listOf(BrowseBookEntry(id = "b1", title = "Book One", author = "Author A"))
    override fun libraries() = listOf(BrowseLibraryEntry(id = "lib1", title = "Library One"))
    override fun booksInLibrary(libraryId: String) =
        if (libraryId == "lib1") listOf(BrowseBookEntry(id = "b1", title = "Book One", author = "Author A")) else emptyList()
    override fun downloadedBooks() = listOf(BrowseBookEntry(id = "b1", title = "Book One", author = "Author A"))
}

class BrowseTreeTest {
    @Test
    fun rootContainsContinueListeningLibrariesAndDownloads() {
        val tree = BrowseTree(repositoryFixture())
        assertEquals(listOf("continue", "libraries", "downloads"), tree.children(BrowseTree.ROOT).map { it.mediaId })
        assertTrue(tree.item("book:b1")!!.isPlayable)
        assertFalse(tree.item("library:lib1")!!.isPlayable)
    }

    @Test
    fun continueListeningChildrenArePlayableBooks() {
        val tree = BrowseTree(repositoryFixture())
        val children = tree.children(BrowseTree.CONTINUE_ROOT)
        assertEquals(listOf("book:b1"), children.map { it.mediaId })
        assertTrue(children.all { it.isPlayable })
    }

    @Test
    fun librariesContainerListsLibrariesThenBooksNested() {
        val tree = BrowseTree(repositoryFixture())
        val libraries = tree.children(BrowseTree.LIBRARIES_ROOT)
        assertEquals(listOf("library:lib1"), libraries.map { it.mediaId })
        assertEquals(listOf("book:b1"), tree.children("library:lib1").map { it.mediaId })
    }

    @Test
    fun downloadsContainerListsDownloadedBooks() {
        val tree = BrowseTree(repositoryFixture())
        assertEquals(listOf("book:b1"), tree.children(BrowseTree.DOWNLOADS_ROOT).map { it.mediaId })
    }

    @Test
    fun searchIsCaseInsensitiveAndReturnsOnlyPlayableMatches() {
        val tree = BrowseTree(repositoryFixture())
        assertEquals(listOf("book:b1"), tree.search("book one").map { it.mediaId })
        assertEquals(listOf("book:b1"), tree.search("BOOK").map { it.mediaId })
        assertTrue(tree.search("nonexistent").isEmpty())
        assertTrue(tree.search("").isEmpty())
    }

    @Test
    fun mediaSessionPlaybackPreparerResolvesPlayableMediaIdAndSearch() {
        val tree = BrowseTree(repositoryFixture())
        var requested: String? = null
        val preparer = MediaSessionPlaybackPreparer(tree) { mediaId -> requested = mediaId }

        assertTrue(preparer.onPrepareFromMediaId("book:b1"))
        assertEquals("book:b1", requested)

        requested = null
        assertFalse(preparer.onPrepareFromMediaId("library:lib1"))
        assertEquals(null, requested)

        requested = null
        assertTrue(preparer.onPrepareFromSearch("Book One"))
        assertEquals("book:b1", requested)

        requested = null
        assertFalse(preparer.onPrepareFromSearch("nonexistent"))
        assertEquals(null, requested)
    }
}
