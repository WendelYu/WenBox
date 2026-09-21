package com.landrop.utils

import android.os.Build
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
    private var isRunning = false
    private var sendThread: Thread? = null
    private var recvThread: Thread? = null

    var onDevicesChangedListener: ((List<PeerDevice>) -> Unit)? = null

    fun start(myPort: Int = 9527) {
        if (isRunning) return
        isRunning = true

        // 1. 接收广播
        recvThread = thread(name = "UDP-Recv") {
            try {
                val socket = DatagramSocket(DISCOVERY_PORT)
                val buffer = ByteArray(1024)
                val packet = DatagramPacket(buffer, buffer.size)

                while (isRunning) {
                    socket.receive(packet)
                    val text = String(packet.data, 0, packet.length)
                    val json = JSONObject(text)

                    if (json.optString("action") == "wenbox_discovery") {
                        val devName = json.optString("device", "未知设备")
                        val platform = json.optString("platform", "Android")
                        val port = json.optInt("port", 9527)
                        val ip = packet.address.hostAddress ?: continue

                        val key = "$ip:$port"
                        val device = PeerDevice(
                            name = devName,
                            ip = ip,
                            port = port,
                            platform = platform,
                            lastSeen = System.currentTimeMillis()
                        )
                        activeDevices[key] = device
                        notifyDevicesChanged()
                    }
                }
                socket.close()
            } catch (e: Exception) {
                // ignore
            }
        }

        // 2. 发送广播 (每 3 秒向局域网宣告自身)
        sendThread = thread(name = "UDP-Send") {
            try {
                val socket = DatagramSocket()
                socket.broadcast = true
                val broadcastAddr = InetAddress.getByName("255.255.255.255")

                val deviceName = "${Build.BRAND} ${Build.MODEL}"

                while (isRunning) {
                    val msg = JSONObject().apply {
                        put("action", "wenbox_discovery")
                        put("device", deviceName)
                        put("platform", "Android")
                        put("port", myPort)
                    }.toString()

                    val bytes = msg.toByteArray()
                    val packet = DatagramPacket(bytes, bytes.size, broadcastAddr, DISCOVERY_PORT)
                    socket.send(packet)

                    // 清理超时 15 秒未通信的下线设备
                    val now = System.currentTimeMillis()
                    val iterator = activeDevices.entries.iterator()
                    var changed = false
                    while (iterator.hasNext()) {
                        val entry = iterator.next()
                        if (now - entry.value.lastSeen > 15000) {
                            iterator.remove()
                            changed = true
                        }
                    }
                    if (changed) notifyDevicesChanged()

                    Thread.sleep(3000)
                }
                socket.close()
            } catch (e: Exception) {
                // ignore
            }
        }
    }

    fun stop() {
        isRunning = false
        sendThread?.interrupt()
        recvThread?.interrupt()
        sendThread = null
        recvThread = null
        activeDevices.clear()
        notifyDevicesChanged()
    }

    fun getDevices(): List<PeerDevice> = activeDevices.values.toList()

    private fun notifyDevicesChanged() {
        onDevicesChangedListener?.invoke(getDevices())
    }
}
