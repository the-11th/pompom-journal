package com.todopup.usage

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.view.ContextThemeWrapper
import android.view.View
import android.widget.BaseAdapter
import android.widget.FrameLayout
import android.widget.GridView
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import java.util.concurrent.ExecutorService
import kotlin.math.abs

/** Render actual gallery cells; fixture URIs never reference the user's image library. */
internal object GallerySelectionChecks {
    fun run(context: Context, captureFile: File? = null) {
        checkDayFilters(context)
        val dotWidths = mutableListOf<Int>()
        val captures = mutableMapOf<Pair<Float, Boolean>, Bitmap>()
        try {
            for (fontScale in listOf(1f, 2f)) {
                val config = Configuration(context.resources.configuration).apply { this.fontScale = fontScale }
                val themed = ContextThemeWrapper(context.createConfigurationContext(config), R.style.Theme_TodoPupUsage)
                val dialog = PhotoGalleryDialog(themed, {}, {}, {})
                fun field(name: String): Any = PhotoGalleryDialog::class.java.getDeclaredField(name).apply { isAccessible = true }.get(dialog)!!
                try {
                    @Suppress("UNCHECKED_CAST") val photos = field("photos") as MutableList<Uri>
                    photos.addAll(listOf(Uri.parse("content://com.todopup.qa.fixture/photo/1"), Uri.parse("content://com.todopup.qa.fixture/photo/2")))
                    val grid = field("grid") as GridView
                    val adapter = field("adapter") as BaseAdapter
                    val cells = (0..1).map { adapter.getView(it, null, grid) as FrameLayout }
                    val size = (24 * themed.resources.displayMetrics.density).toInt()
                    fun dot(cell: FrameLayout): List<Pair<Int, Int>> {
                        val view = cell.getChildAt(1)
                        check(view.layoutParams.width == size && view.layoutParams.height == size) { "Selection ring must remain 24dp" }
                        view.measure(View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY))
                        view.layout(0, 0, size, size)
                        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
                        try {
                            view.draw(Canvas(bitmap))
                            val captureKey = fontScale to cell.isSelected
                            if (captureFile != null && captureKey !in captures) captures[captureKey] = bitmap.copy(Bitmap.Config.ARGB_8888, false)
                            val accent = Color.parseColor(TodoPupUi.ACCENT)
                            val radius = 8 * themed.resources.displayMetrics.density
                            return buildList {
                                for (y in 0 until size) for (x in 0 until size) {
                                    val dx = x + .5f - size / 2f; val dy = y + .5f - size / 2f
                                    if (dx * dx + dy * dy < radius * radius && bitmap.getPixel(x, y) == accent) add(x to y)
                                }
                            }
                        } finally { bitmap.recycle() }
                    }
                    check(cells.all { !it.isSelected && dot(it).isEmpty() })
                    for (index in 0..1) grid.performItemClick(cells[index], index, index.toLong())
                    for (index in 0..1) {
                        val cell = adapter.getView(index, cells[index], grid) as FrameLayout
                        check(cell.isSelected && cell.contentDescription == "Photo ${index + 1}") { "Gallery selection must stay independent for multiple photos" }
                        val pixels = dot(cell)
                        check(pixels.isNotEmpty()) { "Selected photo needs its amber dot" }
                        val centerX = (pixels.minOf { it.first } + pixels.maxOf { it.first } + 1) / 2f
                        val centerY = (pixels.minOf { it.second } + pixels.maxOf { it.second } + 1) / 2f
                        check(abs(centerX - size / 2f) <= .5f && abs(centerY - size / 2f) <= .5f) {
                            "Selection dot is off-center at font scale $fontScale: ($centerX, $centerY), ring center ${size / 2f}"
                        }
                        val width = pixels.maxOf { it.first } - pixels.minOf { it.first } + 1
                        val height = pixels.maxOf { it.second } - pixels.minOf { it.second } + 1
                        check(abs(width - height) <= 1) { "Selection dot must be circular" }
                        dotWidths.add(width)
                    }
                    grid.performItemClick(cells[0], 0, 0)
                    check(!(adapter.getView(0, cells[0], grid) as FrameLayout).isSelected && dot(cells[0]).isEmpty())
                    check((adapter.getView(1, cells[1], grid) as FrameLayout).isSelected && dot(cells[1]).isNotEmpty())
                } finally {
                    (field("io") as ExecutorService).shutdownNow()
                    dialog.dismiss()
                }
            }
            check(dotWidths.distinct().size == 1) { "Photo selection geometry must not change with system font size" }
            if (captureFile != null) {
                val size = captures.values.first().width
                val gap = size / 3
                val sheet = Bitmap.createBitmap(size * 2 + gap * 3, size * 2 + gap * 3, Bitmap.Config.ARGB_8888)
                try {
                    val canvas = Canvas(sheet)
                    canvas.drawColor(Color.parseColor(TodoPupUi.PANEL))
                    for ((row, scale) in listOf(1f, 2f).withIndex()) for ((column, selected) in listOf(false, true).withIndex()) {
                        canvas.drawBitmap(captures.getValue(scale to selected), (gap + column * (size + gap)).toFloat(), (gap + row * (size + gap)).toFloat(), null)
                    }
                    captureFile.parentFile?.mkdirs()
                    captureFile.outputStream().use { sheet.compress(Bitmap.CompressFormat.PNG, 100, it) }
                } finally { sheet.recycle() }
            }
        } finally { captures.values.forEach(Bitmap::recycle) }
    }

    private fun checkDayFilters(context: Context) {
        val day = LocalDate.parse("2026-09-24")
        val start = day.atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
        val end = day.plusDays(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
        val themed = ContextThemeWrapper(context, R.style.Theme_TodoPupUsage)
        val dialog = PhotoGalleryDialog(themed, {}, {}, {}, day)
        fun field(name: String): Any = PhotoGalleryDialog::class.java.getDeclaredField(name).apply { isAccessible = true }.get(dialog)!!
        try {
            @Suppress("UNCHECKED_CAST") val all = field("allPhotos") as MutableList<Pair<Uri, Long?>>
            val rows = listOf(start - 1, start, end - 1, end, null).mapIndexed { index, time ->
                Uri.parse("content://com.todopup.qa.fixture/date/$index") to time
            }
            all.addAll(rows)
            PhotoGalleryDialog::class.java.getDeclaredMethod("filterPhotos").apply { isAccessible = true }.invoke(dialog)
            @Suppress("UNCHECKED_CAST") val visible = field("photos") as MutableList<Uri>
            val tabs = field("tabs") as android.widget.LinearLayout
            val grid = field("grid") as GridView
            val adapter = field("adapter") as BaseAdapter
            check(visible == rows.slice(1..2).map { it.first }) { "This day must exclude neighboring and unknown dates" }
            check(tabs.getChildAt(0).isSelected && !tabs.getChildAt(1).isSelected)
            grid.performItemClick(adapter.getView(0, null, grid), 0, 0)
            tabs.getChildAt(1).performClick()
            check(visible == rows.map { it.first }) { "All photos must include this day, other days and unknown dates" }
            check(!tabs.getChildAt(0).isSelected && tabs.getChildAt(1).isSelected)
            check(adapter.getView(1, null, grid).isSelected) { "Switching to All photos lost the selected photo" }
            grid.performItemClick(adapter.getView(0, null, grid), 0, 0)
            tabs.getChildAt(0).performClick()
            check(visible == rows.slice(1..2).map { it.first } && adapter.getView(0, null, grid).isSelected)
            check((field("add") as android.widget.TextView).text == "Add 2 photos") { "Off-tab selections must remain selected" }
        } finally {
            (field("io") as ExecutorService).shutdownNow()
            dialog.dismiss()
        }
    }
}
