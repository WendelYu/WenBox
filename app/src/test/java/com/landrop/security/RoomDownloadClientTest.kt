package com.landrop.security

import org.junit.Assert.*
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class RoomDownloadClientTest {
    @Test fun streamsPayloadAndSendsTokenOnlyInHeader() {
        ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { server ->
            val executor = Executors.newSingleThreadExecutor()
            try {
                val received = executor.submit<List<String>> {
                    server.accept().use { socket ->
                        val reader = socket.getInputStream().bufferedReader()
                        val lines = mutableListOf<String>()
                        while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break; lines += line }
                        socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello".toByteArray())
                        lines
                    }
                }
                val origin = "http://127.0.0.1:${server.localPort}"
                val result = RoomDownloadClient.download(origin, "/api/download/id?token=old-query", "header-secret") { it.bufferedReader().readText() }
                assertEquals("hello", result)
                val headers = received.get(5, TimeUnit.SECONDS)
                assertEquals("GET /api/download/id HTTP/1.1", headers.first())
                assertTrue(headers.any { it.equals("X-Room-Token: header-secret", true) })
            } finally { executor.shutdownNow() }
        }
    }

    @Test fun redirectCannotForwardRoomCredentialsToAnotherHost() {
        ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { target ->
            target.soTimeout = 300
            ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { server ->
                val executor = Executors.newSingleThreadExecutor()
                try {
                    val response = executor.submit {
                        server.accept().use { socket ->
                            val reader = socket.getInputStream().bufferedReader()
                            while (!reader.readLine().isNullOrEmpty()) { /* Consume headers. */ }
                            socket.getOutputStream().write("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:${target.localPort}/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                        }
                    }
                    assertThrows(IllegalStateException::class.java) {
                        RoomDownloadClient.download("http://127.0.0.1:${server.localPort}", "/api/download/id", "secret") { it.read() }
                    }
                    response.get(5, TimeUnit.SECONDS)
                    assertThrows(SocketTimeoutException::class.java) { target.accept().close() }
                } finally { executor.shutdownNow() }
            }
        }
    }
}
