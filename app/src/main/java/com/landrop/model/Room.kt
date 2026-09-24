package com.landrop.model

data class RoomConfig(
    var isActive: Boolean = false,
    var roomId: String = "",
    var roomName: String = "",
    var pin: String = "",
    var needPassword: Boolean = false,
    var hostDevice: String = "",
    var hostIp: String = "",
    var hostPort: Int = 9527,
    var createdAt: Long = 0L
)

data class DiscoveredRoom(
    val roomId: String,
    val roomName: String,
    val hostDevice: String,
    val ip: String,
    val port: Int,
    val needPassword: Boolean,
    val memberCount: Int = 0,
    var lastSeen: Long = System.currentTimeMillis()
)

data class RoomMember(
    val id: String,
    var name: String,
    var ip: String,
    val platform: String,
    val joinedAt: Long,
    var lastSeen: Long
)
