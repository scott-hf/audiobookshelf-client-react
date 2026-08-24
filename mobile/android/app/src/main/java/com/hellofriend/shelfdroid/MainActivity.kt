package com.hellofriend.shelfdroid

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Must be registered before super.onCreate() so the WebView bridge sees it on first load.
        registerPlugin(SecureSessionPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
