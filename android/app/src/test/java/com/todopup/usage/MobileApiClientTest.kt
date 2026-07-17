package com.todopup.usage

import org.junit.Assert.assertThrows
import org.junit.Test

class MobileApiClientTest {
    @Test
    fun acceptsTailscaleHttpsOrigin() {
        MobileApiClient("https://mac.example.ts.net", "token")
    }

    @Test
    fun rejectsCleartextOrigin() {
        assertThrows(IllegalArgumentException::class.java) {
            MobileApiClient("http://mac.example.ts.net", "token")
        }
    }
}
