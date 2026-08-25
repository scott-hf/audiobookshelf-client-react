package com.hellofriend.shelfdroid.player

/**
 * Read-only Android Auto / media-browser tree (WI-1496 t900 Task 1). Adapted from the donor
 * app's `player/BrowseTree.kt`, which builds `MediaMetadataCompat` rows straight off a live
 * `MediaManager`/Room-backed library -- this repo has neither yet, so [BrowseTree] is a plain
 * JVM-testable core (no `android.*` types, same "testable core, thin Android shell" pattern as
 * `PlayerStateReducer`/`PlaybackStateStore`) built over a small [BrowseRepository] seam instead:
 * the real implementation (wired later, outside this task's 6-file scope) will read the JS
 * side's cached ABS shelves plus this repo's own `DbManager`-backed offline catalog
 * (`LocalLibraryItem` rows from t800); tests substitute a fixture.
 *
 * Deliberately excludes any acquisition/download-initiation affordance: every [BrowseItem] here
 * is either a read-only container or an already-known/cached playable book -- browsing and voice
 * search never trigger the gateway's download-initiation flow.
 */
data class BrowseItem(
    val mediaId: String,
    val title: String,
    val subtitle: String? = null,
    val isPlayable: Boolean
)

data class BrowseLibraryEntry(val id: String, val title: String)

data class BrowseBookEntry(val id: String, val title: String, val author: String? = null)

/** What [BrowseTree] needs from the local catalog / cached ABS shelves. Kept as a plain
 * interface so production wiring (JS-cache-backed) and test fixtures can each supply it without
 * [BrowseTree] depending on either concretely. */
interface BrowseRepository {
    fun continueListening(): List<BrowseBookEntry>
    fun libraries(): List<BrowseLibraryEntry>
    fun booksInLibrary(libraryId: String): List<BrowseBookEntry>
    fun downloadedBooks(): List<BrowseBookEntry>
}

class BrowseTree(private val repository: BrowseRepository) {
    private val itemsById = mutableMapOf<String, BrowseItem>()
    private val childrenById = mutableMapOf<String, MutableList<BrowseItem>>()

    init {
        build()
    }

    fun children(mediaId: String): List<BrowseItem> = childrenById[mediaId] ?: emptyList()

    fun item(mediaId: String): BrowseItem? = itemsById[mediaId]

    /** Voice search: normalizes [query] and returns matching playable items only (never a
     * container) -- read-only against already-known/cached items, exactly like browsing. */
    fun search(query: String): List<BrowseItem> {
        val normalized = query.trim().lowercase()
        if (normalized.isEmpty()) return emptyList()
        return itemsById.values.filter { it.isPlayable && it.title.lowercase().contains(normalized) }
    }

    private fun build() {
        val root = mutableListOf<BrowseItem>()
        addContainer(root, CONTINUE_ROOT, "Continue Listening")
        addContainer(root, LIBRARIES_ROOT, "Libraries")
        addContainer(root, DOWNLOADS_ROOT, "Downloads")
        childrenById[ROOT] = root

        repository.continueListening().forEach { addBook(CONTINUE_ROOT, it) }

        val libraryItems = mutableListOf<BrowseItem>()
        repository.libraries().forEach { library ->
            val libraryMediaId = libraryMediaId(library.id)
            val libraryItem = BrowseItem(libraryMediaId, library.title, isPlayable = false)
            itemsById[libraryMediaId] = libraryItem
            libraryItems += libraryItem
            repository.booksInLibrary(library.id).forEach { addBook(libraryMediaId, it) }
        }
        childrenById[LIBRARIES_ROOT] = libraryItems

        repository.downloadedBooks().forEach { addBook(DOWNLOADS_ROOT, it) }
    }

    private fun addContainer(root: MutableList<BrowseItem>, mediaId: String, title: String) {
        val item = BrowseItem(mediaId, title, isPlayable = false)
        itemsById[mediaId] = item
        root += item
    }

    private fun addBook(parentId: String, book: BrowseBookEntry) {
        val mediaId = bookMediaId(book.id)
        val item = BrowseItem(mediaId, book.title, book.author, isPlayable = true)
        itemsById[mediaId] = item
        val children = childrenById.getOrPut(parentId) { mutableListOf() }
        if (children.none { it.mediaId == mediaId }) children += item
    }

    companion object {
        const val ROOT = "/"
        const val CONTINUE_ROOT = "continue"
        const val LIBRARIES_ROOT = "libraries"
        const val DOWNLOADS_ROOT = "downloads"

        fun bookMediaId(bookId: String) = "book:$bookId"
        fun libraryMediaId(libraryId: String) = "library:$libraryId"
    }
}
