const KEEPALIVE_PORT_NAME = 'doraemon.keepalive';
const RECONNECT_MS = 1000;

let port = null;
let reconnectTimer = null;

const clearReconnect = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
};

const connect = () => {
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
