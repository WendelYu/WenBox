package com.landrop.utils

import android.content.Context
import java.net.Inet4Address
import java.net.NetworkInterface

enum class InterfaceType {
    ETHERNET, // 🔌 有线网卡 / 网线直连
    HOTSPOT,  // 📡 手机个人热点
    WIFI,     // 📶 Wi-Fi 无线网络
    USB,      // 🔗 USB 网络共享 / 直连
    OTHER     // 🌐 局域网络
}

data class NetworkInterfaceInfo(
    val name: String,
    val displayName: String,
    val ip: String,
    val type: InterfaceType
) {
    val isEthernet: Boolean get() = type == InterfaceType.ETHERNET
    val isHotspot: Boolean get() = type == InterfaceType.HOTSPOT
}

object NetworkUtils {

    /**
     * 获取当前设备所有的可用局域网 IPv4 地址列表（智能识别网线、热点与 Wi-Fi）
     */
    fun getAllLocalIpAddresses(context: Context): List<NetworkInterfaceInfo> {
        val result = mutableListOf<NetworkInterfaceInfo>()

        try {
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return emptyList()
            while (interfaces.hasMoreElements()) {
                val intf = interfaces.nextElement()
                if (intf.isLoopback || !intf.isUp) continue

                val ifaceName = intf.name.lowercase()
                // 忽略纯虚拟网卡与移动蜂窝基带数据接口 (如 dummy, rmnet, ccmni)
                if (ifaceName.startsWith("dummy") || ifaceName.startsWith("rmnet") || ifaceName.startsWith("ccmni")) {
                    continue
                }

                val addresses = intf.inetAddresses
                while (addresses.hasMoreElements()) {
                    val addr = addresses.nextElement()
                    if (!addr.isLoopbackAddress && addr is Inet4Address) {
                        val ip = addr.hostAddress ?: continue
                        if (ip.startsWith("127.")) continue

                        val (displayName, type) = parseInterfaceMeta(intf.name, ip)
                        result.add(
                            NetworkInterfaceInfo(
                                name = intf.name,
                                displayName = displayName,
                                ip = ip,
                                type = type
                            )
                        )
                    }
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }

        // 排序规则：有线网卡 (ETHERNET) -> 手机热点 (HOTSPOT) -> Wi-Fi -> USB -> 其他
        result.sortWith(compareBy<NetworkInterfaceInfo> {
            when (it.type) {
                InterfaceType.ETHERNET -> 0
                InterfaceType.HOTSPOT -> 1
                InterfaceType.WIFI -> 2
                InterfaceType.USB -> 3
                InterfaceType.OTHER -> 4
            }
        }.thenBy { it.name })

        return result
    }

    /**
     * 动态查找当前系统是否正在运行真实的热点接口
     */
    fun getDynamicHotspotAddress(context: Context): NetworkInterfaceInfo? {
        val all = getAllLocalIpAddresses(context)
        return all.firstOrNull { it.isHotspot }
    }

    /**
     * 智能识别网络接口类型与展示名称（支持各厂商热点网关与多平台网卡命名规则）
     */
    private fun parseInterfaceMeta(name: String, ip: String): Pair<String, InterfaceType> {
        val lower = name.lowercase()

        // 1. 优先判断是否是有线以太网
        if (lower.startsWith("eth") || lower.startsWith("en")) {
            return Pair("🔌 有线网卡 / 网线直连 ($name)", InterfaceType.ETHERNET)
        }

        // 2. 动态判断是否是手机个人热点 (SoftAP / Tethering)
        // 涵盖高通、联发科、华为海思及各定制系统的热点网卡命名 (ap0, softap, swlan, wlan1, wlan2, tether)
        val isHotspotName = lower.startsWith("ap") || lower.startsWith("softap") || 
                            lower.startsWith("swlan") || lower.startsWith("tether") ||
                            lower == "wlan1" || lower == "wlan2"

        // 涵盖常见的私有网关 IP 段 (如 192.168.43.1, 192.168.x.1, 172.20.10.1 等)
        val isHotspotGatewayIp = ip.endsWith(".1") && (
                ip.startsWith("192.168.43.") || 
                ip.startsWith("172.20.10.") || 
                ip.startsWith("192.168.")
        )

        if (isHotspotName || isHotspotGatewayIp) {
            return Pair("📡 手机个人热点 (本机网关: $name)", InterfaceType.HOTSPOT)
        }

        // 3. 判断是否是 USB 直连 / 网络共享
        if (lower.startsWith("rndis") || lower.startsWith("usb")) {
            return Pair("🔗 USB 网络共享 / 直连 ($name)", InterfaceType.USB)
        }

        // 4. 判断是否是普通 Wi-Fi 客户端
        if (lower.startsWith("wlan")) {
            return Pair("📶 Wi-Fi 无线网络 ($name)", InterfaceType.WIFI)
        }

        return Pair("🌐 局域网络 ($name)", InterfaceType.OTHER)
    }

    /**
     * 获取主要的首选 IP（优先返回有线，其次热点，再次 Wi-Fi）
     */
    fun getLocalIpAddress(context: Context): String? {
        val all = getAllLocalIpAddresses(context)
        return all.firstOrNull()?.ip
    }
}
