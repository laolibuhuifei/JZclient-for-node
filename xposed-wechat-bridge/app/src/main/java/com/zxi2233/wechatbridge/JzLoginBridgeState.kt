package com.zxi2233.wechatbridge

import android.content.Intent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** Volatile UI state used by the Compose status screen. */
object JzLoginBridgeState {
    @Volatile
    private var requestState: String = ""
    var hostUnavailable by mutableStateOf(false)
        private set
    var result by mutableStateOf<BridgeResultUi?>(null)
        private set

    fun markRequest(state: String) {
        requestState = state
        result = null
        hostUnavailable = false
    }

    fun pendingRequest(): String = requestState

    fun markHostOpening() {
        hostUnavailable = false
    }

    fun reportHostUnavailable() {
        hostUnavailable = true
    }

    fun clear() {
        requestState = ""
        hostUnavailable = false
        result = null
    }

    fun applyResult(
        action: String?,
        state: String,
        hasSession: Boolean,
        origin: String,
        wechatError: String,
        wechatErrorCode: Int,
        capturedAt: Long,
        hostVersion: String,
    ) {
        result = bridgeResultFromLaunch(
            action = action,
            actionShowCredential = MainActivity.ACTION_SHOW_CREDENTIAL,
            state = state,
            hasSession = hasSession,
            origin = origin,
            wechatError = wechatError,
            wechatErrorCode = wechatErrorCode,
            capturedAt = capturedAt,
            hostVersion = hostVersion,
        )
    }
}

data class BridgeResultUi(
    val state: String = "",
    val hasSession: Boolean = false,
    val origin: String = "",
    val wechatError: String = "",
    val wechatErrorCode: Int = 0,
    val capturedAt: Long = 0L,
    val hostVersion: String = "",
) {
    val isTerminal: Boolean
        get() = hasSession || wechatErrorCode != 0
}

internal fun isLoginBridgeDeepLink(action: String?, scheme: String?, host: String?): Boolean =
    Intent.ACTION_VIEW == action &&
        MainActivity.DEEP_LINK_SCHEME == scheme &&
        MainActivity.DEEP_LINK_HOST == host

fun bridgeResultFromLaunch(
    action: String?,
    actionShowCredential: String,
    state: String,
    hasSession: Boolean,
    origin: String,
    wechatError: String,
    wechatErrorCode: Int,
    capturedAt: Long,
    hostVersion: String,
): BridgeResultUi? {
    if (action != actionShowCredential && state.isBlank() && !hasSession) return null
    return BridgeResultUi(
        state = state,
        hasSession = hasSession,
        origin = origin,
        wechatError = wechatError,
        wechatErrorCode = wechatErrorCode,
        capturedAt = capturedAt,
        hostVersion = hostVersion,
    )
}
