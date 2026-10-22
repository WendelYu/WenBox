package com.landrop.security

object SafeFileName {
    fun sanitize(raw: String): String = raw.replace('\\', '/').substringAfterLast('/')
        .map { if (it.code < 32 || it in "<>:\"|?*") '_' else it }.joinToString("")
        .trim().trimEnd('.', ' ').take(180).ifBlank { "download.bin" }
}
