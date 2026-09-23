package com.landrop.utils

import android.content.Context
import android.net.wifi.WifiManager
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
    private const val MULTICAST_IPV4 = "239.255.255.250"
    private val activeDevices = ConcurrentHashMap<String, PeerDevice>()
    private val activeRooms = ConcurrentHashMap<String, DiscoveredRoom>()
    private var isReceiverRunning = false
    private var isBroadcasterRunning = false
    private var sendThread: Thread? = null
    private var recvThread: Thread? = null
    private var clientProbeThread: Thread? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    var appContext: Context? = null

    var onDevicesChangedListener: ((List<PeerDevice>) -> Unit)? = null
    var onRoomsChangedListener: ((List<DiscoveredRoom>) -> Unit)? = null

    fun startReceiver(context: Context? = null) {
        if (context != null) {
            appContext = context.applicationContext
        }

        // 持有 Wi-Fi 组播/广播锁，防止系统底层芯片过滤局域网 UDP 广播包
        if (multicastLock == null && appContext != null) {
            try {
                val wm = appContext?.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                multicastLock = wm?.createMulticastLock("WenBox::UdpDiscoveryLock")?.apply {
                    setReferenceCounted(true)
                    acquire()
                }
            } catch (_: Exception) {}
        }

        if (isReceiverRunning) return
        isReceiverRunning = true

        // 客户端模式持续探测线程：非房主模式下每 2.5 秒主动发送搜索探测，秒级发现新开房间
        clientProbeThread = thread(name = "UDP-ClientProbe") {
            while (isReceiverRunning) {
                val room = RoomManager.currentRoom
                if (room == null || !room.isActive) {
                    sendSearchProbe()
                }
                try {
                    Thread.sleep(2500)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }

        recvThread = thread(name = "UDP-Recv") {
            try {
                val socket = java.net.MulticastSocket(DISCOVERY_PORT).apply {
                    reuseAddress = true
                    broadcast = true
                }
                try {
                    socket.joinGroup(InetAddress.getByName(MULTICAST_IPV4))
                } catch (_: Exception) {}

                val buffer = ByteArray(2048)
                val packet = DatagramPacket(buffer, buffer.size)

                while (isReceiverRunning) {
                    socket.receive(packet)
                    val text = String(packet.data, 0, packet.length, Charsets.UTF_8)
                    val json = try {
                        JSONObject(text)
                    } catch (_: Exception) {
                        continue
                    }

                    val action = json.optString("action")
                    val senderIp = packet.address.hostAddress ?: continue

                    // 1. 房间广播通知
                    if (action == "wenbox_room_broadcast") {
                        val roomId = json.optString("roomId")
                        val roomName = json.optString("roomName", "未命名房间")
                        val hostDev = json.optString("hostDevice", "主机")
                        val needPassword = json.optBoolean("needPassword", false)
                        val hostPort = if (json.has("hostPort")) json.optInt("hostPort", 9527) else json.optInt("port", 9527)
                        val memberCount = json.optInt("memberCount", 0)
                        val hostIpField = json.optString("hostIp").trim()
                        // 物理网络直接到达的 senderIp 最具通信可达性，优先用于房间通信，避免被对端多网卡中的虚拟/以太网网卡 IP 干扰
                        val hostIp = if (senderIp.isNotBlank() && !senderIp.startsWith("127.")) {
                            senderIp
                        } else if (hostIpField.isNotBlank()) {
                            hostIpField
                        } else {
                            senderIp
                        }

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
                    }
                    // 2. 主动探测请求 (Ping): 如果本机开房中，单播秒级应答
                    else if (action == "wenbox_search_room") {
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
                            }.toString().toByteArray(Charsets.UTF_8)
                            try {
                                val replyPacket = DatagramPacket(roomMsg, roomMsg.size, packet.address, packet.port)
                                socket.send(replyPacket)
                                // 同时向对方来源 IP 的 9528 端口发送单播回包，因为 Windows 探测时通常以临时端口发包，真正监听在 9528
                                if (packet.port != DISCOVERY_PORT) {
                                    val replyPacket9528 = DatagramPacket(roomMsg, roomMsg.size, packet.address, DISCOVERY_PORT)
                                    socket.send(replyPacket9528)
                                }
                            } catch (_: Exception) {}
                        }
                    }
                    // 3. 房间解散通知 (对端已下线解散，立即从列表剔除)
                    else if (action == "wenbox_room_closed") {
                        val closedRoomId = json.optString("roomId")
                        var changed = false
                        val it = activeRooms.entries.iterator()
                        while (it.hasNext()) {
                            val e = it.next()
                            if (e.value.roomId == closedRoomId || e.value.ip == senderIp) {
                                it.remove()
                                changed = true
                            }
                        }
                        if (changed) notifyRoomsChanged()
                    }
                    // 4. 设备发现通知
                    else if (action == "wenbox_discovery") {
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

                        // 额外向已知在线节点单播发包，穿透无线路由器对广播包的丢弃与睡眠抑制
                        for (dev in activeDevices.values) {
                            if (dev.ip.isNotBlank() && !dev.ip.startsWith("127.")) {
                                try {
                                    val devAddr = InetAddress.getByName(dev.ip)
                                    val devPacket = DatagramPacket(roomMsg, roomMsg.size, devAddr, DISCOVERY_PORT)
                                    socket.send(devPacket)
                                } catch (_: Exception) {}
                            }
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
        clientProbeThread?.interrupt()
        sendThread = null
        recvThread = null
        clientProbeThread = null
        try {
            if (multicastLock?.isHeld == true) {
                multicastLock?.release()
            }
        } catch (_: Exception) {}
        multicastLock = null
        activeDevices.clear()
        activeRooms.clear()
        notifyDevicesChanged()
        notifyRoomsChanged()
    }

    fun broadcastRoomClosed(roomId: String) {
        thread(name = "UDP-RoomClosed") {
            try {
                val socket = DatagramSocket()
                socket.broadcast = true
                val msg = JSONObject().apply {
                    put("action", "wenbox_room_closed")
                    put("roomId", roomId)
                }.toString().toByteArray(Charsets.UTF_8)
                val targetAddrs = getBroadcastAddresses()
                for (bAddr in targetAddrs) {
                    try {
                        val packet = DatagramPacket(msg, msg.size, bAddr, DISCOVERY_PORT)
                        socket.send(packet)
                    } catch (_: Exception) {}
                }
                socket.close()
            } catch (_: Exception) {}
        }
        // 同步从本机缓存中清理
        val it = activeRooms.entries.iterator()
        var changed = false
        while (it.hasNext()) {
            val e = it.next()
            if (e.value.roomId == roomId) {
                it.remove()
                changed = true
            }
        }
        if (changed) notifyRoomsChanged()
    }

    private fun getLocalIpAddresses(): Set<String> {
        val ips = mutableSetOf("127.0.0.1", "localhost")
        try {
            val interfaces = java.net.NetworkInterface.getNetworkInterfaces()
            while (interfaces != null && interfaces.hasMoreElements()) {
                val netIf = interfaces.nextElement()
                val addrs = netIf.inetAddresses
                while (addrs.hasMoreElements()) {
                    val addr = addrs.nextElement()
                    if (!addr.isLoopbackAddress && addr is java.net.Inet4Address) {
                        addr.hostAddress?.let { if (it.isNotBlank()) ips.add(it) }
                    }
                }
            }
        } catch (_: Exception) {}
        return ips
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
                    val inetAddr = addr.address
                    if (inetAddr is java.net.Inet4Address && !inetAddr.isLoopbackAddress) {
                        try {
                            val octets = inetAddr.address
                            octets[3] = 255.toByte()
                            list.add(InetAddress.getByAddress(octets))
                        } catch (_: Exception) {}
                    }
                }
            }
        } catch (_: Exception) {}
        try {
            list.add(InetAddress.getByName("255.255.255.255"))
            list.add(InetAddress.getByName(MULTICAST_IPV4))
        } catch (_: Exception) {}
        return list.distinct()
    }

    fun sendSearchProbe() {
        thread(name = "UDP-Probe") {
            try {
                val socket = DatagramSocket()
                socket.broadcast = true
                val msg = JSONObject().apply {
                    put("action", "wenbox_search_room")
                }.toString().toByteArray(Charsets.UTF_8)
                val targetAddrs = getBroadcastAddresses()
                for (bAddr in targetAddrs) {
                    try {
                        val packet = DatagramPacket(msg, msg.size, bAddr, DISCOVERY_PORT)
                        socket.send(packet)
                    } catch (_: Exception) {}
                }
                // 向已知在线节点也单播发送探测
                for (dev in activeDevices.values) {
                    if (dev.ip.isNotBlank() && !dev.ip.startsWith("127.")) {
                        try {
                            val devAddr = InetAddress.getByName(dev.ip)
                            val devPacket = DatagramPacket(msg, msg.size, devAddr, DISCOVERY_PORT)
                            socket.send(devPacket)
                        } catch (_: Exception) {}
                    }
                }
                socket.close()
            } catch (_: Exception) {}
        }
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

    fun getRooms(): List<DiscoveredRoom> {
        val now = System.currentTimeMillis()
        val localIps = getLocalIpAddresses()
        val curRoomId = RoomManager.currentRoom?.roomId
        val it = activeRooms.entries.iterator()
        var changed = false
        while (it.hasNext()) {
            val entry = it.next()
            if (now - entry.value.lastSeen > 15000) {
                it.remove()
                changed = true
            }
        }
        if (changed) notifyRoomsChanged()

        return activeRooms.values.filter { room ->
            // 过滤掉本机创建的房间或同机IP，避免解散后或在同一台机上发现自己
            (curRoomId == null || room.roomId != curRoomId) && !localIps.contains(room.ip)
        }
    }

    private fun notifyDevicesChanged() {
        onDevicesChangedListener?.invoke(getDevices())
    }

    private fun notifyRoomsChanged() {
        onRoomsChangedListener?.invoke(getRooms())
    }
}
