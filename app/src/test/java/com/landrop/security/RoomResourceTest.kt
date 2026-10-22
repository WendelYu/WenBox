package com.landrop.security

import org.junit.Assert.*
import org.junit.Test

class RoomResourceTest {
    @Test fun relativeAndSameOriginAttachmentsStripAllQueryCredentials() {
        assertEquals("http://192.168.1.8:9527/api/download/file-id", RoomResource.resolve("http://192.168.1.8:9527", "/api/download/file-id?token=secret"))
        assertEquals("https://host/api/download/%E4%B8%AD%E6%96%87.txt", RoomResource.resolve("https://host", "https://host:443/api/download/%E4%B8%AD%E6%96%87.txt").replace(":443", ""))
    }

    @Test fun crossOriginSchemeUserInfoAndAmbiguousPathsAreRejected() {
        val origin = "http://192.168.1.8:9527"
        listOf("http://evil.example/api/download/id", "//evil.example/api/download/id", "http://192.168.1.8/api/download/id",
            "https://192.168.1.8:9527/api/download/id", "http://user@192.168.1.8:9527/api/download/id",
            "/api/messages", "/api/download/../messages", "/api/download/%2e%2e", "/api/download/id%2fother", "/api/download/id#fragment").forEach {
            assertThrows(it, IllegalArgumentException::class.java) { RoomResource.resolve(origin, it) }
        }
    }

    @Test fun traversalAndControlCharactersCannotBecomeOutputPaths() {
        assertEquals("secret.txt", SafeFileName.sanitize("../../secret.txt"))
        assertEquals("report.txt", SafeFileName.sanitize("C:\\temp\\report.txt"))
        assertEquals("download.bin", SafeFileName.sanitize(".."))
        assertEquals("bad_name_.txt", SafeFileName.sanitize("bad\u0000name?.txt"))
        assertEquals("中文发票.pdf", SafeFileName.sanitize("中文发票.pdf"))
    }
}
