package com.landrop.server

import java.io.InputStream
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** Fan-out for the browser-facing Server-Sent Events endpoint. */
object SseHub {
    private const val MAX_CLIENTS = 32
    private const val STALE_AFTER_MS = 120_000L
    private val nextId = AtomicLong(1)
    private val clients = ConcurrentHashMap<Long, Client>()

    fun register(ready: String): Pair<Long, InputStream> {
        pruneStale()
        check(clients.size < MAX_CLIENTS) { "实时连接数已达上限，请稍后重试" }
        val id = nextId.getAndIncrement()
        val queue = ArrayBlockingQueue<String>(64)
        queue.offer(ready)
        val client = Client(queue)
        clients[id] = client
        return id to Stream(id, client)
    }

    fun publish(event: String, data: String = "{}") {
        val payload = "event: $event\ndata: $data\n\n"
        clients.forEach { (id, client) ->
            if (client.isStale()) {
                clients.remove(id, client)
            } else {
                // Drop slow consumers instead of making a room mutation wait.
                client.queue.offer(payload)
            }
        }
    }

    private fun pruneStale() {
        clients.entries.removeAll { (_, client) -> client.isStale() }
    }

    private class Client(val queue: ArrayBlockingQueue<String>) {
        private val lastRead = AtomicLong(System.currentTimeMillis())
        fun touch() = lastRead.set(System.currentTimeMillis())
        fun isStale() = System.currentTimeMillis() - lastRead.get() > STALE_AFTER_MS
    }

    private class Stream(
        private val id: Long,
        private val client: Client
    ) : InputStream() {
        private var pending = ByteArray(0)
        private var offset = 0

        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) <= 0) -1 else one[0].toInt() and 0xff
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (length == 0) return 0
            client.touch()
            if (this.offset >= pending.size) {
                val next = client.queue.poll(15, TimeUnit.SECONDS) ?: ": keep-alive\n\n"
                pending = next.toByteArray(Charsets.UTF_8)
                this.offset = 0
            }
            val count = minOf(length, pending.size - this.offset)
            System.arraycopy(pending, this.offset, buffer, offset, count)
            this.offset += count
            return count
        }

        override fun close() {
            clients.remove(id)
            super.close()
        }
    }
}
