(function () {
  if (window.__renovebotLoaded) return;
  window.__renovebotLoaded = true;

  var script = document.currentScript;
  var base =
    (script && script.dataset && script.dataset.baseUrl) ||
    (script && script.src ? script.src.replace(/\/widget\.js.*$/, "") : "");

  var style = document.createElement("style");
  style.textContent =
    ".rb-root{position:fixed;right:20px;bottom:110px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;}" +
    ".rb-launcher-row{display:flex;align-items:center;gap:12px;}" +
    ".rb-bubble-tip{background:#ffffff;color:#0a1428;border-radius:18px;padding:10px 16px;box-shadow:0 10px 28px rgba(10,20,40,0.18);cursor:pointer;display:flex;flex-direction:column;align-items:flex-start;gap:2px;max-width:240px;position:relative;animation:rbFadeIn 0.35s ease-out;}" +
    ".rb-bubble-tip.rb-hidden{display:none;}" +
    ".rb-bubble-tip::after{content:'';position:absolute;right:-7px;top:50%;transform:translateY(-50%);border:7px solid transparent;border-left-color:#ffffff;}" +
    ".rb-bubble-tip .rb-name{font-size:13px;font-weight:700;color:#0a1428;display:flex;align-items:center;gap:6px;}" +
    ".rb-bubble-tip .rb-status-dot{width:8px;height:8px;border-radius:50%;background:#2fd07f;display:inline-block;box-shadow:0 0 0 3px rgba(47,208,127,0.25);}" +
    ".rb-bubble-tip .rb-msg{font-size:13px;color:#3a4554;line-height:1.3;}" +
    ".rb-launcher{position:relative !important;width:60px !important;height:60px !important;min-width:60px !important;min-height:60px !important;border-radius:50% !important;background:linear-gradient(135deg,#ff8c1a 0%,#ff4d1a 100%) !important;color:#ffffff !important;border:0 !important;cursor:pointer !important;box-shadow:0 10px 28px rgba(255,77,26,0.45) !important;display:flex !important;align-items:center !important;justify-content:center !important;transition:transform 0.18s ease;padding:0 !important;overflow:hidden !important;box-sizing:border-box !important;line-height:1 !important;}" +
    ".rb-launcher:hover{transform:scale(1.06);}" +
    ".rb-launcher svg{width:32px !important;height:32px !important;display:block !important;}" +
    ".rb-launcher .rb-pulse{position:absolute !important;inset:-3px !important;border-radius:50% !important;border:3px solid #ff7821 !important;opacity:0.55;animation:rbPulse 2s ease-out infinite;pointer-events:none;}" +
    ".rb-launcher.rb-open-state .rb-icon-bot{display:none !important;}" +
    ".rb-launcher.rb-open-state .rb-pulse{display:none !important;}" +
    ".rb-launcher .rb-icon-close{display:none !important;}" +
    ".rb-launcher.rb-open-state .rb-icon-close{display:block !important;}" +
    ".rb-frame-wrap{width:min(420px,calc(100vw - 40px));height:min(640px,calc(100vh - 200px));border-radius:16px;overflow:hidden;box-shadow:0 22px 50px rgba(10,20,40,0.3);background:#fff;display:none;}" +
    ".rb-frame-wrap.rb-open{display:block;}" +
    ".rb-frame-wrap iframe{width:100%;height:100%;border:0;display:block;}" +
    "@keyframes rbFadeIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}" +
    "@keyframes rbPulse{0%{transform:scale(1);opacity:0.55;}100%{transform:scale(1.35);opacity:0;}}" +
    "@media (max-width:520px){.rb-root{right:14px;right:calc(14px + env(safe-area-inset-right));bottom:92px;bottom:calc(92px + env(safe-area-inset-bottom));}.rb-bubble-tip{max-width:200px;border-radius:8px;padding:10px 13px;}.rb-bubble-tip::after{display:none;}.rb-frame-wrap{position:fixed;right:0;bottom:0;left:0;top:0;width:100vw;width:100dvw;height:100vh;height:100dvh;border-radius:0;box-shadow:none;}.rb-root.rb-chat-open{inset:0;display:block;pointer-events:none;}.rb-root.rb-chat-open .rb-frame-wrap{pointer-events:auto;}.rb-root.rb-chat-open .rb-launcher-row{position:fixed;top:12px;top:calc(12px + env(safe-area-inset-top));right:12px;right:calc(12px + env(safe-area-inset-right));z-index:2147483002;pointer-events:auto;}.rb-root.rb-chat-open .rb-bubble-tip{display:none;}.rb-root.rb-chat-open .rb-launcher{width:44px !important;height:44px !important;min-width:44px !important;min-height:44px !important;background:rgba(20,60,50,0.9) !important;border:1px solid rgba(255,255,255,0.22) !important;box-shadow:0 8px 22px rgba(0,0,0,0.22) !important;}.rb-root.rb-chat-open .rb-launcher:hover{transform:none;}.rb-root.rb-chat-open .rb-launcher svg{width:24px !important;height:24px !important;}}";
  document.head.appendChild(style);

  var BOT_SVG = '<svg class="rb-icon-bot" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M8 16 Q8 12 12 12 L40 12 Q44 12 44 16 L44 28 Q44 32 40 32 L24 32 Q22 32 22 30 L22 24 Q22 20 26 20 L44 20" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
    '<path d="M22 24 Q22 20 26 20 L52 20 Q56 20 56 24 L56 42 Q56 46 52 46 L38 46 L33 53 L33 46 L26 46 Q22 46 22 42 Z" fill="#ffffff"/>' +
    '<line x1="28" y1="29" x2="50" y2="29" stroke="#ff5722" stroke-width="2.4" stroke-linecap="round"/>' +
    '<line x1="28" y1="35" x2="50" y2="35" stroke="#ff5722" stroke-width="2.4" stroke-linecap="round"/>' +
    '<line x1="28" y1="41" x2="42" y2="41" stroke="#ff5722" stroke-width="2.4" stroke-linecap="round"/>' +
    '</svg>';
  var CLOSE_SVG = '<svg class="rb-icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  var root = document.createElement("div");
  root.className = "rb-root";

  var wrap = document.createElement("div");
  wrap.className = "rb-frame-wrap";
  var iframe = document.createElement("iframe");
  iframe.title = "Chat con Renovebot";
  iframe.src = base + "/";
  wrap.appendChild(iframe);

  var launcherRow = document.createElement("div");
  launcherRow.className = "rb-launcher-row";

  var tip = document.createElement("div");
  tip.className = "rb-bubble-tip";
  tip.innerHTML =
    '<div class="rb-name"><span class="rb-status-dot"></span>Renovebot</div>' +
    '<div class="rb-msg">Te ayudo a solicitar tu presupuesto</div>';

  var btn = document.createElement("button");
  btn.className = "rb-launcher";
  btn.type = "button";
  btn.setAttribute("aria-label", "Abrir chat con Renovebot");
  btn.innerHTML = '<span class="rb-pulse"></span>' + BOT_SVG + CLOSE_SVG;

  launcherRow.appendChild(tip);
  launcherRow.appendChild(btn);
  root.appendChild(wrap);
  root.appendChild(launcherRow);

  function openChat(token) {
    if (token) {
      iframe.src = base + "/?t=" + encodeURIComponent(token);
    }
    wrap.classList.add("rb-open");
    root.classList.add("rb-chat-open");
    btn.classList.add("rb-open-state");
    tip.classList.add("rb-hidden");
    btn.setAttribute("aria-label", "Cerrar chat con Renovebot");
  }
  function closeChat() {
    wrap.classList.remove("rb-open");
    root.classList.remove("rb-chat-open");
    btn.classList.remove("rb-open-state");
    tip.classList.remove("rb-hidden");
    btn.setAttribute("aria-label", "Abrir chat con Renovebot");
  }
  function toggleChat() {
    if (wrap.classList.contains("rb-open")) closeChat();
    else openChat();
  }

  btn.addEventListener("click", toggleChat);
  tip.addEventListener("click", function () { openChat(); });
  window.addEventListener("message", function (event) {
    if (event && event.data && event.data.type === "renovebot:close") {
      closeChat();
    }
  });

  function attach() {
    document.body.appendChild(root);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }

  window.Renovebot = {
    open: openChat,
    close: closeChat,
    toggle: toggleChat,
    openWithToken: function (token) { openChat(token); },
  };
})();
