package com.landrop.ui

import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * 服务端运行状态。原来由 MainActivity 直接调用 TransferFragment 的方法同步 UI，
 * Fragment 重建后回调就失效了；现在改为 StateFlow，任意时刻订阅都能拿到当前值 (A4)。
 */
data class ServiceState(
    val isRunning: Boolean = false,
    val port: Int = 9527,
    val bound: Boolean = false
)

class MainViewModel : ViewModel() {

    private val _serviceState = MutableStateFlow(ServiceState())
    val serviceState: StateFlow<ServiceState> = _serviceState.asStateFlow()

    fun updateServiceState(isRunning: Boolean, port: Int, bound: Boolean = true) {
        _serviceState.value = ServiceState(isRunning = isRunning, port = port, bound = bound)
    }

    fun updateRunning(isRunning: Boolean) {
        _serviceState.value = _serviceState.value.copy(isRunning = isRunning)
    }

    fun updateUnbound() {
        _serviceState.value = _serviceState.value.copy(bound = false, isRunning = false)
    }
}
