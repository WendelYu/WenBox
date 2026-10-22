package com.landrop.server

import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*

class MessageManagerTest {
    @Before fun setup() { MessageManager.clearAll() }
    @After fun cleanup() { MessageManager.clearAll() }

    @Test fun hostAndClientMessagesPublishToObservableHistory() {
        val host = MessageManager.addPhoneMessage("from host", clientId = "host-id")
        val client = MessageManager.addClientMessage("from client", clientId = "client-id")
        assertEquals(listOf(host, client), MessageManager.messageFlow.value)
    }

    @Test fun duplicateNetworkMessagesDoNotPublishTwice() {
        MessageManager.addReceivedMessage("id", "text", "member", 1)
        assertNull(MessageManager.addReceivedMessage("id", "text", "member", 1))
        assertEquals(1, MessageManager.messageFlow.value.size)
    }

    @Test fun historyIsBoundedAndClearPublishesEmptySnapshot() {
        repeat(505) { MessageManager.addClientMessage(it.toString()) }
        assertEquals(500, MessageManager.messageFlow.value.size)
        assertEquals("5", MessageManager.messageFlow.value.first().content)
        MessageManager.clearAll()
        assertEquals(emptyList<Any>(), MessageManager.messageFlow.value)
    }
}
