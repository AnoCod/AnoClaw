(function () {
  "use strict";

  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  function isVisible(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function focusBestField() {
    var selectors = [
      "input[type='search']",
      "input[placeholder*='Search' i]",
      "input[placeholder*='search' i]",
      ".search input",
      ".search",
      "textarea",
      "input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([disabled])"
    ];
    for (var i = 0; i < selectors.length; i++) {
      var items = Array.prototype.slice.call(document.querySelectorAll(selectors[i]));
      var target = items.find(function (el) { return isVisible(el) && !el.disabled && !el.readOnly; });
      if (target) {
        target.focus();
        if (typeof target.select === "function" && target.tagName !== "TEXTAREA") target.select();
        return true;
      }
    }
    return false;
  }

  function installThemeSync() {
    window.addEventListener("message", function (event) {
      if (!event.data || event.data.type !== "anoclaw:theme") return;
      document.documentElement.setAttribute("data-theme", event.data.theme || "dark");
      if (event.data.accent) document.documentElement.setAttribute("data-accent", event.data.accent);
    });
  }

  function installKeys() {
    document.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        if (focusBestField()) event.preventDefault();
      }
      if (event.key === "Escape") {
        var active = document.activeElement;
        if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) active.blur();
      }
    });
  }

  function installHint() {
    if (document.querySelector(".rc-kbd-hint")) return;
    var hint = document.createElement("div");
    hint.className = "rc-kbd-hint";
    hint.textContent = "Ctrl K";
    document.body.appendChild(hint);
    window.setTimeout(function () {
      document.documentElement.classList.remove("rc-plugin-ready");
    }, 2400);
  }

  ready(function () {
    document.documentElement.classList.add("rc-plugin-ready");
    document.documentElement.setAttribute("data-raycast-plugin", "true");
    installThemeSync();
    installKeys();
    installHint();
  });
})();
