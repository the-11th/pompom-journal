package com.todopup.usage

/** Resume an explicitly enabled recorder only while permission remains granted. */
object TrackingStartupPolicy {
    fun shouldRecord(savedChoice: Boolean?, hasPrecisePermission: Boolean): Boolean =
        hasPrecisePermission && savedChoice == true
}
