package com.landrop.server

import com.landrop.model.ChatMessage
import java.util.ArrayDeque
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

object MessageManager {

    /** 单房间保留的最大消息条数，避免历史无界增长 (S4) */
    private const val MAX_MESSAGES = 500

    // ArrayDeque + 显式加锁：CopyOnWriteArrayList 每次写入都要整表复制，消息多时开销很大
    private val messages = ArrayDeque<ChatMessage>()
    private val lock = Any()
    private val _messageFlow = MutableStateFlow<List<ChatMessage>>(emptyList())
    val messageFlow = _messageFlow.asStateFlow()

    var onMessageReceivedListener: ((ChatMessage) -> Unit)? = null

    fun getMessages(sinceTimestamp: Long = 0L): List<ChatMessage> {
        return synchronized(lock) {
            if (sinceTimestamp <= 0L) {
                messages.toList()
            } else {
                messages.filter { it.timestamp > sinceTimestamp }
            }
        }
    }

    private fun append(msg: ChatMessage) {
        synchronized(lock) {
            if (messages.any { it.id == msg.id }) return
            messages.addLast(msg)
            while (messages.size > MAX_MESSAGES) {
                messages.removeFirst()
            }
            _messageFlow.value = messages.toList()
        }
        onMessageReceivedListener?.invoke(msg)
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
        append(msg)
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
        append(msg)
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
        // append 内部会做去重，这里不再单独扫描一遍
        synchronized(lock) {
            if (messages.any { it.id == id }) return null
        }
        val msg = ChatMessage(
            id = id,
            senderName = senderName,
            content = content,
            timestamp = timestamp,
            isFromPhone = isFromPhone,
            senderIp = senderIp,
            clientId = clientId
        )
        append(msg)
        return msg
    }

    fun clearAll() {
        synchronized(lock) { messages.clear(); _messageFlow.value = emptyList() }
    }
}
