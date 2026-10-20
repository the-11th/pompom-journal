package com.todopup.usage

import org.junit.Assert.assertThrows
import org.junit.Test

class MobileApiClientTest {
    @Test
    fun acceptsAdbLoopbackOrigin() {
        MobileApiClient("http://127.0.0.1:5001", "token")
    }

    @Test
    fun rejectsEveryNonUsbOrigin() {
        assertThrows(IllegalArgumentException::class.java) {
            MobileApiClient("https://mac.example.com", "token")
        }
        assertThrows(IllegalArgumentException::class.java) {
            MobileApiClient("http://192.168.1.10:5001", "token")
        }
    }
}
