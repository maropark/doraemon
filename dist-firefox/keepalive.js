// src/extension/keepalive.js
var KEEPALIVE_PORT_NAME = "doraemon.keepalive";
var RECONNECT_MS = 1e3;
var port = null;
var reconnectTimer = null;
var clearReconnect = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
};
var connect = () => {
  clearReconnect();
  try {
    port = browser.runtime.connect({ name: KEEPALIVE_PORT_NAME });
  } catch {
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
    return;
  }
  port.onDisconnect.addListener(() => {
    port = null;
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  });
};
connect();
//# sourceMappingURL=keepalive.js.map
