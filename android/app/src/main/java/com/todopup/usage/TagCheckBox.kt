package com.todopup.usage

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import androidx.appcompat.widget.AppCompatCheckBox

/** A circular tag indicator with independent checkbox selection semantics. */
class TagCheckBox(context: Context) : AppCompatCheckBox(context) {
    private fun dp(value: Int) = (value * resources.displayMetrics.density + .5f).toInt()

    init {
        val accent = Color.parseColor(TodoPupUi.ACCENT)
        fun circle(checked: Boolean) = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setSize(dp(18), dp(18))
            setColor(Color.parseColor(if (checked) TodoPupUi.ACCENT else TodoPupUi.PANEL))
            setStroke(dp(2), if (checked) accent else Color.parseColor(TodoPupUi.TEXT))
        }
        buttonTintList = null
        buttonDrawable = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_checked), circle(true))
            addState(intArrayOf(), circle(false))
        }
        setTextColor(Color.parseColor(TodoPupUi.TEXT))
        typeface = Typeface.MONOSPACE
        textSize = 14f
        minHeight = dp(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP)
        compoundDrawablePadding = dp(TodoPupUi.CONTENT_GAP_DP)
    }

    override fun getCompoundPaddingLeft(): Int = super.getCompoundPaddingLeft() +
        if (layoutDirection == LAYOUT_DIRECTION_LTR) dp(TodoPupUi.CONTENT_GAP_DP) else 0

    override fun getCompoundPaddingRight(): Int = super.getCompoundPaddingRight() +
        if (layoutDirection == LAYOUT_DIRECTION_RTL) dp(TodoPupUi.CONTENT_GAP_DP) else 0
}
