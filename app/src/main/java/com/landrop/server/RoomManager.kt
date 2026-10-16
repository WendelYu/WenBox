package com.landrop.server

import com.landrop.model.RoomConfig
import com.landrop.model.RoomMember
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

object RoomManager {

    var currentRoom: RoomConfig? = null
        private set

    private val members = ConcurrentHashMap<String, RoomMember>()
    private val authTokens = ConcurrentHashMap.newKeySet<String>()

    var currentHostToken: String? = null

    /** 房主成员在 members 里的保留键，绝不能被当作普通客户端 token (S3) */
    const val HOST_MEMBER_KEY = "host"

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
            // roomId 必须是唯一标识：展示名可能重复，两台同名设备会互相不可见 (S6)
            roomId = UUID.randomUUID().toString(),
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
        MessageManager.clearAll()

        // 房主自己作为第一个成员加入
        val hostToken = UUID.randomUUID().toString()
        currentHostToken = hostToken
        authTokens.add(hostToken)
        members[HOST_MEMBER_KEY] = RoomMember(
            // 成员 id 与房主 token 分离，避免公开接口泄露凭证 (S2)
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
        // 无变化绝不通知：否则 TransferFragment 的 onRoomStateChangedListener
        // 会同步回调 setRoomMode(HOST) -> renderNetworkInterfaces -> setHostIp，
        // 形成无限递归并最终 StackOverflow (A1)
        if (room.hostIp == clean) return
        val updated = room.copy(hostIp = clean)
        currentRoom = updated
        val hostMember = members[HOST_MEMBER_KEY]
        if (hostMember != null) {
            hostMember.ip = clean
            hostMember.accessIp = "$clean:${room.hostPort}"
            members[HOST_MEMBER_KEY] = hostMember
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
        MessageManager.clearAll()
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
        // 常量时间比较，避免通过响应时间逐字节推断 PIN (S8)
        if (room.needPassword && !constantTimeEquals(room.pin.trim(), pin.trim())) {
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
        // "host" 是保留键，不能作为普通成员 token 处理 (S3)
        if (token == null || token.isBlank() || token == HOST_MEMBER_KEY) return
        val existing = members[token]
        if (existing != null) {
            existing.lastSeen = System.currentTimeMillis()
            if (!accessIp.isNullOrBlank()) {
                existing.accessIp = accessIp
            }
            if (!name.isNullOrBlank() && existing.name != name.trim()) {
                existing.name = name.trim()
                onMembersChangedListener?.invoke(getMembers())
            }
        } else if (authTokens.contains(token)) {
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
        // 空 token 与保留键 "host" 一律忽略，否则 `{"token":"host"}` 会删掉房主 (S3)
        if (token.isBlank() || token == HOST_MEMBER_KEY) return
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

    /** 房主的成员 id，用于 join/create 响应返回给客户端 (S2) */
    fun getHostMemberId(): String = members[HOST_MEMBER_KEY]?.id ?: ""

    /** 由令牌反查成员 id；令牌与成员 id 解耦后客户端需要它来识别"哪条消息是我发的" (S2) */
    fun getMemberIdByToken(token: String?): String {
        if (token.isNullOrBlank()) return ""
        if (token == HOST_MEMBER_KEY) return getHostMemberId()
        return members[token]?.id ?: ""
    }

    private fun constantTimeEquals(a: String, b: String): Boolean =
        MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

    fun getMembers(): List<RoomMember> {
        val now = System.currentTimeMillis()
        val expiredTokens = mutableListOf<String>()
        val iterator = members.entries.iterator()
        while (iterator.hasNext()) {
            val item = iterator.next()
            if (now - item.value.lastSeen > 15000 && item.key != HOST_MEMBER_KEY) {
                expiredTokens.add(item.key)
                iterator.remove()
            }
        }
        // 成员超时清理时同步回收 auth token，避免已退出成员的旧令牌永久有效 (S3)
        if (expiredTokens.isNotEmpty()) {
            authTokens.removeAll(expiredTokens.toSet())
        }
        return members.values.toList()
    }
}
