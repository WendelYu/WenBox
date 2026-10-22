package com.landrop.server

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.landrop.security.SafeFileName
import kotlinx.coroutines.CancellationException
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import com.landrop.model.SharedFile
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

object FileManager {

    // 线程安全的待分享文件列表
    private val files = CopyOnWriteArrayList<SharedFile>()
    private val receivedFiles = CopyOnWriteArrayList<SharedFile>()

    var onFilesChangedListener: (() -> Unit)? = null

    fun getFiles(): List<SharedFile> = files.toList()

    fun getReceivedFiles(): List<SharedFile> = receivedFiles.toList()

    fun getFileById(id: String): SharedFile? = files.firstOrNull { it.id == id } ?: receivedFiles.firstOrNull { it.id == id }

    fun addFile(context: Context, uri: Uri): SharedFile {
        val resolver = context.contentResolver
        var name = "unknown_${System.currentTimeMillis()}"
        var size: Long = 0
        var mimeType = resolver.getType(uri) ?: "application/octet-stream"

        resolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (nameIndex != -1) {
                    val n = cursor.getString(nameIndex)
                    if (!n.isNullOrBlank()) name = n
                }
                if (sizeIndex != -1) {
                    size = cursor.getLong(sizeIndex)
                }
            }
        }

        val existing = files.firstOrNull { it.uri == uri }
        if (existing != null) {
            return existing
        }

        val file = SharedFile(
            id = UUID.randomUUID().toString(),
            name = name,
            size = size,
            mimeType = mimeType,
            uri = uri
        )
        files.add(file)
        onFilesChangedListener?.invoke()
        return file
    }

    fun removeFile(id: String) {
        files.removeAll { it.id == id }
        receivedFiles.removeAll { it.id == id }
        onFilesChangedListener?.invoke()
    }

    fun clearAll() {
        files.clear()
        receivedFiles.clear()
        onFilesChangedListener?.invoke()
    }

    /** 只清空"我要分享的"列表，保留已接收文件 (供 /api/files/clear 使用) */
    fun clearSharedOnly() {
        files.clear()
        onFilesChangedListener?.invoke()
    }

    /**
     * 在目标目录里挑一个不会覆盖既有文件的文件名：
     * name.ext -> name (1).ext -> name (2).ext
     */
    private fun reserveFile(dir: File, fileName: String): File {
        check(dir.isDirectory || dir.mkdirs() || dir.isDirectory) { "无法创建下载目录" }
        val dot = fileName.lastIndexOf('.')
        val stem = if (dot > 0) fileName.substring(0, dot) else fileName
        val ext = if (dot > 0) fileName.substring(dot) else ""
        for (index in 0..9999) {
            val name = if (index == 0) fileName else "$stem ($index)$ext"
            val next = File(dir, name)
            if (next.createNewFile()) return next
        }
        error("同名文件过多，请整理下载目录后重试")
    }

    /**
     * 流式保存到下载目录。接收到的文件不自动加入全房间共享列表。
     */
    fun saveIncomingFile(context: Context, originalName: String, inputStream: InputStream): SharedFile? {
        val fileName = SafeFileName.sanitize(originalName)
        return try {
            val id = UUID.randomUUID().toString()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Android 10+ 使用 MediaStore Downloads（MediaStore 自身会为同名文件自动改名）
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/WenBox")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = context.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                if (uri == null) {
                    null
                } else {
                    try {
                        var writtenBytes = 0L
                        checkNotNull(resolver.openOutputStream(uri)) { "无法写入下载目录" }.use { out ->
                            writtenBytes = inputStream.copyTo(out)
                        }
                        values.clear()
                        values.put(MediaStore.Downloads.IS_PENDING, 0)
                        check(resolver.update(uri, values, null, null) > 0) { "无法完成文件保存" }

                        val sharedFile = SharedFile(
                            id = id,
                            name = fileName,
                            size = writtenBytes,
                            mimeType = resolver.getType(uri) ?: "application/octet-stream",
                            uri = uri
                        )
                        receivedFiles.add(0, sharedFile)
                        onFilesChangedListener?.invoke()
                        sharedFile
                    } catch (e: Exception) {
                        // 写入失败时必须删掉 IS_PENDING 的残留条目，否则会留下不可见的半截文件
                        runCatching { resolver.delete(uri, null, null) }
                        throw e
                    }
                }
            } else {
                // Android 9 及以下使用公开外部存储（需要 WRITE_EXTERNAL_STORAGE 权限）
                val canWritePublic = ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
                val root = if (canWritePublic) Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                    else context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir
                val targetFile = reserveFile(File(root, "WenBox"), fileName)
                var writtenBytes = 0L
                try {
                    FileOutputStream(targetFile).use { out ->
                        writtenBytes = inputStream.copyTo(out)
                    }
                } catch (e: Exception) {
                    runCatching { targetFile.delete() }
                    throw e
                }
                val fileUri = Uri.fromFile(targetFile)
                val sharedFile = SharedFile(
                    id = id,
                    name = targetFile.name,
                    size = writtenBytes,
                    mimeType = "application/octet-stream",
                    uri = fileUri
                )
                receivedFiles.add(0, sharedFile)
                onFilesChangedListener?.invoke()
                sharedFile
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }
}
