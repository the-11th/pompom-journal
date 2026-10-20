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
        val accent = Color.parseColor(DatapomUi.ACCENT)
        fun circle(checked: Boolean) = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setSize(dp(18), dp(18))
            setColor(Color.parseColor(if (checked) DatapomUi.ACCENT else DatapomUi.PANEL))
            setStroke(dp(2), if (checked) accent else Color.parseColor(DatapomUi.TEXT))
        }
        buttonTintList = null
        buttonDrawable = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_checked), circle(true))
            addState(intArrayOf(), circle(false))
        }
        setTextColor(Color.parseColor(DatapomUi.TEXT))
        typeface = Typeface.MONOSPACE
        textSize = 14f
        minHeight = dp(DatapomUi.COMPACT_CONTROL_HEIGHT_DP)
        compoundDrawablePadding = dp(DatapomUi.CONTENT_GAP_DP)
    }

    override fun getCompoundPaddingLeft(): Int = super.getCompoundPaddingLeft() +
        if (layoutDirection == LAYOUT_DIRECTION_LTR) dp(DatapomUi.CONTENT_GAP_DP) else 0

    override fun getCompoundPaddingRight(): Int = super.getCompoundPaddingRight() +
        if (layoutDirection == LAYOUT_DIRECTION_RTL) dp(DatapomUi.CONTENT_GAP_DP) else 0
}
