package com.landrop.ui.fragment

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import com.landrop.databinding.FragmentJsonBinding
import com.landrop.json.JsonHelper

class JsonFragment : Fragment() {

    private var _binding: FragmentJsonBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentJsonBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        initListeners()
        // 初始填充演示示例
        binding.etJsonInput.setText(JsonHelper.SAMPLE_JSON)
    }

    private fun initListeners() {
        binding.btnFormatJson.setOnClickListener {
            val raw = binding.etJsonInput.text.toString()
            val (success, result) = JsonHelper.formatJson(raw, 2)
            if (success) {
                binding.etJsonInput.setText(result)
                binding.tvJsonError.visibility = View.GONE
                Toast.makeText(context, "格式化成功", Toast.LENGTH_SHORT).show()
            } else {
                binding.tvJsonError.text = result
                binding.tvJsonError.visibility = View.VISIBLE
            }
        }

        binding.btnMinifyJson.setOnClickListener {
            val raw = binding.etJsonInput.text.toString()
            val (success, result) = JsonHelper.minifyJson(raw)
            if (success) {
                binding.etJsonInput.setText(result)
                binding.tvJsonError.visibility = View.GONE
                Toast.makeText(context, "已压缩为单行", Toast.LENGTH_SHORT).show()
            } else {
                binding.tvJsonError.text = result
                binding.tvJsonError.visibility = View.VISIBLE
            }
        }

        binding.btnLoadSample.setOnClickListener {
            binding.etJsonInput.setText(JsonHelper.SAMPLE_JSON)
            binding.tvJsonError.visibility = View.GONE
            Toast.makeText(context, "已载入示例 JSON", Toast.LENGTH_SHORT).show()
        }

        binding.btnCopyJson.setOnClickListener {
            val text = binding.etJsonInput.text.toString()
            if (text.isNotBlank()) {
                val ctx = context ?: return@setOnClickListener
                val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val clip = ClipData.newPlainText("JSON Content", text)
                clipboard.setPrimaryClip(clip)
                Toast.makeText(ctx, "JSON 内容已复制", Toast.LENGTH_SHORT).show()
            }
        }

        binding.btnClearJson.setOnClickListener {
            binding.etJsonInput.setText("")
            binding.tvJsonError.visibility = View.GONE
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
