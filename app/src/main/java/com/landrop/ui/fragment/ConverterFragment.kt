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
import com.landrop.industrial.RadixConverter

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
        // 所有输入都走同一个纯函数实现，负数与前导零的行为保持一致
        bindRadixField(binding.etHex, 16, Field.HEX)
        bindRadixField(binding.etDec, 10, Field.DEC)
        bindRadixField(binding.etBin, 2, Field.BIN)
        bindRadixField(binding.etOct, 8, Field.OCT)

        binding.etAscii.addTextChangedListener(createWatcher { text ->
            if (text.isEmpty()) {
                clearOtherFields(Field.ASCII)
                return@createWatcher
            }
            // 文本 -> 字节 -> 数值：按 UTF-8 字节计算，不经过有符号 BigInteger
            val bytes = text.toByteArray(Charsets.UTF_8)
            val hex = bytes.joinToString("") { String.format("%02X", it) }
            val num = RadixConverter.parseUnsigned(hex, 16)
            if (num == null) {
                showError("输入内容无法转换为数值")
            } else {
                applyConversion(RadixConverter.fromNumber(num), Field.ASCII)
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
            clearError()
        }
    }

    private enum class Field { HEX, DEC, BIN, OCT, ASCII }

    private fun bindRadixField(
        view: android.widget.EditText,
        radix: Int,
        field: Field
    ) {
        view.addTextChangedListener(createWatcher { text ->
            if (text.isBlank()) {
                clearOtherFields(field)
                return@createWatcher
            }
            // 负数与非法输入都给出明确提示，而不是静默算错
            if (text.trim().startsWith("-")) {
                showError("不支持负数，请输入非负整数")
                return@createWatcher
            }
            val num = RadixConverter.parseUnsigned(text, radix)
            if (num == null) {
                showError("「${text.trim()}」不是合法的 ${radixName(radix)} 数值")
            } else {
                clearError()
                applyConversion(RadixConverter.fromNumber(num), field)
            }
        })
    }

    private fun radixName(radix: Int): String = when (radix) {
        16 -> "16 进制"
        10 -> "10 进制"
        2 -> "2 进制"
        8 -> "8 进制"
        else -> "$radix 进制"
    }

    private fun applyConversion(result: RadixConverter.Conversion, source: Field) {
        isUpdating = true
        if (source != Field.HEX) binding.etHex.setText(result.hex)
        if (source != Field.DEC) binding.etDec.setText(result.dec)
        if (source != Field.BIN) binding.etBin.setText(result.bin)
        if (source != Field.OCT) binding.etOct.setText(result.oct)
        if (source != Field.ASCII) binding.etAscii.setText(result.ascii)
        isUpdating = false
    }

    private fun showError(message: String) {
        val banner = _binding?.tvConverterError ?: return
        banner.text = message
        banner.visibility = View.VISIBLE
    }

    private fun clearError() {
        _binding?.tvConverterError?.visibility = View.GONE
    }

    private fun clearOtherFields(source: Field) {
        isUpdating = true
        if (source != Field.HEX) binding.etHex.setText("")
        if (source != Field.DEC) binding.etDec.setText("")
        if (source != Field.BIN) binding.etBin.setText("")
        if (source != Field.OCT) binding.etOct.setText("")
        if (source != Field.ASCII) binding.etAscii.setText("")
        isUpdating = false
        clearError()
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
