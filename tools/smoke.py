"""Headless smoke test for Odo.

    python tools/smoke.py                      does the app load without errors
    python tools/smoke.py "<js expression>"    and what does this evaluate to

The expression runs inside the loaded app. Call __load() first and the real
backup is read in and brought up to date exactly as start-up does, so anything
measured here is measured against the recorded drives rather than an empty
store:

    python tools/smoke.py "(function(){__load();return territory().km2})()"

There is no node on this machine, so the only real JavaScript engine available
is Edge. This builds a copy of index.html next to app.js (relative paths have
to resolve), traps every error the page raises into the DOM, dumps the DOM and
reports what broke. Leaflet is stubbed out because file:// has no network.

It needs odo-backup-*.json.gz in the repo root for __load(); without one the
plain no-argument check still works.
"""
import os, re, subprocess, sys, io, json, tempfile

EDGE = next((p for p in [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
] if os.path.exists(p)), None)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "_smoke.html")

probe = sys.argv[1] if len(sys.argv) > 1 else ""

trap = """
<script>
window.__err=[];
window.onerror=function(m,s,l,c){window.__err.push(m+' @'+(s||'').split('/').pop()+':'+l+':'+c);};
window.addEventListener('unhandledrejection',function(e){
  window.__err.push('promise: '+(e.reason&&e.reason.message||e.reason));});
var L={map:function(){return {setView:function(){return this},on:function(){return this},
  addLayer:function(){return this},removeLayer:function(){return this},
  fitBounds:function(){return this},invalidateSize:function(){return this},
  getZoom:function(){return 13},getBounds:function(){return {getNorth:function(){return 51},
  getSouth:function(){return 50},getEast:function(){return 6},getWest:function(){return 5}}},
  removeControl:function(){return this},addControl:function(){return this},
  latLngToContainerPoint:function(){return {x:0,y:0}},getContainer:function(){return document.createElement('div')}}},
  tileLayer:function(){return {addTo:function(){return this},remove:function(){}}},
  polyline:function(){return {addTo:function(){return this},remove:function(){},
    setLatLngs:function(){return this},getBounds:function(){return {isValid:function(){return false}}},
    setStyle:function(){return this},bringToFront:function(){return this}}},
  circleMarker:function(){return {addTo:function(){return this},remove:function(){},
    setLatLng:function(){return this},setStyle:function(){return this}}},
  marker:function(){return {addTo:function(){return this},remove:function(){},
    setLatLng:function(){return this},bindTooltip:function(){return this}}},
  rectangle:function(){return {addTo:function(){return this},remove:function(){},
    setStyle:function(){return this}}},
  layerGroup:function(){return {addTo:function(){return this},remove:function(){},
    clearLayers:function(){return this},addLayer:function(){return this}}},
  divIcon:function(){return {}}, latLngBounds:function(){return {extend:function(){return this},
    isValid:function(){return true},pad:function(){return this}}},
  latLng:function(a,b){return {lat:a,lng:b}},
  control:{attribution:function(){return {addTo:function(){return this}}}},
  Icon:{Default:{prototype:{}}}, DomUtil:{create:function(t){return document.createElement(t||'div')}},
  DomEvent:{disableClickPropagation:function(){},disableScrollPropagation:function(){}},
  Util:{}};
</script>
"""

report = """
<script>
/* Loads the real backup into the running app so a probe can be measured
   against the 66 recorded drives rather than against an empty store. */
function __load(){
  var x=new XMLHttpRequest();
  x.open('GET','_smoke_data.json',false);
  x.send(null);
  var d=JSON.parse(x.responseText);
  drives=d.drives; cars=d.cars; settings=d.settings;
  /* the same backfill start-up runs, or a drive is measured here with fields
     the phone would have filled in and this page would not */
  migrateDrives();
  markPbs();
  coverCache=null;roadCache=null;shapeCache=null;routeElevCache=null;
  borderCache=null;fogCache=null;regionCache=null;regionNameCache=null;terrCache=null;
  return drives.length;
}
window.addEventListener('load',function(){
  setTimeout(function(){
    var out={errors:window.__err,probe:null,probeErr:null};
    var js=%s;
    if(js){ try{ out.probe=eval(js); }catch(e){ out.probeErr=String(e)+'\\n'+(e.stack||''); } }
    var pre=document.createElement('pre');
    pre.id='__smoke';
    pre.textContent='@@'+JSON.stringify(out)+'@@';
    document.body.appendChild(pre);
  },1200);
});
</script>
""" % json.dumps(probe)

DATA = os.path.join(ROOT, "_smoke_data.json")
if not os.path.exists(DATA):
    import gzip
    raw = gzip.open(os.path.join(ROOT, "odo-backup-2026-09-17.json.gz")).read()
    io.open(DATA, "wb").write(raw)

html = io.open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
html = html.replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>', trap)
# version-agnostic: the ?v= bumps on every deploy
html, n = re.subn(r'<script src="app\.js(\?v=\d+)?"></script>',
                  '<script src="app.js"></script>' + report.replace('\\', '\\\\'), html)
assert n == 1, "could not find the app.js script tag"
io.open(PAGE, "w", encoding="utf-8", newline="").write(html)

try:
    with tempfile.TemporaryDirectory() as prof:
        p = subprocess.run(
            [EDGE, "--headless=new", "--disable-gpu", "--no-sandbox",
             "--allow-file-access-from-files", "--virtual-time-budget=6000",
             "--user-data-dir=" + prof, "--dump-dom", "file:///" + PAGE.replace("\\", "/")],
            capture_output=True, text=True, timeout=180, encoding="utf-8", errors="replace")
    dom = p.stdout or ""
    m = re.search(r"@@(\{.*?\})@@", dom, re.S)
    if not m:
        print("NO REPORT — the page never got far enough to write one.")
        print("stderr tail:", (p.stderr or "")[-2000:])
        sys.exit(2)
    res = json.loads(m.group(1).replace("&quot;", '"').replace("&amp;", "&")
                     .replace("&lt;", "<").replace("&gt;", ">"))
    errs = res["errors"]
    if errs:
        print("ERRORS (%d):" % len(errs))
        for e in errs:
            print("  -", e)
    else:
        print("no page errors")
    if probe:
        if res["probeErr"]:
            print("PROBE THREW:", res["probeErr"])
        else:
            print("PROBE:", json.dumps(res["probe"], indent=1)[:4000])
    sys.exit(1 if errs or res.get("probeErr") else 0)
finally:
    if os.path.exists(PAGE):
        os.remove(PAGE)
