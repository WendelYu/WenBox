package com.landrop.utils

import org.junit.Assert.*
import org.junit.Test

class ImageSamplingTest {
    @Test fun veryWideAndTallImagesAreSampledEvenWhenTheOtherDimensionIsSmall() {
        val wide = ImageSampling.sampleSize(60000, 1200, 600, 600)
        val tall = ImageSampling.sampleSize(1200, 60000, 600, 600)
        assertTrue(wide > 1); assertEquals(wide, tall)
        assertTrue(60000 / wide <= 1200)
    }

    @Test fun smallImagesKeepTheirOriginalResolution() {
        assertEquals(1, ImageSampling.sampleSize(400, 300, 600, 600))
    }

    @Test fun extremeDimensionsCannotOverflowTheSampleFactor() {
        val sample = ImageSampling.sampleSize(Int.MAX_VALUE, Int.MAX_VALUE, 0, 0)
        assertTrue(sample > 0)
        assertTrue(Int.MAX_VALUE / sample <= 2)
    }
}
