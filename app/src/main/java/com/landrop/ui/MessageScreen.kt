package com.landrop.ui

import com.landrop.model.ChatMessage

/** A local clear hides existing rows, without changing the room's authoritative history. */
class MessageScreen {
    private var roomId = ""
    private var hiddenIds = emptySet<String>()

    fun visible(room: String, messages: List<ChatMessage>): List<ChatMessage> {
        if (roomId != room) { roomId = room; hiddenIds = emptySet() }
        return messages.filterNot { it.id in hiddenIds }
    }

    fun clear(room: String, messages: List<ChatMessage>) {
        roomId = room
        hiddenIds = messages.map { it.id }.toSet()
    }
}
