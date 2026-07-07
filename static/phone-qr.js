// phone-qr.js — render QR codes into `.phone-qr[data-qr]` elements on the
// Manage page's Phone-usage card. Uses the vendored (MIT) qrcode-generator
// library loaded as the global `qrcode`; no CDN, no server dependency.
//
// Two QRs are drawn: the public APK download URL, and (only in the once-only
// token-reveal path) a todopup://config deep link carrying endpoint + token.
// We draw to a <canvas> with a white quiet-zone box + near-black modules for
// reliable scanning, framed by the themed border on the container via CSS.
(function () {
  "use strict";

  var CELL = 4;   // px per module
  var MARGIN = 4; // quiet-zone modules (QR spec minimum)

  function draw(el) {
    var text = el.getAttribute("data-qr");
    if (!text || typeof qrcode === "undefined") return;

    var qr;
    try {
      qr = qrcode(0, "M"); // typeNumber 0 = auto-size to fit the data
      qr.addData(text);
      qr.make();
    } catch (e) {
      el.textContent = "QR unavailable";
      return;
    }

    var count = qr.getModuleCount();
    var size = (count + MARGIN * 2) * CELL;

    var canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext("2d");

    // White background (includes the quiet zone) for scannability.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = "#161310"; // near-black modules
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect(
            (c + MARGIN) * CELL,
            (r + MARGIN) * CELL,
            CELL, CELL
          );
        }
      }
    }

    el.textContent = "";
    el.appendChild(canvas);
  }

  function init() {
    var els = document.querySelectorAll(".phone-qr[data-qr]");
    for (var i = 0; i < els.length; i++) draw(els[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
