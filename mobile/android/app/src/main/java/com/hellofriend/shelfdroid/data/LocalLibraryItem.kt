package com.hellofriend.shelfdroid.data

/**
 * Native persistence row for a fully downloaded item (WI-1496 t800 Task 2), mirroring the TS
 * `LocalLibraryItem` contract (Task 1, `mobile/src/downloads/downloadTypes.ts`) field-for-field
 * -- `DbManager` is the only writer/reader, `AbsFileSystem.kt`'s `listLocalItems()` is the only
 * TS-facing reader. Deliberately much smaller than the donor's `data/LocalLibraryItem.kt` (a
 * full `LibraryItemWrapper` with cover/media/progress logic) -- this milestone stores the
 * pre-resolved ABS metadata JSON verbatim (`manifestJson`) rather than re-modeling it natively.
 */
data class LocalLibraryItem(
    val libraryItemId: String,
    val serverConnectionId: String,
    val folderUri: String,
    val manifestJson: String,
    val completedAt: Long
)
