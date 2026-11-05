// Applies the saved or system theme before React mounts. Storage may be unavailable (private mode): fall back.
(function () {
  var theme = "dark";
  try {
    var saved = window.localStorage.getItem("loopback.theme");
    if (saved === "light" || saved === "dark") theme = saved;
    else if (window.matchMedia("(prefers-color-scheme: light)").matches) theme = "light";
  } catch { /* keep the dark default */ }
  document.documentElement.setAttribute("data-theme", theme);
})();
