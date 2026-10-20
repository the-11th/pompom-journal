package com.todopup.usage

import android.content.Context
import android.graphics.Color
import android.util.TypedValue
import android.view.ContextThemeWrapper
import android.view.View

/** Native controls use the same dark palette regardless of the phone's light/dark setting. */
internal object NativeUiChecks {
    fun run(context: Context) {
        GallerySelectionChecks.run(context)
        UsageUploadChecks.run()
        val theme = ContextThemeWrapper(context, R.style.Theme_TodoPupUsage)
        val dialogTheme = TypedValue()
        check(theme.theme.resolveAttribute(android.R.attr.alertDialogTheme, dialogTheme, true))
        val dialogContext = ContextThemeWrapper(theme, dialogTheme.resourceId)
        val attrs = dialogContext.obtainStyledAttributes(intArrayOf(
            android.R.attr.textColorPrimary, android.R.attr.textColorSecondary, android.R.attr.fontFamily))
        try {
            check(attrs.getColor(0, 0) == Color.parseColor(TodoPupUi.TEXT)) {
                "Native dialog and list text must use the mobile text token"
            }
            check(attrs.getColor(1, 0) == Color.parseColor(TodoPupUi.MUTED)) {
                "Native dialog secondary text must use the mobile muted token"
            }
            check(attrs.getString(2) == "monospace") { "Native dialog lists must use monospace" }
        } finally { attrs.recycle() }
        val choice = TagCheckBox(theme).apply { text = "Review spacing" }
        choice.measure(View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
        val minimum = (44 * context.resources.displayMetrics.density).toInt()
        check(choice.measuredHeight >= minimum) { "Tag choices are too short to tap comfortably" }
    }
}
