// "Content saved" listener for a preview page framed by a CMS editor (the idea of Optimizely's createContentSavedListener, generic and CMS-agnostic).
// The editor posts { type: "cms:content-saved", id, version } to the iframe after a save; the page reloads itself and shows the new draft.
// Zero-JS site: this tiny classic script is only added to *preview* responses (head() in app/routes/[[...path]].tsx), never to published pages.
// Origins: the page's own origin plus the comma-separated <meta name="cms-editor-origins" content="https://cms.example.com"> if present. Anything else is ignored.
(function (g) {
  var TYPE = "cms:content-saved";
  function create(o) {
    var t = o.target || g, origins = o.allowedOrigins;
    function on(e) {
      if (origins.indexOf(e.origin) < 0) return;
      var d = e.data;
      if (!d || typeof d !== "object" || d.type !== TYPE || typeof d.id !== "string") return;
      if (o.ids && o.ids.indexOf(d.id) < 0) return;
      (o.onSaved || function () { t.location.reload(); })(d);
    }
    t.addEventListener("message", on);
    return function () { t.removeEventListener("message", on); };
  }
  g.createContentSavedListener = create;
  if (g.document && g.location) {
    var m = g.document.querySelector('meta[name="cms-editor-origins"]');
    create({ allowedOrigins: [g.location.origin].concat(m ? m.content.split(",").map(function (s) { return s.trim(); }) : []) });
  }
})(typeof window !== "undefined" ? window : globalThis);
