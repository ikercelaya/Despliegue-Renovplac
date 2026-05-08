(function () {
  if (window.__renovebotLoaded) return;
  window.__renovebotLoaded = true;

  var script = document.currentScript;
  var base =
    (script && script.dataset && script.dataset.baseUrl) ||
    (script && script.src ? script.src.replace(/\/widget\.js.*$/, "") : "");

  var style = document.createElement("style");
  style.textContent =
    ".rb-launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:60px;height:60px;border-radius:50%;background:#143c32;color:#fff;border:0;font-size:28px;font-weight:700;cursor:pointer;box-shadow:0 8px 24px rgba(20,35,28,0.3);display:flex;align-items:center;justify-content:center;}" +
    ".rb-launcher:hover{transform:scale(1.05);}" +
    ".rb-frame-wrap{position:fixed;right:20px;bottom:90px;z-index:2147483000;width:min(420px,calc(100vw - 40px));height:min(640px,calc(100vh - 120px));border-radius:12px;overflow:hidden;box-shadow:0 18px 50px rgba(20,35,28,0.25);background:#fff;display:none;}" +
    ".rb-frame-wrap.rb-open{display:block;}" +
    ".rb-frame-wrap iframe{width:100%;height:100%;border:0;display:block;}" +
    "@media (max-width:520px){.rb-frame-wrap{right:0;bottom:0;width:100vw;height:100vh;border-radius:0;}}";
  document.head.appendChild(style);

  var btn = document.createElement("button");
  btn.className = "rb-launcher";
  btn.setAttribute("aria-label", "Abrir chat con Renovebot");
  btn.textContent = "R";

  var wrap = document.createElement("div");
  wrap.className = "rb-frame-wrap";
  var iframe = document.createElement("iframe");
  iframe.title = "Chat con Renovebot";
  iframe.src = base + "/";
  wrap.appendChild(iframe);

  btn.addEventListener("click", function () {
    wrap.classList.toggle("rb-open");
  });

  function attach() {
    document.body.appendChild(btn);
    document.body.appendChild(wrap);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach);
  } else {
    attach();
  }
})();
