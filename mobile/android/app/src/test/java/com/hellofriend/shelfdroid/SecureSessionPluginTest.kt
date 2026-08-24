package com.hellofriend.shelfdroid

import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.mockito.ArgumentCaptor
import org.mockito.Mockito.mock
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.Mockito.`when`

private class FakeSecureStore : SecureStore {
    private var value: String? = null
    override fun read(): String? = value
    override fun write(value: String) {
        this.value = value
    }
    override fun clear() {
        value = null
    }
}

class SecureSessionPluginTest {
    private lateinit var plugin: SecureSessionPlugin
    private lateinit var store: FakeSecureStore

    @Before
    fun setUp() {
        plugin = SecureSessionPlugin()
        store = FakeSecureStore()
        plugin.storeOverride = store
    }

    @Test
    fun writeThenReadRoundTripsTheSessionBlob() {
        val writeCall = mock(PluginCall::class.java)
        `when`(writeCall.getString("value")).thenReturn("""{"serverUrl":"https://books.test"}""")
        plugin.write(writeCall)
        verify(writeCall).resolve()

        val readCall = mock(PluginCall::class.java)
        plugin.read(readCall)
        val captor = ArgumentCaptor.forClass(JSObject::class.java)
        verify(readCall).resolve(captor.capture())
        assertEquals("""{"serverUrl":"https://books.test"}""", captor.value.getString("value"))
    }

    @Test
    fun readReturnsNoValueWhenNothingStored() {
        val readCall = mock(PluginCall::class.java)
        plugin.read(readCall)
        val captor = ArgumentCaptor.forClass(JSObject::class.java)
        verify(readCall).resolve(captor.capture())
        assertNull(captor.value.opt("value"))
    }

    @Test
    fun writeRejectsWhenValueMissing() {
        val call = mock(PluginCall::class.java)
        `when`(call.getString("value")).thenReturn(null)
        plugin.write(call)
        verify(call).reject("Missing 'value'")
        verify(call, never()).resolve()
    }

    @Test
    fun clearEmptiesTheStore() {
        store.write("something")
        val call = mock(PluginCall::class.java)
        plugin.clear(call)
        assertNull(store.read())
        verify(call).resolve()
    }
}
