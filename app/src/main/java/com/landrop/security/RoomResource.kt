package com.landrop.security

import java.net.URI

/** Resolve only download resources in the captured room; credentials never belong in a URL. */
object RoomResource {
    fun resolve(origin: String, raw: String): String {
        val base = URI(origin)
        require(base.scheme in listOf("http", "https") && base.host != null && base.userInfo == null)
        val url = base.resolve(URI(raw))
        require(url.scheme.equals(base.scheme, true) && url.host.equals(base.host, true)
            && port(url) == port(base) && url.userInfo == null && url.fragment == null) { "附件地址不属于当前房间" }
        require(url.normalize().rawPath == url.rawPath && url.rawPath.startsWith("/api/download/")
            && url.path.removePrefix("/api/download/").let { it.isNotBlank() && it !in listOf(".", "..") && '/' !in it && '\\' !in it }) { "无效的附件地址" }
        return "${url.scheme}://${url.rawAuthority}${url.rawPath}"
    }

    private fun port(uri: URI) = if (uri.port >= 0) uri.port else if (uri.scheme.equals("https", true)) 443 else 80
}
