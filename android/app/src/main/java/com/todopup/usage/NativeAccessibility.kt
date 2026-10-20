package com.todopup.usage

import android.view.View
import android.view.accessibility.AccessibilityNodeInfo

/** Give custom-styled actions the same role as standard Android buttons. */
internal object NativeAccessibility {
    fun button(view: View) {
        view.accessibilityDelegate = object : View.AccessibilityDelegate() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                info.className = "android.widget.Button"
            }
        }
    }
}
