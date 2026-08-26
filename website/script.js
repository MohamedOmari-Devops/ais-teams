/* AIS Teams showcase site — no dependencies, no build step. */

(function () {
  "use strict";

  var root = document.documentElement;

  // ------------------------------------------------------------ theme toggle
  var themeBtn = document.getElementById("theme");
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var next = root.dataset.theme === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try {
        localStorage.setItem("ais.site.theme", next);
      } catch (e) {
        // Private mode: the choice just does not survive a reload.
      }
    });
  }

  // ------------------------------------------------------- sticky nav border
  var nav = document.getElementById("nav");
  var onScroll = function () {
    if (nav) nav.classList.toggle("is-stuck", window.scrollY > 8);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  // ---------------------------------------------------------------- mobile nav
  var burger = document.getElementById("burger");
  var drawer = document.getElementById("drawer");
  if (burger && drawer) {
    burger.addEventListener("click", function () {
      var open = drawer.classList.toggle("is-open");
      drawer.hidden = !open;
      burger.setAttribute("aria-expanded", String(open));
    });
    drawer.addEventListener("click", function (e) {
      if (e.target.tagName !== "A") return;
      drawer.classList.remove("is-open");
      drawer.hidden = true;
      burger.setAttribute("aria-expanded", "false");
    });
  }

  // --------------------------------------------------------------- copy buttons
  document.querySelectorAll(".snippet").forEach(function (snippet) {
    var button = snippet.querySelector(".snippet__copy");
    if (!button) return;
    var label = button.querySelector("span");
    var original = label ? label.textContent : "";

    button.addEventListener("click", function () {
      var text = snippet.getAttribute("data-copy") || "";
      var done = function () {
        if (!label) return;
        label.textContent = "Copied";
        setTimeout(function () {
          label.textContent = original;
        }, 1400);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else {
        fallback();
      }

      // Clipboard API needs a secure context; a file:// preview has none.
      function fallback() {
        var area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        try {
          document.execCommand("copy");
          done();
        } catch (e) {
          /* nothing else to try */
        }
        document.body.removeChild(area);
      }
    });
  });

  // ---------------------------------------------------------------- product tabs
  var tabs = document.querySelectorAll(".tab");
  var panels = document.querySelectorAll(".panel");
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      var name = tab.getAttribute("data-tab");
      tabs.forEach(function (t) {
        var on = t === tab;
        t.classList.toggle("is-on", on);
        t.setAttribute("aria-selected", String(on));
      });
      panels.forEach(function (p) {
        p.classList.toggle("is-on", p.getAttribute("data-panel") === name);
      });
    });
  });

  // ------------------------------------------------------------- reveal on scroll
  var revealables = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    revealables.forEach(function (el) {
      el.classList.add("is-in");
    });
  } else {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry, i) {
          if (!entry.isIntersecting) return;
          // A small stagger keeps a grid from popping in as one block.
          setTimeout(function () {
            entry.target.classList.add("is-in");
          }, i * 60);
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    revealables.forEach(function (el) {
      observer.observe(el);
    });
  }

  // ------------------------------------------------------------------ footer year
  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());
})();
