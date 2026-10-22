package com.landrop.utils

object ImageSampling {
    fun sampleSize(width: Int, height: Int, requestedWidth: Int, requestedHeight: Int): Int {
        val targetWidth = requestedWidth.coerceAtLeast(1).toLong() * 2
        val targetHeight = requestedHeight.coerceAtLeast(1).toLong() * 2
        var sample = 1
        // Either dimension can dominate, including very wide screenshots and panoramas.
        while (width.toLong() / sample > targetWidth || height.toLong() / sample > targetHeight) sample *= 2
        return sample
    }
}
