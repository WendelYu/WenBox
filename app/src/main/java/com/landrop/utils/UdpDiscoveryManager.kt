package com.landrop.utils

import android.os.Build
import com.landrop.model.DiscoveredRoom
import com.landrop.server.RoomManager
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

data class PeerDevice(
    val name: String,
    val ip: String,
    val port: Int,
    val platform: String,
    var lastSeen: Long
)

object UdpDiscoveryManager {

    private const val DISCOVERY_PORT = 9528
    private val activeDevices = ConcurrentHashMap<String, PeerDevice>()
    private val activeRooms = ConcurrentHashMap<String, DiscoveredRoom>()
    private var isReceiverRunning = false
    private var isBroadcasterRunning = false
    private var sendThread: Thread? = null
    private var recvThread: Thread? = null

    var onDevicesChangedListener: ((List<PeerDevice>) -> Unit)? = null
    var onRoomsChangedListener: ((List<DiscoveredRoom>) -> Unit)? = null

    fun startReceiver() {
        if (isReceiverRunning) return
        isReceiverRunning = true

        recvThread = thread(name = "UDP-Recv") {
            try {
                val socket = DatagramSocket(null).apply {
                    reuseAddress = true
                    broadcast = true
                    bind(java.net.InetSocketAddress(DISCOVERY_PORT))
                }
                val buffer = ByteArray(2048)
                val packet = DatagramPacket(buffer, buffer.size)

                while (isReceiverRunning) {
                    socket.receive(packet)
                    val text = String(packet.data, 0, packet.length)
                    val json = try {
                        JSONObject(text)
                    } catch (_: Exception) {
                        continue
                    }

                    val action = json.optString("action")
                    val senderIp = packet.address.hostAddress ?: continue

                    if (action == "wenbox_room_broadcast") {
                        val roomId = json.optString("roomId")
                        val roomName = json.optString("roomName", "未命名房间")
                        val hostDev = json.optString("hostDevice", "主机")
                        val needPassword = json.optBoolean("needPassword", false)
                        val hostPort = json.optInt("hostPort", 9527)
                        val memberCount = json.optInt("memberCount", 0)
                        val hostIp = json.optString("hostIp").ifBlank { senderIp }

                        val key = "$hostIp:$hostPort"
                        val r = DiscoveredRoom(
                            roomId = roomId,
                            roomName = roomName,
                            hostDevice = hostDev,
                            ip = hostIp,
                            port = hostPort,
                            needPassword = needPassword,
                            memberCount = memberCount,
                            lastSeen = System.currentTimeMillis()
                        )
                        activeRooms[key] = r
                        notifyRoomsChanged()
                    } else if (action == "wenbox_discovery") {
                        val devName = json.optString("device", "未知设备")
                        val platform = json.optString("platform", "Android")
                        val port = json.optInt("port", 9527)

                        val key = "$senderIp:$port"
                        val device = PeerDevice(
                            name = devName,
                            ip = senderIp,
                            port = port,
                            platform = platform,
                            lastSeen = System.currentTimeMillis()
                        )
                        activeDevices[key] = device
                        notifyDevicesChanged()
                    }
                }
                socket.close()
            } catch (_: Exception) {}
        }
    }

    fun startBroadcaster(myPort: Int = 9527) {
        if (isBroadcasterRunning) return
        isBroadcasterRunning = true

        sendThread = thread(name = "UDP-Send") {
            try {
                val socket = DatagramSocket()
                socket.broadcast = true
                val deviceName = "${Build.BRAND} ${Build.MODEL}"

                while (isBroadcasterRunning) {
                    val targetAddrs = getBroadcastAddresses()

                    // 1. 设备在线心跳广播
                    val devMsg = JSONObject().apply {
                        put("action", "wenbox_discovery")
                        put("device", deviceName)
                        put("platform", "Android")
                        put("port", myPort)
                    }.toString().toByteArray()

                    for (bAddr in targetAddrs) {
                        try {
                            val packet = DatagramPacket(devMsg, devMsg.size, bAddr, DISCOVERY_PORT)
                            socket.send(packet)
                        } catch (_: Exception) {}
                    }

                    // 2. 如果当前开启了房间（房主模式），广播房间信息
                    val room = RoomManager.currentRoom
                    if (room != null && room.isActive) {
                        val roomMsg = JSONObject().apply {
                            put("action", "wenbox_room_broadcast")
                            put("roomId", room.roomId)
                            put("roomName", room.roomName)
                            put("needPassword", room.needPassword)
                            put("hostDevice", room.hostDevice)
                            put("hostIp", room.hostIp)
                            put("hostPort", room.hostPort)
                            put("memberCount", RoomManager.getMembers().size)
                        }.toString().toByteArray()

                        for (bAddr in targetAddrs) {
                            try {
                                val packet = DatagramPacket(roomMsg, roomMsg.size, bAddr, DISCOVERY_PORT)
                                socket.send(packet)
                            } catch (_: Exception) {}
                        }
                    }

                    // 3. 清理超时房间与下线节点 (15秒)
                    val now = System.currentTimeMillis()
                    var changedRooms = false
                    val roomIt = activeRooms.entries.iterator()
                    while (roomIt.hasNext()) {
                        val entry = roomIt.next()
                        if (now - entry.value.lastSeen > 15000) {
                            roomIt.remove()
                            changedRooms = true
                        }
                    }
                    if (changedRooms) notifyRoomsChanged()

                    var changedDevs = false
                    val devIt = activeDevices.entries.iterator()
                    while (devIt.hasNext()) {
                        val entry = devIt.next()
                        if (now - entry.value.lastSeen > 15000) {
                            devIt.remove()
                            changedDevs = true
                        }
                    }
                    if (changedDevs) notifyDevicesChanged()

                    Thread.sleep(3000)
                }
                socket.close()
            } catch (_: Exception) {}
        }
    }

    fun start(myPort: Int = 9527) {
        startReceiver()
        startBroadcaster(myPort)
    }

    fun stopBroadcaster() {
        isBroadcasterRunning = false
        sendThread?.interrupt()
        sendThread = null
    }

    fun stop() {
        isReceiverRunning = false
        isBroadcasterRunning = false
        sendThread?.interrupt()
        recvThread?.interrupt()
        sendThread = null
        recvThread = null
        activeDevices.clear()
        activeRooms.clear()
        notifyDevicesChanged()
        notifyRoomsChanged()
    }

    private fun getBroadcastAddresses(): List<InetAddress> {
        val list = mutableListOf<InetAddress>()
        try {
            val interfaces = java.net.NetworkInterface.getNetworkInterfaces()
            while (interfaces != null && interfaces.hasMoreElements()) {
                val netIf = interfaces.nextElement()
                if (netIf.isLoopback || !netIf.isUp) continue
                for (addr in netIf.interfaceAddresses) {
                    val broadcast = addr.broadcast
                    if (broadcast != null) {
                        list.add(broadcast)
                    }
                }
            }
        } catch (_: Exception) {}
        try {
            list.add(InetAddress.getByName("255.255.255.255"))
        } catch (_: Exception) {}
        return list.distinct()
    }

    fun registerDevice(name: String, ip: String, port: Int, platform: String = "Windows") {
        val key = "$ip:$port"
        val device = PeerDevice(
            name = name,
            ip = ip,
            port = port,
            platform = platform,
            lastSeen = System.currentTimeMillis()
        )
        activeDevices[key] = device
        notifyDevicesChanged()
    }

    fun getDevices(): List<PeerDevice> = activeDevices.values.toList()

    fun getRooms(): List<DiscoveredRoom> = activeRooms.values.toList()

    private fun notifyDevicesChanged() {
        onDevicesChangedListener?.invoke(getDevices())
    }

    private fun notifyRoomsChanged() {
        onRoomsChangedListener?.invoke(getRooms())
    }
}
