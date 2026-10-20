package com.todopup.usage

import android.app.AlertDialog
import android.app.Dialog
import android.content.ComponentCallbacks
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.TextView

/** Shared native dialog typography, colors, and outer spacing. */
internal object NativeDialogTheme {
    fun apply(dialog: AlertDialog) {
        val context = dialog.context
        val density = context.resources.displayMetrics.density
        fun dp(value: Int) = (value * density + .5f).toInt()
        dialog.window?.apply {
            setBackgroundDrawable(GradientDrawable().apply {
                setColor(Color.parseColor(DatapomUi.PANEL))
                cornerRadius = dp(DatapomUi.SPACE_MD_DP).toFloat()
                setStroke(dp(1), Color.parseColor(DatapomUi.BORDER))
            })
        }
        followWindowSize(dialog)
        val titleId = context.resources.getIdentifier("alertTitle", "id", "android")
        dialog.findViewById<TextView>(titleId)?.apply {
            setTextColor(Color.parseColor(DatapomUi.TEXT))
            typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
            textSize = 18f
        }
        dialog.findViewById<TextView>(android.R.id.message)?.apply {
            setTextColor(Color.parseColor(DatapomUi.TEXT))
            typeface = Typeface.MONOSPACE
            textSize = 14f
        }
        listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL).forEach { which ->
            dialog.getButton(which)?.apply {
                setTextColor(Color.parseColor(if (which == AlertDialog.BUTTON_POSITIVE) DatapomUi.ACCENT else DatapomUi.MUTED))
                typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
                textSize = 13f
                isAllCaps = false
                minHeight = dp(DatapomUi.CONTROL_HEIGHT_DP)
            }
        }
    }

    /** Activity handles rotation itself, so open dialog windows must update their pixel bounds. */
    fun followWindowSize(dialog: Dialog, fillHeight: Boolean = false) {
        val window = dialog.window ?: return
        val context = dialog.context
        val decor = window.decorView
        fun resize() {
            if (!dialog.isShowing) return
            val metrics = context.resources.displayMetrics
            val gutter = (2 * DatapomUi.PAGE_GUTTER_DP * metrics.density + .5f).toInt()
            val current = if (Build.VERSION.SDK_INT >= 30) window.windowManager.currentWindowMetrics else null
            val insets = if (Build.VERSION.SDK_INT >= 30) current?.windowInsets?.getInsetsIgnoringVisibility(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()) else null
            val width = (current?.bounds?.width() ?: metrics.widthPixels) - (insets?.left ?: 0) - (insets?.right ?: 0) - gutter
            val height = if (fillHeight) ((current?.bounds?.height() ?: metrics.heightPixels) -
                (insets?.top ?: 0) - (insets?.bottom ?: 0) - gutter).coerceAtLeast(gutter)
                else ViewGroup.LayoutParams.WRAP_CONTENT
            window.setLayout(width.coerceAtLeast(gutter), height)
        }
        val callback = object : ComponentCallbacks {
            override fun onConfigurationChanged(newConfig: Configuration) { decor.post { resize() } }
            override fun onLowMemory() = Unit
        }
        context.registerComponentCallbacks(callback)
        decor.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(view: View) = Unit
            override fun onViewDetachedFromWindow(view: View) {
                context.unregisterComponentCallbacks(callback)
                view.removeOnAttachStateChangeListener(this)
            }
        })
        resize()
        decor.post { resize() }
    }
}
