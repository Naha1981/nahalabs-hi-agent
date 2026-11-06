// Light/dark theme: applies the saved choice before first paint, then wires the toggles.
(function () {
  try { if (localStorage.getItem('hi-theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); } catch (e) {}
  function sync() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.querySelectorAll('.themetoggle').forEach(function (b) { b.textContent = dark ? 'Light' : 'Dark'; });
  }
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.themetoggle').forEach(function (b) {
      b.addEventListener('click', function () {
        var el = document.documentElement, dark = el.getAttribute('data-theme') === 'dark';
        if (dark) { el.removeAttribute('data-theme'); } else { el.setAttribute('data-theme', 'dark'); }
        try { dark ? localStorage.removeItem('hi-theme') : localStorage.setItem('hi-theme', 'dark'); } catch (e) {}
        sync();
      });
    });
    sync();
  });
})();
