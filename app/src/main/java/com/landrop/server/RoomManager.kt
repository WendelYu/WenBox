package com.landrop.server

import com.landrop.model.RoomConfig
import com.landrop.model.RoomMember
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

object RoomManager {

    var currentRoom: RoomConfig? = null
        private set

    private val members = ConcurrentHashMap<String, RoomMember>()
    private val authTokens = ConcurrentHashMap.newKeySet<String>()

    var onRoomStateChangedListener: ((RoomConfig?) -> Unit)? = null
    var onMembersChangedListener: ((List<RoomMember>) -> Unit)? = null

    fun createRoom(
        roomName: String,
        pin: String,
        hostDevice: String,
        hostIp: String,
        hostPort: Int = 9527
    ): RoomConfig {
        val cleanPin = pin.trim()
        val needPassword = cleanPin.isNotEmpty()
        val cleanName = if (roomName.trim().isEmpty()) {
            "WenBox-${UUID.randomUUID().toString().take(4).uppercase()}"
        } else {
            roomName.trim()
        }

        val config = RoomConfig(
            isActive = true,
            roomId = cleanName,
            roomName = cleanName,
            pin = cleanPin,
            needPassword = needPassword,
            hostDevice = hostDevice,
            hostIp = hostIp,
            hostPort = hostPort,
            createdAt = System.currentTimeMillis()
        )

        currentRoom = config
        members.clear()
        authTokens.clear()

        // 房主自己作为第一个成员加入
        val hostToken = UUID.randomUUID().toString()
        authTokens.add(hostToken)
        members["127.0.0.1"] = RoomMember(
            id = UUID.randomUUID().toString(),
            name = "$hostDevice (房主)",
            ip = hostIp,
            platform = "Android",
            joinedAt = System.currentTimeMillis(),
            lastSeen = System.currentTimeMillis()
        )

        onRoomStateChangedListener?.invoke(config)
        onMembersChangedListener?.invoke(getMembers())
        return config
    }

    fun closeRoom() {
        currentRoom = null
        members.clear()
        authTokens.clear()
        onRoomStateChangedListener?.invoke(null)
        onMembersChangedListener?.invoke(emptyList())
    }

    fun verifyAndJoin(
        pin: String,
        clientName: String,
        clientIp: String,
        platform: String
    ): Triple<Boolean, String, String> {
        val room = currentRoom ?: return Triple(false, "房间未开启", "")
        if (room.needPassword && room.pin != pin.trim()) {
            return Triple(false, "房间密码错误", "")
        }

        val token = UUID.randomUUID().toString()
        authTokens.add(token)

        val member = RoomMember(
            id = UUID.randomUUID().toString(),
            name = clientName.ifBlank { "访客设备" },
            ip = clientIp,
            platform = platform,
            joinedAt = System.currentTimeMillis(),
            lastSeen = System.currentTimeMillis()
        )
        members[clientIp] = member
        onMembersChangedListener?.invoke(getMembers())

        return Triple(true, "加入成功", token)
    }

    fun heartbeat(clientIp: String) {
        members[clientIp]?.let {
            it.lastSeen = System.currentTimeMillis()
        }
    }

    fun isAuthorized(token: String?): Boolean {
        val room = currentRoom ?: return true
        if (!room.needPassword) return true
        if (token == null) return false
        return authTokens.contains(token)
    }

    fun getMembers(): List<RoomMember> {
        val now = System.currentTimeMillis()
        val iterator = members.entries.iterator()
        while (iterator.hasNext()) {
            val item = iterator.next()
            if (now - item.value.lastSeen > 30000 && item.key != "127.0.0.1") {
                iterator.remove()
            }
        }
        return members.values.toList()
    }
}
