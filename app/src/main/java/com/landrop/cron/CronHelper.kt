package com.landrop.cron

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

object CronHelper {

    data class PresetCron(val label: String, val expression: String)

    val PRESETS = listOf(
        // 秒级与高频调度
        PresetCron("每秒执行任务", "* * * * * ?"),
        PresetCron("每 2 秒执行任务", "0/2 * * * * ?"),
        PresetCron("每 5 秒执行任务", "*/5 * * * * ?"),
        PresetCron("每分钟执行任务", "0 * * * * ?"),
        PresetCron("每 2 分钟执行任务", "0 0/2 * * * ?"),
        PresetCron("每 5 分钟执行任务", "0 */5 * * * ?"),
        PresetCron("每 15 分钟执行任务", "0 */15 * * * ?"),
        PresetCron("每 30 分钟执行任务", "0 */30 * * * ?"),

        // 每天与特定时段
        PresetCron("每整点执行任务", "0 0 * * * ?"),
        PresetCron("每天凌晨 00:00:00", "0 0 0 * * ?"),
        PresetCron("每天早上 08:30:00", "0 30 8 * * ?"),
        PresetCron("每天上午 10:15 执行任务", "0 15 10 ? * *"),
        PresetCron("每天中午 12:00 执行任务", "0 0 12 * * ?"),
        PresetCron("每天上午 10点、下午 2点、4点执行任务", "0 0 10,14,16 * * ?"),
        PresetCron("每天下午 14:00~14:59 每分钟执行任务", "0 * 14 * * ?"),
        PresetCron("每天下午 14:00~14:05 每分钟执行任务", "0 0-5 14 * * ?"),
        PresetCron("每天下午 14:00~14:55 每 5 分钟执行任务", "0 0/5 14 * * ?"),
        PresetCron("每天 14:00~14:55 和 18:00~18:55 每 5 分钟执行任务", "0 0/5 14,18 * * ?"),

        // 工作日与周周期
        PresetCron("工作日早上 09:00 (周一至周五)", "0 0 9 ? * MON-FRI"),
        PresetCron("周一到周五每天上午 10:15 执行任务", "0 15 10 ? * MON-FRI"),
        PresetCron("朝九晚五工作时间内每半小时执行任务", "0 0/30 9-17 * * ?"),
        PresetCron("工作日下午 18:00 下班打卡/汇总", "0 0 18 ? * MON-FRI"),
        PresetCron("每周一上午 10:00 执行任务", "0 0 10 ? * MON"),
        PresetCron("每个星期三中午 12:00 执行任务", "0 0 12 ? * WED"),

        // 月度/季度/年度与高级规则
        PresetCron("每月 1 日凌晨 01:00 执行任务", "0 0 1 1 * ?"),
        PresetCron("每月 1 日凌晨 02:00 执行任务", "0 0 2 1 * ?"),
        PresetCron("每月 15 日上午 10:15 执行任务", "0 15 10 15 * ?"),
        PresetCron("每月最后一天午夜 00:00:00 执行任务", "0 0 0 L * ?"),
        PresetCron("每月第三个星期五上午 10:15 执行任务", "0 15 10 ? * 6#3"),
        PresetCron("每年 3 月每周三下午 14:10 和 14:44 执行任务", "0 10,44 14 ? 3 WED"),
        PresetCron("每季度第一天凌晨 00:00:00 执行任务", "0 0 0 1 1,4,7,10 ?"),
        PresetCron("2005 年每天上午 10:15 执行任务", "0 15 10 * * ? 2005")
    )

    /**
     * 智能将 Cron 表达式翻译为人类通俗可读的中文
     */
    fun explainCron(cron: String): String {
        val trimmed = cron.trim()
        if (trimmed.isEmpty()) return "请输入 Cron 表达式"
        val parts = trimmed.split("\\s+".toRegex())
        if (parts.size < 5 || parts.size > 7) {
            return "无效的 Cron 格式（标准格式应包含 5 到 7 个字段）"
        }

        return try {
            val hasSec = parts.size >= 6
            val sec = if (hasSec) parts[0] else "0"
            val min = if (hasSec) parts[1] else parts[0]
            val hour = if (hasSec) parts[2] else parts[1]
            val day = if (hasSec) parts[3] else parts[2]
            val month = if (hasSec) parts[4] else parts[3]
            val week = if (hasSec) parts[5] else parts[4]
            val year = if (parts.size == 7) parts[6] else null

            // 特殊纯秒级高频
            if (sec == "*" && min == "*" && hour == "*") return "每秒执行任务"
            if ((sec.contains("/") || sec.startsWith("*/")) && min == "*" && hour == "*") {
                val step = sec.substringAfter("/")
                return "每 $step 秒执行任务"
            }
            if (sec == "0" && min == "*" && hour == "*") return "每分钟执行任务"
            if (sec == "0" && (min.contains("/") || min.startsWith("*/")) && hour == "*") {
                val step = min.substringAfter("/")
                return "每 $step 分钟执行任务"
            }

            val desc = StringBuilder()

            // 1. 年
            if (!year.isNullOrBlank() && year != "*" && year != "?") {
                desc.append("${year} 年 ")
            }

            // 2. 月
            if (month != "*" && month != "?") {
                if (month.contains(",")) {
                    desc.append("每年 ").append(month.split(",").joinToString("、")).append(" 月 ")
                } else if (month.contains("-")) {
                    val (s, e) = month.split("-")
                    desc.append("每年 ").append(s).append("月至").append(e).append("月 ")
                } else {
                    desc.append("每年 ").append(month).append(" 月 ")
                }
            }

            // 3. 周 / 日
            if (week != "*" && week != "?") {
                val weekUpper = week.uppercase(Locale.ROOT)
                if (weekUpper.contains("#")) {
                    val p = weekUpper.split("#")
                    val w = p[0]
                    val n = p.getOrNull(1) ?: "1"
                    val wName = when (w) {
                        "1", "SUN" -> "星期日"
                        "2", "MON" -> "星期一"
                        "3", "TUE" -> "星期二"
                        "4", "WED" -> "星期三"
                        "5", "THU" -> "星期四"
                        "6", "FRI" -> "星期五"
                        "7", "SAT" -> "星期六"
                        else -> "星期$w"
                    }
                    desc.append("每月第 $n 个$wName ")
                } else if (weekUpper.endsWith("L")) {
                    val w = weekUpper.removeSuffix("L")
                    val wName = when (w) {
                        "1", "SUN" -> "星期日"
                        "2", "MON" -> "星期一"
                        "3", "TUE" -> "星期二"
                        "4", "WED" -> "星期三"
                        "5", "THU" -> "星期四"
                        "6", "FRI" -> "星期五"
                        "7", "SAT" -> "星期六"
                        else -> "星期六"
                    }
                    desc.append("每月最后一个$wName ")
                } else if (weekUpper == "MON-FRI" || weekUpper == "2-6") {
                    desc.append("周一至周五(工作日) ")
                } else if (weekUpper == "MON-SAT") {
                    desc.append("周一至周六 ")
                } else if (weekUpper.contains(",")) {
                    val days = weekUpper.split(",").joinToString("、") { w ->
                        "周" + when (w) {
                            "1", "SUN" -> "日"
                            "2", "MON" -> "一"
                            "3", "TUE" -> "二"
                            "4", "WED" -> "三"
                            "5", "THU" -> "四"
                            "6", "FRI" -> "五"
                            "7", "SAT" -> "六"
                            else -> w
                        }
                    }
                    desc.append("每周($days) ")
                } else {
                    desc.append(explainWeek(weekUpper)).append(" ")
                }
            } else if (day != "*" && day != "?") {
                val dayUpper = day.uppercase(Locale.ROOT)
                if (dayUpper == "L") {
                    desc.append("每月最后一天 ")
                } else if (dayUpper.endsWith("W")) {
                    desc.append("每月离 ").append(dayUpper.removeSuffix("W")).append(" 日最近的工作日 ")
                } else if (day.contains(",")) {
                    desc.append("每月 ").append(day.replace(",", "、")).append(" 日 ")
                } else if (day.contains("-")) {
                    desc.append("每月 ").append(day).append(" 日 ")
                } else {
                    desc.append("每月 ").append(day).append(" 日 ")
                }
            } else {
                desc.append("每天 ")
            }

            // 4. 小时
            val hDesc = when {
                hour == "*" -> "每小时"
                hour.contains("/") -> {
                    val (s, step) = hour.split("/")
                    "从 $s 点开始每隔 $step 小时"
                }
                hour.contains("-") -> {
                    val (s, e) = hour.split("-")
                    "${s}点至${e}点 期间"
                }
                hour.contains(",") -> {
                    hour.split(",").joinToString("、") { "${it}点" } + " "
                }
                else -> {
                    val hNum = hour.toIntOrNull() ?: 0
                    when {
                        hNum < 6 -> "凌晨 ${hNum}点"
                        hNum < 12 -> "上午 ${hNum}点"
                        hNum == 12 -> "中午 12点"
                        hNum < 18 -> "下午 ${if (hNum > 12) "${hNum - 12}点(${hNum}点)" else "${hNum}点"}"
                        else -> "晚上 ${hNum - 12}点(${hNum}点)"
                    }
                }
            }

            // 5. 分钟
            val mDesc = when {
                min == "*" -> "每分钟"
                min.contains("/") -> {
                    val step = min.substringAfter("/")
                    "每隔 $step 分钟"
                }
                min.contains("-") -> {
                    val (s, e) = min.split("-")
                    String.format("%02d分至%02d分 期间每分钟", s.toIntOrNull() ?: 0, e.toIntOrNull() ?: 0)
                }
                min.contains(",") -> {
                    min.split(",").joinToString("、") { String.format("%02d分", it.toIntOrNull() ?: 0) }
                }
                else -> {
                    String.format("%02d分", min.toIntOrNull() ?: 0)
                }
            }

            // 6. 秒
            val sDesc = when {
                sec == "*" || sec == "0" -> ""
                sec.contains("/") -> " 每隔 ${sec.substringAfter("/")} 秒"
                sec.contains("-") -> {
                    val (s, e) = sec.split("-")
                    String.format(" %02d秒至%02d秒", s.toIntOrNull() ?: 0, e.toIntOrNull() ?: 0)
                }
                sec.contains(",") -> {
                    " " + sec.split(",").joinToString("、") { String.format("%02d秒", it.toIntOrNull() ?: 0) }
                }
                else -> String.format("%02d秒", sec.toIntOrNull() ?: 0)
            }

            val timeStr = when {
                hour.contains(",") && min == "0" && (sec == "0" || sec.isBlank()) -> "$hDesc 整"
                hour.contains("-") || hour.contains("/") || hour == "*" -> "$hDesc$mDesc$sDesc"
                else -> "$hDesc $mDesc$sDesc"
            }

            desc.append(timeStr).append(" 执行任务")
            desc.toString().replace("\\s+".toRegex(), " ").trim()
        } catch (_: Exception) {
            "无法自动解析描述，请检查语法规范"
        }
    }

    private fun explainWeek(week: String): String {
        return when (week.uppercase(Locale.ROOT)) {
            "MON-FRI", "2-6" -> "周一至周五(工作日)"
            "MON", "2" -> "每个星期一"
            "TUE", "3" -> "每个星期二"
            "WED", "4" -> "每个星期三"
            "THU", "5" -> "每个星期四"
            "FRI", "6" -> "每个星期五"
            "SAT", "7" -> "每个星期六"
            "SUN", "1" -> "每个星期日"
            else -> "星期($week)"
        }
    }

    private fun matchCronField(field: String?, value: Int, minRange: Int): Boolean {
        if (field.isNullOrBlank() || field == "*" || field == "?") return true
        for (part in field.split(",")) {
            if (part.contains("/")) {
                val p = part.split("/")
                val start = if (p[0] == "*") minRange else (p[0].toIntOrNull() ?: minRange)
                val step = p.getOrNull(1)?.toIntOrNull() ?: 1
                if (step > 0 && value >= start && (value - start) % step == 0) return true
            } else if (part.contains("-")) {
                val p = part.split("-")
                val s = p.getOrNull(0)?.toIntOrNull() ?: minRange
                val e = p.getOrNull(1)?.toIntOrNull() ?: minRange
                if (value in s..e) return true
            } else {
                val n = part.toIntOrNull()
                if (n != null && n == value) return true
            }
        }
        return false
    }

    private fun matchWeek(weekStr: String?, cal: Calendar): Boolean {
        if (weekStr.isNullOrBlank() || weekStr == "*" || weekStr == "?") return true
        val qDay = cal.get(Calendar.DAY_OF_WEEK) // 1=Sun, 2=Mon ... 7=Sat
        val upper = weekStr.uppercase(Locale.ROOT)
        if (upper.contains("#")) {
            val p = upper.split("#")
            val wMap = mapOf("1" to 1, "2" to 2, "3" to 3, "4" to 4, "5" to 5, "6" to 6, "7" to 7,
                "SUN" to 1, "MON" to 2, "TUE" to 3, "WED" to 4, "THU" to 5, "FRI" to 6, "SAT" to 7)
            val targetQ = wMap[p[0]] ?: return false
            val targetN = p.getOrNull(1)?.toIntOrNull() ?: 1
            if (qDay != targetQ) return false
            val dom = cal.get(Calendar.DAY_OF_MONTH)
            return dom > (targetN - 1) * 7 && dom <= targetN * 7
        }
        val normalized = upper
            .replace("SUN", "1").replace("MON", "2").replace("TUE", "3")
            .replace("WED", "4").replace("THU", "5").replace("FRI", "6").replace("SAT", "7")
        return matchCronField(normalized, qDay, 1)
    }

    private fun matchDayOfMonth(dayStr: String?, cal: Calendar): Boolean {
        if (dayStr.isNullOrBlank() || dayStr == "*" || dayStr == "?") return true
        if (dayStr.equals("L", ignoreCase = true)) {
            val maxDay = cal.getActualMaximum(Calendar.DAY_OF_MONTH)
            return cal.get(Calendar.DAY_OF_MONTH) == maxDay
        }
        return matchCronField(dayStr, cal.get(Calendar.DAY_OF_MONTH), 1)
    }

    /**
     * 预测接下来的 N 次预计执行时间
     */
    fun predictNextExecutionTimes(cron: String, count: Int = 5): List<String> {
        val trimmed = cron.trim()
        val parts = trimmed.split("\\s+".toRegex())
        if (parts.size < 5 || parts.size > 7) {
            return listOf("表达式格式错误，无法预演时间")
        }

        val result = mutableListOf<String>()
        val sdf = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault())
        val cal = Calendar.getInstance()
        val now = System.currentTimeMillis()

        try {
            val hasSec = parts.size >= 6
            val sec = if (hasSec) parts[0] else "0"
            val min = if (hasSec) parts[1] else parts[0]
            val hour = if (hasSec) parts[2] else parts[1]
            val day = if (hasSec) parts[3] else parts[2]
            val month = if (hasSec) parts[4] else parts[3]
            val week = if (hasSec) parts[5] else parts[4]
            val year = if (parts.size == 7) parts[6] else null

            fun isSingleNum(s: String) = s.all { it.isDigit() }

            var stepField = Calendar.SECOND
            var stepAmount = 1

            if (isSingleNum(sec) && isSingleNum(min) && isSingleNum(hour)) {
                cal.set(Calendar.HOUR_OF_DAY, hour.toInt())
                cal.set(Calendar.MINUTE, min.toInt())
                cal.set(Calendar.SECOND, sec.toInt())
                cal.set(Calendar.MILLISECOND, 0)
                stepField = Calendar.DAY_OF_YEAR
                stepAmount = 1
            } else if (isSingleNum(sec) && isSingleNum(min)) {
                cal.set(Calendar.MINUTE, min.toInt())
                cal.set(Calendar.SECOND, sec.toInt())
                cal.set(Calendar.MILLISECOND, 0)
                stepField = Calendar.HOUR_OF_DAY
                stepAmount = 1
            } else if (isSingleNum(sec)) {
                cal.set(Calendar.SECOND, sec.toInt())
                cal.set(Calendar.MILLISECOND, 0)
                stepField = Calendar.MINUTE
                stepAmount = 1
            }

            var iterations = 0
            val maxIterations = 50000

            while (result.size < count && iterations < maxIterations) {
                iterations++
                cal.add(stepField, stepAmount)

                if (cal.timeInMillis <= now) continue
                if (year != null && !matchCronField(year, cal.get(Calendar.YEAR), 1970)) continue
                if (!matchCronField(month, cal.get(Calendar.MONTH) + 1, 1)) continue
                if (!matchDayOfMonth(day, cal)) continue
                if (!matchWeek(week, cal)) continue
                if (!matchCronField(hour, cal.get(Calendar.HOUR_OF_DAY), 0)) continue
                if (!matchCronField(min, cal.get(Calendar.MINUTE), 0)) continue
                if (!matchCronField(sec, cal.get(Calendar.SECOND), 0)) continue

                result.add(sdf.format(cal.time))
            }

            if (result.isEmpty()) {
                return listOf("在未来近期内未匹配到触发时间（如限定历史年份或极小概率时间点）")
            }
        } catch (_: Exception) {
            result.add("时间预演发生异常，请检查表达式规则")
        }

        return result
    }
}
