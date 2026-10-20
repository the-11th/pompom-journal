package com.todopup.usage

import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.GridLayout
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.util.Locale

class JournalCalendarDialog(
    private val context: Context,
    initialDate: LocalDate,
    private val entryDates: Set<String> = emptySet(),
    private val title: String = "Journal date",
    private val onCancel: (() -> Unit)? = null,
    private val onSelect: (LocalDate) -> Unit,
) {
    private val panel = Color.parseColor(TodoPupUi.PANEL)
    private val text = Color.parseColor(TodoPupUi.TEXT)
    private val muted = Color.parseColor(TodoPupUi.MUTED)
    private val border = Color.parseColor(TodoPupUi.BORDER)
    private val accent = Color.parseColor(TodoPupUi.ACCENT)
    private val density = context.resources.displayMetrics.density
    private var selected = initialDate
    private var month = YearMonth.from(initialDate)
    private lateinit var dialog: AlertDialog
    private lateinit var monthTitle: TextView
    private lateinit var grid: GridLayout

    fun show() {
        val content = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(TodoPupUi.DIALOG_PADDING_DP), dp(TodoPupUi.SPACE_MD_DP),
                dp(TodoPupUi.DIALOG_PADDING_DP), dp(TodoPupUi.SPACE_SM_DP))
            setBackgroundColor(panel)
        }
        val header = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(button("‹", "Previous month") { month = month.minusMonths(1); render() },
            LinearLayout.LayoutParams(dp(48), dp(44)))
        monthTitle = label("", text, 16f).apply {
            gravity = Gravity.CENTER
            typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
        }
        header.addView(monthTitle, LinearLayout.LayoutParams(0, dp(44), 1f))
        header.addView(button("›", "Next month") { month = month.plusMonths(1); render() },
            LinearLayout.LayoutParams(dp(48), dp(44)))
        content.addView(header)

        val weekdays = GridLayout(context).apply { columnCount = 7; rowCount = 1 }
        listOf("M", "T", "W", "T", "F", "S", "S").forEach { day ->
            weekdays.addView(label(day, muted, 11f).apply { gravity = Gravity.CENTER }, cellParams(dp(26)))
        }
        content.addView(weekdays, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        grid = GridLayout(context).apply { columnCount = 7; rowCount = 6 }
        content.addView(grid, LinearLayout.LayoutParams(-1, -2))

        dialog = AlertDialog.Builder(context)
            .setTitle(title)
            .setView(ScrollView(context).apply { addView(content) })
            .setNegativeButton("Cancel") { _, _ -> onCancel?.invoke() }
            .setNeutralButton("Today", null)
            .create()
        dialog.setOnShowListener {
            NativeDialogTheme.apply(dialog)
            dialog.window?.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setTextColor(accent)
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                selected = LocalDate.now()
                month = YearMonth.from(selected)
                render()
            }
        }
        dialog.setOnCancelListener { onCancel?.invoke() }
        render()
        dialog.show()
    }

    private fun render() {
        val fullMonth = month.format(DateTimeFormatter.ofPattern("MMMM yyyy", Locale.getDefault()))
        monthTitle.text = if (context.resources.configuration.fontScale > 1.3f)
            month.format(DateTimeFormatter.ofPattern("MMM yyyy", Locale.getDefault())) else fullMonth
        monthTitle.contentDescription = fullMonth
        grid.removeAllViews()
        JournalCalendarModel.month(month, selected, entryDates).forEach { item ->
            val cell = LinearLayout(context).apply {
                NativeAccessibility.button(this)
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                isClickable = true
                isFocusable = true
                contentDescription = buildString {
                    append(item.date)
                    if (item.hasEntry) append(", has journal entry")
                    if (item.selected) append(", selected")
                }
                background = when {
                    item.selected -> rounded(panel, accent)
                    else -> rounded(Color.TRANSPARENT, Color.TRANSPARENT)
                }
                setOnClickListener {
                    selected = item.date
                    onSelect(item.date)
                    dialog.dismiss()
                }
            }
            cell.addView(label(item.date.dayOfMonth.toString(),
                if (item.inMonth) text else muted, 13f).apply {
                gravity = Gravity.CENTER
                alpha = if (item.inMonth) 1f else .5f
            }, LinearLayout.LayoutParams(-1, 0, 1f))
            cell.addView(FrameLayout(context).apply {
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                if (item.hasEntry) addView(View(context).apply {
                    background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(accent) }
                }, FrameLayout.LayoutParams(dp(4), dp(4), Gravity.CENTER))
            }, LinearLayout.LayoutParams(-1, dp(10)))
            grid.addView(cell, cellParams(dp(TodoPupUi.CONTROL_HEIGHT_DP)))
        }
    }

    private fun cellParams(height: Int) = GridLayout.LayoutParams().apply {
        width = 0
        this.height = height
        columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f)
        setMargins(dp(2), dp(2), dp(2), dp(2))
    }

    private fun button(value: String, description: String, click: () -> Unit) =
        label(value, accent, 24f).apply {
            NativeAccessibility.button(this)
            gravity = Gravity.CENTER
            contentDescription = description
            isClickable = true
            isFocusable = true
            background = rounded(panel, border)
            setOnClickListener { click() }
        }

    private fun label(value: String, color: Int, size: Float) = TextView(context).apply {
        text = value
        setTextColor(color)
        textSize = size
        typeface = Typeface.MONOSPACE
        gravity = Gravity.CENTER_VERTICAL
    }

    private fun rounded(fill: Int, stroke: Int) = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        setColor(fill)
        if (stroke != Color.TRANSPARENT) setStroke(dp(1), stroke)
        cornerRadius = dp(6).toFloat()
    }

    private fun dp(value: Int) = (value * density).toInt()
}
