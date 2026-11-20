package com.zxi2233.wechatbridge;

public final class BridgeException extends Exception {
    public final int httpStatus;
    public final String code;

    public BridgeException(int httpStatus, String code, String message) {
        super(message);
        this.httpStatus = httpStatus;
        this.code = code;
    }
}
