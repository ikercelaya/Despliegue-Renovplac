(function () {
  if (window.__renovebotLoaded) return;
  window.__renovebotLoaded = true;

  var script = document.currentScript;
  var base =
    (script && script.dataset && script.dataset.baseUrl) ||
    (script && script.src ? script.src.replace(/\/widget\.js.*$/, "") : "");

  var style = document.createElement("style");
  style.textContent =
    ".rb-root{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;}" +
    ".rb-launcher-row{display:flex;align-items:center;gap:12px;}" +
    ".rb-bubble-tip{background:#ffffff;color:#0a1428;border-radius:18px;padding:10px 16px;box-shadow:0 10px 28px rgba(10,20,40,0.18);cursor:pointer;display:flex;flex-direction:column;align-items:flex-start;gap:2px;max-width:240px;position:relative;animation:rbFadeIn 0.35s ease-out;}" +
    ".rb-bubble-tip.rb-hidden{display:none;}" +
    ".rb-bubble-tip::after{content:'';position:absolute;right:-7px;top:50%;transform:translateY(-50%);border:7px solid transparent;border-left-color:#ffffff;}" +
    ".rb-bubble-tip .rb-name{font-size:13px;font-weight:700;color:#0a1428;display:flex;align-items:center;gap:6px;}" +
    ".rb-bubble-tip .rb-status-dot{width:8px;height:8px;border-radius:50%;background:#2fd07f;display:inline-block;box-shadow:0 0 0 3px rgba(47,208,127,0.25);}" +
    ".rb-bubble-tip .rb-msg{font-size:13px;color:#3a4554;line-height:1.3;}" +
    ".rb-launcher{position:relative;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#ff8c1a 0%,#ff4d1a 100%);color:#ffffff;border:0;cursor:pointer;box-shadow:0 10px 28px rgba(255,77,26,0.45);display:flex;align-items:center;justify-content:center;transition:transform 0.18s ease;padding:0;}" +
    ".rb-launcher:hover{transform:scale(1.06);}" +
    ".rb-launcher svg{width:38px;height:38px;}" +
    ".rb-launcher .rb-pulse{position:absolute;inset:0;border-radius:50%;border:3px solid #ff7821;opacity:0.55;animation:rbPulse 2s ease-out infinite;pointer-events:none;}" +
    ".rb-launcher.rb-open-state .rb-icon-bot{display:none;}" +
    ".rb-launcher.rb-open-state .rb-pulse{display:none;}" +
    ".rb-launcher .rb-icon-close{display:none;}" +
    ".rb-launcher.rb-open-state .rb-icon-close{display:block;}" +
    ".rb-frame-wrap{width:min(420px,calc(100vw - 40px));height:min(640px,calc(100vh - 120px));border-radius:16px;overflow:hidden;box-shadow:0 22px 50px rgba(10,20,40,0.3);background:#fff;display:none;}" +
    ".rb-frame-wrap.rb-open{display:block;}" +
    ".rb-frame-wrap iframe{width:100%;height:100%;border:0;display:block;}" +
    "@keyframes rbFadeIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}" +
    "@keyframes rbPulse{0%{transform:scale(1);opacity:0.55;}100%{transform:scale(1.45);opacity:0;}}" +
    "@media (max-width:520px){.rb-frame-wrap{position:fixed;right:0;bottom:0;left:0;top:0;width:100vw;height:100vh;border-radius:0;}.rb-root{right:14px;bottom:14px;}.rb-bubble-tip{max-width:200px;}}";
  document.head.appendChild(style);

  var BOT_SVG = '<svg class="rb-icon-bot" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<line x1="32" y1="6" x2="32" y2="11" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>' +
    '<circle cx="32" cy="5" r="2.5" fill="#ffffff"/>' +
    '<path d="M14 17 Q14 11 20 11 L44 11 Q50 11 50 17 L50 44 Q50 50 44 50 L28 50 L19 58 L21 50 Q14 50 14 44 Z" fill="#ffffff"/>' +
    '<circle cx="25" cy="28" r="3.4" fill="#ff5722"/>' +
    '<circle cx="39" cy="28" r="3.4" fill="#ff5722"/>' +
    '<circle cx="26" cy="27" r="1" fill="#ffffff"/>' +
    '<circle cx="40" cy="27" r="1" fill="#ffffff"/>' +
    '<path d="M24 36 Q32 42 40 36" stroke="#ff5722" stroke-width="2.5" fill="none" stroke-linecap="round"/>' +
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
    btn.classList.add("rb-open-state");
    tip.classList.add("rb-hidden");
  }
  function closeChat() {
    wrap.classList.remove("rb-open");
    btn.classList.remove("rb-open-state");
    tip.classList.remove("rb-hidden");
  }
  function toggleChat() {
    if (wrap.classList.contains("rb-open")) closeChat();
    else openChat();
  }

  btn.addEventListener("click", toggleChat);
  tip.addEventListener("click", function () { openChat(); });

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