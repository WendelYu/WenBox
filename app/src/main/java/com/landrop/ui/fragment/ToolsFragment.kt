package com.landrop.ui.fragment

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.viewpager2.adapter.FragmentStateAdapter
import androidx.viewpager2.widget.ViewPager2
import com.landrop.R
import com.landrop.databinding.FragmentToolsBinding

/** Tool state belongs to child fragments; switching primary tabs does not recreate their models. */
class ToolsFragment : Fragment() {
    private var _binding: FragmentToolsBinding? = null
    private val binding get() = _binding!!
    private val toolIds = intArrayOf(R.id.toolJson, R.id.toolConverter, R.id.toolCron)
    private var selectedTool = 0
    private var pageCallback: ViewPager2.OnPageChangeCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        selectedTool = savedInstanceState?.getInt("selected_tool") ?: 0
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, state: Bundle?): View {
        _binding = FragmentToolsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.toolPager.adapter = object : FragmentStateAdapter(this) {
            override fun getItemCount() = toolIds.size
            override fun createFragment(position: Int): Fragment = when (position) {
                0 -> JsonFragment()
                1 -> ConverterFragment()
                else -> CronFragment()
            }
        }
        binding.toolPager.isUserInputEnabled = false
        binding.toolPager.offscreenPageLimit = 2
        binding.toolPager.setCurrentItem(selectedTool, false)
        binding.toolSelector.check(toolIds[selectedTool])
        binding.toolSelector.addOnButtonCheckedListener { _, id, checked ->
            if (checked) {
                val index = toolIds.indexOf(id)
                if (index >= 0) { selectedTool = index; binding.toolPager.setCurrentItem(index, false) }
            }
        }
        pageCallback = object : ViewPager2.OnPageChangeCallback() {
            override fun onPageSelected(position: Int) {
                selectedTool = position
                _binding?.toolSelector?.check(toolIds[position])
            }
        }.also { binding.toolPager.registerOnPageChangeCallback(it) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt("selected_tool", selectedTool)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroyView() {
        pageCallback?.let { binding.toolPager.unregisterOnPageChangeCallback(it) }
        pageCallback = null
        binding.toolSelector.clearOnButtonCheckedListeners()
        binding.toolPager.adapter = null
        _binding = null
        super.onDestroyView()
    }
}
