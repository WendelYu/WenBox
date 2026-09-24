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

    var currentHostToken: String? = null

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
        currentHostToken = hostToken
        authTokens.add(hostToken)
        members["host"] = RoomMember(
            id = UUID.randomUUID().toString(),
            name = "$hostDevice (房主)",
            ip = hostIp,
            platform = "Android",
            accessIp = "$hostIp:$hostPort",
            joinedAt = System.currentTimeMillis(),
            lastSeen = System.currentTimeMillis()
        )

        onRoomStateChangedListener?.invoke(config)
        onMembersChangedListener?.invoke(getMembers())
        return config
    }

    fun setHostIp(ip: String) {
        val clean = ip.trim()
        if (clean.isBlank()) return
        val room = currentRoom ?: return
        val updated = room.copy(hostIp = clean)
        currentRoom = updated
        val hostMember = members["host"]
        if (hostMember != null) {
            hostMember.ip = clean
            hostMember.accessIp = "$clean:${room.hostPort}"
            members["host"] = hostMember
        }
        onRoomStateChangedListener?.invoke(updated)
        onMembersChangedListener?.invoke(getMembers())
    }

    fun closeRoom() {
        val oldRoomId = currentRoom?.roomId
        currentRoom = null
        currentHostToken = null
        members.clear()
        authTokens.clear()
        if (oldRoomId != null) {
            com.landrop.utils.UdpDiscoveryManager.broadcastRoomClosed(oldRoomId)
        }
        onRoomStateChangedListener?.invoke(null)
        onMembersChangedListener?.invoke(emptyList())
    }

    fun verifyAndJoin(
        pin: String,
        clientName: String,
        clientIp: String,
        platform: String,
        accessIp: String = ""
    ): Triple<Boolean, String, String> {
        val room = currentRoom ?: return Triple(false, "房间未开启", "")
        if (room.needPassword && room.pin != pin.trim()) {
            return Triple(false, "房间密码错误", "")
        }

        val token = UUID.randomUUID().toString()
        authTokens.add(token)

        val cleanName = clientName.trim()
        val displayName = if (cleanName.isBlank()) "访客设备" else cleanName

        val member = RoomMember(
            id = UUID.randomUUID().toString(),
            name = displayName,
            ip = clientIp,
            platform = platform,
            accessIp = accessIp,
            joinedAt = System.currentTimeMillis(),
            lastSeen = System.currentTimeMillis()
        )
        members[token] = member
        onMembersChangedListener?.invoke(getMembers())

        return Triple(true, "加入成功", token)
    }

    fun heartbeat(clientIp: String, name: String? = null, platform: String? = null, token: String? = null, accessIp: String? = null) {
        val existing = if (!token.isNullOrBlank()) members[token] else null
        if (existing != null) {
            existing.lastSeen = System.currentTimeMillis()
            if (!accessIp.isNullOrBlank()) {
                existing.accessIp = accessIp
            }
            if (!name.isNullOrBlank() && existing.name != name.trim()) {
                existing.name = name.trim()
                onMembersChangedListener?.invoke(getMembers())
            }
        } else if (!token.isNullOrBlank() && authTokens.contains(token)) {
            val displayName = name?.trim()?.ifBlank { null } ?: "访客设备"
            val member = RoomMember(
                id = UUID.randomUUID().toString(),
                name = displayName,
                ip = clientIp,
                platform = platform ?: "Client",
                accessIp = accessIp ?: "",
                joinedAt = System.currentTimeMillis(),
                lastSeen = System.currentTimeMillis()
            )
            members[token] = member
            onMembersChangedListener?.invoke(getMembers())
        }
    }

    fun leaveRoom(token: String) {
        if (token.isBlank()) return
        authTokens.remove(token)
        if (members.remove(token) != null) {
            onMembersChangedListener?.invoke(getMembers())
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
            if (now - item.value.lastSeen > 15000 && item.key != "host") {
                iterator.remove()
            }
        }
        return members.values.toList()
    }
}
