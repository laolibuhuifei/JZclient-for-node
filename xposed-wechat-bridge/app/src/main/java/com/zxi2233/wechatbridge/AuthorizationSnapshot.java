package com.zxi2233.wechatbridge;

/** Immutable copy, so a caller never observes a half-written authorization. */
public final class AuthorizationSnapshot {
    public static final String WAITING_FOR_HOST = "waiting_for_host";
    public static final String AWAITING_CONFIRMATION = "awaiting_confirmation";
    public static final String LAUNCHING_WECHAT = "launching_wechat";
    public static final String WAITING_FOR_WECHAT = "waiting_for_wechat";
    public static final String LOGGING_IN = "logging_in";
    public static final String AUTHORIZED = "authorized";
    public static final String ERROR = "error";

    public final String state;
    public final String status;
    public final long expiresAt;
    public final String accountSession;
    public final int wechatErrorCode;
    public final String wechatError;
    public final String errorCode;
    public final String errorMessage;

    AuthorizationSnapshot(String state, String status, long expiresAt, String accountSession,
                          int wechatErrorCode, String wechatError,
                          String errorCode, String errorMessage) {
        this.state = state;
        this.status = status;
        this.expiresAt = expiresAt;
        this.accountSession = accountSession;
        this.wechatErrorCode = wechatErrorCode;
        this.wechatError = wechatError;
        this.errorCode = errorCode;
        this.errorMessage = errorMessage;
    }

    public boolean isTerminal() {
        return AUTHORIZED.equals(status) || ERROR.equals(status);
    }
}
