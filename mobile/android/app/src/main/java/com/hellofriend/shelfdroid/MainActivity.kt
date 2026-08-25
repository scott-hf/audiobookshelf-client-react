package com.hellofriend.shelfdroid

import android.os.Bundle
import android.webkit.WebSettings
import com.getcapacitor.BridgeActivity
import com.hellofriend.shelfdroid.plugins.AbsAudioPlayer
import com.hellofriend.shelfdroid.plugins.AbsDatabase
import com.hellofriend.shelfdroid.plugins.AbsDownloader
import com.hellofriend.shelfdroid.plugins.AbsFileSystem

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Must be registered before super.onCreate() so the WebView bridge sees it on first load.
        registerPlugin(SecureSessionPlugin::class.java)
        registerPlugin(AbsAudioPlayer::class.java)
        // WI-1496 t800 Task 2: offline downloads' persistence + filesystem bridges.
        registerPlugin(AbsDatabase::class.java)
        registerPlugin(AbsFileSystem::class.java)
        // WI-1496 t800 Task 3: the foreground downloader bridge.
        registerPlugin(AbsDownloader::class.java)
        super.onCreate(savedInstanceState)

        // ShelfDroid connects to a user-supplied, self-hosted Audiobookshelf server address,
        // which is commonly plain HTTP. Capacitor serves the bundled app from a virtual
        // https://localhost origin, so Chromium's mixed-content policy blocks any http://
        // request from it regardless of the manifest's cleartext-traffic setting -- this is a
        // second, independent block from usesCleartextTraffic/network_security_config.
        bridge.webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
    }
}
