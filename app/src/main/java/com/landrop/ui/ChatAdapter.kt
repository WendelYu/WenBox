package com.landrop.ui

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.landrop.databinding.ItemChatMessageBinding
import com.landrop.model.ChatMessage
import kotlinx.coroutines.Job

/** Bind only visible rows; each image task belongs to its holder and is cancelled on reuse. */
class ChatAdapter(private val bindMessage: (ItemChatMessageBinding, ChatMessage) -> Job?) :
    ListAdapter<ChatMessage, ChatAdapter.Holder>(DIFF) {
    class Holder(val binding: ItemChatMessageBinding) : RecyclerView.ViewHolder(binding.root) {
        var imageJob: Job? = null
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        Holder(ItemChatMessageBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun onBindViewHolder(holder: Holder, position: Int) {
        holder.imageJob?.cancel()
        holder.imageJob = bindMessage(holder.binding, getItem(position))
    }

    override fun onViewRecycled(holder: Holder) {
        holder.imageJob?.cancel()
        holder.imageJob = null
        holder.binding.ivMessageImage.setImageDrawable(null)
        super.onViewRecycled(holder)
    }

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<ChatMessage>() {
            override fun areItemsTheSame(old: ChatMessage, new: ChatMessage) = old.id == new.id
            override fun areContentsTheSame(old: ChatMessage, new: ChatMessage) = old == new
        }
    }
}
