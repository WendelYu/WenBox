package com.landrop.model

import android.net.Uri

data class SharedFile(
    val id: String,
    val name: String,
    val size: Long,
    val mimeType: String,
    val uri: Uri
)
