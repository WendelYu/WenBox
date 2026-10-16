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
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.landrop.cron.CronHelper
import com.landrop.databinding.FragmentCronBinding

class CronFragment : Fragment() {

    private var analysisJob: Job? = null
    private var _binding: FragmentCronBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentCronBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        initPresets()
        initInputListener()
    }

    private fun initPresets() {
        val ctx = requireContext()
        val labels = CronHelper.PRESETS.map { it.label }
        val adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, labels)
        binding.spCronPresets.adapter = adapter

        binding.spCronPresets.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val preset = CronHelper.PRESETS[position]
                binding.etCronInput.setText(preset.expression)
            }

            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
    }

    private fun initInputListener() {
        binding.etCronInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                updateCronAnalysis(s?.toString() ?: "")
            }
        })

        binding.btnCopyCron.setOnClickListener {
            val cron = binding.etCronInput.text.toString().trim()
            if (cron.isNotBlank()) {
                val ctx = context ?: return@setOnClickListener
                val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val clip = ClipData.newPlainText("Cron Expression", cron)
                clipboard.setPrimaryClip(clip)
                Toast.makeText(ctx, "Cron 表达式已复制", Toast.LENGTH_SHORT).show()
            }
        }

        binding.tvNextTimes.setOnClickListener {
            val text = binding.tvNextTimes.text.toString()
            if (text.isNotBlank()) {
                val ctx = context ?: return@setOnClickListener
                val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val clip = ClipData.newPlainText("Execution Times", text)
                clipboard.setPrimaryClip(clip)
                Toast.makeText(ctx, "已复制未来执行时间", Toast.LENGTH_SHORT).show()
            }
        }

        updateCronAnalysis("* * * * * ?")
    }

    private fun updateCronAnalysis(cron: String) {
        analysisJob?.cancel()
        analysisJob = viewLifecycleOwner.lifecycleScope.launch {
            delay(180)
            val (meaning, times) = withContext(Dispatchers.Default) {
                CronHelper.explainCron(cron) to CronHelper.predictNextExecutionTimes(cron, 5)
            }
            _binding?.tvCronMeaning?.text = meaning
            _binding?.tvNextTimes?.text = times.mapIndexed { index, time -> "${index + 1}.  $time" }.joinToString("\n")
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        analysisJob?.cancel()
        analysisJob = null
        _binding = null
    }
}
