package com.zxi2233.wechatbridge;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Small HTTP/1.1 server bound to 127.0.0.1 only. It intentionally supports
 * just the bridge endpoints, fixed-size JSON requests and one request per socket.
 */
final class LoopbackHttpServer {
    interface Listener {
        void onAuthorizationCreated(String state);
        void onAuthorizationTransferAccepted(String state);
        void onAuthorizationCancelled(String state);
        String hostVersion();
        JSONObject diagnostics();
        String diagnosticLog();
    }

    private static final int MAX_HEADERS_BYTES = 16 * 1024;
    private static final int MAX_BODY_BYTES = 2 * 1024;
    private static final int MAX_ACTIVE_CONNECTIONS = 32;
    private static final int REQUEST_SOCKET_TIMEOUT_MS = 3_000;

    private final RequestRegistry registry;
    private final Listener listener;
    private final Map<Socket, Boolean> sockets = new HashMap<>();
    private volatile boolean running;
    private ServerSocket serverSocket;

    LoopbackHttpServer(RequestRegistry registry, Listener listener) {
        this.registry = registry;
        this.listener = listener;
    }

    void start() throws IOException {
        ServerSocket socket = new ServerSocket();
        socket.bind(new java.net.InetSocketAddress(
                InetAddress.getByName("127.0.0.1"), BridgeContract.PORT), 8);
        serverSocket = socket;
        running = true;
        Thread acceptor = new Thread(this::acceptLoop, "jz-wechat-bridge-http");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket socket = serverSocket.accept();
                synchronized (sockets) {
                    if (!running || sockets.size() >= MAX_ACTIVE_CONNECTIONS) {
                        socket.close();
                        continue;
                    }
                    sockets.put(socket, Boolean.TRUE);
                }
                Thread worker = new Thread(() -> {
                    try {
                        serve(socket);
                    } finally {
                        synchronized (sockets) {
                            sockets.remove(socket);
                        }
                    }
                }, "jz-wechat-bridge-request");
                worker.setDaemon(true);
                worker.start();
            } catch (SocketException error) {
                if (running) error.printStackTrace();
                return;
            } catch (IOException error) {
                if (!running) return;
            }
        }
    }

    private void serve(Socket socket) {
        Request request = null;
        try (Socket closeable = socket;
             BufferedInputStream input = new BufferedInputStream(socket.getInputStream());
             BufferedOutputStream output = new BufferedOutputStream(socket.getOutputStream())) {
            socket.setSoTimeout(REQUEST_SOCKET_TIMEOUT_MS);
            request = readRequest(input);
            if (request == null) return;
            Response response = dispatch(request);
            writeResponse(output, request, response);
        } catch (HttpError error) {
            try {
                request = error.request;
                writeResponse(socket.getOutputStream(), request,
                        jsonError(error.status, "bad_request", error.getMessage()));
            } catch (IOException ignored) {
                // The browser may already have closed a cancelled request.
            }
        } catch (BridgeException error) {
            try {
                writeResponse(socket.getOutputStream(), request,
                        jsonError(error.httpStatus, error.code, error.getMessage(),
                                normalizedOrigin(request)));
            } catch (IOException ignored) {
            }
        } catch (IOException ignored) {
            // Timeouts and disconnects carry no authorization data.
        } catch (Throwable error) {
            try {
                writeResponse(socket.getOutputStream(), null,
                        jsonError(500, "internal_error", "桥接服务处理请求失败。"));
            } catch (IOException ignored) {
            }
        }
    }

    private static String normalizedOrigin(Request request) {
        if (request == null) return null;
        try {
            String origin = request.headers.get("origin");
            return origin == null ? null : BridgeContract.normalizeOrigin(origin);
        } catch (BridgeException error) {
            return null;
        }
    }

    private Response dispatch(Request request) throws BridgeException, JSONException {
        if (BridgeContract.validateHost(request.headers.get("host")) == null) {
            return jsonError(403, "invalid_host", "Host 请求头无效。");
        }
        String originHeader = request.headers.get("origin");
        String origin = originHeader == null ? null : BridgeContract.normalizeOrigin(originHeader);
        URI uri;
        try {
            uri = URI.create(request.target);
        } catch (IllegalArgumentException error) {
            throw new BridgeException(400, "invalid_path", "请求路径无效。");
        }
        String path = uri.getPath();
        if (path == null || !path.startsWith("/v1/")) {
            return jsonError(404, "not_found", "接口不存在。");
        }

        if ("OPTIONS".equals(request.method)) {
            if (origin == null) throw new BridgeException(403, "origin_required", "需要 Origin。");
            return new Response(204, null, origin);
        }
        if ("/v1/status".equals(path) && "GET".equals(request.method)) {
            JSONObject body = new JSONObject()
                    .put("ok", true)
                    .put("service", "jz-wechat-bridge")
                    .put("protocol", 1)
                    .put("port", BridgeContract.PORT)
                    .put("hostPackage", BridgeContract.HOST_PACKAGE)
                    .put("hostVersion", listener.hostVersion());
            return new Response(200, body, origin);
        }
        if (origin == null) throw new BridgeException(403, "origin_required", "需要网页 Origin。");

        if ("/v1/diagnostics".equals(path) && "GET".equals(request.method)) {
            return new Response(200, new JSONObject()
                    .put("ok", true)
                    .put("data", listener.diagnostics()), origin);
        }
        if ("/v1/diagnostics/log".equals(path) && "GET".equals(request.method)) {
            return new Response(200, new JSONObject()
                    .put("ok", true)
                    .put("data", new JSONObject().put("lines", listener.diagnosticLog())), origin);
        }

        if ("/v1/authorizations".equals(path) && "POST".equals(request.method)) {
            if (request.body == null) throw new BridgeException(400, "body_required", "需要 JSON 请求体。");
            String state;
            try {
                JSONObject json = new JSONObject(new String(request.body, StandardCharsets.UTF_8));
                state = json.getString("state");
            } catch (JSONException error) {
                throw new BridgeException(400, "invalid_json", "请求 JSON 无效。");
            }
            if (registry.bindTransfer(origin, state, System.currentTimeMillis())) {
                AuthorizationSnapshot snapshot = registry.peek(
                        origin, state, System.currentTimeMillis());
                if (snapshot == null) {
                    throw new BridgeException(404, "not_found", "授权请求不存在。");
                }
                listener.onAuthorizationTransferAccepted(state);
                return new Response(202, snapshotJson(snapshot), origin);
            }
            AuthorizationSnapshot snapshot = registry.create(origin, state, System.currentTimeMillis());
            listener.onAuthorizationCreated(state);
            return new Response(202, snapshotJson(snapshot), origin);
        }

        String prefix = "/v1/authorizations/";
        if (path.startsWith(prefix) && path.indexOf('/', prefix.length()) < 0) {
            String state = path.substring(prefix.length());
            if ("GET".equals(request.method)) {
                registry.bindTransfer(origin, state, System.currentTimeMillis());
                AuthorizationSnapshot snapshot = registry.poll(origin, state, System.currentTimeMillis());
                if (snapshot == null) return jsonError(404, "not_found", "授权请求不存在或结果已读取。", origin);
                return new Response(200, snapshotJson(snapshot), origin);
            }
            if ("DELETE".equals(request.method)) {
                registry.bindTransfer(origin, state, System.currentTimeMillis());
                boolean cancelled = registry.cancel(origin, state, System.currentTimeMillis());
                if (!cancelled) return jsonError(404, "not_found", "授权请求不存在或已结束。", origin);
                listener.onAuthorizationCancelled(state);
                return new Response(200, new JSONObject().put("ok", true).put("status", "cancelled"), origin);
            }
        }
        return jsonError(404, "not_found", "接口不存在。", origin);
    }

    private static JSONObject snapshotJson(AuthorizationSnapshot snapshot) throws JSONException {
        JSONObject json = new JSONObject()
                .put("ok", !AuthorizationSnapshot.ERROR.equals(snapshot.status))
                .put("status", snapshot.status)
                .put("state", snapshot.state)
                .put("expiresAt", snapshot.expiresAt);
        if (AuthorizationSnapshot.AUTHORIZED.equals(snapshot.status)) {
            json.put("session", snapshot.accountSession)
                    .put("wechatErrorCode", snapshot.wechatErrorCode);
        } else if (AuthorizationSnapshot.ERROR.equals(snapshot.status)) {
            json.put("wechatErrorCode", snapshot.wechatErrorCode)
                    .put("wechatError", nullable(snapshot.wechatError))
                    .put("error", new JSONObject()
                            .put("code", snapshot.errorCode)
                            .put("message", snapshot.errorMessage));
        }
        return json;
    }

    private static Object nullable(String value) {
        return value == null ? JSONObject.NULL : value;
    }

    private static Response jsonError(int status, String code, String message) {
        return jsonError(status, code, message, null);
    }

    private static Response jsonError(int status, String code, String message, String origin) {
        try {
            return new Response(status, new JSONObject()
                    .put("ok", false)
                    .put("error", new JSONObject().put("code", code).put("message", message)), origin);
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static Request readRequest(BufferedInputStream input) throws IOException, HttpError {
        String requestLine = readLine(input, 8 * 1024);
        if (requestLine == null || requestLine.isEmpty()) return null;
        String[] parts = requestLine.split(" ", 3);
        Request request = new Request();
        if (parts.length != 3 || !parts[2].startsWith("HTTP/1.")) {
            throw new HttpError(400, "HTTP 请求行无效。", request);
        }
        request.method = parts[0];
        request.target = parts[1];
        int headerBytes = requestLine.length() + 2;
        while (true) {
            String line = readLine(input, 8 * 1024);
            if (line == null) throw new EOFException("incomplete headers");
            headerBytes += line.length() + 2;
            if (headerBytes > MAX_HEADERS_BYTES) throw new HttpError(431, "请求头过大。", request);
            if (line.isEmpty()) break;
            int colon = line.indexOf(':');
            if (colon <= 0) throw new HttpError(400, "请求头无效。", request);
            String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
            String value = line.substring(colon + 1).trim();
            request.headers.put(name, value);
        }
        if (request.headers.containsKey("transfer-encoding")) {
            throw new HttpError(400, "不支持分块请求体。", request);
        }
        String length = request.headers.get("content-length");
        if (length != null) {
            final int size;
            try {
                size = Integer.parseInt(length);
            } catch (NumberFormatException error) {
                throw new HttpError(400, "Content-Length 无效。", request);
            }
            if (size < 0 || size > MAX_BODY_BYTES) throw new HttpError(413, "请求体过大。", request);
            request.body = new byte[size];
            int offset = 0;
            while (offset < size) {
                int read = input.read(request.body, offset, size - offset);
                if (read < 0) throw new EOFException("incomplete body");
                offset += read;
            }
        }
        return request;
    }

    private static String readLine(BufferedInputStream input, int limit) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        while (line.size() <= limit) {
            int value = input.read();
            if (value < 0) return line.size() == 0 ? null : line.toString("ISO-8859-1");
            if (value == '\n') {
                byte[] bytes = line.toByteArray();
                int length = bytes.length;
                if (length > 0 && bytes[length - 1] == '\r') length--;
                return new String(bytes, 0, length, StandardCharsets.ISO_8859_1);
            }
            line.write(value);
        }
        throw new IOException("HTTP line too long");
    }

    private static void writeResponse(java.io.OutputStream stream, Request request,
                                      Response response) throws IOException {
        byte[] body = response.body == null ? new byte[0]
                : response.body.toString().getBytes(StandardCharsets.UTF_8);
        StringBuilder headers = new StringBuilder()
                .append("HTTP/1.1 ").append(response.status).append(' ').append(reason(response.status))
                .append("\r\nConnection: close")
                .append("\r\nCache-Control: no-store")
                .append("\r\nX-Content-Type-Options: nosniff")
                .append("\r\nContent-Length: ").append(body.length);
        if (response.body != null) headers.append("\r\nContent-Type: application/json; charset=utf-8");
        if (response.origin != null) {
            headers.append("\r\nAccess-Control-Allow-Origin: ").append(response.origin)
                    .append("\r\nVary: Origin");
        }
        if (request != null && "OPTIONS".equals(request.method)) {
            headers.append("\r\nAccess-Control-Allow-Methods: GET, POST, DELETE, OPTIONS")
                    .append("\r\nAccess-Control-Allow-Headers: Content-Type")
                    .append("\r\nAccess-Control-Max-Age: 0");
            if ("true".equals(request.headers.get("access-control-request-private-network"))) {
                headers.append("\r\nAccess-Control-Allow-Private-Network: true");
            }
        }
        headers.append("\r\n\r\n");
        stream.write(headers.toString().getBytes(StandardCharsets.US_ASCII));
        stream.write(body);
        stream.flush();
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 202: return "Accepted";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 409: return "Conflict";
            case 413: return "Payload Too Large";
            case 429: return "Too Many Requests";
            case 431: return "Request Header Fields Too Large";
            default: return "Error";
        }
    }

    private static final class Request {
        String method;
        String target;
        final Map<String, String> headers = new HashMap<>();
        byte[] body;
    }

    private static final class Response {
        final int status;
        final JSONObject body;
        final String origin;

        Response(int status, JSONObject body, String origin) {
            this.status = status;
            this.body = body;
            this.origin = origin;
        }
    }

    private static final class HttpError extends Exception {
        final int status;
        final Request request;

        HttpError(int status, String message, Request request) {
            super(message);
            this.status = status;
            this.request = request;
        }
    }
}
