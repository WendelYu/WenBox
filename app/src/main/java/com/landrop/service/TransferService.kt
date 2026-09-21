package com.landrop.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.landrop.MainActivity
import com.landrop.R
import com.landrop.server.LanServer
import com.landrop.utils.NetworkUtils

class TransferService : Service() {

    private val binder = LocalBinder()
    private var lanServer: LanServer? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    var isRunning = false
        private set

    var currentPort = 9527
        private set

    var onStatusChanged: ((Boolean) -> Unit)? = null

    inner class LocalBinder : Binder() {
        fun getService(): TransferService = this@TransferService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    fun startServer(port: Int = 9527): Boolean {
        if (isRunning) return true
        try {
            lanServer = LanServer(applicationContext, port).apply {
                start()
            }
            currentPort = port
            isRunning = true

            acquireLocks()
            startForeground(NOTIFICATION_ID, buildNotification())
            com.landrop.utils.UdpDiscoveryManager.start(port)
            onStatusChanged?.invoke(true)
            return true
        } catch (e: Exception) {
            e.printStackTrace()
            stopServer()
            return false
        }
    }

    fun stopServer() {
        try {
            com.landrop.utils.UdpDiscoveryManager.stop()
            lanServer?.stop()
            lanServer = null
        } catch (e: Exception) {
            e.printStackTrace()
        }
        isRunning = false
        releaseLocks()
        stopForeground(STOP_FOREGROUND_REMOVE)
        onStatusChanged?.invoke(false)
    }

    private fun acquireLocks() {
        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "WenDrop::TransferWakeLock"
            ).apply {
                acquire(10 * 60 * 1000L)
            }

            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifiLock = wifiManager.createWifiLock(
                WifiManager.WIFI_MODE_FULL_HIGH_PERF,
                "WenDrop::TransferWifiLock"
            ).apply {
                acquire()
            }

            multicastLock = wifiManager.createMulticastLock("WenDrop::MulticastLock").apply {
                setReferenceCounted(true)
                acquire()
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private var multicastLock: WifiManager.MulticastLock? = null

    private fun releaseLocks() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
            if (wifiLock?.isHeld == true) wifiLock?.release()
            if (multicastLock?.isHeld == true) multicastLock?.release()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.channel_desc)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val interfaces = NetworkUtils.getAllLocalIpAddresses(this)
        val primary = interfaces.firstOrNull()
        val ip = primary?.ip ?: "0.0.0.0"
        val url = "http://$ip:$currentPort"
        val desc = when {
            primary?.isEthernet == true -> "网线直连就绪: $url"
            primary?.isHotspot == true -> "手机热点就绪: $url"
            else -> "电脑端访问: $url"
        }

        val intent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("WenBox 局域网服务运行中")
            .setContentText(desc)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        stopServer()
        super.onDestroy()
    }

    companion object {
        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID = "wendrop_transfer_channel"
    }
}
