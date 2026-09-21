package com.landrop.ui.fragment

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.recyclerview.widget.LinearLayoutManager
import com.landrop.MainActivity
import com.landrop.R
import com.landrop.databinding.FragmentTransferBinding
import com.landrop.databinding.ItemChatMessageBinding
import com.landrop.databinding.ItemIpAddressBinding
import com.landrop.model.ChatMessage
import com.landrop.server.FileManager
import com.landrop.server.MessageManager
import com.landrop.service.TransferService
import com.landrop.ui.FileAdapter
import com.landrop.utils.NetworkUtils
import com.landrop.utils.QrCodeUtils
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class TransferFragment : Fragment() {

    private var _binding: FragmentTransferBinding? = null
    private val binding get() = _binding!!

    private lateinit var fileAdapter: FileAdapter
    private var selectedIpUrl: String? = null
    private val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    private val selectFilesLauncher = registerForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris: List<Uri> ->
        if (uris.isNotEmpty()) {
            val ctx = context ?: return@registerForActivityResult
            uris.forEach { uri ->
                FileManager.addFile(ctx, uri)
            }
            Toast.makeText(ctx, "已添加 ${uris.size} 个待发文件", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentTransferBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        initViews()
        initChatUi()
    }

    private fun getTransferService(): TransferService? {
        return (activity as? MainActivity)?.transferService
    }

    private fun initViews() {
        val ctx = requireContext()

        // 初始化 RecyclerView
        fileAdapter = FileAdapter(emptyList()) { file ->
            FileManager.removeFile(file.id)
        }
        binding.rvFiles.apply {
            layoutManager = LinearLayoutManager(ctx)
            adapter = fileAdapter
        }

        // 监听待发送文件列表变更
        FileManager.onFilesChangedListener = {
            activity?.runOnUiThread { refreshFileListUi() }
        }
        refreshFileListUi()

        // 启停开关
        binding.btnToggleServer.setOnClickListener {
            toggleServer()
        }

        binding.btnAddFiles.setOnClickListener {
            selectFilesLauncher.launch("*/*")
        }

        binding.btnClearFiles.setOnClickListener {
            FileManager.clearAll()
        }

        // 开启/查看热点
        binding.btnOpenHotspot.setOnClickListener {
            showHotspotGuideDialog()
        }

        // 刷新网络状态
        binding.btnRefreshNetwork.setOnClickListener {
            val service = getTransferService()
            if (service?.isRunning == true) {
                renderNetworkInterfaces(service.currentPort)
                Toast.makeText(ctx, "网络接口列表已刷新", Toast.LENGTH_SHORT).show()
            }
        }

        // 初始状态更新
        updateServerUi(getTransferService()?.isRunning == true)
    }

    private fun initChatUi() {
        // 监听来自电脑或手机的消息推送
        MessageManager.onMessageReceivedListener = { msg ->
            activity?.runOnUiThread {
                appendChatMessageView(msg)
            }
        }

        // 初始加载历史消息
        refreshChatUi()

        // 点击发送消息
        binding.btnSendMessage.setOnClickListener {
            val text = binding.etChatMessage.text.toString().trim()
            if (text.isNotBlank()) {
                MessageManager.addPhoneMessage(text)
                binding.etChatMessage.setText("")
            }
        }

        // 清空聊天
        binding.btnClearChat.setOnClickListener {
            MessageManager.clearAll()
            refreshChatUi()
            Toast.makeText(context, "聊天记录已清空", Toast.LENGTH_SHORT).show()
        }
    }

    private fun refreshChatUi() {
        if (_binding == null) return
        binding.llChatMessages.removeAllViews()
        val list = MessageManager.getMessages()
        if (list.isEmpty()) {
            binding.tvEmptyChat.visibility = View.VISIBLE
            binding.llChatMessages.addView(binding.tvEmptyChat)
        } else {
            binding.tvEmptyChat.visibility = View.GONE
            list.forEach { appendChatMessageView(it) }
        }
    }

    private fun appendChatMessageView(msg: ChatMessage) {
        if (_binding == null) return
        val ctx = context ?: return
        binding.tvEmptyChat.visibility = View.GONE

        val itemBinding = ItemChatMessageBinding.inflate(LayoutInflater.from(ctx), binding.llChatMessages, false)
        val timeStr = timeFormat.format(Date(msg.timestamp))
        val senderLabel = if (msg.isFromPhone) "📱 手机端 (本机)" else "💻 ${msg.senderName}"
        itemBinding.tvSenderInfo.text = "$senderLabel • $timeStr"
        itemBinding.tvMessageContent.text = msg.content

        if (msg.isFromPhone) {
            itemBinding.tvMessageContent.setBackgroundColor(Color.parseColor("#1E3A8A"))
            itemBinding.tvMessageContent.setTextColor(Color.parseColor("#BFDBFE"))
        } else {
            itemBinding.tvMessageContent.setBackgroundColor(Color.parseColor("#1E293B"))
            itemBinding.tvMessageContent.setTextColor(Color.parseColor("#F1F5F9"))
        }

        // 点击长按复制消息
        itemBinding.tvMessageContent.setOnClickListener {
            copyToClipboard(msg.content)
        }

        binding.llChatMessages.addView(itemBinding.root)
    }

    override fun onResume() {
        super.onResume()
        val service = getTransferService()
        if (service?.isRunning == true) {
            renderNetworkInterfaces(service.currentPort)
        }
    }

    fun onServiceConnected() {
        updateServerUi(getTransferService()?.isRunning == true)
    }

    private fun toggleServer() {
        val service = getTransferService() ?: return
        if (service.isRunning) {
            service.stopServer()
        } else {
            val started = service.startServer(9527)
            if (!started) {
                Toast.makeText(requireContext(), "服务启动失败，请检查端口是否被占用", Toast.LENGTH_LONG).show()
            }
        }
        updateServerUi(service.isRunning)
    }

    fun updateServerUi(isRunning: Boolean) {
        if (!isAdded || _binding == null) return
        val ctx = requireContext()

        if (isRunning) {
            val port = getTransferService()?.currentPort ?: 9527
            binding.tvStatus.text = getString(R.string.server_running)
            binding.tvStatus.setTextColor(ContextCompat.getColor(ctx, R.color.accent))
            binding.btnToggleServer.text = getString(R.string.stop_server)
            binding.btnToggleServer.setBackgroundColor(ContextCompat.getColor(ctx, R.color.danger))

            renderNetworkInterfaces(port)
        } else {
            binding.tvStatus.text = getString(R.string.server_stopped)
            binding.tvStatus.setTextColor(ContextCompat.getColor(ctx, R.color.text_secondary))
            binding.btnToggleServer.text = getString(R.string.start_server)
            binding.btnToggleServer.setBackgroundColor(ContextCompat.getColor(ctx, R.color.primary))

            binding.llIpSection.visibility = View.GONE
            binding.ivQrCode.visibility = View.GONE
            binding.tvQrHint.visibility = View.GONE
            binding.llIpContainer.removeAllViews()
            selectedIpUrl = null
        }
    }

    private fun renderNetworkInterfaces(port: Int) {
        val ctx = context ?: return
        val interfaces = NetworkUtils.getAllLocalIpAddresses(ctx)
        binding.llIpContainer.removeAllViews()

        if (interfaces.isEmpty()) {
            binding.tvStatus.text = "未检测到可用网络（请连接 Wi-Fi、插网线或开启手机热点）"
            binding.tvStatus.setTextColor(ContextCompat.getColor(ctx, R.color.danger))
            binding.llIpSection.visibility = View.GONE
            binding.ivQrCode.visibility = View.GONE
            binding.tvQrHint.visibility = View.GONE
            return
        }

        binding.llIpSection.visibility = View.VISIBLE

        val hasHotspot = interfaces.any { it.isHotspot }
        if (hasHotspot) {
            binding.tvIpListTitle.text = "检测到手机已开热点 (局域网直传，不耗流量)："
        } else if (interfaces.size > 1) {
            binding.tvIpListTitle.text = "检测到 ${interfaces.size} 个网络连接，电脑可任选其一直连："
        } else {
            binding.tvIpListTitle.text = "电脑浏览器访问以下地址："
        }

        val itemBindings = mutableListOf<Pair<ItemIpAddressBinding, String>>()

        interfaces.forEachIndexed { _, info ->
            val itemBinding = ItemIpAddressBinding.inflate(LayoutInflater.from(ctx), binding.llIpContainer, false)
            val url = "http://${info.ip}:$port"

            itemBinding.tvInterfaceBadge.text = info.displayName
            itemBinding.tvIpUrl.text = url

            // 针对有线网卡或手机热点分别高亮专属颜色
            if (info.isEthernet) {
                itemBinding.tvInterfaceBadge.setBackgroundColor(Color.parseColor("#065F46"))
                itemBinding.tvInterfaceBadge.setTextColor(Color.parseColor("#34D399"))
            } else if (info.isHotspot) {
                itemBinding.tvInterfaceBadge.setBackgroundColor(Color.parseColor("#7C2D12"))
                itemBinding.tvInterfaceBadge.setTextColor(Color.parseColor("#FDBA74"))
            }

            itemBinding.btnCopyIp.setOnClickListener {
                copyToClipboard(url)
                selectIpForQr(url, info.displayName, itemBinding, itemBindings)
            }

            itemBinding.cardIpItem.setOnClickListener {
                selectIpForQr(url, info.displayName, itemBinding, itemBindings)
            }

            binding.llIpContainer.addView(itemBinding.root)
            itemBindings.add(Pair(itemBinding, url))
        }

        val defaultInfo = interfaces.first()
        val defaultUrl = "http://${defaultInfo.ip}:$port"
        selectIpForQr(defaultUrl, defaultInfo.displayName, itemBindings.first().first, itemBindings)
    }

    private fun selectIpForQr(
        url: String,
        displayName: String,
        currentBinding: ItemIpAddressBinding,
        allBindings: List<Pair<ItemIpAddressBinding, String>>
    ) {
        val ctx = context ?: return
        selectedIpUrl = url

        allBindings.forEach { (b, itemUrl) ->
            if (itemUrl == url) {
                b.cardIpItem.strokeColor = ContextCompat.getColor(ctx, R.color.accent)
                b.cardIpItem.strokeWidth = 3
                b.tvActiveTag.visibility = View.VISIBLE
            } else {
                b.cardIpItem.strokeColor = ContextCompat.getColor(ctx, R.color.border_color)
                b.cardIpItem.strokeWidth = 1
                b.tvActiveTag.visibility = View.GONE
            }
        }

        val qrBitmap = QrCodeUtils.createQrCode(url, 400)
        if (qrBitmap != null) {
            binding.ivQrCode.setImageBitmap(qrBitmap)
            binding.ivQrCode.visibility = View.VISIBLE
            binding.tvQrHint.visibility = View.VISIBLE
            binding.tvQrHint.text = "二维码对应: $displayName"
        }
    }

    private fun copyToClipboard(text: String) {
        val ctx = context ?: return
        val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("WenDrop URL", text)
        clipboard.setPrimaryClip(clip)
        Toast.makeText(ctx, "已复制链接: $text", Toast.LENGTH_SHORT).show()
    }

    private fun refreshFileListUi() {
        if (_binding == null) return
        val list = FileManager.getFiles()
        fileAdapter.updateList(list)

        binding.tvFileListHeader.text = "待发送文件 (${list.size})"
        if (list.isEmpty()) {
            binding.tvEmptyHint.visibility = View.VISIBLE
            binding.btnClearFiles.visibility = View.GONE
        } else {
            binding.tvEmptyHint.visibility = View.GONE
            binding.btnClearFiles.visibility = View.VISIBLE
        }
    }

    private fun showHotspotGuideDialog() {
        val ctx = context ?: return
        val port = getTransferService()?.currentPort ?: 9527

        // 动态扫描当前系统真实网卡，绝不写死固定 IP
        val activeHotspot = NetworkUtils.getDynamicHotspotAddress(ctx)

        if (activeHotspot != null) {
            // 热点已在运行，直接动态展示系统真实分配的 IP
            val realHotspotUrl = "http://${activeHotspot.ip}:$port"
            com.google.android.material.dialog.MaterialAlertDialogBuilder(ctx)
                .setTitle("📡 手机热点已在运行")
                .setMessage(
                    "【动态捕获的热点真实直连地址】\n" +
                    "$realHotspotUrl\n\n" +
                    "【检测到的网卡】\n" +
                    "${activeHotspot.displayName}\n\n" +
                    "【电脑端操作】\n" +
                    "电脑连接此热点后，在浏览器直接打开上述地址即可！\n\n" +
                    "💡 提示：纯局域网点对点通信，完全不消耗手机蜂窝移动流量！"
                )
                .setPositiveButton("复制热点地址") { _, _ ->
                    copyToClipboard(realHotspotUrl)
                }
                .setNeutralButton("系统热点设置") { _, _ ->
                    openHotspotSettings()
                }
                .setNegativeButton("关闭", null)
                .show()
        } else {
            // 热点尚未开启，引导用户打开系统开关
            com.google.android.material.dialog.MaterialAlertDialogBuilder(ctx)
                .setTitle("📡 手机个人热点未开启")
                .setMessage(
                    "当前尚未检测到开启的热点网卡。\n\n" +
                    "【使用指引】\n" +
                    "1. 点击下方【打开系统热点】按钮开启热点。\n" +
                    "2. 开启后返回本应用，程序将【自动动态捕获系统底层分配的真实 IP 地址】并生成二维码，无需手动配置！\n\n" +
                    "💡 提示：电脑连热点传输不消耗任何手机移动流量。"
                )
                .setPositiveButton("打开系统热点") { _, _ ->
                    openHotspotSettings()
                }
                .setNegativeButton("取消", null)
                .show()
        }
    }

    private fun openHotspotSettings() {
        val intent = Intent()
        intent.action = "android.settings.TETHER_SETTINGS"
        try {
            startActivity(intent)
        } catch (_: Exception) {
            try {
                startActivity(Intent(android.provider.Settings.ACTION_WIRELESS_SETTINGS))
            } catch (_: Exception) {
                startActivity(Intent(android.provider.Settings.ACTION_SETTINGS))
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
