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

    fun addPhoneMessage(content: String, senderName: String = "📱 手机端"): ChatMessage {
        val msg = ChatMessage(
            id = UUID.randomUUID().toString(),
            senderName = senderName,
            content = content,
            timestamp = System.currentTimeMillis(),
            isFromPhone = true
        )
        messages.add(msg)
        onMessageReceivedListener?.invoke(msg)
        return msg
    }

    fun addClientMessage(content: String, senderName: String = "💻 电脑端"): ChatMessage {
        val msg = ChatMessage(
            id = UUID.randomUUID().toString(),
            senderName = senderName,
            content = content,
            timestamp = System.currentTimeMillis(),
            isFromPhone = false
        )
        messages.add(msg)
        onMessageReceivedListener?.invoke(msg)
        return msg
    }

    fun clearAll() {
        messages.clear()
    }
}
