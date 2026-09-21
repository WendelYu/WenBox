package com.landrop.ui

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.landrop.databinding.ItemFileBinding
import com.landrop.model.SharedFile
import java.text.DecimalFormat

class FileAdapter(
    private var fileList: List<SharedFile>,
    private val onRemoveClick: (SharedFile) -> Unit
) : RecyclerView.Adapter<FileAdapter.FileViewHolder>() {

    fun updateList(newList: List<SharedFile>) {
        fileList = newList
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): FileViewHolder {
        val binding = ItemFileBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return FileViewHolder(binding)
    }

    override fun onBindViewHolder(holder: FileViewHolder, position: Int) {
        holder.bind(fileList[position])
    }

    override fun getItemCount(): Int = fileList.size

    inner class FileViewHolder(private val binding: ItemFileBinding) : RecyclerView.ViewHolder(binding.root) {
        fun bind(file: SharedFile) {
            binding.tvFileName.text = file.name
            binding.tvFileSize.text = formatFileSize(file.size)
            binding.btnRemoveFile.setOnClickListener {
                onRemoveClick(file)
            }
        }

        private fun formatFileSize(size: Long): String {
            if (size <= 0) return "0 B"
            val units = arrayOf("B", "KB", "MB", "GB", "TB")
            val digitGroups = (Math.log10(size.toDouble()) / Math.log10(1024.0)).toInt()
            val format = DecimalFormat("#,##0.#")
            return "${format.format(size / Math.pow(1024.0, digitGroups.toDouble()))} ${units[digitGroups]}"
        }
    }
}
