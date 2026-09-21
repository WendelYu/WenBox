package com.landrop.ui.fragment

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import com.landrop.databinding.FragmentConverterBinding
import java.math.BigInteger

class ConverterFragment : Fragment() {

    private var _binding: FragmentConverterBinding? = null
    private val binding get() = _binding!!

    private var isUpdating = false

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentConverterBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        setupListeners()
        setupCopyButtons()

        // 默认填充一个经典的演示数值
        binding.etHex.setText("1A3F")
    }

    private fun setupListeners() {
        binding.etHex.addTextChangedListener(createWatcher { text ->
            val clean = text.replace("0x", "", ignoreCase = true).replace("\\s+".toRegex(), "")
            if (clean.isNotBlank()) {
                try {
                    val num = BigInteger(clean, 16)
                    updateFromNumber(num, skipHex = true)
                } catch (_: Exception) {}
            } else {
                clearOtherFields(skipHex = true)
            }
        })

        binding.etDec.addTextChangedListener(createWatcher { text ->
            val clean = text.trim()
            if (clean.isNotBlank()) {
                try {
                    val num = BigInteger(clean, 10)
                    updateFromNumber(num, skipDec = true)
                } catch (_: Exception) {}
            } else {
                clearOtherFields(skipDec = true)
            }
        })

        binding.etBin.addTextChangedListener(createWatcher { text ->
            val clean = text.replace("\\s+".toRegex(), "")
            if (clean.isNotBlank()) {
                try {
                    val num = BigInteger(clean, 2)
                    updateFromNumber(num, skipBin = true)
                } catch (_: Exception) {}
            } else {
                clearOtherFields(skipBin = true)
            }
        })

        binding.etOct.addTextChangedListener(createWatcher { text ->
            val clean = text.trim()
            if (clean.isNotBlank()) {
                try {
                    val num = BigInteger(clean, 8)
                    updateFromNumber(num, skipOct = true)
                } catch (_: Exception) {}
            } else {
                clearOtherFields(skipOct = true)
            }
        })

        binding.etAscii.addTextChangedListener(createWatcher { text ->
            if (text.isNotEmpty()) {
                val hexSb = StringBuilder()
                val bytes = text.toByteArray(Charsets.UTF_8)
                for (b in bytes) {
                    hexSb.append(String.format("%02X", b))
                }
                val hexStr = hexSb.toString()
                try {
                    val num = BigInteger(hexStr, 16)
                    updateFromNumber(num, skipAscii = true)
                } catch (_: Exception) {}
            } else {
                clearOtherFields(skipAscii = true)
            }
        })

        binding.btnClearAll.setOnClickListener {
            isUpdating = true
            binding.etHex.setText("")
            binding.etDec.setText("")
            binding.etBin.setText("")
            binding.etOct.setText("")
            binding.etAscii.setText("")
            isUpdating = false
        }
    }

    private fun updateFromNumber(
        num: BigInteger,
        skipHex: Boolean = false,
        skipDec: Boolean = false,
        skipBin: Boolean = false,
        skipOct: Boolean = false,
        skipAscii: Boolean = false
    ) {
        isUpdating = true

        val hexStr = num.toString(16).uppercase()
        if (!skipHex) {
            // 两位一组格式化
            binding.etHex.setText(hexStr.padStart(if (hexStr.length % 2 != 0) hexStr.length + 1 else hexStr.length, '0').chunked(2).joinToString(" "))
        }
        if (!skipDec) {
            binding.etDec.setText(num.toString(10))
        }
        if (!skipBin) {
            val rawBin = num.toString(2)
            val paddedBin = rawBin.padStart((Math.ceil(rawBin.length / 4.0).toInt() * 4).coerceAtLeast(4), '0')
            binding.etBin.setText(paddedBin.chunked(4).joinToString(" "))
        }
        if (!skipOct) {
            binding.etOct.setText(num.toString(8))
        }
        if (!skipAscii) {
            try {
                val bytes = num.toByteArray()
                // 去掉 BigInteger 可能带的符号位 0 字节
                val trimmedBytes = if (bytes.isNotEmpty() && bytes[0] == 0.toByte()) bytes.copyOfRange(1, bytes.size) else bytes
                binding.etAscii.setText(String(trimmedBytes, Charsets.UTF_8))
            } catch (_: Exception) {
                binding.etAscii.setText("")
            }
        }

        isUpdating = false
    }

    private fun clearOtherFields(
        skipHex: Boolean = false,
        skipDec: Boolean = false,
        skipBin: Boolean = false,
        skipOct: Boolean = false,
        skipAscii: Boolean = false
    ) {
        isUpdating = true
        if (!skipHex) binding.etHex.setText("")
        if (!skipDec) binding.etDec.setText("")
        if (!skipBin) binding.etBin.setText("")
        if (!skipOct) binding.etOct.setText("")
        if (!skipAscii) binding.etAscii.setText("")
        isUpdating = false
    }

    private fun createWatcher(onText: (String) -> Unit): TextWatcher {
        return object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                if (isUpdating) return
                onText(s?.toString() ?: "")
            }
        }
    }

    private fun setupCopyButtons() {
        binding.btnCopyHex.setOnClickListener { copyField(binding.etHex.text.toString(), "16 进制") }
        binding.btnCopyDec.setOnClickListener { copyField(binding.etDec.text.toString(), "10 进制") }
        binding.btnCopyBin.setOnClickListener { copyField(binding.etBin.text.toString(), "2 进制") }
        binding.btnCopyOct.setOnClickListener { copyField(binding.etOct.text.toString(), "8 进制") }
        binding.btnCopyAscii.setOnClickListener { copyField(binding.etAscii.text.toString(), "ASCII 文本") }
    }

    private fun copyField(text: String, label: String) {
        if (text.isBlank()) return
        val ctx = context ?: return
        val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText(label, text)
        clipboard.setPrimaryClip(clip)
        Toast.makeText(ctx, "已复制 $label", Toast.LENGTH_SHORT).show()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
