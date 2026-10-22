package com.landrop.ui

import com.landrop.model.ChatMessage
import org.junit.Assert.*
import org.junit.Test

class MessageScreenTest {
    private fun message(id: String) = ChatMessage(id, "member", "text", 1, false)

    @Test fun clearingHidesExistingRowsAndPreservesAuthoritativeHistory() {
        val history = listOf(message("one"), message("two"))
        val screen = MessageScreen()
        screen.clear("room", history)
        assertTrue(screen.visible("room", history).isEmpty())
        assertEquals(2, history.size)
    }

    @Test fun pollingAfterClearShowsOnlyNewMessages() {
        val first = message("one"); val second = message("two")
        val screen = MessageScreen(); screen.clear("room", listOf(first))
        assertEquals(listOf(second), screen.visible("room", listOf(first, second)))
    }

    @Test fun anotherRoomDoesNotInheritThePreviousRoomsClearState() {
        val item = message("reused-id")
        val screen = MessageScreen(); screen.clear("old-room", listOf(item))
        assertEquals(listOf(item), screen.visible("new-room", listOf(item)))
    }
}
