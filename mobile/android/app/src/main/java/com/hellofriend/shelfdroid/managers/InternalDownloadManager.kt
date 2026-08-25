package com.hellofriend.shelfdroid.managers

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Streams one audio track into an app-owned `.part` staging file (WI-1496 t800 Task 3), adapted
 * from the donor app's `InternalDownloadManager.kt` down to a synchronous, OkHttp-direct call
 * (no Jackson/`Call`-callback plumbing) so `DownloadItemManager` can drive it from a coroutine
 * and unit-test every branch with MockWebServer on the JVM. `okhttp3` was NOT already a project
 * dependency despite the Task 3 dispatch's carried trap suggesting it might be via ExoPlayer --
 * t700's `PlayerNotificationService` uses ExoPlayer's own `DefaultHttpDataSource`
 * (`java.net.HttpURLConnection`-backed), not an OkHttp extension -- so `com.squareup.okhttp3:okhttp`
 * was added explicitly in `app/build.gradle` (see that file's Task 3 comment).
 */
class InternalDownloadManager(private val client: OkHttpClient) {

    /** Outcome of one [transferPart] attempt. [bytesDownloaded] is always the file's actual
     * on-disk length after the attempt, regardless of success/failure, so a caller can persist
     * an accurate resume offset either way. */
    sealed class Outcome {
        data class Success(val bytesDownloaded: Long, val contentLength: Long) : Outcome()
        data class Unauthorized(val bytesDownloaded: Long) : Outcome()
        data class Failure(val message: String, val bytesDownloaded: Long) : Outcome()
    }

    /**
     * Downloads (or resumes) [url] into [stagingFile]. Resumes automatically from the file's
     * existing on-disk length via a `Range` header when non-empty. [expectedSize] `<= 0` means
     * unknown (accepted from the response's `Content-Length` instead); a known, mismatched final
     * size is reported as [Outcome.Failure] rather than [Outcome.Success] -- callers must not
     * treat a short/long transfer as complete. [hasAvailableSpace] is polled between chunks so a
     * disk-exhaustion mid-transfer stops the write instead of filling the device.
     * [onCallCreated] fires synchronously right after the OkHttp [Call] is built (before it
     * blocks in `execute()`), giving a caller (`DownloadItemManager`) a handle to `Call.cancel()`
     * a transfer that a real, in-flight `pause()`/`cancel()` must stop immediately rather than
     * waiting for the blocking read loop to notice a cancelled coroutine `Job` -- a plain
     * `Job.cancel()` does not interrupt a synchronous `execute()`/`InputStream.read()` call.
     */
    fun transferPart(
        url: String,
        token: String,
        stagingFile: File,
        expectedSize: Long,
        hasAvailableSpace: () -> Boolean,
        onCallCreated: (Call) -> Unit = {},
        onProgress: (bytesDownloaded: Long) -> Unit
    ): Outcome {
        stagingFile.parentFile?.mkdirs()
        val existingBytes = stagingFile.takeIf { it.exists() }?.length() ?: 0L
        val request = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer $token")
            .apply { if (existingBytes > 0L) addHeader("Range", "bytes=$existingBytes-") }
            .build()
        val call = client.newCall(request)
        onCallCreated(call)

        return try {
            call.execute().use { response ->
                if (response.code == 401) return Outcome.Unauthorized(existingBytes)

                if (response.code == 416 && expectedSize > 0L && existingBytes == expectedSize) {
                    onProgress(existingBytes)
                    return Outcome.Success(existingBytes, expectedSize)
                }

                val append = existingBytes > 0L && response.code == 206
                if (existingBytes > 0L && !append && response.code != 200) {
                    return Outcome.Failure("Unexpected resume response ${response.code}", existingBytes)
                }
                if (!response.isSuccessful || response.body == null) {
                    return Outcome.Failure("HTTP ${response.code}", existingBytes)
                }

                val startBytes = if (append) existingBytes else 0L
                val responseLength = response.body!!.contentLength()
                val totalLength = when {
                    expectedSize > 0L -> expectedSize
                    responseLength >= 0L -> startBytes + responseLength
                    else -> -1L
                }

                var total = startBytes
                var spaceExhausted = false
                FileOutputStream(stagingFile, append).use { out ->
                    response.body!!.byteStream().use { input ->
                        val buffer = ByteArray(CHUNK_SIZE)
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            if (!hasAvailableSpace()) {
                                spaceExhausted = true
                                break
                            }
                            out.write(buffer, 0, read)
                            total += read
                            onProgress(total)
                        }
                    }
                }

                if (spaceExhausted) return Outcome.Failure("insufficient_space", total)

                val finalExpected = if (totalLength > 0L) totalLength else null
                if (finalExpected != null && total != finalExpected) {
                    Outcome.Failure("Byte count mismatch: expected $finalExpected got $total", total)
                } else {
                    Outcome.Success(total, finalExpected ?: total)
                }
            }
        } catch (e: IOException) {
            Outcome.Failure(e.message ?: "Transfer failed", stagingFile.takeIf { it.exists() }?.length() ?: existingBytes)
        }
    }

    private companion object {
        const val CHUNK_SIZE = 64 * 1024
    }
}
