package com.landrop.server

import com.landrop.model.ChatMessage
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

object MessageManager {

    private val messages = CopyOnWriteArrayList<ChatMessage>()

    var onMessageReceivedListener: ((ChatMessage) -> Unit)? = null

    fun getMessages(sinceTimestamp: Long = 0L): List<ChatMessage> {
        return if (sinceTimestamp <= 0L) {
            messages.toList()
        } else {
            messages.filter { it.timestamp > sinceTimestamp }
        }
    }

    fun addPhoneMessage(content: String, senderName: String = "本机", senderIp: String = "", clientId: String = ""): ChatMessage {
        val msg = ChatMessage(
            id = UUID.randomUUID().toString(),
            senderName = senderName,
            content = content,
            timestamp = System.currentTimeMillis(),
            isFromPhone = true,
            senderIp = senderIp,
            clientId = clientId
        )
        messages.add(msg)
        onMessageReceivedListener?.invoke(msg)
        return msg
    }

    fun addClientMessage(content: String, senderName: String = "成员", senderIp: String = "", clientId: String = ""): ChatMessage {
        val msg = ChatMessage(
            id = UUID.randomUUID().toString(),
            senderName = senderName,
            content = content,
            timestamp = System.currentTimeMillis(),
            isFromPhone = false,
            senderIp = senderIp,
            clientId = clientId
        )
        messages.add(msg)
        onMessageReceivedListener?.invoke(msg)
        return msg
    }

    fun addReceivedMessage(
        id: String,
        content: String,
        senderName: String,
        timestamp: Long,
        senderIp: String = "",
        isFromPhone: Boolean = false,
        clientId: String = ""
    ): ChatMessage? {
        if (messages.any { it.id == id }) return null
        val msg = ChatMessage(
            id = id,
            senderName = senderName,
            content = content,
            timestamp = timestamp,
            isFromPhone = isFromPhone,
            senderIp = senderIp,
            clientId = clientId
        )
        messages.add(msg)
        onMessageReceivedListener?.invoke(msg)
        return msg
    }

    fun clearAll() {
        messages.clear()
    }
}
