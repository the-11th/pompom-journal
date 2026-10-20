package com.todopup.usage

import java.net.URI

object MobileEndpoint {
    fun normalize(value: String): String = value.trim().trimEnd('/')

    fun requireAllowed(value: String): String {
        val normalized = normalize(value)
        val uri = runCatching { URI(normalized) }.getOrNull()
            ?: throw IllegalArgumentException("Invalid Datapom sync URL")
        val adbLoopback = uri.scheme == "http" && uri.host in setOf("127.0.0.1", "localhost") &&
            (uri.port == -1 || uri.port == 5001)
        require(adbLoopback) { "Datapom sync requires the USB helper" }
        return normalized
    }
}
