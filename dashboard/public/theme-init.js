// Applies the saved theme before first paint (external file: CSP forbids inline scripts).
try {
  var t = localStorage.getItem("envvault-theme");
  if (t === "dark" || ((!t || t === "system") && matchMedia("(prefers-color-scheme: dark)").matches)) {
    document.documentElement.classList.add("dark");
  }
} catch {}
