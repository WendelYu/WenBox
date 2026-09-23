package com.landrop.model

data class ChatMessage(
    val id: String,
    val senderName: String,
    val content: String,
    val timestamp: Long,
    val isFromPhone: Boolean,
    val senderIp: String = ""
)
