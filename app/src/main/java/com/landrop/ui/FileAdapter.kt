package com.landrop.ui

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.DiffUtil
import com.landrop.databinding.ItemFileBinding
import com.landrop.model.SharedFile
import java.text.DecimalFormat

class FileAdapter(
    initialFiles: List<SharedFile>,
    private val onRemoveClick: (SharedFile) -> Unit
) : ListAdapter<SharedFile, FileAdapter.FileViewHolder>(DIFF) {

    init { submitList(initialFiles.toList()) }

    fun updateList(newList: List<SharedFile>) {
        submitList(newList.toList())
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): FileViewHolder {
        val binding = ItemFileBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return FileViewHolder(binding)
    }

    override fun onBindViewHolder(holder: FileViewHolder, position: Int) {
        holder.bind(getItem(position))
    }


    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<SharedFile>() {
            override fun areItemsTheSame(old: SharedFile, new: SharedFile) = old.id == new.id
            override fun areContentsTheSame(old: SharedFile, new: SharedFile) = old == new
        }
    }

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
