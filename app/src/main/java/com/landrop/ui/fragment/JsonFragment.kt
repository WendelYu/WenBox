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
import androidx.lifecycle.lifecycleScope
import com.landrop.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.core.widget.addTextChangedListener
import com.landrop.databinding.FragmentJsonBinding
import com.landrop.json.JsonHelper

class JsonFragment : Fragment() {

    private var formatJob: Job? = null
    private var inputRevision = 0
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
        if (savedInstanceState == null) binding.etJsonInput.setText(JsonHelper.SAMPLE_JSON)
    }

    private fun initListeners() {
        binding.etJsonInput.addTextChangedListener { inputRevision++ }
        binding.btnFormatJson.setOnClickListener { transformJson(minify = false) }
        binding.btnMinifyJson.setOnClickListener { transformJson(minify = true) }

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

    private fun transformJson(minify: Boolean) {
        formatJob?.cancel()
        val current = binding
        val raw = current.etJsonInput.text.toString()
        val revision = inputRevision
        current.btnFormatJson.isEnabled = false
        current.btnMinifyJson.isEnabled = false
        formatJob = viewLifecycleOwner.lifecycleScope.launch {
            try {
                val (success, result) = withContext(Dispatchers.Default) {
                    if (minify) JsonHelper.minifyJson(raw) else JsonHelper.formatJson(raw, 2)
                }
                if (_binding !== current || inputRevision != revision) return@launch
                if (success) {
                    current.etJsonInput.setText(result)
                    current.tvJsonError.visibility = View.GONE
                    Toast.makeText(context, if (minify) R.string.json_minified else R.string.json_formatted, Toast.LENGTH_SHORT).show()
                } else {
                    current.tvJsonError.text = result
                    current.tvJsonError.visibility = View.VISIBLE
                }
            } finally {
                if (_binding === current) {
                    current.btnFormatJson.isEnabled = true
                    current.btnMinifyJson.isEnabled = true
                }
            }
        }
    }

    override fun onDestroyView() {
        formatJob?.cancel()
        formatJob = null
        super.onDestroyView()
        _binding = null
    }
}
