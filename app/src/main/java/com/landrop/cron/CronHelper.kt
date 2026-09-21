package com.landrop.cron

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

object CronHelper {

    data class PresetCron(val label: String, val expression: String)

    val PRESETS = listOf(
        PresetCron("每秒执行一次", "* * * * * ?"),
        PresetCron("每 5 秒执行一次", "*/5 * * * * ?"),
        PresetCron("每分钟执行一次", "0 * * * * ?"),
        PresetCron("每 5 分钟执行一次", "0 */5 * * * ?"),
        PresetCron("每 15 分钟执行一次", "0 */15 * * * ?"),
        PresetCron("每 30 分钟执行一次", "0 */30 * * * ?"),
        PresetCron("每整点执行一次", "0 0 * * * ?"),
        PresetCron("每天凌晨 00:00:00", "0 0 0 * * ?"),
        PresetCron("每天早上 08:30:00", "0 30 8 * * ?"),
        PresetCron("工作日早上 09:00 (周一至周五)", "0 0 9 ? * MON-FRI"),
        PresetCron("每周一上午 10:00", "0 0 10 ? * MON"),
        PresetCron("每月 1 日凌晨 01:00", "0 0 1 1 * ?")
    )

    /**
     * 智能将 Cron 表达式翻译为人类通俗可读的中文
     */
    fun explainCron(cron: String): String {
        val parts = cron.trim().split("\\s+".toRegex())
        if (parts.size < 5 || parts.size > 7) {
            return "无效的 Cron 格式（标准格式应包含 5 到 7 个字段）"
        }

        return try {
            val hasSeconds = parts.size >= 6
            val sec = if (hasSeconds) parts[0] else "0"
            val min = if (hasSeconds) parts[1] else parts[0]
            val hour = if (hasSeconds) parts[2] else parts[1]
            val day = if (hasSeconds) parts[3] else parts[2]
            val week = if (hasSeconds) parts[5] else parts[4]

            if (sec == "*" && min == "*" && hour == "*") {
                return "每秒执行一次"
            }

            val desc = StringBuilder()

            if (sec.startsWith("*/")) {
                val step = sec.removePrefix("*/")
                desc.append("每隔 $step 秒")
            } else if (min.startsWith("*/")) {
                val step = min.removePrefix("*/")
                desc.append("每隔 $step 分钟")
            } else if (min == "*" && hour == "*") {
                desc.append("每分钟 ")
            } else {
                if (week != "*" && week != "?") {
                    desc.append(explainWeek(week)).append(" ")
                } else if (day != "*" && day != "?") {
                    desc.append("每月 ").append(day).append(" 日 ")
                } else {
                    desc.append("每天 ")
                }

                val hStr = if (hour == "*") "每小时" else String.format("%02d点", hour.toIntOrNull() ?: 0)
                val mStr = if (min == "*") "每分钟" else String.format("%02d分", min.toIntOrNull() ?: 0)
                val sStr = if (sec == "*" || sec == "0") "" else String.format("%02d秒", sec.toIntOrNull() ?: 0)
                desc.append("$hStr$mStr$sStr")
            }

            desc.append(" 执行")
            desc.toString()
        } catch (_: Exception) {
            "无法自动解析描述，请检查语法规范"
        }
    }

    private fun explainWeek(week: String): String {
        return when (week.uppercase()) {
            "MON-FRI", "2-6" -> "工作日(周一至周五)"
            "MON", "2" -> "每周一"
            "TUE", "3" -> "每周二"
            "WED", "4" -> "每周三"
            "THU", "5" -> "每周四"
            "FRI", "6" -> "每周五"
            "SAT", "7" -> "每周六"
            "SUN", "1" -> "每周日"
            else -> "星期($week)"
        }
    }

    /**
     * 预测接下来的 N 次预计执行时间
     */
    fun predictNextExecutionTimes(cron: String, count: Int = 5): List<String> {
        val parts = cron.trim().split("\\s+".toRegex())
        if (parts.size < 5 || parts.size > 7) {
            return listOf("表达式格式错误，无法预演时间")
        }

        val result = mutableListOf<String>()
        val sdf = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault())
        val cal = Calendar.getInstance()

        try {
            val hasSeconds = parts.size >= 6
            val sec = if (hasSeconds) parts[0] else "0"
            val min = if (hasSeconds) parts[1] else parts[0]
            val hour = if (hasSeconds) parts[2] else parts[1]

            if (sec == "*" && min == "*" && hour == "*") {
                // 每秒执行
                for (i in 1..count) {
                    cal.add(Calendar.SECOND, 1)
                    result.add(sdf.format(cal.time))
                }
                return result
            }

            var stepMinutes = 0
            var stepSeconds = 0

            if (sec.startsWith("*/")) {
                stepSeconds = sec.removePrefix("*/").toIntOrNull() ?: 5
            } else if (min.startsWith("*/")) {
                stepMinutes = min.removePrefix("*/").toIntOrNull() ?: 1
            }

            if (stepSeconds > 0) {
                val currentSec = cal.get(Calendar.SECOND)
                val remainder = currentSec % stepSeconds
                cal.add(Calendar.SECOND, stepSeconds - remainder)
                for (i in 0 until count) {
                    result.add(sdf.format(cal.time))
                    cal.add(Calendar.SECOND, stepSeconds)
                }
            } else if (stepMinutes > 0) {
                cal.set(Calendar.SECOND, 0)
                val currentMin = cal.get(Calendar.MINUTE)
                val remainder = currentMin % stepMinutes
                cal.add(Calendar.MINUTE, stepMinutes - remainder)
                for (i in 0 until count) {
                    result.add(sdf.format(cal.time))
                    cal.add(Calendar.MINUTE, stepMinutes)
                }
            } else {
                val targetHour = hour.toIntOrNull() ?: cal.get(Calendar.HOUR_OF_DAY)
                val targetMin = min.toIntOrNull() ?: 0
                val targetSec = sec.toIntOrNull() ?: 0

                cal.set(Calendar.HOUR_OF_DAY, targetHour)
                cal.set(Calendar.MINUTE, targetMin)
                cal.set(Calendar.SECOND, targetSec)

                if (cal.timeInMillis <= System.currentTimeMillis()) {
                    cal.add(Calendar.DAY_OF_YEAR, 1)
                }

                for (i in 0 until count) {
                    result.add(sdf.format(cal.time))
                    cal.add(Calendar.DAY_OF_YEAR, 1)
                }
            }
        } catch (_: Exception) {
            result.add("时间预演发生异常，请检查表达式规则")
        }

        return result
    }
}
