package com.landrop

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.viewpager2.adapter.FragmentStateAdapter
import androidx.viewpager2.widget.ViewPager2
import com.landrop.databinding.ActivityMainBinding
import com.landrop.server.FileManager
import com.landrop.server.RoomManager
import com.landrop.service.TransferService
import com.landrop.ui.MainViewModel
import com.landrop.ui.fragment.ConverterFragment
import com.landrop.ui.fragment.CronFragment
import com.landrop.ui.fragment.JsonFragment
import com.landrop.ui.fragment.TransferFragment
import com.landrop.utils.NetworkUtils

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    private val mainViewModel: MainViewModel by viewModels()

    var transferService: TransferService? = null
        private set
    private var isBound = false

    private val requestNotificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        if (!isGranted) {
            Toast.makeText(this, "未开启通知权限，可能无法在后台稳定保活快传服务", Toast.LENGTH_SHORT).show()
        }
    }

    /** 保存文件到相册/下载目录所需的存储权限 (API 26-28) */
    private val requestLegacyStorageLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { }

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as TransferService.LocalBinder
            val svc = binder.getService()
            transferService = svc
            isBound = true

            svc.onStatusChanged = { running ->
                // 不再直接调用 Fragment 的方法：服务状态通过 StateFlow 暴露给所有订阅者 (A4)
                mainViewModel.updateServiceState(running, svc.currentPort, bound = true)
            }
            mainViewModel.updateServiceState(svc.isRunning, svc.currentPort, bound = true)

            // 打开软件即自动开启服务并创建免密房间:
            // 局域网内其他设备通过 IP 访问后无需任何操作即可直接加入互传
            if (RoomManager.currentRoom?.isActive != true) {
                if (!svc.isRunning) {
                    svc.startServer(9527)
                }
                val primaryIp = NetworkUtils.getAllLocalIpAddresses(this@MainActivity)
                    .firstOrNull()?.ip ?: "127.0.0.1"
                val devName = "${Build.BRAND} ${Build.MODEL}"
                RoomManager.createRoom(
                    roomName = "${devName}的房间",
                    pin = "",
                    hostDevice = devName,
                    hostIp = primaryIp,
                    hostPort = 9527
                )
            }
            mainViewModel.updateServiceState(svc.isRunning, svc.currentPort, bound = true)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            transferService = null
            isBound = false
            mainViewModel.updateUnbound()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupViewPager()
        setupBottomNavigation()
        bindTransferService()
        checkPermissions()
        handleIncomingShareIntent(intent)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        intent?.let { handleIncomingShareIntent(it) }
    }

    private fun setupViewPager() {
        binding.viewPager.adapter = object : FragmentStateAdapter(this) {
            override fun getItemCount(): Int = NAV_ITEM_COUNT

            // 每次都由 FragmentManager 创建新实例，Activity 不再持有 Fragment 引用，
            // 重建后回调不会指向已经销毁的 Fragment (A4)
            override fun createFragment(position: Int): Fragment = when (position) {
                0 -> TransferFragment()
                1 -> JsonFragment()
                2 -> ConverterFragment()
                else -> CronFragment()
            }
        }

        binding.viewPager.isUserInputEnabled = false // 禁止滑动切换，通过底栏点击切换保证各工具操作时不误触

        binding.viewPager.registerOnPageChangeCallback(object : ViewPager2.OnPageChangeCallback() {
            override fun onPageSelected(position: Int) {
                val menuId = when (position) {
                    0 -> R.id.nav_transfer
                    1 -> R.id.nav_json
                    2 -> R.id.nav_converter
                    3 -> R.id.nav_cron
                    else -> R.id.nav_transfer
                }
                if (binding.bottomNavigation.selectedItemId != menuId) {
                    binding.bottomNavigation.selectedItemId = menuId
                }
            }
        })
    }

    private fun setupBottomNavigation() {
        binding.bottomNavigation.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_transfer -> {
                    binding.viewPager.setCurrentItem(0, false)
                    true
                }
                R.id.nav_json -> {
                    binding.viewPager.setCurrentItem(1, false)
                    true
                }
                R.id.nav_converter -> {
                    binding.viewPager.setCurrentItem(2, false)
                    true
                }
                R.id.nav_cron -> {
                    binding.viewPager.setCurrentItem(3, false)
                    true
                }
                else -> false
            }
        }
    }

    private fun bindTransferService() {
        val intent = Intent(this, TransferService::class.java)
        startService(intent)
        bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
    }

    private fun checkPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                requestNotificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        // API 26-28 保存图片/接收上传需要写外部存储；后台接收上传无法弹框，
        // 因此首次启动服务时就申请，拒绝时业务侧退回应用私有目录 (A7)
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
                requestLegacyStorageLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
        }
    }

    private fun handleIncomingShareIntent(intent: Intent) {
        val action = intent.action ?: return

        if (Intent.ACTION_SEND == action) {
            (intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))?.let { uri ->
                FileManager.addFile(this, uri)
                Toast.makeText(this, "已通过分享添加文件", Toast.LENGTH_SHORT).show()
                binding.viewPager.setCurrentItem(0, false)
                if (transferService?.isRunning == false) {
                    transferService?.startServer(9527)
                }
            }
        } else if (Intent.ACTION_SEND_MULTIPLE == action) {
            val uris = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
            if (!uris.isNullOrEmpty()) {
                uris.forEach { uri ->
                    FileManager.addFile(this, uri)
                }
                Toast.makeText(this, "已通过分享添加 ${uris.size} 个文件", Toast.LENGTH_SHORT).show()
                binding.viewPager.setCurrentItem(0, false)
                if (transferService?.isRunning == false) {
                    transferService?.startServer(9527)
                }
            }
        }
    }

    override fun onDestroy() {
        if (isBound) {
            unbindService(serviceConnection)
            isBound = false
        }
        super.onDestroy()
    }

    companion object {
        private const val NAV_ITEM_COUNT = 4
    }
}
