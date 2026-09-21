package com.landrop.ui.fragment

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.landrop.MainActivity
import com.landrop.R
import com.landrop.databinding.DialogCreateRoomBinding
import com.landrop.databinding.DialogJoinPinBinding
import com.landrop.databinding.FragmentTransferBinding
import com.landrop.databinding.ItemChatMessageBinding
import com.landrop.databinding.ItemDiscoveredRoomBinding
import com.landrop.databinding.ItemIpAddressBinding
import com.landrop.model.ChatMessage
import com.landrop.model.DiscoveredRoom
import com.landrop.model.RoomConfig
import com.landrop.server.FileManager
import com.landrop.server.MessageManager
import com.landrop.server.RoomManager
import com.landrop.service.TransferService
import com.landrop.ui.FileAdapter
import com.landrop.utils.HttpHelper
import com.landrop.utils.NetworkUtils
import com.landrop.utils.QrCodeUtils
import com.landrop.utils.UdpDiscoveryManager
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class TransferFragment : Fragment() {

    enum class RoomMode {
        CLIENT,  // 默认客户端发现大厅
        HOST,    // 房主服务中
        JOINED   // 已加入他人房间
    }

    private var _binding: FragmentTransferBinding? = null
    private val binding get() = _binding!!

    private lateinit var fileAdapter: FileAdapter
    private var selectedIpUrl: String? = null
    private val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    private var currentRoomMode = RoomMode.CLIENT
    private var joinedRoom: DiscoveredRoom? = null
    private var joinedToken: String? = null
    private var clientPollJob: Job? = null

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
        initRoomEvents()
    }

    private fun getTransferService(): TransferService? {
        return (activity as? MainActivity)?.transferService
    }

    private fun initViews() {
        val ctx = requireContext()

        // 初始化待发文件 RecyclerView
        fileAdapter = FileAdapter(emptyList()) { file ->
            FileManager.removeFile(file.id)
        }
        binding.rvFiles.apply {
            layoutManager = LinearLayoutManager(ctx)
            adapter = fileAdapter
        }

        FileManager.onFilesChangedListener = {
            activity?.runOnUiThread { refreshFileListUi() }
        }
        refreshFileListUi()

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

        // 房间操作按钮绑定
        binding.btnCreateRoom.setOnClickListener {
            showCreateRoomDialog()
        }

        binding.btnCloseRoom.setOnClickListener {
            confirmCloseRoom()
        }

        binding.btnLeaveRoom.setOnClickListener {
            confirmLeaveRoom()
        }

        binding.btnRefreshRooms.setOnClickListener {
            renderDiscoveredRooms(UdpDiscoveryManager.getRooms())
            Toast.makeText(ctx, "已刷新局域网房间", Toast.LENGTH_SHORT).show()
        }

        // 启动后台 UDP 房间发现监听
        UdpDiscoveryManager.startReceiver(requireContext().applicationContext)
        UdpDiscoveryManager.onRoomsChangedListener = { rooms ->
            activity?.runOnUiThread {
                if (_binding != null && currentRoomMode == RoomMode.CLIENT) {
                    renderDiscoveredRooms(rooms)
                }
            }
        }
        renderDiscoveredRooms(UdpDiscoveryManager.getRooms())

        // 恢复已有房间状态
        val activeRoom = RoomManager.currentRoom
        if (activeRoom != null && activeRoom.isActive) {
            setRoomMode(RoomMode.HOST, activeRoom)
        } else {
            setRoomMode(RoomMode.CLIENT)
        }
    }

    private fun initRoomEvents() {
        RoomManager.onRoomStateChangedListener = { cfg ->
            activity?.runOnUiThread {
                if (cfg != null && cfg.isActive) {
                    setRoomMode(RoomMode.HOST, cfg)
                } else {
                    if (currentRoomMode == RoomMode.HOST) {
                        setRoomMode(RoomMode.CLIENT)
                    }
                }
            }
        }
        RoomManager.onMembersChangedListener = { members ->
            activity?.runOnUiThread {
                if (_binding != null && currentRoomMode == RoomMode.HOST) {
                    binding.tvChatOnlineCount.text = "👥 在线: ${members.size} 人"
                }
            }
        }
    }

    private fun setRoomMode(mode: RoomMode, roomCfg: RoomConfig? = null) {
        currentRoomMode = mode
        if (_binding == null) return
        val ctx = context ?: return

        when (mode) {
            RoomMode.CLIENT -> {
                clientPollJob?.cancel()
                clientPollJob = null
                joinedRoom = null
                joinedToken = null

                binding.tvRoomModeBadge.text = "🔍 客户端模式（搜索房间中）"
                binding.tvRoomModeBadge.setTextColor(Color.parseColor("#38BDF8"))
                binding.tvRoomModeBadge.setBackgroundColor(Color.parseColor("#1E293B"))
                binding.tvRoomDetails.text = "当前处于客户端发现大厅，系统正在自动搜索局域网房间。点击下方房间可一键加入；若需别人连接您，请点击「创建房间」。"

                binding.btnCreateRoom.visibility = View.VISIBLE
                binding.btnCloseRoom.visibility = View.GONE
                binding.btnLeaveRoom.visibility = View.GONE
                binding.cardDiscoveredRooms.visibility = View.VISIBLE
                binding.llHostDetails.visibility = View.GONE
                binding.cardChatSection.visibility = View.GONE
                renderDiscoveredRooms(UdpDiscoveryManager.getRooms())
            }

            RoomMode.HOST -> {
                clientPollJob?.cancel()
                clientPollJob = null
                val cfg = roomCfg ?: RoomManager.currentRoom

                val pinHint = if (cfg?.needPassword == true) " • PIN: ${cfg.pin}" else " • 免密"
                binding.tvRoomModeBadge.text = "👑 房主服务中: ${cfg?.roomName ?: "未命名"}"
                binding.tvRoomModeBadge.setTextColor(Color.parseColor("#34D399"))
                binding.tvRoomModeBadge.setBackgroundColor(Color.parseColor("#064E3B"))
                binding.tvRoomDetails.text = "您已变身服务端房主$pinHint！局域网内的电脑和其他手机可自动搜索发现您的房间，也可扫码或在电脑浏览器访问下方地址直连。"

                binding.btnCreateRoom.visibility = View.GONE
                binding.btnCloseRoom.visibility = View.VISIBLE
                binding.btnLeaveRoom.visibility = View.GONE
                binding.cardDiscoveredRooms.visibility = View.GONE
                binding.llHostDetails.visibility = View.VISIBLE
                binding.cardChatSection.visibility = View.VISIBLE
                binding.tvChatSectionTitle.text = "💬 局域网即时互发消息 (房主服务中)"

                val port = getTransferService()?.currentPort ?: 9527
                val primaryIp = NetworkUtils.getAllLocalIpAddresses(ctx).firstOrNull()?.ip ?: "127.0.0.1"
                binding.tvChatOnlineCount.text = "👥 在线: ${RoomManager.getMembers().size} 人"
                binding.tvChatRoomUrl.text = "🌐 访问: http://$primaryIp:$port"
                renderNetworkInterfaces(port)
            }

            RoomMode.JOINED -> {
                val r = joinedRoom ?: return
                binding.tvRoomModeBadge.text = "📱 已加入房间: ${r.roomName}"
                binding.tvRoomModeBadge.setTextColor(Color.parseColor("#A78BFA"))
                binding.tvRoomModeBadge.setBackgroundColor(Color.parseColor("#3B0764"))
                binding.tvRoomDetails.text = "已直连房主设备「${r.hostDevice}」(http://${r.ip}:${r.port})。双方已打通双向通道，可在下方即时互发消息和共享文件！"

                binding.btnCreateRoom.visibility = View.GONE
                binding.btnCloseRoom.visibility = View.GONE
                binding.btnLeaveRoom.visibility = View.VISIBLE
                binding.cardDiscoveredRooms.visibility = View.GONE
                binding.llHostDetails.visibility = View.GONE
                binding.cardChatSection.visibility = View.VISIBLE
                binding.tvChatSectionTitle.text = "💬 局域网即时互发消息 (已加入: ${r.roomName})"
                binding.tvChatOnlineCount.text = "👥 在线: 2 人"
                binding.tvChatRoomUrl.text = "🌐 访问: http://${r.ip}:${r.port}"

                startJoinedRoomPolling(r)
            }
        }
    }

    private fun showCreateRoomDialog() {
        val ctx = context ?: return
        val dialogBinding = DialogCreateRoomBinding.inflate(LayoutInflater.from(ctx))

        MaterialAlertDialogBuilder(ctx)
            .setView(dialogBinding.root)
            .setPositiveButton("立即创建并开启服务") { _, _ ->
                val rName = dialogBinding.etRoomName.text.toString().trim()
                val rPin = dialogBinding.etRoomPin.text.toString().trim()

                val service = getTransferService()
                if (service?.isRunning != true) {
                    val ok = service?.startServer(9527) ?: false
                    if (!ok) {
                        Toast.makeText(ctx, "服务启动失败，请检查端口", Toast.LENGTH_LONG).show()
                        return@setPositiveButton
                    }
                }

                val primaryIp = NetworkUtils.getAllLocalIpAddresses(ctx).firstOrNull()?.ip ?: "127.0.0.1"
                val devName = "${Build.BRAND} ${Build.MODEL}"
                val cfg = RoomManager.createRoom(
                    roomName = rName,
                    pin = rPin,
                    hostDevice = devName,
                    hostIp = primaryIp,
                    hostPort = 9527
                )
                setRoomMode(RoomMode.HOST, cfg)
                Toast.makeText(ctx, "🎉 房间「${cfg.roomName}」已创建，本机已变身服务端！", Toast.LENGTH_LONG).show()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun confirmCloseRoom() {
        val ctx = context ?: return
        MaterialAlertDialogBuilder(ctx)
            .setTitle("解散房间")
            .setMessage("确定要解散当前房间吗？解散后本机将恢复为客户端发现模式。")
            .setPositiveButton("解散") { _, _ ->
                RoomManager.closeRoom()
                getTransferService()?.stopServer()
                setRoomMode(RoomMode.CLIENT)
                Toast.makeText(ctx, "房间已解散，已切换回客户端发现大厅", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun confirmLeaveRoom() {
        val ctx = context ?: return
        MaterialAlertDialogBuilder(ctx)
            .setTitle("退出房间")
            .setMessage("确定要退出当前房间吗？")
            .setPositiveButton("退出") { _, _ ->
                setRoomMode(RoomMode.CLIENT)
                Toast.makeText(ctx, "已退出房间", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun renderDiscoveredRooms(rooms: List<DiscoveredRoom>) {
        if (_binding == null) return
        val ctx = context ?: return

        binding.tvDiscoveredRoomsTitle.text = "📡 局域网已发现房间 (${rooms.size})"
        binding.llDiscoveredRoomsContainer.removeAllViews()

        if (rooms.isEmpty()) {
            binding.tvNoRoomsPrompt.visibility = View.VISIBLE
            return
        }

        binding.tvNoRoomsPrompt.visibility = View.GONE
        rooms.forEach { room ->
            val itemBinding = ItemDiscoveredRoomBinding.inflate(
                LayoutInflater.from(ctx),
                binding.llDiscoveredRoomsContainer,
                false
            )

            itemBinding.tvRoomName.text = room.roomName
            val memberStr = if (room.memberCount > 0) " • 成员: ${room.memberCount}" else ""
            itemBinding.tvRoomHostInfo.text = "房主: ${room.hostDevice} (${room.ip}:${room.port})$memberStr"

            if (room.needPassword) {
                itemBinding.tvRoomLockBadge.text = "🔒 需密码"
                itemBinding.tvRoomLockBadge.setTextColor(Color.parseColor("#FBBF24"))
                itemBinding.tvRoomLockBadge.setBackgroundColor(Color.parseColor("#78350F"))
            } else {
                itemBinding.tvRoomLockBadge.text = "🟢 免密进入"
                itemBinding.tvRoomLockBadge.setTextColor(Color.parseColor("#34D399"))
                itemBinding.tvRoomLockBadge.setBackgroundColor(Color.parseColor("#064E3B"))
            }

            itemBinding.btnJoinRoom.setOnClickListener {
                showJoinRoomDialog(room)
            }

            binding.llDiscoveredRoomsContainer.addView(itemBinding.root)
        }
    }

    private fun showJoinRoomDialog(room: DiscoveredRoom) {
        val ctx = context ?: return
        val dialogBinding = DialogJoinPinBinding.inflate(LayoutInflater.from(ctx))
        dialogBinding.tvJoinRoomTitle.text = "📱 加入「${room.roomName}」"

        val sp = ctx.getSharedPreferences("wenbox_prefs", Context.MODE_PRIVATE)
        val defaultNick = sp.getString("user_nickname", null) ?: "${Build.BRAND}手机"
        dialogBinding.etJoinNickname.setText(defaultNick)

        if (room.needPassword) {
            dialogBinding.llPinSection.visibility = View.VISIBLE
        } else {
            dialogBinding.llPinSection.visibility = View.GONE
        }

        MaterialAlertDialogBuilder(ctx)
            .setView(dialogBinding.root)
            .setPositiveButton("立即加入") { _, _ ->
                val nick = dialogBinding.etJoinNickname.text.toString().trim().ifBlank { "${Build.BRAND}手机" }
                sp.edit().putString("user_nickname", nick).apply()
                val pin = if (room.needPassword) dialogBinding.etJoinPin.text.toString().trim() else ""
                joinRemoteRoom(room, pin, nick)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun joinRemoteRoom(room: DiscoveredRoom, pin: String, nickname: String) {
        val ctx = context ?: return
        Toast.makeText(ctx, "正在接入「${room.roomName}」...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            try {
                val url = "http://${room.ip}:${room.port}/api/room/join"
                val body = JSONObject().apply {
                    put("pin", pin)
                    put("name", nickname)
                    put("platform", "Android")
                }
                val (code, resText) = HttpHelper.postJson(url, body)
                if (code == 200) {
                    val json = JSONObject(resText)
                    if (json.optBoolean("success", false)) {
                        joinedRoom = room
                        joinedToken = json.optString("token", "")
                        setRoomMode(RoomMode.JOINED)
                        Toast.makeText(ctx, "🎉 成功加入房间！已与「${room.hostDevice}」建立直连", Toast.LENGTH_LONG).show()
                    } else {
                        val msg = json.optString("message", "入房密码不正确")
                        Toast.makeText(ctx, "加入失败: $msg", Toast.LENGTH_LONG).show()
                    }
                } else {
                    Toast.makeText(ctx, "连接房主失败: HTTP $code", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Toast.makeText(ctx, "网络连接异常: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun startJoinedRoomPolling(room: DiscoveredRoom) {
        clientPollJob?.cancel()
        clientPollJob = lifecycleScope.launch {
            var failCount = 0
            while (isActive && currentRoomMode == RoomMode.JOINED) {
                try {
                    // 1. 发送心跳与拉取成员
                    val hbUrl = "http://${room.ip}:${room.port}/api/room/heartbeat"
                    HttpHelper.postJson(hbUrl, JSONObject())

                    val memUrl = "http://${room.ip}:${room.port}/api/room/members"
                    val (mCode, mRes) = HttpHelper.getJson(memUrl)
                    if (mCode == 200) {
                        failCount = 0
                        val mJson = JSONObject(mRes)
                        val mArr = mJson.optJSONArray("members")
                        val count = mArr?.length() ?: 1
                        _binding?.tvChatOnlineCount?.text = "👥 在线: $count 人"
                    } else if (mCode == 404) {
                        failCount++
                    }

                    // 2. 拉取房间聊天消息
                    val msgUrl = "http://${room.ip}:${room.port}/api/messages"
                    val headers = mutableMapOf<String, String>()
                    joinedToken?.let { headers["X-Room-Token"] = it }
                    val (code, res) = HttpHelper.getJson(msgUrl, headers)
                    if (code == 200) {
                        failCount = 0
                        val json = JSONObject(res)
                        val arr = json.optJSONArray("messages")
                        if (arr != null) {
                            for (i in 0 until arr.length()) {
                                val item = arr.getJSONObject(i)
                                val sender = item.optString("senderName", "成员")
                                val content = item.optString("content", "")
                                val ts = item.optLong("timestamp", System.currentTimeMillis())
                                val isFromPhone = item.optBoolean("isFromPhone", false)

                                val exists = MessageManager.getMessages().any { it.content == content && Math.abs(it.timestamp - ts) < 2000 }
                                if (!exists && !isFromPhone) {
                                    MessageManager.addClientMessage(content, sender)
                                }
                            }
                        }
                    } else {
                        failCount++
                    }
                } catch (_: Exception) {
                    failCount++
                }

                if (failCount >= 3) {
                    context?.let { ctx ->
                        Toast.makeText(ctx, "房主已解散房间或网络中断，已返回大厅", Toast.LENGTH_SHORT).show()
                    }
                    setRoomMode(RoomMode.CLIENT)
                    break
                }

                delay(3000)
            }
        }
    }

    private fun initChatUi() {
        MessageManager.onMessageReceivedListener = { msg ->
            activity?.runOnUiThread {
                appendChatMessageView(msg)
            }
        }

        refreshChatUi()

        binding.btnSendMessage.setOnClickListener {
            val text = binding.etChatMessage.text.toString().trim()
            if (text.isNotBlank()) {
                val msg = MessageManager.addPhoneMessage(text)
                binding.etChatMessage.setText("")

                // 如果处于 JOINED 模式，向房主服务端发送此条消息
                if (currentRoomMode == RoomMode.JOINED) {
                    val r = joinedRoom
                    if (r != null) {
                        lifecycleScope.launch {
                            try {
                                val sendUrl = "http://${r.ip}:${r.port}/api/messages"
                                val body = JSONObject().apply {
                                    put("content", text)
                                    put("senderName", "📱 ${Build.BRAND}手机端")
                                }
                                val headers = mutableMapOf<String, String>()
                                joinedToken?.let { headers["X-Room-Token"] = it }
                                HttpHelper.postJson(sendUrl, body, headers)
                            } catch (_: Exception) {}
                        }
                    }
                }
            }
        }

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
        val content = msg.content
        if (content.startsWith("[image:") && content.endsWith("]")) {
            itemBinding.tvMessageContent.text = "🖼️ [图片/截图消息] 点击复制数据"
            itemBinding.tvMessageContent.setOnClickListener { copyToClipboard(content) }
        } else if (content.startsWith("[file:") && content.endsWith("]")) {
            val inner = content.removePrefix("[file:").removeSuffix("]")
            val parts = inner.split("|")
            val fileName = parts.getOrNull(0) ?: "文件"
            val fileSize = parts.getOrNull(1) ?: ""
            itemBinding.tvMessageContent.text = "📎 [文件快传] $fileName ($fileSize)\n点击打开下载"
            itemBinding.tvMessageContent.setOnClickListener {
                if (parts.size >= 3) {
                    val fileUrl = parts[2]
                    try {
                        val host = joinedRoom?.let { "http://${it.ip}:${it.port}" } ?: ""
                        val finalUrl = if (fileUrl.startsWith("http")) fileUrl else "$host$fileUrl"
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(finalUrl))
                        startActivity(intent)
                    } catch (_: Exception) {
                        copyToClipboard(fileUrl)
                    }
                } else {
                    copyToClipboard(content)
                }
            }
        } else {
            itemBinding.tvMessageContent.text = content
            itemBinding.tvMessageContent.autoLinkMask = android.text.util.Linkify.WEB_URLS
            itemBinding.tvMessageContent.movementMethod = android.text.method.LinkMovementMethod.getInstance()
            itemBinding.tvMessageContent.setOnClickListener {
                copyToClipboard(msg.content)
            }
        }

        if (msg.isFromPhone) {
            itemBinding.tvMessageContent.setBackgroundColor(Color.parseColor("#1E3A8A"))
            itemBinding.tvMessageContent.setTextColor(Color.parseColor("#BFDBFE"))
        } else {
            itemBinding.tvMessageContent.setBackgroundColor(Color.parseColor("#1E293B"))
            itemBinding.tvMessageContent.setTextColor(Color.parseColor("#F1F5F9"))
        }

        binding.llChatMessages.addView(itemBinding.root)
    }

    override fun onResume() {
        super.onResume()
        val service = getTransferService()
        if (service?.isRunning == true && currentRoomMode == RoomMode.HOST) {
            renderNetworkInterfaces(service.currentPort)
        }
    }

    fun onServiceConnected() {
        val running = getTransferService()?.isRunning == true
        if (running && RoomManager.currentRoom?.isActive == true) {
            setRoomMode(RoomMode.HOST)
        } else if (currentRoomMode != RoomMode.JOINED) {
            setRoomMode(RoomMode.CLIENT)
        }
    }

    fun updateServerUi(isRunning: Boolean) {
        if (!isAdded || _binding == null) return
        if (isRunning && RoomManager.currentRoom?.isActive == true) {
            setRoomMode(RoomMode.HOST)
        } else if (!isRunning && currentRoomMode == RoomMode.HOST) {
            setRoomMode(RoomMode.CLIENT)
        }
    }

    private fun renderNetworkInterfaces(port: Int) {
        val ctx = context ?: return
        val interfaces = NetworkUtils.getAllLocalIpAddresses(ctx)
        binding.llIpContainer.removeAllViews()

        if (interfaces.isEmpty()) {
            binding.llIpSection.visibility = View.GONE
            binding.ivQrCode.visibility = View.GONE
            binding.tvQrHint.visibility = View.GONE
            return
        }

        binding.llIpSection.visibility = View.VISIBLE
        val itemBindings = mutableListOf<Pair<ItemIpAddressBinding, String>>()

        interfaces.forEachIndexed { _, info ->
            val itemBinding = ItemIpAddressBinding.inflate(LayoutInflater.from(ctx), binding.llIpContainer, false)
            val url = "http://${info.ip}:$port"

            itemBinding.tvInterfaceBadge.text = info.displayName
            itemBinding.tvIpUrl.text = url

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
        val clip = ClipData.newPlainText("WenBox URL", text)
        clipboard.setPrimaryClip(clip)
        Toast.makeText(ctx, "已复制: $text", Toast.LENGTH_SHORT).show()
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
        val activeHotspot = NetworkUtils.getDynamicHotspotAddress(ctx)

        if (activeHotspot != null) {
            val realHotspotUrl = "http://${activeHotspot.ip}:$port"
            MaterialAlertDialogBuilder(ctx)
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
            MaterialAlertDialogBuilder(ctx)
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
        clientPollJob?.cancel()
        clientPollJob = null
        _binding = null
    }
}
