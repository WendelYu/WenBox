package com.landrop.ui.fragment

import android.app.Dialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.text.format.Formatter
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import com.landrop.MainActivity
import com.landrop.R
import com.landrop.databinding.DialogCreateRoomBinding
import com.landrop.databinding.DialogCustomAlertBinding
import com.landrop.databinding.DialogCustomConfirmBinding
import com.landrop.databinding.DialogEditNicknameBinding
import com.landrop.databinding.DialogJoinPinBinding
import com.landrop.databinding.FragmentTransferBinding
import com.landrop.databinding.ItemChatMessageBinding
import com.landrop.databinding.ItemDiscoveredRoomBinding
import com.landrop.databinding.ItemIpAddressBinding
import com.landrop.model.ChatMessage
import com.landrop.model.DiscoveredRoom
import com.landrop.service.TransferService
import com.landrop.ui.MainViewModel
import com.landrop.ui.RoomMode
import com.landrop.ui.TransferViewModel
import com.landrop.server.FileManager
import com.landrop.server.MessageManager
import com.landrop.server.RoomManager
import com.landrop.ui.FileAdapter
import com.landrop.utils.NetworkUtils
import com.landrop.utils.QrCodeUtils
import com.landrop.utils.UdpDiscoveryManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class TransferFragment : Fragment() {

    private var _binding: FragmentTransferBinding? = null
    private val binding get() = _binding!!

    private val transferViewModel: TransferViewModel by activityViewModels()
    private val mainViewModel: MainViewModel by activityViewModels()

    private lateinit var fileAdapter: FileAdapter
    private var selectedIpUrl: String? = null
    private val timeFormat = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    private var currentRoomMode = RoomMode.CLIENT
    private var joinedRoomMembers = mutableListOf<Pair<String, String>>()
    private var observerJob: Job? = null

    private val openDialogs = mutableListOf<Dialog>()

    private val bitmapCache = object : android.util.LruCache<String, Bitmap>(12 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.allocationByteCount
    }

    private val selectFilesLauncher = registerForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris: List<Uri> ->
        if (uris.isNotEmpty()) {
            val ctx = context ?: return@registerForActivityResult
            uris.forEach { uri ->
                FileManager.addFile(ctx, uri)
            }
            Toast.makeText(ctx, getString(R.string.toast_added_files, uris.size), Toast.LENGTH_SHORT).show()
        }
    }

    private val chatImagePickerLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri == null) return@registerForActivityResult
        val ctx = context ?: return@registerForActivityResult
        // 发送逻辑在 ViewModel 作用域内执行，切页/重建都不会中断 (A8)
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val cr = ctx.contentResolver
                val bmp = cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) }
                if (bmp == null) {
                    transferViewModel.toast("无法读取图片")
                    return@launch
                }
                val maxDim = 1280
                val width = bmp.width
                val height = bmp.height
                val scaled = if (width > maxDim || height > maxDim) {
                    val ratio = if (width > height) maxDim.toFloat() / width else maxDim.toFloat() / height
                    Bitmap.createScaledBitmap(bmp, (width * ratio).toInt(), (height * ratio).toInt(), true)
                } else {
                    bmp
                }
                val baos = ByteArrayOutputStream()
                scaled.compress(Bitmap.CompressFormat.JPEG, 82, baos)
                val base64 = android.util.Base64.encodeToString(baos.toByteArray(), android.util.Base64.NO_WRAP)
                transferViewModel.sendMessage("[image:data:image/jpeg;base64,$base64]")
            } catch (e: Exception) {
                transferViewModel.toast("发送图片失败: ${e.message}")
            }
        }
    }

    private val chatFilePickerLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri == null) return@registerForActivityResult
        val ctx = context ?: return@registerForActivityResult
        lifecycleScope.launch(Dispatchers.IO) {
            var fileName = "file_${System.currentTimeMillis()}"
            var fileSize: Long = 0
            runCatching {
                ctx.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                        if (nameIdx != -1) {
                            val n = cursor.getString(nameIdx)
                            if (!n.isNullOrBlank()) fileName = n
                        }
                        if (sizeIdx != -1) fileSize = cursor.getLong(sizeIdx)
                    }
                }
            }
            val sizeStr = Formatter.formatFileSize(ctx, fileSize)

            when (transferViewModel.state.value.mode) {
                RoomMode.HOST -> {
                    val sf = FileManager.addFile(ctx, uri)
                    transferViewModel.sendMessage("[file:$fileName|$sizeStr|/api/download/${sf.id}]")
                }
                RoomMode.JOINED -> transferViewModel.sendFileToJoinedRoom(ctx.contentResolver, uri, fileName, sizeStr)
                RoomMode.CLIENT -> transferViewModel.toast("请先创建或加入房间后再发送文件")
            }
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
        observeState()
    }

    private fun getTransferService(): TransferService? {
        return (activity as? MainActivity)?.transferService
    }

    // ---------------- 状态订阅 ----------------

    private fun observeState() {
        observerJob?.cancel()
        observerJob = viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    transferViewModel.state.collect { state ->
                        if (_binding == null) return@collect
                        renderState(state)
                    }
                }
                launch {
                    mainViewModel.serviceState.collect { service ->
                        if (_binding == null) return@collect
                        transferViewModel.updateServiceRunning(service.isRunning)
                        if (service.isRunning && RoomManager.currentRoom?.isActive == true) {
                            renderNetworkInterfaces(service.port)
                        }
                    }
                }
                launch {
                    transferViewModel.toasts.collect { message ->
                        val ctx = context ?: return@collect
                        Toast.makeText(ctx, message, Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }
        // 按当前进程状态恢复界面，View 重建后不会丢 JOINED (A5)
        transferViewModel.syncFromManagers(getTransferService()?.isRunning == true)
    }

    private fun renderState(state: com.landrop.ui.TransferUiState) {
        currentRoomMode = state.mode
        val ctx = context ?: return

        when (state.mode) {
            RoomMode.CLIENT -> {
                binding.tvRoomModeBadge.text = getString(R.string.room_badge_client)
                binding.tvRoomModeBadge.setTextColor(ContextCompat.getColor(ctx, R.color.accent_blue))
                binding.tvRoomModeBadge.backgroundTintList =
                    android.content.res.ColorStateList.valueOf(ContextCompat.getColor(ctx, R.color.card_bg))
                binding.tvRoomDetails.text = getString(R.string.room_details_client)

                binding.btnCreateRoom.visibility = View.VISIBLE
                binding.btnCloseRoom.visibility = View.GONE
                binding.btnLeaveRoom.visibility = View.GONE
                binding.btnChangeNicknameJoined.visibility = View.GONE
                binding.cardDiscoveredRooms.visibility = View.VISIBLE
                binding.llHostDetails.visibility = View.GONE
                binding.cardChatSection.visibility = View.GONE
                renderDiscoveredRooms(UdpDiscoveryManager.getRooms())
            }

            RoomMode.HOST -> {
                val cfg = state.room ?: RoomManager.currentRoom
                binding.btnCreateRoom.visibility = View.GONE
                binding.btnCloseRoom.visibility = View.VISIBLE
                binding.btnLeaveRoom.visibility = View.GONE
                binding.btnChangeNicknameJoined.visibility = View.GONE
                binding.cardDiscoveredRooms.visibility = View.GONE
                binding.llHostDetails.visibility = View.VISIBLE
                binding.cardChatSection.visibility = View.VISIBLE
                binding.tvChatSectionTitle.text = getString(R.string.chat_title_host)
                updateHostHeader(cfg)

                val port = getTransferService()?.currentPort ?: 9527
                renderNetworkInterfaces(port)
            }

            RoomMode.JOINED -> {
                val room = state.joinedRoom ?: return
                binding.tvRoomModeBadge.text = getString(R.string.room_badge_joined, room.roomName)
                binding.tvRoomModeBadge.setTextColor(ContextCompat.getColor(ctx, R.color.chat_accent_purple))
                binding.tvRoomModeBadge.backgroundTintList =
                    android.content.res.ColorStateList.valueOf(ContextCompat.getColor(ctx, R.color.card_bg))
                binding.tvRoomDetails.text = getString(R.string.room_details_joined, room.hostDevice, "${room.ip}:${room.port}")

                binding.btnCreateRoom.visibility = View.GONE
                binding.btnCloseRoom.visibility = View.GONE
                binding.btnLeaveRoom.visibility = View.VISIBLE
                binding.btnChangeNicknameJoined.visibility = View.VISIBLE
                binding.cardDiscoveredRooms.visibility = View.GONE
                binding.llHostDetails.visibility = View.GONE
                binding.cardChatSection.visibility = View.VISIBLE
                binding.tvChatSectionTitle.text = getString(R.string.chat_title_joined, room.roomName)
                binding.tvChatOnlineCount.text = getString(R.string.online_count, state.onlineCount)
                binding.tvChatRoomUrl.text = getString(R.string.visit_url_joined, "${room.ip}:${room.port}")
                // JOINED 的消息只来自 ViewModel，绝不写进本机 MessageManager (A3)
                renderJoinedMessages(state.joinedMessages)
            }
        }
        updateNicknameButtonDisplay()
    }

    /** 只刷新房间名/IP/在线数：不重建网卡列表，避免 setHostIp -> listener 递归 (A1) */
    private fun updateHostHeader(cfg: com.landrop.model.RoomConfig?) {
        val ctx = context ?: return
        val pinHint = if (cfg?.needPassword == true) " • PIN: ${cfg.pin}" else " • 免密"
        binding.tvRoomModeBadge.text = getString(R.string.room_badge_host, cfg?.roomName ?: "")
        binding.tvRoomModeBadge.setTextColor(ContextCompat.getColor(ctx, R.color.success_fg))
        binding.tvRoomModeBadge.backgroundTintList =
            android.content.res.ColorStateList.valueOf(ContextCompat.getColor(ctx, R.color.card_bg))
        binding.tvRoomDetails.text =
            "您已变身服务端房主$pinHint！局域网内的电脑和其他手机可自动搜索发现您的房间，也可扫码或在电脑浏览器访问下方地址直连。"
        binding.tvChatOnlineCount.text = getString(R.string.online_count, cfg?.let { RoomManager.getMembers().size } ?: 1)
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

        binding.btnChangeNicknameJoined.setOnClickListener {
            showEditNicknameDialog()
        }

        binding.btnChangeNicknameChat.setOnClickListener {
            showEditNicknameDialog()
        }

        updateNicknameButtonDisplay()

        binding.btnRefreshRooms.setOnClickListener {
            UdpDiscoveryManager.sendSearchProbe()
            renderDiscoveredRooms(UdpDiscoveryManager.getRooms())
            Toast.makeText(ctx, getString(R.string.toast_searching), Toast.LENGTH_SHORT).show()
        }

        binding.tvChatRoomUrl.setOnClickListener {
            val text = binding.tvChatRoomUrl.text.toString()
                .removePrefix("访问: ").removePrefix("🌐 访问: ").trim()
            if (text.isNotBlank()) {
                copyToClipboard(text)
            }
        }

        binding.tvChatOnlineCount.setOnClickListener {
            showOnlineMembersDialog()
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
    }

    private fun initRoomEvents() {
        RoomManager.onRoomStateChangedListener = { cfg ->
            activity?.runOnUiThread {
                if (_binding == null) return@runOnUiThread
                if (cfg != null && cfg.isActive) {
                    // 已经是房主时只刷新状态条，绝不重新进入 setRoomMode，
                    // 否则 renderNetworkInterfaces -> setHostIp -> listener 会无限递归 (A1)
                    if (transferViewModel.state.value.mode == RoomMode.HOST) {
                        transferViewModel.updateHostRoom(cfg)
                    } else {
                        transferViewModel.setHostMode(cfg)
                    }
                } else if (transferViewModel.state.value.mode == RoomMode.HOST) {
                    transferViewModel.setClientMode()
                }
            }
        }
        RoomManager.onMembersChangedListener = { members ->
            activity?.runOnUiThread {
                transferViewModel.updateOnlineCount(members.size)
            }
        }
    }

    private fun showCustomConfirmDialog(
        title: String,
        message: String,
        okText: String = "确定",
        onConfirm: () -> Unit
    ) {
        val ctx = context ?: return
        val dialogBinding = DialogCustomConfirmBinding.inflate(LayoutInflater.from(ctx))
        dialogBinding.tvConfirmTitle.text = title
        dialogBinding.tvConfirmMessage.text = message
        dialogBinding.btnConfirmOk.text = okText

        val dialog = trackDialog(createStyledDialog(ctx, dialogBinding.root))

        dialogBinding.btnConfirmCancel.setOnClickListener {
            dialog.dismiss()
        }
        dialogBinding.btnConfirmOk.setOnClickListener {
            dialog.dismiss()
            onConfirm()
        }
        dialog.show()
    }

    private fun showCustomAlertDialog(
        title: String,
        message: String,
        btnText: String = "我知道了"
    ) {
        val ctx = context ?: return
        val dialogBinding = DialogCustomAlertBinding.inflate(LayoutInflater.from(ctx))
        dialogBinding.tvAlertTitle.text = title
        dialogBinding.tvAlertMessage.text = message
        dialogBinding.btnAlertOk.text = btnText

        val dialog = trackDialog(createStyledDialog(ctx, dialogBinding.root))
        dialogBinding.btnAlertOk.setOnClickListener {
            dialog.dismiss()
        }
        dialog.show()
    }

    /** 所有自定义弹窗统一走这里，确保 View 销毁时能被关闭，避免 WindowLeaked (P2) */
    private fun createStyledDialog(ctx: Context, content: View): Dialog {
        return Dialog(ctx).apply {
            requestWindowFeature(Window.FEATURE_NO_TITLE)
            setContentView(content)
            window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            window?.setLayout(
                (resources.displayMetrics.widthPixels * 0.9).toInt(),
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
    }

    private fun trackDialog(dialog: Dialog): Dialog {
        openDialogs.add(dialog)
        dialog.setOnDismissListener { openDialogs.remove(dialog) }
        return dialog
    }

    private fun showCreateRoomDialog() {
        val ctx = context ?: return
        val dialogBinding = DialogCreateRoomBinding.inflate(LayoutInflater.from(ctx))
        val dialog = trackDialog(createStyledDialog(ctx, dialogBinding.root))

        renderRoomProfiles(dialogBinding)

        dialogBinding.btnCancelCreateRoom.setOnClickListener {
            dialog.dismiss()
        }

        dialogBinding.btnConfirmCreateRoom.setOnClickListener {
            val rName = dialogBinding.etRoomName.text.toString().trim()
            val rPin = dialogBinding.etRoomPin.text.toString().trim()

            // 勾选"保存为常用密码房"时记录该配置，下次创建可一键填入
            if (dialogBinding.chkSaveProfile.isChecked && rPin.isNotBlank()) {
                saveRoomProfile(rName, rPin)
            }

            val service = getTransferService()
            if (service?.isRunning != true) {
                val ok = service?.startServer(9527) ?: false
                if (!ok) {
                    Toast.makeText(ctx, getString(R.string.toast_service_start_failed), Toast.LENGTH_LONG).show()
                    dialog.dismiss()
                    return@setOnClickListener
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
            transferViewModel.setHostMode(cfg)
            dialog.dismiss()
            Toast.makeText(ctx, getString(R.string.toast_room_created, cfg.roomName), Toast.LENGTH_LONG).show()
        }

        dialog.show()
    }

    // ---------------- 常用密码房配置 (保存 / 一键填入 / 长按删除) ----------------

    private fun prefs() = requireContext().getSharedPreferences(TransferViewModel.PREFS, Context.MODE_PRIVATE)

    private fun getRoomProfiles(): MutableList<JSONObject> {
        return try {
            val arr = JSONArray(prefs().getString("room_profiles", "[]") ?: "[]")
            (0 until arr.length()).mapTo(mutableListOf()) { arr.getJSONObject(it) }
        } catch (_: Exception) {
            mutableListOf()
        }
    }

    private fun persistRoomProfiles(profiles: List<JSONObject>) {
        prefs().edit().putString("room_profiles", JSONArray(profiles).toString()).apply()
    }

    private fun saveRoomProfile(name: String, pin: String) {
        val profiles = getRoomProfiles()
        profiles.removeAll { it.optString("name") == name }
        profiles.add(0, JSONObject().put("name", name).put("pin", pin))
        while (profiles.size > 10) profiles.removeAt(profiles.size - 1)
        persistRoomProfiles(profiles)
    }

    private fun renderRoomProfiles(dialogBinding: DialogCreateRoomBinding) {
        val ctx = context ?: return
        val profiles = getRoomProfiles()
        val container = dialogBinding.llRoomProfiles
        container.removeAllViews()
        if (profiles.isEmpty()) {
            container.visibility = View.GONE
            return
        }
        container.visibility = View.VISIBLE

        val hint = TextView(ctx).apply {
            text = getString(R.string.room_profiles_hint)
            setTextColor(ContextCompat.getColor(ctx, R.color.text_secondary))
            textSize = 12f
        }
        container.addView(hint)

        profiles.forEach { profile ->
            val name = profile.optString("name", "未命名房间")
            val pin = profile.optString("pin", "")
            val row = TextView(ctx).apply {
                text = "▸ $name${if (pin.isNotBlank()) " (PIN: $pin)" else " (免密)"}"
                setTextColor(ContextCompat.getColor(ctx, R.color.accent_blue))
                textSize = 13f
                val pad = (8 * resources.displayMetrics.density).toInt()
                setPadding(0, pad, 0, pad)
                setOnClickListener {
                    dialogBinding.etRoomName.setText(name)
                    dialogBinding.etRoomPin.setText(pin)
                }
                setOnLongClickListener {
                    val remaining = getRoomProfiles().filter { it.optString("name") != name }
                    persistRoomProfiles(remaining)
                    renderRoomProfiles(dialogBinding)
                    Toast.makeText(context, "已删除常用房间「$name」", Toast.LENGTH_SHORT).show()
                    true
                }
            }
            container.addView(row)
        }
    }

    private fun confirmCloseRoom() {
        showCustomConfirmDialog(
            title = "解散房间",
            message = "确定要解散当前房间吗？解散后本机将恢复为客户端发现大厅，所有连入成员将被断开。",
            okText = "确认解散"
        ) {
            val ctx = context
            RoomManager.closeRoom()
            getTransferService()?.stopServer()
            transferViewModel.setClientMode()
            if (ctx != null) {
                Toast.makeText(ctx, getString(R.string.toast_room_closed), Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun confirmLeaveRoom() {
        showCustomConfirmDialog(
            title = "退出房间",
            message = "确定要退出当前房间吗？",
            okText = "确认退出"
        ) {
            // 先通知房主，成员列表即时更新，不必等 15 秒超时
            transferViewModel.leaveJoinedRoom()
        }
    }

    private fun renderDiscoveredRooms(rooms: List<DiscoveredRoom>) {
        if (_binding == null) return
        val ctx = context ?: return

        binding.tvDiscoveredRoomsTitle.text = getString(R.string.discovered_rooms_title, rooms.size)
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
            itemBinding.tvRoomHostInfo.text = getString(R.string.room_host_info, room.hostDevice, "${room.ip}:${room.port}")

            if (room.needPassword) {
                itemBinding.tvRoomLockBadge.text = getString(R.string.room_lock_required)
                itemBinding.tvRoomLockBadge.setTextColor(ContextCompat.getColor(ctx, R.color.warning_fg))
            } else {
                itemBinding.tvRoomLockBadge.text = getString(R.string.room_lock_open)
                itemBinding.tvRoomLockBadge.setTextColor(ContextCompat.getColor(ctx, R.color.success_fg))
            }
            itemBinding.tvRoomLockBadge.backgroundTintList = android.content.res.ColorStateList.valueOf(
                ContextCompat.getColor(ctx, R.color.card_bg)
            )

            itemBinding.btnJoinRoom.isEnabled = !transferViewModel.state.value.sending
            itemBinding.btnJoinRoom.setOnClickListener {
                // 请求期间禁用按钮，避免重复点击产生孤儿状态 (A6)
                if (transferViewModel.state.value.sending) return@setOnClickListener
                showJoinRoomDialog(room)
            }

            binding.llDiscoveredRoomsContainer.addView(itemBinding.root)
        }
    }

    private fun updateNicknameButtonDisplay() {
        val nick = transferViewModel.nickname()
        _binding?.btnChangeNicknameJoined?.text = getString(R.string.nickname_label, nick)
        _binding?.btnChangeNicknameChat?.text = getString(R.string.nickname_label, nick)
    }

    private fun showEditNicknameDialog() {
        val ctx = context ?: return
        val dialogBinding = DialogEditNicknameBinding.inflate(LayoutInflater.from(ctx))
        val currentNick = transferViewModel.nickname()
        dialogBinding.etEditNickname.setText(currentNick)
        dialogBinding.etEditNickname.selectAll()

        val dialog = trackDialog(createStyledDialog(ctx, dialogBinding.root))

        dialogBinding.btnCancelEditNickname.setOnClickListener {
            dialog.dismiss()
        }

        dialogBinding.btnConfirmEditNickname.setOnClickListener {
            val newNick = dialogBinding.etEditNickname.text.toString().trim()
            if (newNick.isBlank()) {
                Toast.makeText(ctx, getString(R.string.toast_nickname_invalid), Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            transferViewModel.setNickname(newNick)
            updateNicknameButtonDisplay()
            dialog.dismiss()
            Toast.makeText(ctx, getString(R.string.toast_nickname_changed, newNick), Toast.LENGTH_SHORT).show()
        }

        dialog.show()
    }

    private fun showJoinRoomDialog(room: DiscoveredRoom) {
        val ctx = context ?: return
        val dialogBinding = DialogJoinPinBinding.inflate(LayoutInflater.from(ctx))
        dialogBinding.tvJoinRoomTitle.text = getString(R.string.join_room_title, room.roomName)
        dialogBinding.etJoinNickname.setText(transferViewModel.nickname())

        dialogBinding.llPinSection.visibility = if (room.needPassword) View.VISIBLE else View.GONE

        val dialog = trackDialog(createStyledDialog(ctx, dialogBinding.root))

        dialogBinding.btnCancelJoinRoom.setOnClickListener {
            dialog.dismiss()
        }

        dialogBinding.btnConfirmJoinRoom.setOnClickListener {
            val nick = dialogBinding.etJoinNickname.text.toString().trim().ifBlank { "${Build.BRAND}手机" }
            transferViewModel.setNickname(nick)
            updateNicknameButtonDisplay()
            val pin = if (room.needPassword) dialogBinding.etJoinPin.text.toString().trim() else ""
            // 整个入房流程在 ViewModel 中完成：即使 View 被销毁也不会产生孤儿状态 (A6)
            transferViewModel.joinRemoteRoom(room, pin, nick)
            dialog.dismiss()
        }

        dialog.show()
    }

    // ---------------- 聊天 ----------------

    private fun initChatUi() {
        binding.btnSendMessage.setOnClickListener {
            val draft = binding.etChatMessage.text.toString()
            if (draft.isBlank()) return@setOnClickListener
            if (currentRoomMode == RoomMode.CLIENT) {
                Toast.makeText(context, getString(R.string.toast_need_room_message), Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            transferViewModel.sendMessage(draft.trim())
            binding.etChatMessage.setText("")
        }

        binding.btnChatSendImage.setOnClickListener {
            if (currentRoomMode == RoomMode.CLIENT) {
                Toast.makeText(context, getString(R.string.toast_need_room_image), Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            chatImagePickerLauncher.launch("image/*")
        }

        binding.btnChatSendFile.setOnClickListener {
            if (currentRoomMode == RoomMode.CLIENT) {
                Toast.makeText(context, getString(R.string.toast_need_room_file), Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            chatFilePickerLauncher.launch("*/*")
        }

        binding.btnClearChat.setOnClickListener {
            if (currentRoomMode == RoomMode.HOST) {
                MessageManager.clearAll()
            } else {
                transferViewModel.clearJoinedMessages()
            }
            Toast.makeText(context, getString(R.string.toast_chat_cleared), Toast.LENGTH_SHORT).show()
        }
    }

    /** JOINED 模式的会话流完全由 ViewModel 提供，不再读写本机 MessageManager (A3) */
    private fun renderJoinedMessages(messages: List<ChatMessage>) {
        if (_binding == null) return
        binding.llChatMessages.removeAllViews()
        if (messages.isEmpty()) {
            binding.tvEmptyChat.visibility = View.VISIBLE
            binding.llChatMessages.addView(binding.tvEmptyChat)
        } else {
            binding.tvEmptyChat.visibility = View.GONE
            messages.forEach { appendChatMessageView(it) }
        }
    }

    private fun appendChatMessageView(msg: ChatMessage) {
        if (_binding == null) return
        val ctx = context ?: return
        binding.tvEmptyChat.visibility = View.GONE

        val itemBinding = ItemChatMessageBinding.inflate(LayoutInflater.from(ctx), binding.llChatMessages, false)
        val timeStr = timeFormat.format(Date(msg.timestamp))

        val cleanName = msg.senderName.replace(Regex("^[\\s\\uD83C-\\uDBFF\\uDC00-\\uDFFF]+"), "").trim().ifBlank { "成员" }
        val ipTag = if (msg.senderIp.isNotBlank()) " (${msg.senderIp})" else ""
        val isMe = (msg.clientId.isNotBlank() && msg.clientId == transferViewModel.phoneClientId) || msg.isFromPhone
        if (isMe) {
            itemBinding.tvSenderInfo.text = "（我）$cleanName$ipTag"
            itemBinding.tvSenderInfo.setTextColor(ContextCompat.getColor(ctx, R.color.chat_accent_blue))
        } else {
            itemBinding.tvSenderInfo.text = "$cleanName$ipTag"
            itemBinding.tvSenderInfo.setTextColor(ContextCompat.getColor(ctx, R.color.chat_accent_green))
        }
        itemBinding.tvMessageTime.text = timeStr

        val content = msg.content
        var textToCopy = content

        val isImageMessage = (content.startsWith("[image:") && content.endsWith("]")) ||
                content.startsWith("data:image/") ||
                ((content.startsWith("http://") || content.startsWith("https://")) &&
                (content.endsWith(".png") || content.endsWith(".jpg") || content.endsWith(".jpeg") || content.endsWith(".webp") || content.endsWith(".gif")))

        if (isImageMessage) {
            val rawImgPayload = if (content.startsWith("[image:") && content.endsWith("]")) {
                content.removePrefix("[image:").removeSuffix("]")
            } else {
                content
            }
            val resolvedUrl = if (rawImgPayload.startsWith("/api/")) {
                appendRoomToken("${roomApiOrigin()}$rawImgPayload")
            } else {
                rawImgPayload
            }

            textToCopy = resolvedUrl
            itemBinding.tvMessageContent.visibility = View.GONE
            itemBinding.cvMessageImage.visibility = View.VISIBLE

            val cachedBmp = bitmapCache.get(resolvedUrl)
            if (cachedBmp != null) {
                itemBinding.ivMessageImage.setImageBitmap(cachedBmp)
            } else {
                viewLifecycleOwner.lifecycleScope.launch(Dispatchers.IO) {
                    val decodedBmp = decodeImagePayload(resolvedUrl)
                    if (decodedBmp != null) {
                        bitmapCache.put(resolvedUrl, decodedBmp)
                        withContext(Dispatchers.Main) {
                            if (_binding != null) itemBinding.ivMessageImage.setImageBitmap(decodedBmp)
                        }
                    }
                }
            }

            itemBinding.cvMessageImage.setOnClickListener {
                showImageLightboxDialog(resolvedUrl)
            }
        } else if (content.startsWith("[file:") && content.endsWith("]")) {
            itemBinding.tvMessageContent.visibility = View.VISIBLE
            itemBinding.cvMessageImage.visibility = View.GONE
            val inner = content.removePrefix("[file:").removeSuffix("]")
            val parts = inner.split("|")
            val fileName = parts.getOrNull(0) ?: "文件"
            val fileSize = parts.getOrNull(1) ?: ""
            itemBinding.tvMessageContent.text = getString(R.string.chat_file_card, fileName, fileSize)
            if (parts.size >= 3) {
                val fileUrl = parts[2]
                val finalUrl = appendRoomToken(if (fileUrl.startsWith("http")) fileUrl else "${roomApiOrigin()}$fileUrl")
                textToCopy = "$fileName - $finalUrl"
                itemBinding.tvMessageContent.setOnClickListener {
                    try {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(finalUrl))
                        startActivity(intent)
                    } catch (_: Exception) {
                        copyToClipboard(finalUrl)
                    }
                }
            }
        } else {
            itemBinding.tvMessageContent.visibility = View.VISIBLE
            itemBinding.cvMessageImage.visibility = View.GONE
            itemBinding.tvMessageContent.text = content
            itemBinding.tvMessageContent.autoLinkMask = android.text.util.Linkify.WEB_URLS
            itemBinding.tvMessageContent.movementMethod = android.text.method.LinkMovementMethod.getInstance()
        }

        itemBinding.btnCopyMessage.setOnClickListener {
            copyToClipboard(textToCopy)
        }

        binding.llChatMessages.addView(itemBinding.root)
        binding.nestedScrollView.post {
            binding.nestedScrollView.fullScroll(View.FOCUS_DOWN)
        }
    }

    /** 端口随服务变化，不再写死 127.0.0.1:9527 */
    private fun roomApiOrigin(): String {
        val port = getTransferService()?.currentPort ?: 9527
        return when (currentRoomMode) {
            RoomMode.HOST -> {
                val ip = NetworkUtils.getAllLocalIpAddresses(requireContext()).firstOrNull()?.ip ?: "127.0.0.1"
                "http://$ip:$port"
            }
            RoomMode.JOINED -> transferViewModel.state.value.joinedRoom?.let { "http://${it.ip}:${it.port}" } ?: ""
            RoomMode.CLIENT -> ""
        }
    }

    private fun appendRoomToken(url: String): String {
        val token = when (currentRoomMode) {
            RoomMode.HOST -> RoomManager.currentHostToken
            RoomMode.JOINED -> transferViewModel.state.value.joinedToken
            else -> null
        }
        if (token.isNullOrBlank() || !url.contains("/api/")) return url
        val sep = if (url.contains('?')) "&" else "?"
        return try {
            url + sep + "token=" + URLEncoder.encode(token, "UTF-8")
        } catch (_: Exception) {
            url + sep + "token=" + token
        }
    }

    private fun decodeImagePayload(payload: String, reqWidth: Int = 600, reqHeight: Int = 600): Bitmap? {
        return try {
            when {
                payload.startsWith("data:image/") -> {
                    val bytes = android.util.Base64.decode(payload.substringAfter("base64,"), android.util.Base64.DEFAULT)
                    decodeSampled(bytes, reqWidth, reqHeight)
                }
                payload.startsWith("http://") || payload.startsWith("https://") -> {
                    val conn = URL(payload).openConnection() as java.net.HttpURLConnection
                    conn.connectTimeout = 8000
                    conn.readTimeout = 20000
                    try {
                        val bytes = conn.inputStream.use { it.readBytes() }
                        decodeSampled(bytes, reqWidth, reqHeight)
                    } finally {
                        conn.disconnect()
                    }
                }
                else -> null
            }
        } catch (t: Throwable) {
            t.printStackTrace()
            null
        }
    }

    private fun decodeSampled(bytes: ByteArray, reqWidth: Int, reqHeight: Int): Bitmap? {
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        opts.inSampleSize = calculateInSampleSize(opts, reqWidth, reqHeight)
        opts.inJustDecodeBounds = false
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
    }

    private fun calculateInSampleSize(options: BitmapFactory.Options, reqWidth: Int, reqHeight: Int): Int {
        val (height: Int, width: Int) = options.outHeight to options.outWidth
        var inSampleSize = 1
        if (height > reqHeight || width > reqWidth) {
            val halfHeight: Int = height / 2
            val halfWidth: Int = width / 2
            while (halfHeight / inSampleSize >= reqHeight && halfWidth / inSampleSize >= reqWidth) {
                inSampleSize *= 2
            }
        }
        return inSampleSize
    }

    private fun showImageLightboxDialog(payload: String) {
        val ctx = context ?: return
        val dialog = trackDialog(Dialog(ctx, android.R.style.Theme_Black_NoTitleBar_Fullscreen))
        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#E6000000"))
            gravity = Gravity.CENTER
            setPadding(16, 32, 16, 24)
        }

        val topBar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                bottomMargin = 16
            }
        }

        val btnClose = Button(ctx).apply {
            text = getString(R.string.dialog_close)
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.TRANSPARENT)
            textSize = 14f
            setOnClickListener { dialog.dismiss() }
        }

        val spacer = View(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(0, 1, 1f)
        }

        val btnSave = Button(ctx).apply {
            text = getString(R.string.save_to_gallery)
            setTextColor(ContextCompat.getColor(ctx, R.color.accent_blue))
            setBackgroundColor(Color.TRANSPARENT)
            textSize = 14f
        }

        topBar.addView(btnClose)
        topBar.addView(spacer)
        topBar.addView(btnSave)
        root.addView(topBar)

        val imageView = ImageView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
            adjustViewBounds = true
            scaleType = ImageView.ScaleType.FIT_CENTER
        }
        root.addView(imageView)

        var fullBmp: Bitmap? = null

        viewLifecycleOwner.lifecycleScope.launch(Dispatchers.IO) {
            // 按屏幕尺寸采样解码，避免全尺寸解码大图 OOM (A9)
            val metrics = resources.displayMetrics
            val bmp = decodeImagePayload(payload, metrics.widthPixels, metrics.heightPixels)
            fullBmp = bmp
            withContext(Dispatchers.Main) {
                if (bmp != null) {
                    imageView.setImageBitmap(bmp)
                } else {
                    Toast.makeText(ctx, getString(R.string.toast_image_load_failed), Toast.LENGTH_SHORT).show()
                }
            }
        }

        btnSave.setOnClickListener {
            val bmp = fullBmp
            if (bmp == null) {
                Toast.makeText(ctx, getString(R.string.toast_image_not_ready), Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            saveBitmapToGallery(ctx, bmp)
        }

        dialog.setContentView(root)
        dialog.show()
    }

    private fun saveBitmapToGallery(ctx: Context, bmp: Bitmap) {
        viewLifecycleOwner.lifecycleScope.launch(Dispatchers.IO) {
            try {
                val fileName = "WenBox_IMG_${System.currentTimeMillis()}.jpg"
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = android.content.ContentValues().apply {
                        put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
                        put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                        put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/WenBox")
                        put(MediaStore.Images.Media.IS_PENDING, 1)
                    }
                    val resolver = ctx.contentResolver
                    val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                    if (uri == null) {
                        withContext(Dispatchers.Main) { Toast.makeText(ctx, getString(R.string.toast_image_save_creating_failed), Toast.LENGTH_SHORT).show() }
                        return@launch
                    }
                    try {
                        resolver.openOutputStream(uri)?.use { out ->
                            bmp.compress(Bitmap.CompressFormat.JPEG, 95, out)
                        } ?: throw IllegalStateException("无法写入")
                        values.clear()
                        values.put(MediaStore.Images.Media.IS_PENDING, 0)
                        resolver.update(uri, values, null, null)
                        withContext(Dispatchers.Main) {
                            Toast.makeText(ctx, getString(R.string.toast_image_saved_gallery), Toast.LENGTH_SHORT).show()
                        }
                    } catch (e: Exception) {
                        // 写入失败必须删掉 IS_PENDING 残留
                        runCatching { resolver.delete(uri, null, null) }
                        throw e
                    }
                } else {
                    // API 26-28 需要写外部存储权限，无权限时退回应用私有目录 (A7)
                    val targetDir = if (Environment.getExternalStorageState() == Environment.MEDIA_MOUNTED &&
                        ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
                        android.content.pm.PackageManager.PERMISSION_GRANTED
                    ) {
                        File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "WenBox")
                    } else {
                        ctx.getExternalFilesDir(Environment.DIRECTORY_PICTURES) ?: ctx.filesDir
                    }
                    if (!targetDir.exists()) targetDir.mkdirs()
                    val f = File(targetDir, fileName)
                    java.io.FileOutputStream(f).use { out ->
                        bmp.compress(Bitmap.CompressFormat.JPEG, 95, out)
                    }
                    if (Environment.getExternalStorageState() == Environment.MEDIA_MOUNTED) {
                        ctx.sendBroadcast(Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.fromFile(f)))
                    }
                    val label = if (targetDir.absolutePath.contains("Pictures")) "Pictures/WenBox" else targetDir.absolutePath
                    withContext(Dispatchers.Main) {
                        Toast.makeText(ctx, getString(R.string.toast_image_saved_to, label), Toast.LENGTH_SHORT).show()
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(ctx, getString(R.string.toast_image_save_failed, e.message ?: ""), Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun showOnlineMembersDialog() {
        val ctx = context ?: return
        val membersList = if (currentRoomMode == RoomMode.HOST) {
            RoomManager.getMembers().map { it.name to it.ip }
        } else {
            joinedRoomMembers.toList()
        }

        val dialog = trackDialog(Dialog(ctx).apply {
            requestWindowFeature(Window.FEATURE_NO_TITLE)
            window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        })

        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_dialog_card)
            val pad = (20 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
        }

        val title = TextView(ctx).apply {
            text = getString(R.string.members_title, membersList.size)
            setTextColor(ContextCompat.getColor(ctx, R.color.text_primary))
            textSize = 17f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        }
        root.addView(title)

        val sub = TextView(ctx).apply {
            text = getString(R.string.members_subtitle)
            setTextColor(ContextCompat.getColor(ctx, R.color.text_secondary))
            textSize = 12f
            setPadding(0, (4 * resources.displayMetrics.density).toInt(), 0, (12 * resources.displayMetrics.density).toInt())
        }
        root.addView(sub)

        val scroll = ScrollView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                (240 * resources.displayMetrics.density).toInt()
            )
        }
        val listContainer = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
        }

        if (membersList.isEmpty()) {
            val emptyTv = TextView(ctx).apply {
                text = getString(R.string.members_empty)
                setTextColor(ContextCompat.getColor(ctx, R.color.text_secondary))
                textSize = 14f
                setPadding(0, (16 * resources.displayMetrics.density).toInt(), 0, (16 * resources.displayMetrics.density).toInt())
            }
            listContainer.addView(emptyTv)
        } else {
            membersList.forEach { (name, ip) ->
                val row = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, (8 * resources.displayMetrics.density).toInt(), 0, (8 * resources.displayMetrics.density).toInt())
                }
                val infoCol = LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                }
                val nameTv = TextView(ctx).apply {
                    text = name
                    setTextColor(ContextCompat.getColor(ctx, R.color.text_primary))
                    textSize = 14f
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                }
                val ipTv = TextView(ctx).apply {
                    text = "IP: $ip"
                    setTextColor(ContextCompat.getColor(ctx, R.color.accent_blue))
                    textSize = 12f
                }
                infoCol.addView(nameTv)
                infoCol.addView(ipTv)
                row.addView(infoCol)

                val copyBtn = Button(ctx).apply {
                    text = getString(R.string.members_copy_ip)
                    textSize = 12f
                    setTextColor(Color.WHITE)
                    setBackgroundResource(R.drawable.bg_btn_primary)
                    setOnClickListener {
                        copyToClipboard(ip)
                    }
                    val btnPadH = (12 * resources.displayMetrics.density).toInt()
                    val btnPadV = (8 * resources.displayMetrics.density).toInt()
                    // 触控目标不小于 48dp
                    setPadding(btnPadH, btnPadV, btnPadH, btnPadV)
                    minHeight = (48 * resources.displayMetrics.density).toInt()
                    minWidth = (48 * resources.displayMetrics.density).toInt()
                    layoutParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        (48 * resources.displayMetrics.density).toInt()
                    )
                }
                row.addView(copyBtn)
                listContainer.addView(row)
            }
        }
        scroll.addView(listContainer)
        root.addView(scroll)

        val closeBtn = Button(ctx).apply {
            text = getString(R.string.dialog_close)
            setTextColor(ContextCompat.getColor(ctx, R.color.text_primary))
            setBackgroundResource(R.drawable.bg_btn_secondary)
            textSize = 14f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                (48 * resources.displayMetrics.density).toInt()
            ).apply {
                topMargin = (16 * resources.displayMetrics.density).toInt()
            }
            setOnClickListener { dialog.dismiss() }
        }
        root.addView(closeBtn)

        dialog.setContentView(root)
        dialog.window?.setLayout(
            (resources.displayMetrics.widthPixels * 0.9).toInt(),
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        dialog.show()
    }

    override fun onResume() {
        super.onResume()
        val service = getTransferService()
        if (service?.isRunning == true && transferViewModel.state.value.mode == RoomMode.HOST) {
            renderNetworkInterfaces(service.currentPort)
        } else if (transferViewModel.state.value.mode == RoomMode.CLIENT) {
            UdpDiscoveryManager.sendSearchProbe()
            renderDiscoveredRooms(UdpDiscoveryManager.getRooms())
        }
    }

    /** 网卡列表刷新入口：只重绘列表与二维码，不做任何房间状态写入 (A1) */
    private fun renderNetworkInterfaces(port: Int) {
        val ctx = context ?: return
        if (_binding == null) return
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

        interfaces.forEach { info ->
            val itemBinding = ItemIpAddressBinding.inflate(LayoutInflater.from(ctx), binding.llIpContainer, false)
            val url = "http://${info.ip}:$port"

            itemBinding.tvInterfaceBadge.text = info.displayName
            itemBinding.tvIpUrl.text = url

            val badgeColor = when {
                info.isEthernet -> R.color.success_fg
                info.isHotspot -> R.color.warning_fg
                else -> R.color.text_secondary
            }
            itemBinding.tvInterfaceBadge.setTextColor(ContextCompat.getColor(ctx, badgeColor))

            itemBinding.btnCopyIp.setOnClickListener {
                copyToClipboard(url)
            }

            itemBinding.cardIpItem.setOnClickListener {
                selectIpForQr(url, info.displayName, itemBinding, itemBindings)
            }

            binding.llIpContainer.addView(itemBinding.root)
            itemBindings.add(Pair(itemBinding, url))
        }

        val defaultPair = if (selectedIpUrl != null && itemBindings.any { it.second == selectedIpUrl }) {
            itemBindings.first { it.second == selectedIpUrl }
        } else {
            itemBindings.first()
        }
        val defaultInfo = interfaces.firstOrNull { "http://${it.ip}:$port" == defaultPair.second } ?: interfaces.first()
        selectIpForQr(defaultPair.second, defaultInfo.displayName, defaultPair.first, itemBindings)
    }

    private fun selectIpForQr(
        url: String,
        displayName: String,
        currentBinding: ItemIpAddressBinding,
        allBindings: List<Pair<ItemIpAddressBinding, String>>
    ) {
        val ctx = context ?: return
        selectedIpUrl = url
        val selectedIp = url.removePrefix("http://").substringBefore(":")
        // RoomManager.setHostIp 内部已做去重：IP 未变化时不会再回调监听器，
        // 因此这条调用链不会形成递归 (A1)
        RoomManager.setHostIp(selectedIp)
        binding.tvChatRoomUrl.text = "访问: $url"

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
        Toast.makeText(ctx, getString(R.string.toast_copied, text), Toast.LENGTH_SHORT).show()
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

        val dialogBinding = DialogCustomConfirmBinding.inflate(LayoutInflater.from(ctx))
        val dialog = trackDialog(Dialog(ctx).apply {
            requestWindowFeature(Window.FEATURE_NO_TITLE)
            setContentView(dialogBinding.root)
            window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            window?.setLayout(
                (resources.displayMetrics.widthPixels * 0.9).toInt(),
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        })

        if (activeHotspot != null) {
            val realHotspotUrl = "http://${activeHotspot.ip}:$port"
            dialogBinding.tvConfirmTitle.text = "手机热点已在运行"
            dialogBinding.tvConfirmMessage.text = "【动态捕获的热点真实直连地址】\n$realHotspotUrl\n\n【检测到的网卡】\n${activeHotspot.displayName}\n\n【电脑端操作】\n电脑连接此热点后，在浏览器直接打开上述地址即可！\n\n提示：纯局域网点对点通信，完全不消耗手机蜂窝移动流量！"
            dialogBinding.btnConfirmCancel.text = "系统热点设置"
            dialogBinding.btnConfirmCancel.setOnClickListener {
                dialog.dismiss()
                openHotspotSettings()
            }
            dialogBinding.btnConfirmOk.text = "复制热点地址"
            dialogBinding.btnConfirmOk.setBackgroundResource(R.drawable.bg_btn_primary)
            dialogBinding.btnConfirmOk.setOnClickListener {
                dialog.dismiss()
                copyToClipboard(realHotspotUrl)
            }
        } else {
            dialogBinding.tvConfirmTitle.text = "手机个人热点未开启"
            dialogBinding.tvConfirmMessage.text = "当前尚未检测到开启的热点网卡。\n\n【使用指引】\n1. 点击下方【打开系统热点】按钮开启热点。\n2. 开启后返回本应用，程序将【自动动态捕获系统底层分配的真实 IP 地址】并生成二维码，无需手动配置！\n\n提示：电脑连热点传输不消耗任何手机移动流量。"
            dialogBinding.btnConfirmCancel.text = "取消"
            dialogBinding.btnConfirmCancel.setOnClickListener {
                dialog.dismiss()
            }
            dialogBinding.btnConfirmOk.text = "打开系统热点"
            dialogBinding.btnConfirmOk.setBackgroundResource(R.drawable.bg_btn_primary)
            dialogBinding.btnConfirmOk.setOnClickListener {
                dialog.dismiss()
                openHotspotSettings()
            }
        }

        dialog.show()
    }

    private fun openHotspotSettings() {
        // 定制 ROM 上可能没有该设置页，逐级退回并兜底 toast (P2)
        val candidates = listOf(
            "android.settings.TETHER_SETTINGS",
            android.provider.Settings.ACTION_WIRELESS_SETTINGS,
            android.provider.Settings.ACTION_SETTINGS
        )
        for (action in candidates) {
            try {
                startActivity(Intent(action))
                return
            } catch (_: Exception) {
                // 尝试下一个
            }
        }
        Toast.makeText(context, getString(R.string.toast_hotspot_settings_missing), Toast.LENGTH_SHORT).show()
    }

    override fun onDestroyView() {
        observerJob?.cancel()
        observerJob = null
        openDialogs.toList().forEach { runCatching { it.dismiss() } }
        openDialogs.clear()
        // 单例监听器持有 Fragment 会导致内存泄漏，必须在 onDestroyView 解绑 (P2)
        FileManager.onFilesChangedListener = null
        RoomManager.onRoomStateChangedListener = null
        RoomManager.onMembersChangedListener = null
        MessageManager.onMessageReceivedListener = null
        UdpDiscoveryManager.onRoomsChangedListener = null
        bitmapCache.evictAll()
        _binding = null
        super.onDestroyView()
    }
}
