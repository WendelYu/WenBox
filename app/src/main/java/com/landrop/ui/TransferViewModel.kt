package com.landrop.ui

import android.app.Application
import android.content.ContentResolver
import android.net.Uri
import android.os.Build
import com.landrop.R
import com.landrop.server.FileManager
import com.landrop.security.RoomProfileStore
import com.landrop.security.RoomDownloadClient
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.io.FilterInputStream
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.landrop.model.ChatMessage
import com.landrop.model.DiscoveredRoom
import com.landrop.model.RoomConfig
import com.landrop.server.MessageManager
import com.landrop.server.RoomManager
import com.landrop.utils.HttpHelper
import com.landrop.utils.NetworkUtils
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

enum class RoomMode {
    CLIENT,  // 默认客户端发现大厅
    HOST,    // 房主服务中
    JOINED   // 已加入他人房间
}

/**
 * 传输页的全部可变状态。全部放在 ViewModel 里，View 重建后依然存活：
 * - 轮询 Job 挂在 viewModelScope，切页/旋转不会中断；
 * - 通过 StateFlow 订阅，Fragment 重建后按当前状态重新渲染，不再强制回到 HOST (A5)。
 */
data class TransferUiState(
    val mode: RoomMode = RoomMode.CLIENT,
    val room: RoomConfig? = null,
    val joinedRoom: DiscoveredRoom? = null,
    val joinedMessages: List<ChatMessage> = emptyList(),
    val onlineCount: Int = 1,
    val myMemberId: String = "",
    val serviceRunning: Boolean = false,
    val sending: Boolean = false,
    /** 加入他人房间后拿到的房间令牌，随 state 一起在 View 重建后恢复 */
    val joinedToken: String = ""
)

class TransferViewModel(application: Application) : AndroidViewModel(application) {

    private val _state = MutableStateFlow(TransferUiState())
    val state: StateFlow<TransferUiState> = _state.asStateFlow()

    private val _toasts = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val toasts = _toasts.asSharedFlow()

    private val hostMessageScreen = MessageScreen()
    fun visibleHostMessages(messages: List<ChatMessage>) = hostMessageScreen.visible(_state.value.room?.roomId.orEmpty(), messages)
    fun clearHostScreen() = hostMessageScreen.clear(_state.value.room?.roomId.orEmpty(), MessageManager.getMessages())

    private var pollJob: Job? = null
    private val profileStore = RoomProfileStore(application)

    init {
        viewModelScope.launch {
            try { profileStore.load() } // Migrate old plaintext before a profile dialog is opened.
            catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (_: Exception) { toast(application.getString(R.string.profiles_unavailable)) }
        }
    }

    fun saveRoomProfile(name: String, pin: String) {
        viewModelScope.launch {
            try { profileStore.upsert(name, pin) }
            catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (_: Exception) { toast(getApplication<Application>().getString(R.string.profiles_save_failed)) }
        }
    }

    fun downloadAttachment(resource: String, fileName: String) {
        val snapshot = _state.value
        val origin = when (snapshot.mode) {
            RoomMode.HOST -> "http://127.0.0.1:${snapshot.room?.hostPort ?: 9527}"
            RoomMode.JOINED -> snapshot.joinedRoom?.let { "http://${it.ip}:${it.port}" } ?: return
            RoomMode.CLIENT -> return
        }
        val token = if (snapshot.mode == RoomMode.HOST) RoomManager.currentHostToken else snapshot.joinedToken
        viewModelScope.launch(Dispatchers.IO) {
            val app = getApplication<Application>()
            try {
                val coroutine = currentCoroutineContext()
                toast(app.getString(R.string.attachment_downloading, fileName))
                val saved = RoomDownloadClient.download(origin, resource, token.orEmpty()) { input ->
                    val stream = object : FilterInputStream(input) {
                        override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
                            coroutine.ensureActive()
                            return super.read(bytes, offset, length)
                        }
                    }
                    checkNotNull(FileManager.saveIncomingFile(app, fileName, stream)) { "无法保存文件" }
                }
                coroutine.ensureActive()
                val location = if (saved.uri.scheme == "file") saved.uri.path.orEmpty() else "Downloads/WenBox/${saved.name}"
                toast(app.getString(R.string.attachment_saved, location))
            } catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (_: Exception) { toast(app.getString(R.string.attachment_failed)) }
        }
    }


    /** 本机客户端 id 持久化，重建后保持一致，避免自己的消息被当成别人的重复显示 (A5/Rust 其它) */
    val phoneClientId: String = run {
        val prefs = application.getSharedPreferences(PREFS, Application.MODE_PRIVATE)
        val existing = prefs.getString(KEY_CLIENT_ID, null)
        if (!existing.isNullOrBlank()) {
            existing
        } else {
            val generated = "android_" + UUID.randomUUID().toString().take(8)
            prefs.edit().putString(KEY_CLIENT_ID, generated).apply()
            generated
        }
    }

    fun nickname(): String {
        val prefs = getApplication<Application>().getSharedPreferences(PREFS, Application.MODE_PRIVATE)
        return prefs.getString(KEY_NICKNAME, null) ?: "${Build.BRAND}手机"
    }

    fun setNickname(value: String) {
        val prefs = getApplication<Application>().getSharedPreferences(PREFS, Application.MODE_PRIVATE)
        prefs.edit().putString(KEY_NICKNAME, value).apply()
    }

    fun toast(message: String) {
        _toasts.tryEmit(message)
    }

    // ---------------- 房间模式 ----------------

    /** 按当前进程状态重建界面状态；View 重建后调用，不再无条件回到 HOST (A5) */
    fun syncFromManagers(serviceRunning: Boolean) {
        val active = RoomManager.currentRoom
        val mode = when {
            _state.value.mode == RoomMode.JOINED && _state.value.joinedRoom != null -> RoomMode.JOINED
            active != null && active.isActive -> RoomMode.HOST
            else -> RoomMode.CLIENT
        }
        _state.value = _state.value.copy(
            mode = mode,
            room = if (mode == RoomMode.HOST) active else _state.value.room,
            serviceRunning = serviceRunning
        )
        if (mode == RoomMode.JOINED) {
            val joined = _state.value.joinedRoom
            if (joined != null) startJoinedPolling(joined)
        }
    }

    fun setHostMode(cfg: RoomConfig) {
        pollJob?.cancel()
        pollJob = null
        _state.value = _state.value.copy(
            mode = RoomMode.HOST,
            room = cfg,
            joinedRoom = null,
            joinedMessages = emptyList(),
            onlineCount = RoomManager.getMembers().size,
            myMemberId = RoomManager.getHostMemberId(),
            joinedToken = ""
        )
    }

    /**
     * 房主信息变化（房间名/IP/在线数）只刷新状态条数据，
     * 不重建网卡列表，避免 setRoomMode -> renderNetworkInterfaces -> setHostIp 的递归 (A1)。
     */
    fun updateHostRoom(cfg: RoomConfig) {
        if (_state.value.mode != RoomMode.HOST) return
        _state.value = _state.value.copy(room = cfg, onlineCount = RoomManager.getMembers().size)
    }

    fun updateOnlineCount(count: Int) {
        _state.value = _state.value.copy(onlineCount = count)
    }

    fun setClientMode() {
        pollJob?.cancel()
        pollJob = null
        _state.value = _state.value.copy(
            mode = RoomMode.CLIENT,
            room = null,
            joinedRoom = null,
            joinedMessages = emptyList(),
            myMemberId = "",
            joinedToken = ""
        )
    }

    fun updateServiceRunning(running: Boolean) {
        _state.value = _state.value.copy(serviceRunning = running)
    }

    // ---------------- 加入 / 退出他人房间 ----------------

    fun joinRemoteRoom(room: DiscoveredRoom, pin: String, nickname: String) {
        if (_state.value.sending) return
        _state.value = _state.value.copy(sending = true)
        viewModelScope.launch {
            try {
                val body = JSONObject().apply {
                    put("pin", pin)
                    put("name", nickname)
                    put("platform", "Android")
                }
                val (code, resText) = HttpHelper.postJson("http://${room.ip}:${room.port}/api/room/join", body)
                when {
                    code == 429 -> {
                        val message = runCatching { JSONObject(resText).optString("message") }.getOrNull()
                        _toasts.tryEmit(message?.takeIf { it.isNotBlank() } ?: "尝试过多，请稍后再试")
                    }
                    code == 200 -> {
                        val json = JSONObject(resText)
                        if (json.optBoolean("success", false)) {
                            val token = json.optString("token", "")
                            _state.value = _state.value.copy(
                                mode = RoomMode.JOINED,
                                joinedRoom = room,
                                myMemberId = json.optString("memberId", ""),
                                joinedMessages = emptyList(),
                                sending = false,
                                joinedToken = token
                            )
                            startJoinedPolling(room)
                            _toasts.tryEmit("已加入房间「${room.roomName}」")
                        } else {
                            _toasts.tryEmit("加入失败: ${json.optString("message", "入房密码不正确")}")
                        }
                    }
                    else -> _toasts.tryEmit("连接房主失败: HTTP $code")
                }
            } catch (e: Exception) {
                _toasts.tryEmit("网络连接异常: ${e.message}")
            } finally {
                _state.value = _state.value.copy(sending = false)
            }
        }
    }

    /** 退出房间：先通知房主，成员列表即时更新，不必等 15 秒超时 (P2) */
    fun leaveJoinedRoom() {
        val room = _state.value.joinedRoom
        val token = _state.value.joinedToken
        pollJob?.cancel()
        pollJob = null
        _state.value = _state.value.copy(
            mode = RoomMode.CLIENT,
            joinedRoom = null,
            joinedMessages = emptyList(),
            myMemberId = "",
            joinedToken = ""
        )
        if (room != null && !token.isNullOrBlank()) {
            viewModelScope.launch {
                runCatching {
                    HttpHelper.postJson(
                        "http://${room.ip}:${room.port}/api/room/leave",
                        JSONObject().put("token", token),
                        mapOf("X-Room-Token" to token)
                    )
                }
            }
        }
        _toasts.tryEmit("已退出房间")
    }

    // ---------------- JOINED 轮询 ----------------

    fun startJoinedPolling(room: DiscoveredRoom) {
        if (pollJob?.isActive == true) return
        pollJob = viewModelScope.launch {
            var lastMsgTs = 0L
            var failCount = 0
            val knownIds = _state.value.joinedMessages.map { it.id }.toMutableSet()
            while (isActive && _state.value.mode == RoomMode.JOINED) {
                var cycleSuccess = false
                try {
                    val token = _state.value.joinedToken
                    val headers = if (!token.isNullOrBlank()) mapOf("X-Room-Token" to token) else emptyMap()

                    // 1. 心跳：向房主注册身份，同时同步房间状态
                    val hbBody = JSONObject().apply {
                        put("name", nickname())
                        put("platform", "Mobile")
                        put("roomId", room.roomId)
                        if (!token.isNullOrBlank()) put("token", token)
                    }
                    val (hbCode, hbRes) = HttpHelper.postJson("http://${room.ip}:${room.port}/api/room/heartbeat", hbBody, headers)
                    if (hbCode == 200) {
                        cycleSuccess = true
                        val hbJson = JSONObject(hbRes)
                        val memberId = hbJson.optString("memberId", "")
                        val roomObj = hbJson.optJSONObject("room")
                        if (roomObj != null && !roomObj.optBoolean("isActive", true)) {
                            _toasts.tryEmit("房主已关闭房间")
                            setClientMode()
                            return@launch
                        }
                        if (roomObj != null) {
                            val newRoomId = roomObj.optString("roomId", "")
                            val newRoomName = roomObj.optString("roomName", "")
                            if (newRoomId.isNotBlank() && newRoomId != _state.value.joinedRoom?.roomId) {
                                _state.value = _state.value.copy(
                                    joinedRoom = room.copy(roomId = newRoomId, roomName = newRoomName.ifBlank { room.roomName })
                                )
                            }
                        }
                        if (memberId.isNotBlank() && memberId != _state.value.myMemberId) {
                            _state.value = _state.value.copy(myMemberId = memberId)
                        }
                    } else if (hbCode == 401) {
                        _toasts.tryEmit("房间需要密码或凭证已失效，请重新加入")
                        setClientMode()
                        return@launch
                    }

                    // 2. 成员列表
                    val (mCode, mRes) = HttpHelper.getJson("http://${room.ip}:${room.port}/api/room/members", headers)
                    if (mCode == 200) {
                        cycleSuccess = true
                        val mJson = JSONObject(mRes)
                        val count = mJson.optInt("count", mJson.optJSONArray("members")?.length() ?: 1)
                        _state.value = _state.value.copy(onlineCount = count)
                    }

                    // 3. 增量拉取消息。解析放到 Default 线程，避免首轮大图 base64 卡主线程 (P2)
                    val msgUrl = buildString {
                        append("http://${room.ip}:${room.port}/api/messages")
                        if (lastMsgTs > 0) append("?since=${lastMsgTs - 1}")
                    }
                    val (code, res) = HttpHelper.getJson(msgUrl, headers)
                    if (code == 200) {
                        cycleSuccess = true
                        val parsed = withContext(Dispatchers.Default) {
                            val arr = JSONObject(res).optJSONArray("messages") ?: return@withContext emptyList()
                            (0 until arr.length()).mapNotNull { index ->
                                val item = arr.optJSONObject(index) ?: return@mapNotNull null
                                ChatMessage(
                                    id = item.optString("id", ""),
                                    senderName = item.optString("senderName", "成员"),
                                    content = item.optString("content", ""),
                                    timestamp = item.optLong("timestamp", System.currentTimeMillis()),
                                    isFromPhone = false,
                                    senderIp = item.optString("senderIp", ""),
                                    clientId = item.optString("clientId", "")
                                )
                            }
                        }
                        if (parsed.isNotEmpty()) {
                            val incoming = parsed.filter { msg ->
                                val id = msg.id.ifBlank { "${msg.timestamp}-${msg.content.hashCode()}" }
                                if (knownIds.contains(id)) {
                                    false
                                } else {
                                    knownIds.add(id)
                                    true
                                }
                            }.map { msg ->
                                // 自己的消息由本机直接加入列表，这里过滤掉服务端回显
                                msg.copy(id = msg.id.ifBlank { UUID.randomUUID().toString() })
                            }.filter { it.clientId.isBlank() || it.clientId != phoneClientId }

                            val merged = (_state.value.joinedMessages + incoming)
                                .distinctBy { it.id }
                                .sortedBy { it.timestamp }
                                .takeLast(MAX_UI_MESSAGES)
                            _state.value = _state.value.copy(joinedMessages = merged)
                            parsed.forEach { if (it.timestamp > lastMsgTs) lastMsgTs = it.timestamp }
                        }
                    }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // 网络抖动：计入失败次数后重试
                }

                if (cycleSuccess) {
                    failCount = 0
                } else {
                    failCount++
                }
                if (failCount >= 5) {
                    _toasts.tryEmit("房主已解散房间或网络中断，已返回大厅")
                    setClientMode()
                    return@launch
                }
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    // ---------------- 发送 ----------------

    fun sendMessage(text: String) {
        if (_state.value.mode == RoomMode.CLIENT || text.isBlank()) return
        val app = getApplication<Application>()
        val myIp = NetworkUtils.getAllLocalIpAddresses(app).firstOrNull()?.ip ?: ""
        val nick = nickname()

        if (_state.value.mode == RoomMode.HOST) {
            MessageManager.addPhoneMessage(text, nick, myIp, phoneClientId)
            return
        }

        val room = _state.value.joinedRoom ?: return
        val token = _state.value.joinedToken
        viewModelScope.launch {
            try {
                val body = JSONObject().apply {
                    put("content", text)
                    put("senderName", nick)
                    put("senderIp", myIp)
                    put("clientId", phoneClientId)
                }
                val headers = mapOf("X-Room-Token" to token)
                val (code, _) = HttpHelper.postJson("http://${room.ip}:${room.port}/api/messages", body, headers)
                if (code !in 200..299) throw IllegalStateException("HTTP $code")
                if (!isCurrentJoinedRoom(room, token)) return@launch
                // 自己的消息只写进会话列表，绝不写进本机 MessageManager：
                // 否则加入别人房间的消息会出现在本机房间的服务端，造成串房 (A3)
                appendJoinedMessage(
                    ChatMessage(
                        id = UUID.randomUUID().toString(),
                        senderName = nick,
                        content = text,
                        timestamp = System.currentTimeMillis(),
                        isFromPhone = true,
                        senderIp = myIp,
                        clientId = phoneClientId
                    )
                )
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                // 在 ViewModel 作用域内发送，切页/重建后不会抛 IllegalStateException (A8)
                _toasts.tryEmit("发送失败，请检查连接后重试")
            }
        }
    }

    /**
     * 发送文件到 JOINED 房间。UI 只负责给出 ContentResolver + Uri，
     * 上传在 viewModelScope 中完成，View 被销毁也不会中断或抛异常 (A8)。
     */
    fun sendFileToJoinedRoom(resolver: ContentResolver, uri: Uri, fileName: String, sizeLabel: String) {
        val room = _state.value.joinedRoom ?: return
        val token = _state.value.joinedToken
        viewModelScope.launch {
            var tempFile: File? = null
            try {
                _toasts.tryEmit("正在上传「$fileName」…")
                val buffer = withContext(Dispatchers.IO) {
                    val target = File.createTempFile("wenbox_upload_", ".tmp", getApplication<Application>().cacheDir)
                    tempFile = target
                    resolver.openInputStream(uri)?.use { input ->
                        FileOutputStream(target).use { output -> input.copyTo(output) }
                    } ?: throw IllegalStateException("无法读取所选文件")
                    target
                }
                val headers = mapOf("X-Room-Token" to token)
                val (code, res) = withContext(Dispatchers.IO) {
                    buffer.inputStream().use { stream ->
                        HttpHelper.uploadFile("http://${room.ip}:${room.port}/api/upload", fileName, stream, headers)
                    }
                }
                if (code !in 200..299) {
                    _toasts.tryEmit("上传文件失败 (code: $code)")
                    return@launch
                }
                if (!isCurrentJoinedRoom(room, token)) return@launch
                val fileId = runCatching { JSONObject(res).optString("fileId", "") }.getOrDefault("")
                val encoded = java.net.URLEncoder.encode(fileName, "UTF-8")
                val dlUrl = if (fileId.isNotBlank()) "/api/download/$fileId" else "/api/download/$encoded"
                val msg = "[file:$fileName|$sizeLabel|$dlUrl]"
                val body = JSONObject().apply {
                    put("content", msg)
                    put("senderName", nickname())
                    put("senderIp", NetworkUtils.getAllLocalIpAddresses(getApplication()).firstOrNull()?.ip ?: "")
                    put("clientId", phoneClientId)
                }
                val (messageCode, _) = HttpHelper.postJson("http://${room.ip}:${room.port}/api/messages", body, headers)
                check(messageCode in 200..299) { "文件已上传，但消息发送失败" }
                if (!isCurrentJoinedRoom(room, token)) return@launch
                appendJoinedMessage(
                    ChatMessage(
                        id = UUID.randomUUID().toString(),
                        senderName = nickname(),
                        content = msg,
                        timestamp = System.currentTimeMillis(),
                        isFromPhone = true,
                        senderIp = "",
                        clientId = phoneClientId
                    )
                )
                _toasts.tryEmit("文件「$fileName」发送成功")
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                _toasts.tryEmit("发送文件出错: ${e.message}")
            } finally {
                tempFile?.delete()
            }
        }
    }

    private fun isCurrentJoinedRoom(room: DiscoveredRoom, token: String) =
        _state.value.mode == RoomMode.JOINED && _state.value.joinedRoom?.roomId == room.roomId && _state.value.joinedToken == token

    private fun appendJoinedMessage(msg: ChatMessage) {
        val merged = (_state.value.joinedMessages + msg).distinctBy { it.id }.sortedBy { it.timestamp }
        _state.value = _state.value.copy(joinedMessages = merged.takeLast(MAX_UI_MESSAGES))
    }

    /** 清空 JOINED 会话流（只影响本机视图，不动本机房间的消息） */
    fun clearJoinedMessages() {
        _state.value = _state.value.copy(joinedMessages = emptyList())
    }

    override fun onCleared() {
        // 页面/进程销毁时主动通知房主，避免成员残留到 15 秒超时 (A5)
        val room = _state.value.joinedRoom
        val token = _state.value.joinedToken
        if (room != null && !token.isNullOrBlank()) {
            kotlinx.coroutines.CoroutineScope(Dispatchers.IO).launch {
                runCatching {
                    HttpHelper.postJson(
                        "http://${room.ip}:${room.port}/api/room/leave",
                        JSONObject().put("token", token),
                        mapOf("X-Room-Token" to token)
                    )
                }
            }
        }
        super.onCleared()
    }

    companion object {
        const val PREFS = "wenbox_prefs"
        private const val KEY_NICKNAME = "user_nickname"
        private const val KEY_CLIENT_ID = "client_id"
        private const val POLL_INTERVAL_MS = 3000L
        private const val MAX_UI_MESSAGES = 500
    }
}
