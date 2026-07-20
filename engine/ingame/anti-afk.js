// Anti-AFK: prevents the server from marking the player as disconnected when
// the browser tab is in the background.
//
// PROBLEM: Chrome throttles setInterval in BOTH the main thread AND Web Workers
// after ~5 min in a background tab (5s → 60s). The game's 5-second ping becomes
// a ~60-second ping, exceeding the server's 30-second timeout.
//
// SOLUTION: Override window.setInterval so ALL timers (including the game's own
// 5-second ping) delegate to a Web Worker. The worker manages the actual timing
// and posts messages back — setInterval callbacks execute via the worker's tick,
// bypassing Chrome's throttling of main-thread timers.
//
// Also sends an extra keep-alive ping every 15s when the tab is hidden, as a
// safety net in case the game's own ping interval somehow stalls.

var antiAfkWorker = null;
var antiAfkIntervalCallbacks = {}; // workerId → callback
var antiAfkNextId = 1;
var nativeAntiAfkSetInterval = window.setInterval.bind(window);
var nativeAntiAfkClearInterval = window.clearInterval.bind(window);
var antiAfkWorkerReady = false;
var antiAfkKeepAliveInterval = null;

  // ---- Web Worker that manages all timers ----

function createAntiAfkWorker() {
  if (
    typeof Worker !== "function" ||
    typeof URL?.createObjectURL !== "function" ||
    typeof URL?.revokeObjectURL !== "function"
  ) {
    return;
  }
  // The worker accepts "start" and "stop" commands and fires ticks back.
  var code = [
        'var timers = {};',
        'self.onmessage = function(e) {',
        '  var d = e.data;',
        '  if (d.cmd === "start") {',
        '    if (timers[d.id]) clearInterval(timers[d.id]);',
        '    timers[d.id] = setInterval(function() {',
        '      self.postMessage({id: d.id});',
        '    }, d.ms);',
        '  } else if (d.cmd === "stop") {',
        '    if (timers[d.id]) { clearInterval(timers[d.id]); delete timers[d.id]; }',
        '  }',
        '};',
  ].join('\n');
  var blob = new Blob([code], { type: "application/javascript" });
  var url = URL.createObjectURL(blob);
  antiAfkWorker = new Worker(url);
  URL.revokeObjectURL(url);

  antiAfkWorker.onmessage = function(ev) {
    var id = ev.data && ev.data.id;
    if (id && antiAfkIntervalCallbacks[id]) {
      antiAfkIntervalCallbacks[id]();
    }
  };

  antiAfkWorker.onerror = function(ev) {
    console.error("[AntiAFK] Worker error:", ev.message);
  };

  antiAfkWorkerReady = true;
}

  // ---- Override setInterval / clearInterval ----

function workerAntiAfkSetInterval(fn, ms) {
    if (!antiAfkWorkerReady || typeof fn !== "function") {
      // Fallback to native if worker isn't available
      return nativeAntiAfkSetInterval(fn, ms);
    }
    // Ensure minimum delay of 100ms to avoid flooding the worker
    if (typeof ms !== "number" || ms < 100) ms = 100;
    var id = antiAfkNextId++;
    antiAfkIntervalCallbacks[id] = fn;
    antiAfkWorker.postMessage({ cmd: "start", id: id, ms: ms });
    return id;
  }

function workerAntiAfkClearInterval(id) {
    if (antiAfkIntervalCallbacks[id]) {
      delete antiAfkIntervalCallbacks[id];
      if (antiAfkWorkerReady) {
        antiAfkWorker.postMessage({ cmd: "stop", id: id });
      }
    }
    // Also clear native in case this ID was a native fallback
    nativeAntiAfkClearInterval(id);
}

  // Install the overrides
window.setInterval = workerAntiAfkSetInterval;
window.clearInterval = workerAntiAfkClearInterval;

  // ---- Extra keep-alive ping when tab is hidden ----

function sendAntiAfkKeepAlivePing() {
    if (!runtimeState.antiAfkEnabled) return;
    if (typeof isSocketConnected !== "function" || !isSocketConnected()) return;
    if (typeof sendRawPacket !== "function") return;
    sendRawPacket({ type: "ping" });
}

function startAntiAfkKeepAlive() {
    if (antiAfkKeepAliveInterval !== null) return;
    // Send a keep-alive every 15s when tab is hidden, as a safety net
    antiAfkKeepAliveInterval = nativeAntiAfkSetInterval(function() {
      if (document.hidden) {
        sendAntiAfkKeepAlivePing();
      }
    }, 15000);
  }

function stopAntiAfkKeepAlive() {
    if (antiAfkKeepAliveInterval !== null) {
      nativeAntiAfkClearInterval(antiAfkKeepAliveInterval);
      antiAfkKeepAliveInterval = null;
    }
  }

  // ---- Feature toggle ----

window.setAntiAfkEnabled = function setAntiAfkEnabled(enabled) {
    runtimeState.antiAfkEnabled = Boolean(enabled);
    if (runtimeState.antiAfkEnabled) {
      startAntiAfkKeepAlive();
    } else {
      stopAntiAfkKeepAlive();
    }
};

  // ---- Bootstrap ----

createAntiAfkWorker();
  // Note: antiAfkEnabled is declared in runtime.js (loaded after this file).
  // It starts as false; the lobby's syncAntiAfkHelper() will call
  // setAntiAfkEnabled(true) once settings are synced. The setInterval override
  // is always active regardless — it routes ALL timers through the worker.
startAntiAfkKeepAlive();
