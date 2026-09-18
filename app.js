/* shown in the Garage, so which code a phone is actually running is checkable
   rather than guessable */
const BUILD='2026-09-18 · naming reports itself · assets v29';

/* ============ storage ============ */
const K_DRV='odo.drives.v1', K_CAR='odo.cars.v1', K_SET='odo.settings.v1';
async function load(key,fallback){
  if(window.storage){try{const r=await window.storage.get(key);if(r)return JSON.parse(r.value)}catch(e){}}
  try{const v=localStorage.getItem(key);if(v)return JSON.parse(v)}catch(e){}
  return fallback;
}
async function save(key,val){
  if(window.storage){try{await window.storage.set(key,JSON.stringify(val));return}catch(e){}}
  try{localStorage.setItem(key,JSON.stringify(val))}
  catch(e){toast('Storage full — export a backup and delete old drives.')}
}
let drives=[], cars=[], settings={activeCar:null,routeNames:{}};
const $=id=>document.getElementById(id);

/* ============ twistiness ============ */
function bearing(a,b,c,d){
  const p=Math.PI/180,y=Math.sin((d-b)*p)*Math.cos(c*p);
  const x=Math.cos(a*p)*Math.sin(c*p)-Math.sin(a*p)*Math.cos(c*p)*Math.cos((d-b)*p);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}
/* Heading change per kilometre, and the same trap cleanGain() sidesteps for
   altitude: adding up every wobble turns noise into signal. Two fixes a second
   apart sit about 15 m apart, and a phone scatters by 10 m or more, so bearings
   between neighbouring fixes are mostly error. Worse, the error is rectified —
   |turn| is never negative, so it can only ever add. A dead straight road was
   measuring 1370°/km, and after the baseline was widened it still read 180°/km
   at realistic scatter, because widening shrinks the wobble without removing
   the bias.

   So: smooth the track over a window of road, take headings between anchors a
   fixed distance apart, and bank a swing only once it has held its direction
   past TWIST_HYST — wobble that doubles back is discarded rather than counted,
   exactly as cleanGain() refuses to bank a climb until it has held. Distances
   are in metres, not fixes, so a slow run and a fast run agree.

   Tuned against tracks of known curvature at 4–20 m of scatter: a straight road
   reads 0–2 where the old code read 1370, a 1200 m sweep 49 against 48 true, a
   sweeping B-road 80 against 85, hairpins 468 against 480. Roads that bend
   tighter than the smoothing window read low but stay clearly serpentine. */
const TWIST_SMOOTH=100;  // m either side of a point that is averaged into it
const TWIST_STEP=100;    // m between the anchors a heading is measured across
const TWIST_HYST=25;     // ° a swing must hold before it counts as a bend
const TWIST_MIN_KMH=25;  // below this it is a car park, not a road

/* running mean of position over ±win metres of travelled path */
function smoothPath(pts,win){
  const n=pts.length,cum=[0];
  for(let i=1;i<n;i++)cum.push(cum[i-1]+hav(pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1]));
  const out=[];
  let lo=0,hi=0;
  for(let i=0;i<n;i++){
    while(cum[i]-cum[lo]>win)lo++;
    while(hi<n-1&&cum[hi+1]-cum[i]<=win)hi++;
    let la=0,ln=0,c=0;
    for(let j=lo;j<=hi;j++){la+=pts[j][0];ln+=pts[j][1];c++}
    out.push([la/c,ln/c,pts[i][2],pts[i][3],pts[i][4]]);
  }
  return out;
}
/* total turning in a run of unwrapped headings, counting a swing only once it
   has held its direction past H, so a wobble that reverses is never banked */
function swings(h,H){
  if(!h||h.length<2)return 0;
  let total=0,anchor=h[0],ext=h[0],dir=0;
  for(let i=1;i<h.length;i++){
    const v=h[i];
    if(dir===0){
      if(Math.abs(v-anchor)>Math.abs(ext-anchor))ext=v;
      if(Math.abs(ext-anchor)>H)dir=ext>anchor?1:-1;
    }else if(dir>0){
      if(v>ext)ext=v;
      else if(ext-v>H){total+=ext-anchor;anchor=ext;ext=v;dir=-1}   // turned back
    }else{
      if(v<ext)ext=v;
      else if(v-ext>H){total+=anchor-ext;anchor=ext;ext=v;dir=1}
    }
  }
  if(dir>0&&ext-anchor>H)total+=ext-anchor;
  if(dir<0&&anchor-ext>H)total+=anchor-ext;
  return total;
}
/* degrees of heading change per kilometre */
function twistOf(pts){
  if(!pts||pts.length<6)return null;
  const p=smoothPath(pts,TWIST_SMOOTH);
  let metres=0,anchor=null,acc=0,prev=null,cur=0;
  const runs=[];let run=[];
  for(let i=1;i<p.length;i++){
    const d=hav(p[i-1][0],p[i-1][1],p[i][0],p[i][1]);
    // imported tracks carry no speed, so fall back to the clock
    const dt=(p[i][2]-p[i-1][2])/1000;
    let spd=p[i][3];
    if(!(spd>0)&&dt>0)spd=d/dt*3.6;
    // a crawl breaks the run: no bearing is drawn across a car park
    if(!(spd>=TWIST_MIN_KMH)){
      if(run.length>1)runs.push(run);
      run=[];anchor=null;prev=null;acc=0;continue;
    }
    if(anchor==null)anchor=p[i-1];
    acc+=d;
    if(acc<TWIST_STEP)continue;
    const br=bearing(anchor[0],anchor[1],p[i][0],p[i][1]);
    if(prev==null)cur=br;                      // unwrap so a run reads continuously
    else{let dd=br-prev;while(dd>180)dd-=360;while(dd<-180)dd+=360;cur+=dd}
    run.push(cur);
    metres+=acc;                               // turning and distance always agree
    prev=br;anchor=p[i];acc=0;
  }
  if(run.length>1)runs.push(run);
  if(metres<800)return null;
  const deg=runs.reduce((a,r)=>a+swings(r,TWIST_HYST),0);
  return +(deg/(metres/1000)).toFixed(1);
}

function twistLabel(t){
  if(t==null)return '–';
  return t>=220?'serpentine':t>=140?'twisty':t>=80?'flowing':t>=40?'gentle':'straight';
}

/* ============ g from gps ============
   A phone that reports no devicemotion still records where it was and how
   fast it was going, and both axes of acceleration fall out of that.
   Longitudinal is the change in recorded speed over time. Lateral is how
   quickly the heading turns multiplied by the speed — the v*omega form of
   v^2/r, which beats fitting a circle through three scattered fixes.

   The trap twistOf() documents applies here too: neighbouring fixes are
   mostly error, and taking a magnitude rectifies it so it can only ever add.
   So a sample is thrown away unless the car is properly moving, both legs are
   long enough for the bearing to mean anything, and the timing is sane. A
   dropout leaves two distant fixes many seconds apart, and is skipped rather
   than read as one enormous slow corner. */
const GG_MINSPD=20/3.6, GG_MINLEG=10, GG_MAXDT=4, GG_CAP=1.4;
/* Smoothness comes from the spread of the acceleration itself, not from
   counting threshold crossings. Measured over 66 real drives, the 95th
   percentile of |a| within a drive runs from 0.081 g to 0.226 g, and the
   99th never passed 0.444 g. The old 0.35 g threshold, inherited from the
   motion sensor, therefore sat above the 99th percentile of every single
   drive: nothing ever tripped it and every drive scored 100.
   These two anchors are physical rather than fitted to one driver. A 95th
   percentile of 0.075 g is genuinely serene; 0.30 g is firm input most of
   the time. Across those 66 drives they spread the scores 33 to 97 with a
   median of 61, which is the discrimination the old count never had. */
const GG_SERENE=.075, GG_BUSY=.30;
/* Coordinates are stored to five decimals, about 1.1 m, and a bearing taken
   over a 13 m leg inherits roughly 5 degrees of that rounding. It works out at
   about 0.15 g of scatter on every single sample, whatever the speed. The
   average rides over it, but a peak taken sample by sample lands on the worst
   excursion instead of the hardest corner: tested against noise-free arcs it
   read 11-59% high. Averaged over five samples, about five seconds, the same
   test lands within 1.4-7.6%, and a long brake is untouched because the
   longitudinal figure never had the problem. */
const GG_WIN=5, GG_JWIN=3;
function ggSmooth(s,w){
  const h=(w||GG_WIN)>>1, out=[];
  for(let i=0;i<s.length;i++){
    let a=0,b=0,c=0;
    for(let j=Math.max(0,i-h),e=Math.min(s.length,i+h+1);j<e;j++){a+=s[j][0];b+=s[j][1];c++}
    out.push([a/c,b/c,s[i][2],s[i][3]]);
  }
  return out;
}

function ggPoints(d){
  const p=d&&d.pts, out=[];
  if(!p||p.length<3)return out;
  for(let i=1;i<p.length-1;i++){
    const dtA=p[i][2]-p[i-1][2], dtB=p[i+1][2]-p[i][2];
    if(dtA<=0||dtB<=0||dtA>GG_MAXDT||dtB>GG_MAXDT)continue;
    const v0=p[i-1][3]/3.6, v1=p[i][3]/3.6, v2=p[i+1][3]/3.6;
    if(v1<GG_MINSPD)continue;
    if(hav(p[i-1][0],p[i-1][1],p[i][0],p[i][1])<GG_MINLEG)continue;
    if(hav(p[i][0],p[i][1],p[i+1][0],p[i+1][1])<GG_MINLEG)continue;
    let db=bearing(p[i][0],p[i][1],p[i+1][0],p[i+1][1])-
           bearing(p[i-1][0],p[i-1][1],p[i][0],p[i][1]);
    if(db>180)db-=360; else if(db<-180)db+=360;
    const lat=v1*(db*Math.PI/180)/((dtA+dtB)/2)/9.81;
    const lon=(v2-v0)/(dtA+dtB)/9.81;
    if(!isFinite(lat)||!isFinite(lon))continue;
    if(Math.abs(lat)>GG_CAP||Math.abs(lon)>GG_CAP)continue;
    out.push([+lat.toFixed(3),+lon.toFixed(3),p[i][3],p[i][2]]);
  }
  return out;
}
/* peak combined g, and a jolt count on the footing the sensor uses: one event
   however long it lasts, so a long hard brake is not a hundred separate jolts */
function ggOf(d){
  const raw=ggPoints(d);
  if(raw.length<12)return null;
  let peak=0;
  for(const q of ggSmooth(raw,GG_WIN)){
    const m=Math.hypot(q[0],q[1]);
    if(m>peak)peak=m;
  }
  /* The score reads a narrower window than the peak does. Five samples is
     about five seconds, enough to flatten a three-second brake; three keeps
     it while still cutting per-sample scatter from 0.15 g to 0.087 g. */
  const mags=ggSmooth(raw,GG_JWIN).map(q=>Math.hypot(q[0],q[1])).sort((a,b)=>a-b);
  const p95=mags[Math.min(mags.length-1,Math.floor(mags.length*.95))];
  const smooth=Math.max(0,Math.min(100,Math.round(
    100-(p95-GG_SERENE)/(GG_BUSY-GG_SERENE)*100)));
  return {g:+peak.toFixed(2),smooth,p95:+p95.toFixed(3),n:raw.length};
}
/* a real sensor reading wins where there is one; gps fills in where there is not */
function gOf(d){return d.g!=null?d.g:(d.gGps!=null?d.gGps:null)}
function smoothOf(d){return d.smooth!=null?d.smooth:(d.smoothGps!=null?d.smoothGps:null)}
function gFromGps(d){return d.g==null&&d.gGps!=null}

/* ============ maths ============ */
const R=6371000;
function hav(a,b,c,d){
  const p=Math.PI/180,dla=(c-a)*p,dlo=(d-b)*p;
  const x=Math.sin(dla/2)**2+Math.cos(a*p)*Math.cos(c*p)*Math.sin(dlo/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}
const km=m=>m/1000;
function hms(s){s=Math.round(s);const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;
  return h?h+':'+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0')
          :m+':'+String(x).padStart(2,'0')}
function mins(s){return Math.round(s/60)+'′'}
function median(a){if(!a.length)return 0;const s=a.slice().sort((x,y)=>x-y);const m=s.length>>1;
  return s.length%2?s[m]:(s[m-1]+s[m])/2}
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('on');
  clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('on'),2800)}
function dayKey(ts){const d=new Date(ts);return d.getFullYear()+'-'+d.getMonth()+'-'+d.getDate()}
function driveName(ts){const h=new Date(ts).getHours();
  return h<6?'Night drive':h<10?'Morning run':h<12?'Late morning':h<14?'Midday drive'
        :h<17?'Afternoon drive':h<20?'Evening drive':'Late drive'}
function fmtDate(ts){return new Date(ts).toLocaleDateString(undefined,{day:'numeric',month:'short'})
  +' · '+new Date(ts).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}
function clock(ts){return new Date(ts).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}
function smoothness(events,secs){
  const perMin=events/Math.max(secs/60,.5);
  return Math.max(0,Math.min(100,Math.round(100-perMin*9)));
}
function esc(s){return String(s).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}

/* ============ xp ============ */
function driveXp(d){
  return xpBreakdown(d).reduce((a,x)=>a+x.v,0);
}
const need=n=>50*n*n;
function levelOf(xp){let n=1;while(xp>=need(n+1))n++;return n}
function streak(){
  if(!drives.length)return 0;
  const days=new Set(drives.map(d=>dayKey(d.start)));
  let n=0,cur=new Date();
  if(!days.has(dayKey(cur.getTime())))cur.setDate(cur.getDate()-1);
  while(days.has(dayKey(cur.getTime()))){n++;cur.setDate(cur.getDate()-1)}
  return n;
}

/* ============ fuel ============ */
function carOf(d){return cars.find(c=>c.id===d.carId)||null}
function fuelOf(d){
  const c=carOf(d);if(!c)return null;
  const rate=measuredL100(c)||c.l100;
  return rate? km(d.dist)*rate/100 : null}
function costOf(d){
  const c=carOf(d),l=fuelOf(d);if(!c||l==null)return null;
  const st=fuelStats(c);
  const price=(st&&st.last&&st.last.pricePerL)||c.price;
  return price? l*price : null}
function carKm(c){
  return (c.odoStart||0)+km(drives.filter(d=>d.carId===c.id).reduce((a,d)=>a+d.dist,0));
}

/* ============ places & recurring routes ============ */
const PLACE_R=280;   // metres: two endpoints this close count as the same place
function buildRoutes(){
  const places=[];
  const findPlace=(lat,lng)=>{
    for(const p of places) if(hav(p.lat,p.lng,lat,lng)<PLACE_R){p.n++;return p}
    const p={id:places.length,lat,lng,n:1};places.push(p);return p;
  };
  const sorted=drives.filter(d=>d.pts&&d.pts.length>1).sort((a,b)=>a.start-b.start);
  const map=new Map();
  sorted.forEach(d=>{
    const a=d.pts[0], b=d.pts[d.pts.length-1];
    const pa=findPlace(a[0],a[1]), pb=findPlace(b[0],b[1]);
    if(pa.id===pb.id && d.dist<1500)return;          // shuffling round the block
    const key=pa.id+'>'+pb.id;
    if(!map.has(key))map.set(key,{key,from:pa,to:pb,runs:[]});
    map.get(key).runs.push(d);
  });
  // letters by how often a place is used
  const rank=places.slice().sort((x,y)=>y.n-x.n);
  const letter=p=>{const i=rank.indexOf(p);
    return i<26?String.fromCharCode(65+i):'#'+i};
  const nameOf=p=>placeLabel(p)||letter(p);
  const out=[];
  map.forEach(r=>{
    if(r.runs.length<2)return;
    const dists=r.runs.map(d=>d.dist), md=median(dists);
    const runs=r.runs.filter(d=>Math.abs(d.dist-md)<md*0.3);   // drop detours
    if(runs.length<2)return;
    const durs=runs.map(d=>d.dur);
    out.push({
      key:r.key,
      name:settings.routeNames[r.key]||(nameOf(r.from)+' → '+nameOf(r.to)),
      runs:runs.sort((a,b)=>b.start-a.start),
      dist:md, best:Math.min(...durs), worst:Math.max(...durs),
      med:median(durs), last:runs[0].dur, lastStart:runs[0].start,
      from:r.from, to:r.to          // nameePlaces() and leaveCard() need the endpoints
    });
  });
  return out.sort((a,b)=>b.runs.length-a.runs.length);
}
/* ---------- route bests ----------
   A best time was already toasted on the way out of the car, but nothing kept
   it: no xp, no marker, no history, and the toast was lost entirely whenever
   the same drive also levelled you up. This replays each route in the order
   you drove it and flags the runs that were the quickest at the time, the way
   firstTimeSegments() does for new road. Replaying rather than comparing to
   today's best means a run you have since beaten keeps the credit it earned,
   and the result is the same however many times it runs. */
function markPbs(){
  const won=new Set();
  buildRoutes().forEach(r=>{
    let best=Infinity, seen=0;
    r.runs.slice().sort((a,b)=>a.start-b.start).forEach(d=>{
      if(seen>=2&&d.dur<best)won.add(d.id);   // two earlier runs to beat
      if(d.dur<best)best=d.dur;
      seen++;
    });
  });
  let changed=false;
  drives.forEach(d=>{
    const v=won.has(d.id);
    if(!!d.pb!==v){d.pb=v;changed=true}
  });
  return changed;
}

function bestWindow(runs){
  const buck=new Map();
  runs.forEach(d=>{
    const t=new Date(d.start), b=Math.floor((t.getHours()*60+t.getMinutes())/15);
    if(!buck.has(b))buck.set(b,[]);
    buck.get(b).push(d.dur);
  });
  let best=null;
  buck.forEach((v,b)=>{
    if(v.length<2)return;
    const m=median(v);
    if(!best||m<best.med)best={b,med:m,n:v.length};
  });
  if(!best)return null;
  const h=Math.floor(best.b/4), m=(best.b%4)*15;
  return {label:String(h).padStart(2,'0')+':'+String(m).padStart(2,'0'),med:best.med,n:best.n};
}

/* ============ coverage ============ */
const CELL=100;                       // metres
let coverCache=null;
function cellKey(lat,lng){
  const dLat=CELL/111320, dLng=CELL/(111320*Math.cos(lat*Math.PI/180));
  return Math.round(lat/dLat)+':'+Math.round(lng/dLng);
}
function coverage(){
  if(coverCache)return coverCache;
  const cells=new Map();
  drives.forEach(d=>{
    if(!d.pts)return;
    for(let i=0;i<d.pts.length;i++){
      const p=d.pts[i];
      cells.set(cellKey(p[0],p[1]),(cells.get(cellKey(p[0],p[1]))||0)+1);
      if(i){ // fill the gap so fast stretches don't leave holes
        const q=d.pts[i-1], gap=hav(q[0],q[1],p[0],p[1]);
        const steps=Math.min(60,Math.floor(gap/60));
        for(let s=1;s<steps;s++){
          const f=s/steps, la=q[0]+(p[0]-q[0])*f, lo=q[1]+(p[1]-q[1])*f;
          const k=cellKey(la,lo);
          cells.set(k,(cells.get(k)||0)+1);
        }
      }
    }
  });
  coverCache={cells,unique:cells.size};
  return coverCache;
}

/* ============ odometer ============ */
function drawOdo(kmTotal){
  const box=$('odo');
  const whole=Math.floor(kmTotal), tenth=Math.floor((kmTotal-whole)*10);
  const digits=String(whole).padStart(5,'0').slice(-5).split('').concat([String(tenth)]);
  if(box.children.length!==6){
    box.innerHTML='';
    digits.forEach((_,i)=>{
      const c=document.createElement('div');
      c.className='cell'+(i===5?' tenths':'');
      const r=document.createElement('div');r.className='roll';
      for(let n=0;n<=10;n++){const s=document.createElement('i');s.textContent=n%10;r.appendChild(s)}
      c.appendChild(r);box.appendChild(c);
    });
  }
  digits.forEach((d,i)=>{
    box.children[i].querySelector('.roll').style.transform='translateY(-'+(Number(d)*52)+'px)';
  });
}

/* ============ route glyph ============ */
function speedColor(kmh){
  const t=Math.max(0,Math.min(1,kmh/130));
  const stops=[[0,'#4E86A8'],[.35,'#7FA05F'],[.7,'#E8A33D'],[1,'#D2402A']];
  for(let i=1;i<stops.length;i++){
    if(t<=stops[i][0]){
      const a=stops[i-1],b=stops[i],f=(t-a[0])/(b[0]-a[0]);
      const px=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16));
      const A=px(a[1]),B=px(b[1]);
      return 'rgb('+A.map((v,j)=>Math.round(v+(B[j]-v)*f)).join(',')+')';
    }
  }
  return '#D2402A';
}
function glyph(pts,o){
  const g=Object.assign({w:62,h:40,pad:8,n:60,dot:2.6,cls:'glyph'},o||{});
  const W=g.w,H=g.h;
  const head='<svg class="'+g.cls+'" viewBox="0 0 '+W+' '+H+'">';
  if(!pts||pts.length<2)return head+'</svg>';
  const step=Math.max(1,Math.floor(pts.length/g.n));
  const p=pts.filter((_,i)=>i%step===0||i===pts.length-1);
  const la=p.map(x=>x[0]),lo=p.map(x=>x[1]);
  const y0=Math.min(...la),y1=Math.max(...la),x0=Math.min(...lo),x1=Math.max(...lo);
  const mid=(y0+y1)/2*Math.PI/180;
  const w=Math.max((x1-x0)*Math.cos(mid),1e-6),h=Math.max(y1-y0,1e-6);
  const s=Math.min((W-g.pad)/w,(H-g.pad)/h), ox=(W-w*s)/2, oy=(H-h*s)/2;
  const xy=q=>[ox+(q[1]-x0)*Math.cos(mid)*s, H-oy-(q[0]-y0)*s];
  let segs='';
  for(let i=1;i<p.length;i++){
    const a=xy(p[i-1]),b=xy(p[i]);
    segs+='<path d="M'+a[0].toFixed(1)+' '+a[1].toFixed(1)+'L'+b[0].toFixed(1)+' '+b[1].toFixed(1)+
          '" stroke="'+speedColor(p[i][3]||0)+'"/>';
  }
  const e=xy(p[p.length-1]);
  return head+segs+
    '<circle cx="'+e[0].toFixed(1)+'" cy="'+e[1].toFixed(1)+'" r="'+g.dot+'"/></svg>';
}

/* ============ perspective ============ */
const REFS=[
  {km:4.259,  t:'the Zandvoort circuit'},
  {km:13.626, t:'the Le Mans Circuit de la Sarthe'},
  {km:20.832, t:'the Nürburgring Nordschleife'},
  {km:60.725, t:'the Isle of Man TT Mountain Course'},
  {km:106,    t:'the A2 down to Maastricht'},
  {km:435,    t:'the drive from Eindhoven to Paris'},
  {km:1300,   t:'the run through the Alps to Milan'},
  {km:3130,   t:'every motorway in the Netherlands'},
  {km:3940,   t:'Route 66, end to end'},
  {km:10600,  t:'a crossing of the Sahara'},
  {km:21196,  t:'the Great Wall of China'},
  {km:40075,  t:'a lap of the Earth, round the equator'},
  {km:384400, t:'the drive to the Moon'}
];
function pct(x){return x>=100?Math.round(x)+'×':x>=10?x.toFixed(1)+'×':Math.round(x*100)+'%'}
function prow(x,label,note){
  const done=x>=1;
  return '<div class="pr'+(done?' done':'')+'"><div class="pr-top">'+
    '<div class="pr-t"><b>'+pct(x)+'</b>'+label+'</div><div class="pr-n">'+note+'</div></div>'+
    '<div class="pr-bar"><i style="width:'+Math.min(100,x*100).toFixed(1)+'%"></i></div></div>';
}
function renderPersp(totKm,hours,climb,topKmh,litres,cost){
  $('scaleKm').textContent=Math.round(totKm).toLocaleString();
  $('persp').innerHTML=REFS.map(r=>{
    const x=totKm/r.km;
    const note=x>=1?Math.floor(x)+'× done · '+r.km.toLocaleString()+' km each'
      :(r.km-totKm).toLocaleString(undefined,{maximumFractionDigits:0})+' km to go';
    return prow(x,' of '+r.t,note);
  }).join('');
  const m=[];
  m.push(prow(hours/24,' of a full Le Mans, sat at the wheel',hours.toFixed(1)+' h logged'));
  if(climb>0){
    m.push(prow(climb/8849,' of the height of Everest, climbed by road',Math.round(climb).toLocaleString()+' m'));
    m.push(prow(climb/1071,' of the climb up Alpe d’Huez',Math.round(climb).toLocaleString()+' m'));
  }
  if(topKmh>0){
    m.push(prow(topKmh/305,' of a Bugatti Chiron flat out',topKmh+' km/h best'));
    m.push(prow(topKmh/1227,' of the speed of sound',topKmh+' km/h best'));
  }
  if(litres>0){
    m.push(prow(litres/150,' of a filled bathtub, in fuel',litres.toFixed(0)+' litres'));
    m.push(prow(litres*2.31/1000,' of a tonne of CO₂ out of the exhaust',
      (litres*2.31).toFixed(0)+' kg CO₂'));
  }
  if(cost>0)m.push(prow(cost/400,' of a decent set of tyres, in fuel money','€'+cost.toFixed(0)+' spent'));
  $('perspMisc').innerHTML=m.join('');
}

/* ============ the clean run ============
   The longest stretch of a drive that never provoked the accelerometer.
   Standing still provokes nothing either, so stopped time is taken out before
   the stretch is measured — otherwise a wait at a level crossing would
   out-score any real piece of driving.

   Jolts only carry a timestamp from the build that started recording them, so
   an older drive has no sensor answer. It falls back to the gps estimate,
   which is shown but never paid for: that is the same footing smoothness sits
   on, and for the same reason — there is nothing to calibrate it against. */
const COMBO_STEP=150;        // seconds of clean driving per 0.1x
const COMBO_CAP=2.0;
const COMBO_MIN=180;         // under three minutes of movement, say nothing

/* cumulative moving seconds, so a stretch is measured in driving and not in
   waiting. A gap longer than 30 s is a dropped fix rather than a stop, and
   counting it either way would be a guess, so it counts as neither. */
function movingClock(d){
  const p=d.pts||[], ts=[], cum=[];
  let run=0;
  for(let i=0;i<p.length;i++){
    if(i){
      const dt=p[i][2]-p[i-1][2];
      if(dt>0&&dt<=30&&(p[i][3]>5||p[i-1][3]>5))run+=dt;
    }
    ts.push(p[i][2]);cum.push(run);
  }
  return {ts,cum,total:run};
}
function movedBy(clk,t){
  const ts=clk.ts, cum=clk.cum;
  if(!ts.length)return 0;
  if(t<=ts[0])return 0;
  const last=ts.length-1;
  if(t>=ts[last])return cum[last];
  let lo=0,hi=last;
  while(lo+1<hi){const m=(lo+hi)>>1;if(ts[m]<=t)lo=m;else hi=m}
  const span=ts[hi]-ts[lo];
  return span>0?cum[lo]+(cum[hi]-cum[lo])*((t-ts[lo])/span):cum[lo];
}
/* gps stand-in for a drive recorded before jolt times were kept. The sensor
   arms at 3.5 m/s2 and re-arms below 2.2; this mirrors that ratio so the two
   paths at least count the same kind of event. */
function gpsJolts(d){
  const s=ggSmooth(ggPoints(d),GG_JWIN), out=[];
  let armed=false;
  for(const q of s){
    const m=Math.hypot(q[0],q[1]);
    if(m>GG_BUSY){if(!armed){out.push(q[3]);armed=true}}
    else if(m<GG_BUSY*0.63)armed=false;
  }
  return out;
}
function comboOf(d){
  if(!d||!d.pts||d.pts.length<6)return null;
  const sensor=Array.isArray(d.joltT);
  const clk=movingClock(d);
  if(clk.total<COMBO_MIN)return null;
  const js=(sensor?d.joltT:gpsJolts(d)).filter(t=>t>0&&t<d.dur).sort((a,b)=>a-b);
  const marks=[0].concat(js,[d.dur]);
  let best=0,at=0;
  for(let i=1;i<marks.length;i++){
    const run=movedBy(clk,marks[i])-movedBy(clk,marks[i-1]);
    if(run>best){best=run;at=marks[i-1]}
  }
  const mult=Math.min(COMBO_CAP,1+Math.floor(best/COMBO_STEP)/10);
  return {secs:Math.round(best),mult:+mult.toFixed(1),jolts:js.length,
          at:Math.round(at),sensor,share:best/Math.max(clk.total,1)};
}
function comboXp(cb){return cb?Math.round((cb.mult-1)*10)*6:0}

/* ============ drive grade ============
   Five things a drive can be good at, each scored 0-1 and weighted. A
   component with no data drops out and the rest are re-weighted, so a phone
   with no motion sensor is graded on what it does know rather than marked
   down for what it does not.

   Control and Commitment pull against each other on purpose: holding a high
   line smoothly is the thing worth grading, and either one alone is easy.

   These bands are a first cut and have never met your drives. gradeSpread()
   prints the distribution — if it piles everything on one letter the ladder
   is decoration, and the ramps below are what to move. */
const GRADE_BANDS=[[86,'S'],[72,'A'],[56,'B'],[38,'C'],[22,'D'],[0,'E']];
const ramp=(v,a,b)=>Math.max(0,Math.min(1,(v-a)/(b-a)));
/* Where each component reads nothing and where it reads full marks, set
   against the 66 recorded drives rather than guessed at. Each pair sits at
   roughly the 5th and 95th percentile of what those drives actually produced,
   so an ordinary drive lands in the middle of every ramp and a good one near
   the top of it:

     smoothness   36 .. 86      twist    10 .. 57 deg/km
     peak g      .19 .. .47     distance  5 .. 70 km

   Distance tops out at 55 rather than 70 because the drives are two
   clumps, a ten kilometre commute and a fifty kilometre run, and a ramp
   that reached the far end of the long ones left more than half of them
   pinned at full marks, which is a component carrying no information.

   Twist is the one worth explaining. The previous pair asked for 130 deg/km
   against a twisty-road challenge that asks 140, but no recorded drive has
   ever passed 68 and the median is under 20, so Road scored a flat zero on
   almost everything and a quarter of the grade did nothing. These roads are
   not those roads.

   Across the 66 the ladder now reads E 3, D 12, C 27, B 19, A 5, centred on
   C with the best drive at 82. S is deliberately just out of reach of
   anything driven so far. gradeSpread() reprints all of this. */
const GR_SM=[38,88];        // smoothness, 0-100
const GR_TW=[8,60];         // degrees per km
const GR_G=[.17,.48];       // peak g
const GR_KM=[3,55];         // km
const GR_NEW=14;            // most that breaking new ground can add
function gradeOf(d){
  if(!d||d.dist<1500)return null;
  const parts=[];
  const sm=smoothOf(d);
  if(sm!=null)parts.push({k:'Control',w:35,s:ramp(sm,GR_SM[0],GR_SM[1]),d:sm+'/100'});
  if(d.twist!=null)parts.push({k:'Road',w:25,s:ramp(d.twist,GR_TW[0],GR_TW[1]),
    d:Math.round(d.twist)+'°/km'});
  const g=gOf(d);
  if(g!=null)parts.push({k:'Commitment',w:25,s:ramp(g,GR_G[0],GR_G[1]),
    d:g.toFixed(2)+' g'});
  parts.push({k:'Journey',w:15,s:ramp(km(d.dist),GR_KM[0],GR_KM[1]),
    d:Math.round(km(d.dist))+' km'});
  const wsum=parts.reduce((a,p)=>a+p.w,0);
  if(!wsum)return null;
  const base=parts.reduce((a,p)=>a+p.s*p.w,0)/wsum*100;
  /* Discovery adds and never subtracts. As a weighted component it was a
     quarter of the grade that almost every drive forfeited, because almost
     every drive is down a road you have already been: a physically perfect
     run on known roads could not beat 78. Finding new road is a bonus on top
     of how you drove, not a tax on driving the same road well. */
  const newKm=(d.newCells||0)*CELL/1000;
  const bonus=ramp(newKm,0,5)*GR_NEW;
  const score=Math.round(Math.min(100,base+bonus));
  return {score,letter:GRADE_BANDS.find(b=>score>=b[0])[1],parts,
          bonus:Math.round(bonus),newKm};
}
/* What the ladder is actually doing, and the raw spread behind it, so the
   anchors above can be moved against real numbers rather than guessed at
   twice. Prints the 10th, 50th and 90th percentile of every input. */
function gradeSpread(){
  const letters={}, comp={};
  const add=(k,v)=>{(comp[k]=comp[k]||[]).push(v)};
  let n=0;
  drives.forEach(d=>{
    const g=gradeOf(d);
    if(!g)return;
    n++;
    letters[g.letter]=(letters[g.letter]||0)+1;
    g.parts.forEach(p=>add(p.k,p.s));
    add('score',g.score);
    if(smoothOf(d)!=null)add('raw smoothness',smoothOf(d));
    if(d.twist!=null)add('raw twist',d.twist);
    if(gOf(d)!=null)add('raw peak g',gOf(d));
    add('raw km',km(d.dist));
    add('raw new km',(d.newCells||0)*CELL/1000);
  });
  if(!n){console.log('No drives long enough to grade yet.');return null}
  const pct=(a,q)=>{const s=a.slice().sort((x,y)=>x-y);
    return s[Math.min(s.length-1,Math.floor(s.length*q))]};
  const out={drives:n,letters:letters,pct:{}};
  let txt='\n'+n+' drives graded\n'+
    GRADE_BANDS.map(b=>b[1]).map(L=>'  '+L+'  '+(letters[L]||0)).join('\n')+
    '\n\n                     p10      p50      p90\n';
  Object.keys(comp).forEach(k=>{
    const v=[pct(comp[k],.1),pct(comp[k],.5),pct(comp[k],.9)]
      .map(x=>+x.toFixed(3));
    out.pct[k]=v;
    txt+='  '+k.padEnd(18)+v.map(x=>String(x).padStart(8)).join('')+'\n';
  });
  console.log(txt);
  return out;
}

/* ============ car age ============
   An old car earns more: one percent per year of its age. The age is taken
   at the time of the drive rather than today, so a drive keeps the xp it
   earned instead of quietly gaining a percent every New Year — the same
   reason markPbs() replays the history rather than measuring against today's
   best.

   The boost multiplies what the drive itself earned. A streak, a weekly
   challenge and a service are not the car's doing and are left alone, which
   also keeps the Stats xp breakdown honest: the boost is one named row and
   not a thumb on every other scale.

   Two cars therefore earn at their own rates from the same wheel, which is
   the point — a 1991 car at +35% and a 2024 one at +2%. */
const AGE_PCT=0.01;
function carAgeAt(c,ts){
  if(!c||!c.year)return 0;
  const age=new Date(ts).getFullYear()-c.year;
  return age>0?age:0;
}
function ageBoost(d){
  const c=carOf(d);
  const age=carAgeAt(c,d.start);
  if(!age)return null;
  return {age,year:c.year,name:c.name,mult:1+age*AGE_PCT};
}

/* ============ route medals ============
   Distance piled onto one route, which is a different achievement from
   driving it quickly: it is the road you actually know. */
const ROUTE_MEDALS=[[100,'\u{1F949}','Bronze'],[250,'\u{1F948}','Silver'],
  [500,'\u{1F947}','Gold'],[1000,'\u{1F4A0}','Platinum'],
  [2500,'\u{1F451}','Crown'],[5000,'\u{1F3C6}','Legend']];
function routeMedal(r){
  const tot=km(r.runs.reduce((a,d)=>a+d.dist,0));
  let got=null;
  ROUTE_MEDALS.forEach(m=>{if(tot>=m[0])got=m});
  const next=ROUTE_MEDALS.find(m=>tot<m[0])||null;
  return {km:tot,medal:got,next,to:next?next[0]-tot:0};
}

/* ============ the eight borders ============
   How far out you have reached in each compass sector, measured from the
   place you set off from most often. A sector only counts past 2 km so that
   wandering round your own town cannot set a border.

   borderPushes() replays the drives in the order you made them, the way
   markPbs() and firstTimeSegments() do, so a push keeps the credit it earned
   on the day even after a later drive goes further. */
const BORDER_MIN=2000;      // metres: closer than this is not a direction
const BORDER_STEP=1000;     // metres of new ground before a push is worth xp
function borderSector(home,p){
  const far=hav(home.lat,home.lng,p[0],p[1]);
  if(far<BORDER_MIN)return null;
  return {far,i:Math.floor(((bearing(home.lat,home.lng,p[0],p[1])+22.5)%360)/45)};
}
function borders(){
  const home=homePlace();
  if(!home)return null;
  const best=COMPASS.map(()=>null);
  drives.slice().sort((a,b)=>a.start-b.start).forEach(d=>{
    (d.pts||[]).forEach(p=>{
      const s=borderSector(home,p);
      if(!s)return;
      if(!best[s.i]||s.far>best[s.i].m)
        best[s.i]={m:s.far,lat:p[0],lng:p[1],when:d.start,id:d.id};
    });
  });
  return {home,dirs:COMPASS.map((c,i)=>Object.assign({dir:c,m:0},best[i]||{}))};
}
let borderCache=null;
function borderPushes(){
  if(borderCache)return borderCache;
  const out=new Map(), home=homePlace();
  if(!home)return borderCache=out;
  const best=COMPASS.map(()=>0);
  drives.slice().sort((a,b)=>a.start-b.start).forEach(d=>{
    /* measured against where the border stood before the drive, not against
       the point before. Driving steadily outward extends the sector a few
       metres at a time, and per-point increments would score a 50 km push as
       a string of 100 m ones and pay for none of them. */
    const before=best.slice();
    (d.pts||[]).forEach(p=>{
      const s=borderSector(home,p);
      if(s&&s.far>best[s.i])best[s.i]=s.far;
    });
    let won=null;
    for(let i=0;i<COMPASS.length;i++){
      /* the first time a sector is touched there was no border to push */
      if(before[i]<=0||best[i]<=before[i])continue;
      const by=best[i]-before[i];
      if(!won||by>won.by)won={dir:COMPASS[i],by,to:best[i]};
    }
    if(won&&won.by>=BORDER_STEP)out.set(d.id,won);
  });
  return borderCache=out;
}

/* ---------- grade, medals and borders on screen ---------- */
function gradeHtml(d){
  const g=gradeOf(d), cb=comboOf(d);
  if(!g&&!cb)return '';
  let h='';
  if(g)h+='<div class="gr-top">'+
    '<div class="gr-letter gr-'+g.letter+'">'+g.letter+'</div>'+
    '<div class="gr-meta"><div class="gr-score">'+g.score+'<s>/100</s>'+
    (g.bonus?'<b class="gr-bonus">+'+g.bonus+' new road</b>':'')+'</div>'+
    '<div class="gr-bars">'+g.parts.map(p=>
      '<div class="gr-bar"><i style="width:'+Math.round(p.s*100)+'%"></i>'+
      '<span>'+p.k+'<s>'+esc(p.d)+'</s></span></div>').join('')+
    '</div></div></div>';
  if(cb)h+='<div class="gr-combo"><b>×'+cb.mult.toFixed(1)+'</b> '+
    mins(cb.secs)+' unbroken'+
    (cb.jolts?' · '+cb.jolts+' jolt'+(cb.jolts>1?'s':''):' · not one jolt')+
    (cb.sensor?'':'<s>gps</s>')+'</div>';
  return h;
}
function medalNote(md){
  if(!md.next)return ' · <b>'+Math.round(md.km).toLocaleString()+
    ' km</b> on this road — every medal taken';
  return ' · <b>'+Math.round(md.km).toLocaleString()+' km</b> on this road, '+
    Math.round(md.to).toLocaleString()+' km to '+md.next[2]+' '+md.next[1];
}
function bordersHtml(){
  const b=borders();
  if(!b)return '<div class="empty" style="border:0">'+
    'Drive a little further out and your borders appear here.</div>';
  const max=Math.max.apply(null,b.dirs.map(x=>x.m));
  if(max<=0)return '<div class="empty" style="border:0">Nothing yet more than '+
    (BORDER_MIN/1000)+' km from home.</div>';
  const S=240,C=S/2,R=C-26;
  let rings='',spokes='',labels='';
  [.33,.66,1].forEach(k=>rings+='<circle class="bd-ring" cx="'+C+'" cy="'+C+'" r="'+
    (k*R).toFixed(1)+'"/>');
  b.dirs.forEach((x,i)=>{
    const a=(i*45-90)*Math.PI/180;
    const len=x.m>0?Math.max(6,x.m/max*R):0;
    const ex=C+Math.cos(a)*len, ey=C+Math.sin(a)*len;
    const lx=C+Math.cos(a)*(R+14), ly=C+Math.sin(a)*(R+14);
    if(len){
      spokes+='<line class="bd-ray" x1="'+C+'" y1="'+C+'" x2="'+ex.toFixed(1)+
        '" y2="'+ey.toFixed(1)+'"/>'+
        '<circle class="bd-dot" cx="'+ex.toFixed(1)+'" cy="'+ey.toFixed(1)+'" r="3"/>';
    }
    labels+='<text class="bd-l" x="'+lx.toFixed(1)+'" y="'+(ly+3).toFixed(1)+
      '" text-anchor="middle">'+x.dir+'</text>';
  });
  const list=b.dirs.slice().sort((p,q)=>q.m-p.m).map(x=>
    '<div class="bd-row"><span class="k">'+dirWord(x.dir)+'</span><span class="v">'+
    (x.m?km(x.m).toFixed(1)+' km':'–')+'</span><span class="w">'+
    (x.when?new Date(x.when).toLocaleDateString(undefined,
      {month:'short',year:'numeric'}):'')+'</span></div>').join('');
  return '<div class="cap">Furthest reached in each direction, from '+
    esc(placeLabel(b.home)||'home')+' · outer ring '+km(max).toFixed(0)+' km</div>'+
    '<svg class="bd-svg" viewBox="0 0 '+S+' '+S+'">'+rings+spokes+labels+'</svg>'+
    '<div class="bd-list">'+list+'</div>';
}

/* ============ badges ============ */
const BADGES=[
  {ic:'🔑',n:'First drive',f:()=>drives.length>=1},
  {ic:'💯',n:'100 km',f:t=>t>=1e5},
  {ic:'🏔',n:'1 000 km',f:t=>t>=1e6},
  {ic:'🌍',n:'10 000 km',f:t=>t>=1e7},
  {ic:'🌙',n:'Night owl',f:()=>drives.some(d=>{const h=new Date(d.start).getHours();return h>=23||h<5})},
  {ic:'🛣',n:'100 km run',f:()=>drives.some(d=>d.dist>=1e5)},
  {ic:'🔥',n:'7 day streak',f:()=>streak()>=7},
  {ic:'🏁',n:'50 drives',f:()=>drives.length>=50},
  {ic:'🧭',n:'20 new cells',f:()=>coverage().unique>=200},
  {ic:'🔁',n:'A route ×10',f:()=>buildRoutes().some(r=>r.runs.length>=10)},
  {ic:'🪶',n:'Smooth 95',f:()=>drives.some(d=>smoothOf(d)!=null&&smoothOf(d)>=95)},
  {ic:'⛰',n:'1 000 m climbed',f:()=>drives.reduce((a,d)=>a+(gainOf(d)||0),0)>=1000}
];

/* ============ render ============ */
function render(){
  const totM=drives.reduce((a,d)=>a+d.dist,0);
  const totSec=drives.reduce((a,d)=>a+d.dur,0);
  const idleSec=drives.reduce((a,d)=>a+(d.idle||0),0);
  const climb=drives.reduce((a,d)=>a+(gainOf(d)||0),0);
  const totXp=drives.reduce((a,d)=>a+driveXp(d),0)+streak()*20+challengeXp()+bonusXp();
  const lvl=levelOf(totXp), base=need(lvl), nxt=need(lvl+1);
  const topKmh=Math.round(Math.max(0,...drives.map(d=>d.top))*3.6);
  const litres=drives.reduce((a,d)=>a+(fuelOf(d)||0),0);
  const cost=drives.reduce((a,d)=>a+(costOf(d)||0),0);

  drawOdo(km(totM));
  const ri=rankInfo(lvl);
  $('lvl').textContent=lvl;
  document.documentElement.style.setProperty('--rank',ri.col);
  const rn=$('rankName');
  if(rn)rn.innerHTML=ri.name+' <span class="tier">'+ri.roman+'</span>';
  $('xpNow').textContent=totXp.toLocaleString();
  $('xpNext').textContent=(nxt-totXp).toLocaleString()+' xp to level '+(lvl+1);
  $('xpFill').style.width=Math.max(2,Math.min(100,(totXp-base)/(nxt-base)*100))+'%';
  const pips=$('rankPips');
  if(pips)pips.innerHTML=Array.from({length:ri.tiers},(_,i)=>
    '<i class="'+(i<ri.tier?'on':'')+'"></i>').join('')+
    '<span>'+(ri.nextAt?ri.name+' '+ri.roman+' · '+(ri.nextAt-lvl)+' to '+ri.next
      :ri.name+' · top rank')+'</span>';

  $('sDrives').textContent=drives.length;
  $('sTime').innerHTML=(totSec/3600).toFixed(1)+'<s>h</s>';
  $('sTop').innerHTML=topKmh+'<s>km/h</s>';
  $('sStreak').textContent=streak();
  $('sLong').innerHTML=km(Math.max(0,...drives.map(d=>d.dist))).toFixed(1)+'<s>km</s>';
  const wk=Date.now()-6048e5;
  $('sWeek').innerHTML=km(drives.filter(d=>d.start>wk).reduce((a,d)=>a+d.dist,0)).toFixed(1)+'<s>km</s>';
  $('sClimb').innerHTML=Math.round(climb).toLocaleString()+'<s>m</s>';
  $('sIdle').innerHTML=(totSec?Math.round(idleSec/totSec*100):0)+'<s>%</s>';
  const gs=drives.map(gOf).filter(v=>v!=null);
  const sm=drives.map(smoothOf).filter(v=>v!=null);
  $('sG').innerHTML=gs.length?Math.max(...gs).toFixed(2)+'<s>g</s>':'–';
  $('sSmooth').innerHTML=sm.length?Math.round(sm.reduce((a,b)=>a+b,0)/sm.length)+'<s>/100</s>':'–';
  $('sFuel').innerHTML=litres>0?litres.toFixed(0)+'<s>L</s>':'–';
  $('sCost').innerHTML=cost>0?'€'+Math.round(cost).toLocaleString():'–';

  renderDrives();
  renderRoutes();
  renderCoverage(totM);
  renderCars();
  renderPersp(km(totM),totSec/3600,climb,topKmh,litres,cost);
  renderExtras();
  renderStats();
  renderAccel();
  renderLight();
  renderReview();
  renderRoads();
  renderNudge();
  renderLogbook();
  renderXpSources();
  $('badges').innerHTML=BADGES.map(b=>
    '<div class="badge'+(b.f(totM)?' got':'')+'"><div class="ic">'+b.ic+'</div><div class="n">'+b.n+'</div></div>'
  ).join('');
}

function renderDrives(){
  const list=$('list');
  const view=settings.driveView==='shapes'?'shapes':'list';
  document.querySelectorAll('#driveView button').forEach(b=>
    b.classList.toggle('on',b.dataset.v===view));
  if(!drives.length){
    list.innerHTML='<div class="empty">No drives yet.<br>Hit start when you pull out.</div>';return;
  }
  const sorted=drives.slice().sort((a,b)=>b.start-a.start);
  if(view==='shapes'){
    list.className='shapes';
    list.innerHTML=sorted.map(d=>
      '<button class="shape" data-id="'+d.id+'">'+
      glyph(d.pts,{w:120,h:86,pad:16,n:90,dot:3,cls:'shape-g'})+
      '<div class="shape-n">'+km(d.dist).toFixed(1)+'<s>km</s></div>'+
      '<div class="shape-d">'+fmtDate(d.start)+'</div></button>').join('');
    list.querySelectorAll('.shape').forEach(b=>b.onclick=()=>openDrive(b.dataset.id));
    return;
  }
  list.className='';
  list.innerHTML=sorted.map(d=>{
    const c=carOf(d);
    return '<button class="drive" data-id="'+d.id+'">'+glyph(d.pts)+
      '<div class="d-main"><div class="d-title">'+esc(d.name)+
      (d.pb?'<span class="tag">pb</span>':'')+
      (c?'<span class="tag">'+esc(c.name.slice(0,10))+'</span>':'')+'</div>'+
      '<div class="d-sub">'+fmtDate(d.start)+' · '+hms(d.dur)+
      (d.twist!=null?' · '+twistLabel(d.twist):'')+(d.wx?' · '+Math.round(d.wx.t)+'°':'')+'</div></div>'+
      '<div class="d-dist">'+km(d.dist).toFixed(1)+'<s>+'+driveXp(d)+' xp</s></div></button>';
  }).join('');
  list.querySelectorAll('.drive').forEach(b=>b.onclick=()=>openDrive(b.dataset.id));
}
document.querySelectorAll('#driveView button').forEach(b=>{
  b.onclick=async()=>{settings.driveView=b.dataset.v;await saveV2(K_SET,settings);renderDrives()};
});

function renderRoutes(){
  const rs=buildRoutes(), box=$('routes');
  $('rCount').textContent=rs.length?rs.length:'';
  if(!rs.length){
    box.innerHTML='<div class="empty">Nothing repeated yet.<br>Drive the same trip twice and it shows up here with your times.</div>';
    return;
  }
  box.innerHTML=rs.map(r=>{
    const w=bestWindow(r.runs), md=routeMedal(r);
    const dl=r.last-r.med, sign=dl<0?'−':'+';
    const cls=r.last<=r.best*1.02?'best':(dl>r.med*.12?'bad':'');
    return '<div class="route" data-key="'+r.key+'">'+
      '<div class="r-top"><div class="r-name">'+esc(r.name)+'</div>'+
      '<div class="r-runs">'+(md.medal?'<b class="r-medal" title="'+
        esc(md.medal[2]+' · '+Math.round(md.km)+' km on this route')+'">'+
        md.medal[1]+'</b> ':'')+r.runs.length+' runs · '+
        km(r.dist).toFixed(1)+' km</div></div>'+
      '<div class="r-times">'+
        '<div><div class="k">Last</div><div class="v '+cls+'">'+mins(r.last)+'</div></div>'+
        '<div><div class="k">Median</div><div class="v">'+mins(r.med)+'</div></div>'+
        '<div><div class="k">Best</div><div class="v best">'+mins(r.best)+'</div></div>'+
        '<div><div class="k">Worst</div><div class="v">'+mins(r.worst)+'</div></div>'+
      '</div>'+
      scatter(r)+
      '<div class="r-note">Last run <b>'+sign+Math.abs(Math.round(dl/60))+' min</b> against your median'+
      (w?' · quickest when you leave around <b>'+w.label+'</b> ('+mins(w.med)+', '+w.n+' runs)':'')+
      medalNote(md)+rainNote(r)+costNote(r)+
      '</div></div>';
  }).join('');
  box.querySelectorAll('.route').forEach(b=>b.onclick=()=>openRoute(b.dataset.key));
}
function scatter(r){
  const pts=r.runs.map(d=>{const t=new Date(d.start);
    return {x:t.getHours()*60+t.getMinutes(),y:d.dur}});
  const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);
  const x0=Math.min(...xs)-8,x1=Math.max(...xs)+8;
  const y0=Math.min(...ys)*.96,y1=Math.max(...ys)*1.04;
  const W=320,H=74,P=16;
  const px=v=>P+(v-x0)/Math.max(x1-x0,1)*(W-P*2);
  const py=v=>H-P-(v-y0)/Math.max(y1-y0,1)*(H-P*2-6);
  const best=Math.min(...ys);
  const lab=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(Math.round(m%60)).padStart(2,'0');
  return '<svg class="scatter" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'+
    '<line class="ax" x1="'+P+'" y1="'+(H-P)+'" x2="'+(W-P)+'" y2="'+(H-P)+'"/>'+
    '<line class="md" x1="'+P+'" y1="'+py(r.med).toFixed(1)+'" x2="'+(W-P)+'" y2="'+py(r.med).toFixed(1)+'"/>'+
    pts.map(p=>'<circle cx="'+px(p.x).toFixed(1)+'" cy="'+py(p.y).toFixed(1)+'" r="3.4"'+
      (p.y===best?' class="best"':'')+'/>').join('')+
    '<text x="'+P+'" y="'+(H-4)+'">'+lab(x0)+'</text>'+
    '<text x="'+(W-P)+'" y="'+(H-4)+'" text-anchor="end">'+lab(x1)+'</text>'+
    '<text x="'+P+'" y="10">departure time vs duration</text></svg>';
}
function renameRoute(key){
  const cur=settings.routeNames[key]||'';
  const v=prompt('Name this route (e.g. "Work, morning")',cur);
  if(v===null)return;
  if(v.trim())settings.routeNames[key]=v.trim().slice(0,40);
  else delete settings.routeNames[key];
  saveV2(K_SET,settings);renderRoutes();
}

function renderCoverage(totM){
  const c=coverage();
  const uKm=c.unique*CELL/1000;
  $('covKm').innerHTML=uKm.toFixed(1)+'<s>km of distinct road</s>';
  if(!drives.length){$('covT').textContent='Drive somewhere to start filling the map.';return}
  const rep=km(totM)/Math.max(uKm,.1);
  $('covT').innerHTML='You have driven <b>'+km(totM).toFixed(0)+' km</b> over <b>'+
    uKm.toFixed(0)+' km</b> of different road — every stretch <b>'+rep.toFixed(1)+
    '×</b> on average. New roads are worth more than new kilometres.';
}

/* ============ garage ============ */
function renderCars(){
  const box=$('cars');
  if(!cars.length){
    box.innerHTML='<div class="empty">No car yet.<br>Add one to track service intervals and fuel.</div>';
    return;
  }
  box.innerHTML=cars.map(c=>{
    const total=carKm(c), mine=km(drives.filter(d=>d.carId===c.id).reduce((a,d)=>a+d.dist,0));
    const svc=(c.services||[]).map(s=>{
      const due=s.lastKm+s.everyKm, left=due-total;
      const pctUsed=Math.max(0,Math.min(100,(1-left/s.everyKm)*100));
      const cls=left<=0?'due':left<=500?'soon':'';
      const txt=left<=0?'overdue by '+Math.abs(Math.round(left)).toLocaleString()+' km'
                       :Math.round(left).toLocaleString()+' km to go';
      return '<div class="svc-row"><div class="svc-top"><span class="n">'+esc(s.name)+'</span>'+
        '<span class="d '+cls+'">'+txt+'</span></div>'+
        '<div class="svc-bar"><i class="'+cls+'" style="width:'+pctUsed.toFixed(0)+'%"></i></div>'+
        '<div class="svc-act"><button class="mini" data-done="'+c.id+'|'+s.id+'">Done now</button>'+
        '<button class="mini" data-delsvc="'+c.id+'|'+s.id+'">Remove</button></div></div>';
    }).join('');
    return '<div class="card'+(settings.activeCar===c.id?' act':'')+'">'+
      '<div class="c-head"><div class="c-name">'+esc(c.name)+'</div>'+
      '<div class="c-odo">'+Math.round(total).toLocaleString()+' km</div></div>'+
      '<div class="c-meta">'+mine.toFixed(0)+' km logged here'+
      (measuredL100(c)?' · '+measuredL100(c).toFixed(1)+' L/100 km measured'
        :(c.l100?' · '+c.l100+' L/100 km estimated':''))+(c.price?' · €'+c.price+'/L':'')+
      (c.year?' · '+c.year+' · +'+
        Math.round(carAgeAt(c,Date.now())*AGE_PCT*100)+'% xp':'')+
      (settings.activeCar===c.id?' · active':'')+'</div>'+
      '<div class="svc">'+(svc||'<div class="c-meta">No service intervals set.</div>')+'</div>'+
      renderFuel(c)+
      '<div class="row" style="margin-top:10px">'+
        (settings.activeCar===c.id?'':'<button class="ghost" data-use="'+c.id+'">Use this car</button>')+
        '<button class="ghost" data-svc="'+c.id+'">Add interval</button>'+
        '<button class="ghost" data-edit="'+c.id+'">Edit</button>'+
      '</div></div>';
  }).join('');

  box.querySelectorAll('[data-use]').forEach(b=>b.onclick=async()=>{
    settings.activeCar=b.dataset.use;await saveV2(K_SET,settings);render();toast('Active car set.')});
  box.querySelectorAll('[data-svc]').forEach(b=>b.onclick=()=>addService(b.dataset.svc));
  box.querySelectorAll('[data-fill]').forEach(b=>b.onclick=()=>addFill(b.dataset.fill));
  box.querySelectorAll('[data-delfill]').forEach(b=>b.onclick=()=>{
    const [cid,fid]=b.dataset.delfill.split('|');
    if(confirm('Delete this fill-up?'))delFill(cid,fid);
  });
  box.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>editCar(b.dataset.edit));
  box.querySelectorAll('[data-done]').forEach(b=>b.onclick=async()=>{
    const [cid,sid]=b.dataset.done.split('|');
    const c=cars.find(x=>x.id===cid), s=c.services.find(x=>x.id===sid);
    const total=Math.round(carKm(c));
    const early=(s.lastKm+s.everyKm)-total>0;
    s.log=s.log||[];s.log.push({ts:Date.now(),atKm:total,early});
    s.lastKm=total;await saveV2(K_CAR,cars);render();
    toast(s.name+' done at '+total.toLocaleString()+' km · +'+(early?25:15)+' xp')});
  box.querySelectorAll('[data-delsvc]').forEach(b=>b.onclick=async()=>{
    const [cid,sid]=b.dataset.delsvc.split('|');
    const c=cars.find(x=>x.id===cid);
    c.services=c.services.filter(x=>x.id!==sid);await saveV2(K_CAR,cars);render()});
}
async function editCar(id){
  const c=id?cars.find(x=>x.id===id):null;
  const name=prompt('Car name',c?c.name:'');
  if(name===null||!name.trim())return;
  const odo=prompt('Current odometer reading in km (the real one on the dash)',c?c.odoStart:'0');
  if(odo===null)return;
  const year=prompt('Year the car was built — an older car earns '+
    Math.round(AGE_PCT*100)+'% more xp per year of age (blank to skip)',
    c&&c.year?c.year:'');
  if(year===null)return;
  const yr=Math.round(Number(year));
  const yrOk=year!==''&&isFinite(yr)&&yr>=1900&&yr<=new Date().getFullYear()+1;
  if(year!==''&&!yrOk)toast('That year looks wrong, so no age bonus was set.');
  const l100=prompt('Average fuel use, litres per 100 km (blank to skip)',c&&c.l100?c.l100:'');
  const price=prompt('Fuel price per litre in € (blank to skip)',c&&c.price?c.price:'');
  const rec={
    id:c?c.id:'c'+Date.now(),name:name.trim().slice(0,30),
    odoStart:Number(odo)||0,
    l100:l100?Number(l100)||null:null,
    price:price?Number(price)||null:null,
    year:yrOk?yr:null,
    services:c?c.services||[]:[]
  };
  if(c)Object.assign(c,rec); else cars.push(rec);
  if(!settings.activeCar){settings.activeCar=rec.id;await saveV2(K_SET,settings)}
  await saveV2(K_CAR,cars);render();toast('Saved.');
}
const SERVICE_PRESETS=[['Oil change',8000],['Oil filter',8000],['Air filter',20000],
  ['Cabin filter',20000],['Spark plugs',40000],['Brake fluid',40000],['Tyres',30000],
  ['Wash',1500],['Timing belt',100000],['APK inspection',20000]];
async function addService(cid){
  const c=cars.find(x=>x.id===cid);
  const list=SERVICE_PRESETS.map((p,i)=>(i+1)+'. '+p[0]).join('\n');
  const pick=prompt('Pick a number, or type your own name:\n\n'+list,'1');
  if(pick===null)return;
  const idx=Number(pick)-1;
  const preset=(idx>=0&&idx<SERVICE_PRESETS.length)?SERVICE_PRESETS[idx]:null;
  const name=preset?preset[0]:pick;
  if(!name||!name.trim())return;
  const every=prompt('Every how many km?',String(preset?preset[1]:8000));
  if(every===null||!Number(every))return;
  const last=prompt('Last done at which odometer reading?',String(Math.round(carKm(c))));
  if(last===null)return;
  c.services=c.services||[];
  c.services.push({id:'s'+Date.now(),name:name.trim().slice(0,28),
    everyKm:Number(every),lastKm:Number(last)||0});
  await saveV2(K_CAR,cars);render();toast('Interval added.');
}
$('btnAddCar').onclick=()=>editCar(null);
$('btnClaim').onclick=async()=>{
  if(!settings.activeCar)return toast('Add a car first.');
  const n=drives.filter(d=>!d.carId).length;
  if(!n)return toast('Every drive already has a car.');
  if(!confirm('Assign '+n+' unassigned drives to the active car?'))return;
  drives.forEach(d=>{if(!d.carId)d.carId=settings.activeCar});
  await saveV2(K_DRV,drives);render();toast(n+' drives assigned.');
};

/* ============ environment check ============ */
function diagnose(){
  const framed = window.self!==window.top;
  const secure = window.isSecureContext;
  const proto = location.protocol;
  const lines = ['origin: '+(location.origin||proto)+
    ' · secure: '+secure+' · framed: '+framed+
    ' · geolocation: '+('geolocation' in navigator)];
  $('bDiag').textContent=lines.join('\n');

  let title=null,text=null;
  if(!('geolocation' in navigator)){
    title='This browser has no location API';
    text='Try Chrome or Safari.';
  }else if(proto==='file:'){
    title='Opened as a local file — GPS is blocked';
    text='Chrome only gives location to secure origins, and <code>file://</code> is not one. '+
      'It refuses without even showing a permission prompt, which is what you saw. '+
      'Host the file at an <code>https://</code> address and it will work — see the note below.';
  }else if(framed){
    title='Running inside a preview frame';
    text='Embedded previews block location. Open the page in its own browser tab.';
  }else if(!secure){
    title='This page is not on a secure origin';
    text='Location needs <code>https://</code>. Reload the page over https.';
  }
  if(title){
    $('bTitle').textContent=title;
    $('bText').innerHTML=text;
    $('banner').classList.add('on');
  }
  return !title;
}
$('btnTest').onclick=()=>{
  $('bDiag').textContent='Asking for a fix…';
  if(!('geolocation' in navigator))return $('bDiag').textContent='No geolocation API at all.';
  navigator.geolocation.getCurrentPosition(
    p=>{$('bDiag').textContent='Got a fix: '+p.coords.latitude.toFixed(4)+', '+
        p.coords.longitude.toFixed(4)+' (±'+Math.round(p.coords.accuracy)+' m). '+
        'Location works here — recording will too.';
      $('banner').classList.remove('on');toast('GPS works.')},
    e=>{$('bDiag').textContent='Error '+e.code+' — '+
        (e.code===1?'PERMISSION_DENIED. Either you declined it, or the origin is not allowed to ask.'
        :e.code===2?'POSITION_UNAVAILABLE. No fix — try outdoors, or turn on device location.'
        :'TIMEOUT. No fix within 20 s.')+
        (e.message?' ['+e.message+']':'')},
    {enableHighAccuracy:true,timeout:20000,maximumAge:0});
};

/* ============ recording ============ */
let rec=null,watchId=null,tick=null,wake=null;
const MAXACC=45, MAXSPD=90;
let motionOn=false,gPeak=0,harsh=0,gSum=0,gN=0,jolts=[];
let grav={x:0,y:0,z:0},gravInit=false,inJolt=false;

/* The phone's orientation in the mount is unknown, so estimate the gravity
   vector per axis with a slow low-pass, subtract it, and measure what's left.
   Measuring the magnitude of the raw vector does not work: gravity dominates
   it, and 0.3 g of cornering barely moves the number. */
function onMotion(e){
  let lin=e.acceleration;                       // already gravity-free when offered
  if(!lin||lin.x==null){
    const a=e.accelerationIncludingGravity;
    if(!a||a.x==null)return;
    if(!gravInit){grav={x:a.x,y:a.y,z:a.z};gravInit=true;return}
    const k=.02;                                 // ~1 s time constant at 50 Hz
    grav.x+=(a.x-grav.x)*k;grav.y+=(a.y-grav.y)*k;grav.z+=(a.z-grav.z)*k;
    lin={x:a.x-grav.x,y:a.y-grav.y,z:a.z-grav.z};
  }
  const mag=Math.hypot(lin.x,lin.y,lin.z);
  if(!isFinite(mag)||mag>30)return;              // dropped phone, not driving
  const g=mag/9.81;
  if(g>gPeak)gPeak=g;
  gSum+=g;gN++;
  // one jolt counts once, however long it lasts, so a long hard brake
  // is not scored as a hundred separate events
  if(mag>3.5){if(!inJolt){harsh++;inJolt=true;
    if(rec)jolts.push(Math.round((Date.now()-rec.start)/1000))}}
  else if(mag<2.2)inJolt=false;
}
async function askMotion(){
  try{
    if(typeof DeviceMotionEvent!=='undefined'&&DeviceMotionEvent.requestPermission){
      if(await DeviceMotionEvent.requestPermission()!=='granted')return false;
    }
    window.addEventListener('devicemotion',onMotion);motionOn=true;return true;
  }catch(e){return false}
}
async function start(){
  if(!navigator.geolocation)return toast('This browser has no GPS access.');
  rec={start:Date.now(),dist:0,top:0,pts:[],last:null,lastAcc:null,gain:0,alt:null,idle:0};
  gPeak=0;harsh=0;gSum=0;gN=0;gravInit=false;inJolt=false;jolts=[];
  const gotMotion=await askMotion();
  if(!gotMotion)toast('No motion sensor — g and smoothness will be blank.');
  $('btnRec').textContent='Stop';$('btnRec').classList.add('live');
  {const cp=$('carPick');if(cp)cp.classList.remove('on')}
  $('livePanel').classList.add('on');
  $('hint').textContent='Recording. Leaving this screen will pause GPS updates.';
  watchId=navigator.geolocation.watchPosition(onPos,onErr,
    {enableHighAccuracy:true,maximumAge:1000,timeout:25000});
  tick=setInterval(()=>{
    $('lvTime').textContent=hms((Date.now()-rec.start)/1000);
    if(rec.lastAcc&&Date.now()-rec.lastAcc>6000)$('lvSpeed').textContent='0';
  },500);
  try{if('wakeLock' in navigator)wake=await navigator.wakeLock.request('screen')}catch(e){}
}
function onPos(p){
  const c=p.coords;
  if(c.accuracy>MAXACC){$('lvGps').innerHTML='Weak signal · ±'+Math.round(c.accuracy)+' m';return}
  const now=p.timestamp||Date.now();
  let spd=(c.speed!=null&&c.speed>=0)?c.speed:0;
  if(rec.last){
    const dt=(now-rec.last.t)/1000;
    if(dt<=0)return;
    const d=hav(rec.last.lat,rec.last.lng,c.latitude,c.longitude);
    const derived=d/dt;
    if(derived>MAXSPD)return;
    if(c.speed==null||c.speed<0)spd=derived;
    if(d>4||spd>1.5)rec.dist+=d; else rec.idle+=Math.min(dt,20);
  }
  if(c.altitude!=null&&(c.altitudeAccuracy==null||c.altitudeAccuracy<18)){
    if(rec.alt==null)rec.alt=c.altitude;
    const da=c.altitude-rec.alt;
    if(Math.abs(da)>3){if(da>0)rec.gain+=da;rec.alt=c.altitude}
  }
  if(spd>rec.top&&c.accuracy<25)rec.top=spd;
  rec.lastAcc=Date.now();
  const t=Math.round((now-rec.start)/1000);
  const keep=!rec.last||hav(rec.last.lat,rec.last.lng,c.latitude,c.longitude)>12||t-rec.last.st>8;
  if(keep){
    rec.pts.push([+c.latitude.toFixed(5),+c.longitude.toFixed(5),t,+(spd*3.6).toFixed(1),
      c.altitude!=null?Math.round(c.altitude):null]);
    rec.last={lat:c.latitude,lng:c.longitude,t:now,st:t};
  }else rec.last.t=now;
  $('lvSpeed').textContent=Math.round(spd*3.6);
  $('lvDist').textContent=km(rec.dist).toFixed(1);
  $('lvTop').textContent=Math.round(rec.top*3.6);
  $('lvClimb').textContent=Math.round(rec.gain);
  $('lvG').textContent=motionOn?gPeak.toFixed(1):'–';
  $('lvSmooth').textContent=motionOn?smoothness(harsh,(Date.now()-rec.start)/1000):'–';
  $('lvGps').innerHTML='Fix ±'+Math.round(c.accuracy)+' m · <b>'+rec.pts.length+'</b> points';
}
function onErr(e){
  $('lvGps').textContent=e.code===1
    ?'Location denied (error 1) — see the note at the top of the page.'
    :e.code===2?'No fix available (error 2) — is device location switched on?'
    :'No GPS fix yet (error 3). Under open sky this takes a few seconds.';
  if(e.code===1)diagnose();
}
async function stop(){
  navigator.geolocation.clearWatch(watchId);clearInterval(tick);
  if(wake){try{await wake.release()}catch(e){}wake=null}
  if(motionOn){window.removeEventListener('devicemotion',onMotion);motionOn=false}
  $('btnRec').textContent='Start';$('btnRec').classList.remove('live');
  $('livePanel').classList.remove('on');
  $('hint').textContent='Keep this screen visible while you drive — a background tab stops receiving GPS.';
  const dur=(Date.now()-rec.start)/1000;
  const d={id:String(rec.start),name:driveName(rec.start),start:rec.start,dur,
    dist:rec.dist,top:rec.top,pts:rec.pts,gain:Math.round(rec.gain),
    idle:Math.round(rec.idle),
    g:gN?+gPeak.toFixed(2):null,
    gAvg:gN?+(gSum/gN).toFixed(3):null,
    smooth:gN?smoothness(harsh,dur):null,
    joltT:gN?jolts.slice():null,
    twist:twistOf(rec.pts),
    gainClean:cleanGain(rec.pts),
    accel:accelOf({pts:rec.pts}),
    carId:settings.activeCar||null};
  rec=null;
  if(d.dist<150||d.pts.length<3)return toast('Too short to save — nothing recorded.');
  const known=coverage().cells;
  const fresh=new Set();
  d.pts.forEach(p=>{const k=cellKey(p[0],p[1]);if(!known.has(k))fresh.add(k)});
  d.newCells=fresh.size;
  const before=levelOf(drives.reduce((a,x)=>a+driveXp(x),0)+streak()*20+challengeXp()+bonusXp());
  drives.push(d);coverCache=null;roadCache=null;shapeCache=null;routeElevCache=null;borderCache=null;fogCache=null;regionCache=null;regionNameCache=null;
  markPbs();
  await saveV2(K_DRV,drives);
  fetchWeather(d).then(w=>{if(w){d.wx=w;saveV2(K_DRV,drives);render()}});
  render();
  showCarPick(d.id);
  const after=levelOf(drives.reduce((a,x)=>a+driveXp(x),0)+streak()*20+challengeXp()+bonusXp());
  const rt=buildRoutes().find(r=>r.runs.some(x=>x.id===d.id));
  floatXp(driveXp(d));
  if(after>before){celebrate(after,driveXp(d),d);return}
  if(d.pb&&rt){
    const others=rt.runs.filter(x=>x.id!==d.id).map(x=>x.dur);
    const by=others.length?Math.round(Math.min(...others)-d.dur):0;
    toast('Best yet on '+rt.name+' \u2014 '+mins(d.dur)+
      (by>0?', '+by+' s under your previous best':''));
  }
  else if(rt&&d.dur<=rt.best) toast('Best time yet on '+rt.name+' \u2014 '+mins(d.dur));
  else if(d.newCells>=15) toast((d.newCells*CELL/1000).toFixed(1)+' km of new road · +'+driveXp(d)+' xp');
  else toast(km(d.dist).toFixed(1)+' km · +'+driveXp(d)+' xp');
}
$('btnRec').onclick=()=>rec?stop():start();
document.addEventListener('visibilitychange',async()=>{
  if(document.visibilityState==='visible'&&rec&&'wakeLock' in navigator){
    try{wake=await navigator.wakeLock.request('screen')}catch(e){}
  }
});
window.addEventListener('beforeunload',e=>{if(rec){e.preventDefault();e.returnValue=''}});

/* ============ maps ============ */
let map,layer,allMap,allLayer,allTiles;
function openDrive(id){
  const d=drives.find(x=>x.id===id);if(!d)return;
  $('shTitle').textContent=d.name;
  $('shDist').textContent=km(d.dist).toFixed(1);
  $('shTime').textContent=hms(d.dur);
  const moving=Math.max(d.dur-(d.idle||0),1);
  $('shAvg').textContent=Math.round(km(d.dist)/(moving/3600));
  $('shTop').textContent=Math.round(d.top*3.6);
  $('shClimb').textContent=(gainOf(d)!=null?gainOf(d):0)+' m';
  $('shClimb').title=gainSource(d)||'measured on this drive alone';
  $('shIdle').textContent=d.idle?Math.round(d.idle/60)+'′':'0′';
  const gv=gOf(d);
  $('shG').innerHTML=gv!=null?gv.toFixed(2)+(gFromGps(d)?'<s>gps</s>':''):'–';
  const l=fuelOf(d),cst=costOf(d);
  $('shFuel').innerHTML=l!=null?(l.toFixed(1)+' L'+(cst?'<s>€'+cst.toFixed(2)+'</s>':'')):'–';
  $('shElev').innerHTML=elevSvg(d);
  $('shGg').innerHTML=ggSvg(d);
  $('shGrade').innerHTML=gradeHtml(d);
  $('sheet').classList.add('on');
  $('shDel').onclick=async()=>{
    if(!confirm('Delete this drive? It cannot be recovered.'))return;
    drives=drives.filter(x=>x.id!==id);coverCache=null;roadCache=null;shapeCache=null;routeElevCache=null;borderCache=null;fogCache=null;regionCache=null;regionNameCache=null;roadCache=null;await saveV2(K_DRV,drives);
    $('sheet').classList.remove('on');render();toast('Drive deleted.');
  };
  setTimeout(()=>{
    if(typeof L==='undefined'){
      $('map').innerHTML='<div class="empty" style="border:0">Map needs a connection. The stats below still work.</div>';return}
    if(!map){
      map=L.map('map');
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        {maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
    }
    if(layer)map.removeLayer(layer);
    const st=Math.max(1,Math.ceil(d.pts.length/600));
    const sp=d.pts.filter((_,i)=>i%st===0||i===d.pts.length-1);
    const segs=[];
    // a highlighter stroke under the route, wherever this drive broke new ground
    const fresh=firstTimeSegments(0,0,d.id);
    fresh.runs.forEach(r=>segs.push(L.polyline(r,{color:'#6BD08A',weight:11,opacity:.30})));
    for(let i=1;i<sp.length;i++){
      segs.push(L.polyline([[sp[i-1][0],sp[i-1][1]],[sp[i][0],sp[i][1]]],
        {color:speedColor(sp[i][3]||0),weight:4,opacity:.95}));
    }
    const line=d.pts.map(p=>[p[0],p[1]]);
    segs.push(L.circleMarker(line[0],{radius:5,color:'#EFE9D9',fillOpacity:1}));
    segs.push(L.circleMarker(line[line.length-1],{radius:5,color:'#D2402A',fillOpacity:1}));
    layer=L.layerGroup(segs).addTo(map);
    map.invalidateSize();map.fitBounds(L.latLngBounds(line).pad(.12));
  },60);
}
function elevSvg(d){
  const alt=(d.pts||[]).map(p=>p[4]).filter(v=>v!=null&&isFinite(v));
  if(alt.length<8)return '';
  const lo=Math.min(...alt),hi=Math.max(...alt);
  if(hi-lo<6)return '<div class="cap">Elevation · flat, '+Math.round(hi-lo)+' m of variation</div>';
  const W=320,H=60;
  const pts=alt.map((v,i)=>[i/(alt.length-1)*W,H-(v-lo)/(hi-lo)*(H-8)-4]);
  const line=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join('');
  return '<div class="cap">Elevation · '+Math.round(lo)+'–'+Math.round(hi)+
    ' m · '+(gainOf(d)||0)+' m climbed</div>'+
    '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'+
    '<path class="f" d="'+line+'L'+W+' '+H+'L0 '+H+'Z"/><path class="l" d="'+line+'"/></svg>';
}
document.querySelectorAll('#heatSel button').forEach(b=>{
  b.onclick=async()=>{
    settings.heatNew=b.dataset.h;delete settings.heatRange;
    await saveV2(K_SET,settings);
    document.querySelectorAll('#heatSel button').forEach(x=>x.classList.toggle('on',x===b));
    $('btnAll').onclick();
  };
});
$('shClose').onclick=()=>$('sheet').classList.remove('on');
$('shAllClose').onclick=()=>$('sheetAll').classList.remove('on');
$('btnName').onclick=()=>nameFogPlaces();
$('btnNameStop').onclick=()=>{namingStop=true;toast('Stopping…')};
$('btnRoads').onclick=()=>fetchRegionRoads();
$('btnRoadsStop').onclick=()=>{roadsStop=true;toast('Stopping after this square…')};
$('btnFog').onclick=async()=>{
  settings.fog=!settings.fog;
  await saveV2(K_SET,settings);
  $('btnFog').classList.toggle('on',fogOn());
  $('btnName').style.display=fogOn()?'':'none';
  $('btnAll').onclick();
  toast(fogOn()?'Fog of war on — only roads you have driven.':'Map back on.');
};
$('btnAll').onclick=()=>{
  if(!drives.length)return toast('No routes to map yet.');
  $('sheetAll').classList.add('on');
  $('btnFog').classList.toggle('on',fogOn());
  $('btnName').style.display=fogOn()?'':'none';
  const c=coverage();
  $('allInfo').textContent=drives.length+' drives · '+(c.unique*CELL/1000).toFixed(0)+
    ' km of distinct road · roads you repeat burn hotter';
  setTimeout(()=>{
    if(typeof L==='undefined'){
      $('allmap').innerHTML='<div class="empty" style="border:0">Map needs a connection.</div>';return}
    if(!allMap){
      allMap=L.map('allmap');
      allTiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        {maxZoom:19,attribution:'© OpenStreetMap'});
    }
    if(fogOn()){if(allMap.hasLayer(allTiles))allMap.removeLayer(allTiles)}
    else if(!allMap.hasLayer(allTiles))allTiles.addTo(allMap);
    $('allmap').classList.toggle('fog',fogOn());
    if(allLayer)allMap.removeLayer(allLayer);
    const cells=coverage().cells, all=[], segs=[];
    const heat=n=>n>=8?'#D2402A':n>=4?'#E8A33D':n>=2?'#8C8455':'#3F5B6B';
    // keep the layer count sane: thin points, then merge runs of one colour
    const total=drives.reduce((a,d)=>a+(d.pts?d.pts.length:0),0);
    const step=Math.max(1,Math.ceil(total/6000));
    drives.forEach(d=>{
      if(!d.pts||d.pts.length<2)return;
      const p=d.pts.filter((_,i)=>i%step===0||i===d.pts.length-1);
      let run=[[p[0][0],p[0][1]]], col=heat(cells.get(cellKey(p[0][0],p[0][1]))||1);
      all.push(run[0]);
      for(let i=1;i<p.length;i++){
        const c2=heat(cells.get(cellKey(p[i][0],p[i][1]))||1);
        run.push([p[i][0],p[i][1]]);
        if(c2!==col||i===p.length-1){
          const hot=col==='#D2402A'||col==='#E8A33D';
          segs.push(L.polyline(run,{color:col,weight:hot?4:3,opacity:hot?.9:.5}));
          run=[[p[i][0],p[i][1]]];col=c2;
        }
      }
    });
    // new roads go on top: a soft halo, then a bright line
    const per=heatPeriod();
    let newKm=0;
    if(per){
      const nf=firstTimeSegments(per.a,per.b);
      newKm=nf.km;
      nf.runs.forEach(r=>{
        segs.push(L.polyline(r,{color:'#EFE9D9',weight:9,opacity:.16}));
        segs.push(L.polyline(r,{color:'#6BD08A',weight:4,opacity:.95}));
      });
    }
    if(fogOn())fogMarkers().forEach(m=>segs.push(m));
    allLayer=L.layerGroup(segs).addTo(allMap);
    allMap.invalidateSize();
    if(all.length)allMap.fitBounds(L.latLngBounds(all).pad(.1));
    $('allNew').innerHTML=per
      ? (newKm>0.05
          ? '<b>'+newKm.toFixed(1)+' km</b> of it was driven for the first time '+per.label+
            ', picked out in green.'
          : 'Nothing new '+per.label+' — every road on this map you had already driven.')
      : 'Highlighting off.';
  },60);
};

/* ---------- which car was that? ----------
   Asked after the drive rather than before it. The answer is obvious once you
   are standing next to the thing, and a question before the key turns is one
   more screen between you and driving. The car that drove it is already set
   from the active car, so one car is one glance and no taps.

   Changing it re-earns the drive: the age bonus is worked out per drive from
   the car that drove it, so moving a drive between a 1991 car and a new one
   moves its xp too. */
function showCarPick(id){
  const box=$('carPick');
  if(!box)return;
  const d=drives.find(x=>x.id===id);
  if(!d||cars.length<1){box.classList.remove('on');box.innerHTML='';return}
  box.innerHTML='<div class="cp-t">Which car was that?</div>'+
    '<div class="cp-row">'+cars.map(c=>
      '<button class="cp'+(d.carId===c.id?' on':'')+'" data-car="'+c.id+'">'+
      esc(c.name)+(c.year?'<s>'+c.year+'</s>':'')+'</button>').join('')+'</div>';
  box.classList.add('on');
  box.querySelectorAll('[data-car]').forEach(b=>b.onclick=async()=>{
    if(d.carId===b.dataset.car)return;
    d.carId=b.dataset.car;
    settings.activeCar=d.carId;
    await saveV2(K_DRV,drives);
    await saveV2(K_SET,settings);
    const c=cars.find(x=>x.id===d.carId);
    render();showCarPick(id);
    toast('Logged to '+(c?c.name:'that car')+' · '+driveXp(d)+' xp');
  });
}

/* ============ regions ============
   The coverage grid grouped into 10 km squares, so exploring has somewhere to
   finish rather than being one number that only ever goes up.

   Progress is measured in kilometres of distinct road driven inside a square,
   not as a percentage of it. A percentage needs to know how much road the
   square holds, which needs the road network, which the app does not have and
   cannot get offline — and most of a 10 km square is fields, so any honest
   denominator would put every region at two or three percent forever. The
   README already refuses to fake this for coverage and it is refused here.

   The tiers are therefore absolute distances, and they are named as such.
   None of them means a square is finished, because the app has no way to
   know what finished would be. */
const REGION=10000;                    // metres
/* Named for how much road you have driven there, because that is what is
   measured. An earlier set said Scouted, Known, Owned and Mastered, which
   promises a share of the roads that exist — the very denominator the
   comment above explains the app cannot have. 78 km of road inside a square
   holding a city is a good deal of driving and nothing like all of it. */
const REGION_TIERS=[[2,'Been through'],[10,'Driven a fair bit'],
  [30,'Driven a lot'],[60,'Driven a great deal']];
/* The same ladder once a square has been measured and there is a real
   denominator. The percentages are low on purpose: the square holding
   Hasselt carries 499.9 km of road and 78.7 km of it has been driven, which
   is 15.7% and is the best square there is. Across twenty-one squares
   measured against the map the shares run: lowest 0.2%, quarter-way 2.6%,
   half-way 3.4%, three-quarters 7.3%, highest 15.7%. So the ladder puts
   most squares on the first rung, the well-driven ones on the second, the
   best few on the third, and leaves the fourth to be earned. A tier at 75%
   would be one nobody ever reaches, which is how the first version of this
   went wrong. */
const REGION_PCT_TIERS=[[2,'Been through'],[6,'Driven a fair bit'],
  [12,'Driven a lot'],[20,'Driven a great deal']];
let regionCache=null;
function regionKey(lat,lng){
  const dLat=REGION/111320, dLng=REGION/(111320*Math.cos(lat*Math.PI/180));
  return Math.round(lat/dLat)+':'+Math.round(lng/dLng);
}
function pickTier(table,v){
  let t=null;
  table.forEach(x=>{if(v>=x[0])t=x});
  const next=table.find(x=>v<x[0])||null;
  return {tier:t,next,to:next?next[0]-v:0};
}
function regionTier(kmDriven){return pickTier(REGION_TIERS,kmDriven)}
/* Once a square has been measured against the map there is a real
   denominator, so the tier is a share of the roads that exist and can say so.
   Until then it falls back to plain distance, which is all the app knows
   offline and never pretends to be more. */
function regionStanding(r){
  const pct=regionPct(r);
  if(pct==null)return Object.assign({measured:false,pct:null},
    pickTier(REGION_TIERS,r.km));
  return Object.assign({measured:true,pct},pickTier(REGION_PCT_TIERS,pct));
}
/* Built from the coverage cells rather than from the points, so a region
   counts the same distinct road the heat map does and a stretch driven two
   hundred times still counts once. */
function regions(){
  if(regionCache)return regionCache;
  const cells=coverage().cells, byReg=new Map();
  cells.forEach((n,k)=>{
    const parts=k.split(':');
    /* rebuild the cell's position from its key: the grid is regular, so the
       row index alone gives the latitude, and latitude gives the column width */
    const dLat=CELL/111320;
    const lat=Number(parts[0])*dLat;
    const dLng=CELL/(111320*Math.cos(lat*Math.PI/180));
    const lng=Number(parts[1])*dLng;
    const rk=regionKey(lat,lng);
    let r=byReg.get(rk);
    if(!r){r={key:rk,cells:0,lat:0,lng:0,visits:0};byReg.set(rk,r)}
    r.cells++;r.visits+=n;r.lat+=lat;r.lng+=lng;
  });
  const out=[];
  byReg.forEach(r=>{
    r.lat/=r.cells;r.lng/=r.cells;
    r.km=r.cells*CELL/1000;
    Object.assign(r,regionStanding(r));
    out.push(r);
  });
  return regionCache=out.sort((a,b)=>b.km-a.km);
}
/* Named from the town labels already looked up for the fog map, so no region
   costs a request of its own. A region with no named town nearby keeps its
   grid reference, which is at least stable. */
/* Two squares either side of a town are both nearest to that town, and the
   list showed "Nazareth" twice with no way to tell which was which. The
   closest keeps the bare name and the others say which side of it they are,
   so every row names somewhere different. */
let regionNameCache=null;
function regionNameMap(){
  if(regionNameCache)return regionNameCache;
  const out=new Map(), groups=new Map();
  regions().forEach(r=>{
    let best=null,bd=REGION;
    fogClusters().forEach(c=>{
      const nm=fogName(c);
      if(!nm)return;
      const d=hav(r.lat,r.lng,c.lat,c.lng);
      if(d<bd){bd=d;best={nm,lat:c.lat,lng:c.lng,d}}
    });
    if(!best){out.set(r.key,'Square '+r.key);return}
    const g=groups.get(best.nm)||[];
    g.push({r,town:best});groups.set(best.nm,g);
  });
  groups.forEach((g,nm)=>{
    g.sort((a,b)=>a.town.d-b.town.d);
    g.forEach((x,i)=>out.set(x.r.key, i===0?nm
      :nm+' '+compassOf(bearing(x.town.lat,x.town.lng,x.r.lat,x.r.lng))));
  });
  return regionNameCache=out;
}
function regionName(r){return regionNameMap().get(r.key)||('Square '+r.key)}
/* A standing pot, the way completed challenges are: reaching a tier is worth
   holding, and it cannot be lost. */
function regionXp(){
  return regions().reduce((a,r)=>{
    if(!r.tier)return a;
    const tbl=r.measured?REGION_PCT_TIERS:REGION_TIERS;
    return a+(tbl.findIndex(x=>x[1]===r.tier[1])+1)*40;
  },0);
}
function regionsHtml(){
  const rs=regions();
  if(!rs.length)return '<div class="empty" style="border:0">'+
    'Drive somewhere and it will start filling in.</div>';
  /* Once any square has a real share, the ones without it must not borrow the
     same words. Distance tiers and share tiers are different scales, and side
     by side they lie: a square with 54.9 km driven and no denominator filled
     its bar to the brim beside Hasselt, which is the best known square there
     is, sitting at 16% of the road it actually holds. So when a measurement
     exists anywhere, an unmeasured square shows its distance and says plainly
     that it has not been measured, rather than being given a tier it has not
     earned on a scale it is not on. With nothing measured at all, distance is
     all there is and the old ladder stands. */
  const meas=rs.filter(r=>r.measured);
  const mixed=meas.length>0;
  const order=mixed
    ? meas.slice().sort((a,b)=>b.pct-a.pct)
        .concat(rs.filter(r=>!r.measured).sort((a,b)=>b.km-a.km))
    : rs;
  const rows=order.slice(0,14).map(r=>{
    const road=regionRoadKm(r);
    if(r.measured){
      const fill=r.next?r.pct/r.next[0]*100:100;
      return '<div class="rg-row"><div class="rg-top">'+
        '<span class="n">'+esc(regionName(r))+'</span>'+
        '<span class="t got">'+(r.tier?r.tier[1]:'Barely touched')+'</span></div>'+
        '<div class="rg-bar"><i style="width:'+Math.max(2,Math.min(100,fill))+'%"></i></div>'+
        '<div class="rg-sub">'+r.km.toFixed(1)+' of '+road.toFixed(0)+' km · '+
        '<b>'+r.pct.toFixed(1)+'%</b>'+
        (r.next?' · '+(r.next[0]-r.pct).toFixed(1)+' points more for “'+
          r.next[1]+'”':'')+'</div></div>';
    }
    if(mixed)
      return '<div class="rg-row pending"><div class="rg-top">'+
        '<span class="n">'+esc(regionName(r))+'</span>'+
        '<span class="t">Not measured</span></div>'+
        '<div class="rg-bar"><i style="width:0%"></i></div>'+
        '<div class="rg-sub">'+r.km.toFixed(1)+' km driven · '+
        'measure to see the share</div></div>';
    const fill=r.next?r.km/r.next[0]*100:100;
    return '<div class="rg-row"><div class="rg-top">'+
      '<span class="n">'+esc(regionName(r))+'</span>'+
      '<span class="t'+(r.tier?' got':'')+'">'+
      (r.tier?r.tier[1]:'Barely touched')+'</span></div>'+
      '<div class="rg-bar"><i style="width:'+Math.max(2,Math.min(100,fill))+'%"></i></div>'+
      '<div class="rg-sub">'+r.km.toFixed(1)+' km of road'+
      (r.next?' · '+r.to.toFixed(1)+' km more for “'+r.next[1]+'”':'')+
      '</div></div>';
  }).join('');
  const left=rs.length-meas.length;
  const unnamed=rs.filter(r=>regionName(r).indexOf('Square ')===0).length;
  return '<div class="cap">'+rs.length+' squares touched · 10 km to a side · '+
    (mixed
      ? (left
          ? meas.length+' measured against the map, '+left+' still to go'
          : 'every one measured against the map')
      : 'distance driven in each — “Measure the squares” turns these into shares')+
    '</div><div class="rg-list">'+rows+'</div>'+
    (order.length>14?'<div class="cap">Showing fourteen of '+rs.length+'.</div>':'')+
    (mixed&&left?'<div class="cap">'+left+' square'+(left>1?'s':'')+
      ' timed out on the map service — tap “Measure the squares” '+
      'again to finish them.</div>':'')+
    (unnamed?'<div class="cap">'+unnamed+' square'+(unnamed>1?'s':'')+
      ' still showing a grid reference — they take their names from the '+
      'map, under “Name the towns”.</div>':'');
}

/* ---------- how much road a square actually holds ----------
   Overpass will sum the length of every road in a bounding box server-side,
   so the answer to "how much of this place have I driven" costs one short
   request and about 350 bytes rather than the geometry of every street.

   Only roads you could drive down are counted: no tracks, no footpaths, no
   service roads and car parks, which would otherwise inflate the total with
   things no one drives for their own sake.

   The answer is kept, because a square's roads do not change between
   Saturdays, and the whole point is not to ask twice. */
const OVERPASS_MIRRORS=[
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'];
const OVERPASS_ROADS='motorway|trunk|primary|secondary|tertiary|unclassified|'+
  'residential|living_street';
function regionBox(key){
  const p=key.split(':');
  const dLat=REGION/111320;
  const lat=Number(p[0])*dLat;
  const dLng=REGION/(111320*Math.cos(lat*Math.PI/180));
  const lng=Number(p[1])*dLng;
  return [lat-dLat/2,lng-dLng/2,lat+dLat/2,lng+dLng/2];
}
function regionRoadKm(r){
  const v=settings.regionRoad&&settings.regionRoad[r.key];
  return (typeof v==='number'&&v>0)?v:null;
}
/* The share is honest about what it divides. Driven distance is counted in
   distinct 100 m cells, and a cell holds one square whatever runs through it,
   so where streets are dense the figure reads low: three parallel streets in
   one cell count once on top and three times underneath. It is a fair measure
   of a countryside square and a conservative one of a town centre. */
function regionPct(r){
  const road=regionRoadKm(r);
  return road?Math.min(100,r.km/road*100):null;
}
/* Returns metres, or null when the question could not be asked. The
   difference matters: a square that genuinely holds no road is an answer and
   is remembered, while a timeout is not an answer and must be asked again.
   Writing zero for both would have quietly marked every square the server
   was too busy for as roadless, for ever. */
/* Returns {m:metres} or {err:'why'}. The reason is carried back rather than
   swallowed, because "the map service is busy" is not something you can act
   on and "HTTP 504 Gateway Timeout ×8" is: it says the servers are loaded and
   trying later will work, where a 400 would mean the query itself is wrong
   and trying later will not.

   Overpass reports a timeout two different ways. Usually it is an HTTP status,
   but under load it answers 200 with no elements and a "remark" explaining
   itself, which would otherwise read as a square holding no road at all. */
/* A square normally answers in about two seconds, but asking thirty-three
   times in a row does not take thirty-three times as long: the public servers
   start queueing you, and once they do every answer takes twenty to thirty
   seconds and the slowest fall off the end of the deadline. Measured here,
   one square at a time, answers went from 2 s to 20-30 s by the fourth
   request and squares began timing out.

   Overpass will take several bounding boxes in one query and label each
   answer, so the whole thing can be asked in a handful of requests instead of
   thirty-three. That is the difference between being throttled and not.

   Which squares failed looked like it depended on their names, and it did,
   but only by accident: unnamed squares are the least-driven ones, so they
   sort last, so they were asked when the throttling was worst. */
const OVERPASS_BATCH=6;
const OVERPASS_WAIT=20000;          // one square
const OVERPASS_WAIT_EACH=9000;      // and per extra square in a batch
function fetchFor(url,ms){
  if(typeof AbortController==='undefined')return fetch(url);
  const ac=new AbortController();
  const t=setTimeout(()=>ac.abort(),ms);
  return fetch(url,{signal:ac.signal}).finally(()=>clearTimeout(t));
}
/* Returns a Map of key -> metres for whatever came back, or {err} for a batch
   that could not be asked at all. A key missing from the answer is left out,
   so it stays unasked rather than being written down as having no roads. */
async function overpassBatch(keys){
  let q='[out:json][timeout:180];';
  keys.forEach(k=>{
    q+='way["highway"~"^('+OVERPASS_ROADS+')$"]('+
      regionBox(k).map(x=>x.toFixed(5)).join(',')+');'+
      'make stat key="'+k+'",total=sum(length());out;';
  });
  const wait=OVERPASS_WAIT+OVERPASS_WAIT_EACH*(keys.length-1);
  let last='no answer';
  for(const host of OVERPASS_MIRRORS){
    try{
      const res=await fetchFor(host+'?data='+encodeURIComponent(q),wait);
      if(!res.ok){last='HTTP '+res.status+(res.statusText?' '+res.statusText:'');continue}
      const j=await res.json();
      const els=j.elements||[];
      if(!els.length&&j.remark){
        last=String(j.remark).replace(/\s+/g,' ').trim().slice(0,60);continue;
      }
      const out=new Map();
      els.forEach(e=>{
        const t=e&&e.tags;
        if(!t||!t.key)return;
        const m=Number(t.total);
        if(isFinite(m))out.set(t.key,m);
      });
      if(out.size)return {got:out};
      last='no squares in the answer';
    }catch(e){
      last=(e&&e.name==='AbortError')
        ?'no answer in '+Math.round(wait/1000)+' s'
        :((e&&e.message)?String(e.message).slice(0,60):'no connection');
    }
  }
  return {err:last};
}
function progBar(done,total,label,cls){
  const pct=total?Math.round(done/total*100):0;
  return '<div class="pg-bar"><i class="'+(cls||'')+'" style="width:'+pct+'%"></i></div>'+
    '<div class="pg-t">'+esc(label)+'</div>';
}
let roadsStop=false;
async function fetchRegionRoads(){
  const rs=regions();
  if(!rs.length)return toast('Drive somewhere first.');
  settings.regionRoad=settings.regionRoad||{};
  const todo=rs.filter(r=>settings.regionRoad[r.key]===undefined).map(r=>r.key);
  const box=$('roadsProg'), btn=$('btnRoads'), stop=$('btnRoadsStop');
  if(!todo.length){
    if(box){box.classList.add('on');box.innerHTML=progBar(1,1,'Every square is measured.')}
    return;
  }
  if(btn)btn.disabled=true;
  if(stop)stop.style.display='';
  roadsStop=false;
  if(box)box.classList.add('on');
  let ok=0,miss=0,waited=0;
  const errs=new Map();
  const paint=(from,n)=>{if(box)box.innerHTML=progBar(ok+miss,todo.length,
    'Measuring '+(from+1)+(n>1?'–'+(from+n):'')+' of '+todo.length+
    (waited>2?' · '+waited+' s':'')+
    (miss?' · '+miss+' failed':''))};

  /* A batch that cannot be asked is split and tried again, so one awkward
     square cannot take five good ones down with it every time. */
  const ask=async(keys,from)=>{
    if(roadsStop)return;
    waited=0;paint(from,keys.length);
    const tick=setInterval(()=>{waited++;paint(from,keys.length)},1000);
    const res=await overpassBatch(keys);
    clearInterval(tick);
    if(res.got){
      for(const k of keys){
        if(res.got.has(k)){settings.regionRoad[k]=res.got.get(k)/1000;ok++}
        else{miss++;errs.set('left out of the answer',
          (errs.get('left out of the answer')||0)+1)}
      }
      regionCache=null;regionNameCache=null;
      await saveV2(K_SET,settings);
      return;
    }
    if(keys.length>1){                       // split and retry the halves
      const h=Math.ceil(keys.length/2);
      await ask(keys.slice(0,h),from);
      await ask(keys.slice(h),from+h);
      return;
    }
    miss++;errs.set(res.err,(errs.get(res.err)||0)+1);
  };

  for(let i=0;i<todo.length&&!roadsStop;i+=OVERPASS_BATCH){
    await ask(todo.slice(i,i+OVERPASS_BATCH),i);
    if(i+OVERPASS_BATCH<todo.length&&!roadsStop)
      await new Promise(x=>setTimeout(x,1500));
  }
  if(btn)btn.disabled=false;
  if(stop)stop.style.display='none';
  regionCache=null;regionNameCache=null;
  render();
  if(box){
    box.classList.add('on');
    const done=ok+miss;
    const why=[...errs.entries()].sort((a,b)=>b[1]-a[1])
      .map(e=>e[0]+(e[1]>1?' ×'+e[1]:'')).join(' · ');
    box.innerHTML=progBar(ok,todo.length,
      (ok?ok+' of '+todo.length+' measured':'None measured')+
      (roadsStop&&done<todo.length?' · stopped':'')+
      (miss?' · '+miss+' failed — tap again to retry them':
        (done<todo.length?'':' · all done')),
      miss?(ok?'part':'bad'):'')+
      (why?'<div class="pg-e">'+esc(why)+'</div>':'');
  }
  toast(ok?'Measured '+ok+' square'+(ok>1?'s':'')+(miss?', '+miss+' failed.':'.')
          :'Nothing measured — the map service is busy.');
}
/* ---------- the towns behind the fog ----------
   With the map taken away the coverage floats in nothing, so the places you
   drive through are labelled back in. The labels come from your own driving
   rather than from a label layer: one cluster per 8 km of driven road, named
   once and remembered. The map then names the places you have been and stays
   quiet about everywhere else, which is the whole point of the view.

   8 km is about one town. Tighter and a single town answers three times over
   under three different suburb names; looser and neighbouring towns collapse
   into whichever happened to be driven first.

   Clusters are built in the order you drove them, so the name attaches to the
   first place you reached rather than wherever a later drive happened to
   start, and the count is how often you have been near it. */
const FOG_CLUSTER=8000;
const FOG_STEP=20;          // every twentieth point is plenty at this radius
let fogCache=null;
function fogClusters(){
  if(fogCache)return fogCache;
  const out=[];
  drives.slice().sort((a,b)=>a.start-b.start).forEach(d=>{
    const p=d.pts||[];
    for(let i=0;i<p.length;i+=FOG_STEP){
      let hit=null;
      for(const c of out)
        if(hav(c.lat,c.lng,p[i][0],p[i][1])<FOG_CLUSTER){hit=c;break}
      if(hit)hit.n++;
      else out.push({lat:p[i][0],lng:p[i][1],n:1});
    }
  });
  return fogCache=out.sort((a,b)=>b.n-a.n);
}
function fogKey(c){return c.lat.toFixed(3)+','+c.lng.toFixed(3)}
function fogName(c){
  const v=settings.fogNames&&settings.fogNames[fogKey(c)];
  return (v&&v!=='Unknown')?v:null;
}
/* Two clusters either side of a town both answer with the town. Keep the one
   you have been near most and drop the rest, so the name appears once. */
function fogLabelled(){
  const best=new Map();
  fogClusters().forEach(c=>{
    const nm=fogName(c);
    if(!nm)return;
    const cur=best.get(nm);
    if(!cur||c.n>cur.n)best.set(nm,c);
  });
  return [...best.entries()].map(([name,c])=>({name,lat:c.lat,lng:c.lng,n:c.n}));
}
function fogMarkers(){
  if(typeof L==='undefined')return [];
  const ls=fogLabelled();
  if(!ls.length)return [];
  const top=Math.max(...ls.map(x=>x.n));
  return ls.map(x=>L.marker([x.lat,x.lng],{
    interactive:false,keyboard:false,
    icon:L.divIcon({className:'fog-label'+(x.n>=top*0.5?' big':''),
      html:'<span>'+esc(x.name)+'</span>',iconSize:[0,0]})}));
}
/* Nominatim answers one point at a time, a second apart, and rate-limits bulk
   reverse geocoding, so a run of thirty can be cut off part way through. That
   used to pass in silence: a cluster whose lookup failed was simply skipped,
   and every square nearest to it kept a grid reference with nothing on screen
   saying why. The run now reports itself the way measuring does.

   The name is taken from the widest thing that names a place a driver would
   recognise, then narrower ones, and finally whatever the point itself is
   called. The narrow ones matter in the countryside, where there is no town
   for several kilometres but there is a hamlet with a name. */
function placeNameFrom(j){
  const a=(j&&j.address)||{};
  return a.city||a.town||a.village||a.municipality||a.borough||
    a.city_district||a.suburb||a.hamlet||a.locality||a.county||
    (j&&j.name)||null;
}
let namingStop=false;
async function nameFogPlaces(){
  const cl=fogClusters();
  if(!cl.length)return toast('Drive somewhere first.');
  settings.fogNames=settings.fogNames||{};
  /* A place the service could not name is worth asking about once more on a
     later run: it is far more often a refused request than a nameless field,
     and storing it for ever turned a busy minute into a permanent blank. */
  const todo=cl.filter(c=>{
    const v=settings.fogNames[fogKey(c)];
    return !v||v==='Unknown';
  });
  const box=$('nameProg'), btn=$('btnName'), stop=$('btnNameStop');
  if(!todo.length){
    if(box){box.classList.add('on');box.innerHTML=progBar(1,1,'Every place is named.')}
    return;
  }
  if(btn)btn.disabled=true;
  if(stop)stop.style.display='';
  namingStop=false;
  if(box)box.classList.add('on');
  let ok=0,bad=0,waited=0;
  const errs=new Map();
  const paint=i=>{if(box)box.innerHTML=progBar(ok+bad,todo.length,
    'Looking up '+(i+1)+' of '+todo.length+
    (waited>2?' · '+waited+' s':'')+(bad?' · '+bad+' failed':''))};
  for(let i=0;i<todo.length;i++){
    if(namingStop)break;
    const c=todo[i];
    waited=0;paint(i);
    const tick=setInterval(()=>{waited++;paint(i)},1000);
    try{
      const r=await fetchFor('https://nominatim.openstreetmap.org/reverse'+
        '?format=jsonv2&zoom=12&addressdetails=1&lat='+c.lat+'&lon='+c.lng,15000);
      if(!r.ok)throw new Error('HTTP '+r.status+(r.statusText?' '+r.statusText:''));
      const j=await r.json();
      const nm=placeNameFrom(j);
      if(nm){settings.fogNames[fogKey(c)]=nm;ok++}
      else{
        settings.fogNames[fogKey(c)]='Unknown';bad++;
        errs.set('nothing named there',(errs.get('nothing named there')||0)+1);
      }
    }catch(e){
      bad++;
      const why=(e&&e.name==='AbortError')?'no answer in 15 s'
        :((e&&e.message)?String(e.message).slice(0,60):'no connection');
      errs.set(why,(errs.get(why)||0)+1);
    }
    clearInterval(tick);
    await saveV2(K_SET,settings);
    regionNameCache=null;      // the clusters are unchanged, only their names
    if(i<todo.length-1&&!namingStop)await new Promise(x=>setTimeout(x,1200));
  }
  if(btn)btn.disabled=false;
  if(stop)stop.style.display='none';
  regionNameCache=null;
  render();
  if(box){
    const why=[...errs.entries()].sort((a,b)=>b[1]-a[1])
      .map(e=>e[0]+(e[1]>1?' ×'+e[1]:'')).join(' · ');
    box.innerHTML=progBar(ok,todo.length,
      (ok?ok+' of '+todo.length+' named':'None named')+
      (namingStop&&ok+bad<todo.length?' · stopped':'')+
      (bad?' · '+bad+' failed — tap again to retry them':' · all done'),
      bad?(ok?'part':'bad'):'')+
      (why?'<div class="pg-e">'+esc(why)+'</div>':'');
  }
  toast(ok?'Named '+ok+' place'+(ok>1?'s':'')+(bad?', '+bad+' failed.':'.')
          :'Could not reach the name service — nothing lost, tap again.');
  $('btnAll').onclick();
}

/* ---------- fog of war ----------
   The same coverage, with the map underneath it taken away. What is left is
   only the roads you have actually driven, which is a different question from
   where you have been on a map: it shows the shape of what you know rather
   than the shape of the country. */
function fogOn(){return !!settings.fog}

/* ============ data in / out ============ */
function dl(name,text,type){
  const b=new Blob([text],{type}),u=URL.createObjectURL(b);
  const a=document.createElement('a');a.href=u;a.download=name;a.click();
  setTimeout(()=>URL.revokeObjectURL(u),1000);
}
$('btnExport').onclick=()=>{
  if(!drives.length)return toast('Nothing to export yet.');
  dl('odo-backup-'+new Date().toISOString().slice(0,10)+'.json',
     JSON.stringify({v:3,drives,cars,settings}),'application/json');
  toast('Backup downloaded.');
};
$('btnGpx').onclick=()=>{
  if(!drives.length)return toast('Nothing to export yet.');
  const trks=drives.map(d=>'<trk><name>'+esc(d.name)+' '+new Date(d.start).toISOString()+
    '</name><trkseg>'+d.pts.map(p=>'<trkpt lat="'+p[0]+'" lon="'+p[1]+'">'+
      (p[4]!=null?'<ele>'+p[4]+'</ele>':'')+
      '<time>'+new Date(d.start+p[2]*1000).toISOString()+'</time></trkpt>').join('')+
    '</trkseg></trk>').join('');
  dl('odo-'+new Date().toISOString().slice(0,10)+'.gpx',
    '<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Odo" '+
    'xmlns="http://www.topografix.com/GPX/1/1">'+trks+'</gpx>','application/gpx+xml');
  toast('GPX downloaded.');
};
$('btnImport').onclick=()=>$('fileIn').click();
$('fileIn').onchange=e=>{
  const f=e.target.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=async()=>{
    try{
      const raw=JSON.parse(r.result);
      const inc=Array.isArray(raw)?raw:raw.drives;
      if(!Array.isArray(inc))throw 0;
      const have=new Set(drives.map(d=>d.id));
      const add=inc.filter(d=>d&&d.id&&d.pts&&!have.has(d.id));
      drives=drives.concat(add);
      if(raw.cars&&Array.isArray(raw.cars)){
        const hc=new Set(cars.map(c=>c.id));
        cars=cars.concat(raw.cars.filter(c=>c&&c.id&&!hc.has(c.id)));
        await saveV2(K_CAR,cars);
      }
      if(raw.settings){settings=Object.assign(settings,raw.settings);await saveV2(K_SET,settings)}
      coverCache=null;roadCache=null;shapeCache=null;routeElevCache=null;borderCache=null;fogCache=null;regionCache=null;regionNameCache=null;await saveV2(K_DRV,drives);render();
      toast(add.length+' drives restored.');
    }catch(err){toast("That file isn't an Odo backup.")}
    e.target.value='';
  };
  r.readAsText(f);
};

/* ============ tabs ============ */
document.querySelectorAll('.tabs button').forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x===b));
    document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.id===b.dataset.tab));
    window.scrollTo({top:0,behavior:'smooth'});
  };
});



/* ================================================================
   Additions: IndexedDB, weather, challenges, records, sharing
   ================================================================ */

/* ---------- IndexedDB (localStorage caps out around 5 MB) ---------- */
const IDB={db:null,
  open(){
    if(this.db)return Promise.resolve(this.db);
    return new Promise((res,rej)=>{
      if(!window.indexedDB)return rej('no idb');
      const r=indexedDB.open('odo',1);
      r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('kv'))r.result.createObjectStore('kv')};
      r.onsuccess=()=>{this.db=r.result;res(this.db)};
      r.onerror=()=>rej(r.error);
    });
  },
  async get(k){const db=await this.open();return new Promise((res,rej)=>{
    const r=db.transaction('kv').objectStore('kv').get(k);
    r.onsuccess=()=>res(r.result===undefined?null:r.result);r.onerror=()=>rej(r.error)})},
  async set(k,v){const db=await this.open();return new Promise((res,rej)=>{
    const t=db.transaction('kv','readwrite');t.objectStore('kv').put(v,k);
    t.oncomplete=()=>res();t.onerror=()=>rej(t.error)})}
};
let idbOk=false;
async function loadV2(key,fallback){
  if(idbOk){try{const v=await IDB.get(key);if(v!=null)return v}catch(e){}}
  return load(key,fallback);                 // falls back to the old keys, so nothing is lost
}
async function saveV2(key,val){
  if(idbOk){try{await IDB.set(key,val);return}catch(e){}}
  return save(key,val);
}

/* ---------- weather (Open-Meteo, no key needed) ---------- */
const WX={0:'clear',1:'mostly clear',2:'partly cloudy',3:'overcast',45:'fog',48:'freezing fog',
  51:'light drizzle',53:'drizzle',55:'heavy drizzle',61:'light rain',63:'rain',65:'heavy rain',
  66:'freezing rain',67:'freezing rain',71:'light snow',73:'snow',75:'heavy snow',
  77:'snow grains',80:'showers',81:'showers',82:'violent showers',85:'snow showers',
  86:'snow showers',95:'thunderstorm',96:'thunderstorm',99:'thunderstorm'};
const isWet=c=>c!=null&&((c>=51&&c<=67)||(c>=80&&c<=99));
const isSnow=c=>c!=null&&((c>=71&&c<=77)||c===85||c===86);
async function fetchWeather(d){
  if(!d.pts||!d.pts.length)return null;
  const p=d.pts[0], date=new Date(d.start), iso=date.toISOString().slice(0,10);
  const hour=date.getHours();
  const url='https://archive-api.open-meteo.com/v1/archive?latitude='+p[0].toFixed(3)+
    '&longitude='+p[1].toFixed(3)+'&start_date='+iso+'&end_date='+iso+
    '&hourly=temperature_2m,precipitation,weather_code,wind_speed_10m&timezone=auto';
  try{
    const r=await fetch(url);
    if(!r.ok)return null;
    const j=await r.json();
    if(!j.hourly||!j.hourly.time)return null;
    const i=Math.min(hour,j.hourly.time.length-1);
    return {t:j.hourly.temperature_2m[i],mm:j.hourly.precipitation[i],
      code:j.hourly.weather_code[i],wind:j.hourly.wind_speed_10m[i]};
  }catch(e){return null}
}
async function backfillWeather(){
  const todo=drives.filter(d=>!d.wx&&d.pts&&d.pts.length);
  if(!todo.length)return toast('Every drive already has weather.');
  toast('Fetching weather for '+todo.length+' drives…');
  let n=0;
  for(const d of todo){
    const w=await fetchWeather(d);
    if(w){d.wx=w;n++}
    await new Promise(r=>setTimeout(r,220));    // be polite to a free API
  }
  await saveV2(K_DRV,drives);render();
  toast(n+' drives updated. The archive lags about five days.');
}
function wxLine(d){
  if(!d.wx)return '';
  const w=d.wx;
  return Math.round(w.t)+'°C · '+(WX[w.code]||'—')+(w.mm>0?' · '+w.mm.toFixed(1)+' mm':'');
}

/* ---------- personal records ---------- */
function records(){
  if(!drives.length)return [];
  const byDay=new Map();
  drives.forEach(d=>{const k=dayKey(d.start);byDay.set(k,(byDay.get(k)||0)+d.dist)});
  const bestDay=Math.max(...byDay.values());
  const tw=drives.filter(d=>d.twist!=null);
  const sm=drives.filter(d=>smoothOf(d)!=null);
  const gg=drives.filter(d=>gOf(d)!=null);
  const out=[
    {k:'Longest drive',v:km(Math.max(...drives.map(d=>d.dist))).toFixed(1)+' km'},
    {k:'Biggest day',v:km(bestDay).toFixed(1)+' km'},
    {k:'Top speed',v:Math.round(Math.max(...drives.map(d=>d.top))*3.6)+' km/h'},
    {k:'Longest time out',v:hms(Math.max(...drives.map(d=>d.dur)))}
  ];
  if(tw.length)out.push({k:'Twistiest road',
    v:Math.max(...tw.map(d=>d.twist)).toFixed(0)+'°/km ('+twistLabel(Math.max(...tw.map(d=>d.twist)))+')'});
  if(sm.length)out.push({k:'Smoothest drive',v:Math.max(...sm.map(smoothOf))+'/100'});
  if(gg.length)out.push({k:'Hardest g',v:Math.max(...gg.map(gOf)).toFixed(2)+' g'});
  const cl=drives.map(gainOf).filter(v=>v);
  if(cl.length)out.push({k:'Biggest climb',v:Math.max(...cl)+' m'});
  return out;
}

/* ---------- weekly challenges ---------- */
function weekId(ts){
  const d=new Date(ts);const y=d.getFullYear();
  const jan=new Date(y,0,1);
  return y+'w'+Math.floor(((d-jan)/86400000+jan.getDay())/7);
}
function weekStart(){
  const d=new Date();d.setHours(0,0,0,0);
  d.setDate(d.getDate()-((d.getDay()+6)%7));   // Monday
  return d.getTime();
}
const CHALLENGES=[
  {id:'dist',   name:'Cover 120 km this week', xp:120, goal:120,unit:'km',
   f:w=>km(w.reduce((a,d)=>a+d.dist,0))},
  {id:'new',    name:'Find 8 km of road you have never driven', xp:200, goal:8,unit:'km',
   f:w=>newRoadKm(w)},
  {id:'smooth', name:'Two drives scoring 85+ for smoothness', xp:150, goal:2,unit:'drives',
   f:w=>w.filter(d=>smoothOf(d)!=null&&smoothOf(d)>=85).length},
  {id:'twist',  name:'Drive something twisty (140°/km or more)', xp:180, goal:1,unit:'drives',
   f:w=>w.filter(d=>d.twist!=null&&d.twist>=140).length},
  {id:'days',   name:'Drive on five separate days', xp:130, goal:5,unit:'days',
   f:w=>new Set(w.map(d=>dayKey(d.start))).size},
  {id:'long',   name:'One drive of 40 km or more', xp:160, goal:1,unit:'drives',
   f:w=>w.filter(d=>d.dist>=40000).length},
  {id:'dawn',   name:'A drive before 07:00', xp:110, goal:1,unit:'drives',
   f:w=>w.filter(d=>new Date(d.start).getHours()<7).length},
  {id:'climb',  name:'Climb 250 m in total', xp:140, goal:250,unit:'m',
   f:w=>w.reduce((a,d)=>a+(gainOf(d)||0),0)},
  {id:'gforce', name:'A drive touching 0.4 g', xp:150, goal:1,unit:'drives',
   f:w=>w.filter(d=>gOf(d)!=null&&gOf(d)>=.4).length},
  {id:'pb',     name:'Set a best time on a route you repeat', xp:170, goal:1,unit:'drives',
   f:w=>w.filter(d=>d.pb).length},
  {id:'night',  name:'A drive after 22:00', xp:120, goal:1,unit:'drives',
   f:w=>w.filter(d=>new Date(d.start).getHours()>=22).length},
  {id:'wet',    name:'Drive through the rain', xp:130, goal:1,unit:'drives',
   f:w=>w.filter(d=>d.wx&&isWet(d.wx.code)).length}
];
function newRoadKm(week){
  const before=new Set(), ws=weekStart();
  drives.filter(d=>d.start<ws).forEach(d=>(d.pts||[]).forEach(p=>before.add(cellKey(p[0],p[1]))));
  const fresh=new Set();
  week.forEach(d=>(d.pts||[]).forEach(p=>{const k=cellKey(p[0],p[1]);
    if(!before.has(k))fresh.add(k)}));
  return fresh.size*CELL/1000;
}
function thisWeek(){const ws=weekStart();return drives.filter(d=>d.start>=ws)}
/* A challenge you cannot win is worse than none. Climb and twist depend on
   terrain, so they only join the pool once your own drives show the terrain
   is there to find. */
function challengePool(){
  const hilly=drives.some(d=>(gainOf(d)||0)>=60);
  const bendy=drives.some(d=>d.twist!=null&&d.twist>=120);
  return CHALLENGES.filter(c=>
    (c.id!=='climb'||hilly)&&(c.id!=='twist'||bendy));
}
function activeChallenges(){
  const wk=weekId(Date.now());
  let seed=0;for(const c of wk)seed=(seed*31+c.charCodeAt(0))>>>0;
  const pool=challengePool();
  const out=[];
  for(let i=0;i<3&&pool.length;i++){
    seed=(seed*1103515245+12345)>>>0;
    out.push(pool.splice(seed%pool.length,1)[0]);
  }
  const w=thisWeek();
  return out.map(c=>{const have=c.f(w);
    return {...c,have,done:have>=c.goal,pctv:Math.min(100,have/c.goal*100)}});
}
function challengeXp(){
  const claimed=settings.claimed||{};
  return Object.values(claimed).reduce((a,v)=>a+v,0);
}
async function claimChallenges(){
  const wk=weekId(Date.now());
  settings.claimed=settings.claimed||{};
  let got=0;
  activeChallenges().forEach(c=>{
    const key=wk+':'+c.id;
    if(c.done&&!settings.claimed[key]){settings.claimed[key]=c.xp;got+=c.xp}
  });
  if(!got)return;
  await saveV2(K_SET,settings);
  toast('Challenge complete — +'+got+' xp');
  render();
}

/* ---------- ranks ---------- */
const RANKS=[[1,'Learner'],[5,'Commuter'],[10,'Regular'],[16,'Road tripper'],
  [24,'Long hauler'],[34,'Pathfinder'],[46,'Ironbutt'],[60,'Cartographer'],[80,'Legend']];
function rankOf(lvl){let r='Learner';RANKS.forEach(([n,t])=>{if(lvl>=n)r=t});return r}

/* ---------- share card ---------- */
function shareCard(d){
  const W=1080,H=1350,c=document.createElement('canvas');
  c.width=W;c.height=H;const x=c.getContext('2d');
  x.fillStyle='#0D0C08';x.fillRect(0,0,W,H);
  const grd=x.createRadialGradient(W/2,0,0,W/2,0,W);
  grd.addColorStop(0,'rgba(232,163,61,.16)');grd.addColorStop(1,'transparent');
  x.fillStyle=grd;x.fillRect(0,0,W,H);
  x.fillStyle='#EFE9D9';x.font='700 46px "Saira Condensed",sans-serif';
  x.letterSpacing='14px';x.fillText('ODO',80,120);
  x.fillStyle='#847E6C';x.font='400 26px "IBM Plex Mono",monospace';x.letterSpacing='2px';
  x.fillText(fmtDate(d.start).toUpperCase(),80,170);
  // route
  const pts=d.pts||[];
  if(pts.length>2){
    const la=pts.map(p=>p[0]),lo=pts.map(p=>p[1]);
    const y0=Math.min(...la),y1=Math.max(...la),x0=Math.min(...lo),x1=Math.max(...lo);
    const mid=(y0+y1)/2*Math.PI/180;
    const w=Math.max((x1-x0)*Math.cos(mid),1e-6),h=Math.max(y1-y0,1e-6);
    const s=Math.min(820/w,620/h),ox=(W-w*s)/2,oy=250+(620-h*s)/2;
    x.lineWidth=7;x.lineCap='round';x.lineJoin='round';
    for(let i=1;i<pts.length;i++){
      const A=[ox+(pts[i-1][1]-x0)*Math.cos(mid)*s,oy+620-(pts[i-1][0]-y0)*s];
      const B=[ox+(pts[i][1]-x0)*Math.cos(mid)*s,oy+620-(pts[i][0]-y0)*s];
      x.strokeStyle=speedColor(pts[i][3]||0);
      x.beginPath();x.moveTo(A[0],A[1]);x.lineTo(B[0],B[1]);x.stroke();
    }
  }
  const stats=[[km(d.dist).toFixed(1),'KM'],[hms(d.dur),'TIME'],
    [Math.round(d.top*3.6),'TOP KM/H'],[d.twist!=null?d.twist.toFixed(0)+'°':'–','PER KM']];
  stats.forEach((s,i)=>{
    const cx=80+i*245;
    x.fillStyle='#E8A33D';x.font='600 68px "Saira Condensed",sans-serif';x.letterSpacing='0px';
    x.fillText(String(s[0]),cx,1080);
    x.fillStyle='#847E6C';x.font='400 20px "IBM Plex Mono",monospace';x.letterSpacing='3px';
    x.fillText(s[1],cx,1120);
  });
  x.fillStyle='#EFE9D9';x.font='600 44px "Saira Condensed",sans-serif';x.letterSpacing='0px';
  x.fillText(d.name+(d.twist!=null?' · '+twistLabel(d.twist):''),80,1230);
  if(d.wx){x.fillStyle='#847E6C';x.font='400 24px "IBM Plex Mono",monospace';
    x.fillText(wxLine(d),80,1275)}
  return c;
}
async function shareDrive(id){
  const d=drives.find(x=>x.id===id);if(!d)return;
  const c=shareCard(d);
  const ph=d.hasPhoto?await getPhoto(id):null;
  if(ph){
    await new Promise(res=>{
      const im=new Image();
      im.onload=()=>{
        const x=c.getContext('2d');
        const s=Math.max(1080/im.width,520/im.height);
        const w=im.width*s,h=im.height*s;
        x.save();x.beginPath();x.rect(0,0,1080,520);x.clip();
        x.globalAlpha=.9;x.drawImage(im,(1080-w)/2,(520-h)/2,w,h);
        const gr=x.createLinearGradient(0,300,0,520);
        gr.addColorStop(0,'rgba(13,12,8,0)');gr.addColorStop(1,'#0D0C08');
        x.globalAlpha=1;x.fillStyle=gr;x.fillRect(0,300,1080,220);x.restore();
        res();
      };
      im.onerror=res;im.src=ph;
    });
  }
  c.toBlob(async b=>{
    const file=new File([b],'odo-drive.png',{type:'image/png'});
    if(navigator.canShare&&navigator.canShare({files:[file]})){
      try{await navigator.share({files:[file],title:d.name})}catch(e){}
    }else{
      const u=URL.createObjectURL(b);const a=document.createElement('a');
      a.href=u;a.download='odo-drive.png';a.click();
      setTimeout(()=>URL.revokeObjectURL(u),1000);
      toast('Card saved to downloads.');
    }
  },'image/png');
}

/* ---------- the friction circle ---------- */
function ggSvg(d){
  const s=ggSmooth(ggPoints(d),GG_WIN);
  if(s.length<12)return '';
  let mx=0;for(const q of s){const m=Math.hypot(q[0],q[1]);if(m>mx)mx=m}
  const lim=Math.max(.4,Math.ceil(mx*5)/5);
  const S=200,C=S/2,R=C-16;
  let rings='';
  for(let k=1;k*.2<=lim+1e-9;k++)
    rings+='<circle class="gg-ring" cx="'+C+'" cy="'+C+'" r="'+(k*.2/lim*R).toFixed(1)+'"/>';
  rings+='<text class="gg-t" x="'+C+'" y="'+(C-R+10).toFixed(1)+'" text-anchor="middle">'+
    lim.toFixed(1)+' g</text>';
  const dots=s.map(q=>'<circle cx="'+(C+q[0]/lim*R).toFixed(1)+'" cy="'+
    (C-q[1]/lim*R).toFixed(1)+'" r="1.8" fill="'+speedColor(q[2]||0)+'"/>').join('');
  const o=ggOf(d);
  return '<div class="cap">How hard you drove \u00b7 '+s.length+' samples from gps'+
    (o?' \u00b7 peak '+o.g.toFixed(2)+' g \u00b7 smoothness '+o.smooth:'')+
    '</div>'+
    '<svg class="gg-svg" viewBox="0 0 '+S+' '+S+'">'+
    '<line class="gg-ax" x1="'+C+'" y1="8" x2="'+C+'" y2="'+(S-8)+'"/>'+
    '<line class="gg-ax" x1="8" y1="'+C+'" x2="'+(S-8)+'" y2="'+C+'"/>'+
    rings+dots+'</svg>'+
    '<div class="gg-key">up accelerating \u00b7 down braking \u00b7 sideways cornering</div>';
}

/* ---------- route comparison ---------- */
function cumDist(pts){
  const out=[0];
  for(let i=1;i<pts.length;i++)out.push(out[i-1]+hav(pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1]));
  return out;
}
/* sample "seconds elapsed at distance x along the route" for two runs, then
   compare the pace in each 200 m slice */
function compareRuns(a,b){
  const ca=cumDist(a.pts), cb=cumDist(b.pts);
  const len=Math.min(ca[ca.length-1],cb[cb.length-1]);
  if(len<500)return null;
  const step=200, n=Math.floor(len/step);
  const at=(c,pts,dist)=>{
    let i=1;while(i<c.length-1&&c[i]<dist)i++;
    const f=(dist-c[i-1])/Math.max(c[i]-c[i-1],1e-6);
    return {t:pts[i-1][2]+(pts[i][2]-pts[i-1][2])*f,
            lat:pts[i-1][0]+(pts[i][0]-pts[i-1][0])*f,
            lng:pts[i-1][1]+(pts[i][1]-pts[i-1][1])*f};
  };
  const segs=[];
  for(let k=1;k<=n;k++){
    const d0=(k-1)*step,d1=k*step;
    const a0=at(ca,a.pts,d0),a1=at(ca,a.pts,d1);
    const b0=at(cb,b.pts,d0),b1=at(cb,b.pts,d1);
    segs.push({lat0:a0.lat,lng0:a0.lng,lat1:a1.lat,lng1:a1.lng,
      delta:(a1.t-a0.t)-(b1.t-b0.t)});     // negative = run A quicker here
  }
  return {segs,total:a.dur-b.dur};
}

/* ---------- calendar ---------- */
function calendar(){
  const days=new Map();
  drives.forEach(d=>{const k=dayKey(d.start);days.set(k,(days.get(k)||0)+d.dist)});
  const cells=[];
  const today=new Date();today.setHours(0,0,0,0);
  const start=new Date(today);start.setDate(start.getDate()-181);
  start.setDate(start.getDate()-((start.getDay()+6)%7));
  const max=Math.max(1,...days.values());
  for(let t=new Date(start);t<=today;t.setDate(t.getDate()+1)){
    const v=days.get(dayKey(t.getTime()))||0;
    cells.push({v,lvl:v?Math.min(4,1+Math.floor(v/max*3.99)):0,
      d:t.toLocaleDateString(undefined,{day:'numeric',month:'short'})});
  }
  return cells;
}
function renderCalendar(){
  const box=$('cal');if(!box)return;
  const cs=calendar();
  box.innerHTML=cs.map(c=>'<i class="l'+c.lvl+'" title="'+c.d+
    (c.v?' · '+km(c.v).toFixed(1)+' km':'')+'"></i>').join('');
}

/* ---------- extra rendering hooks ---------- */
function renderExtras(){
  // records
  const rec=records();
  $('records').innerHTML=rec.length
    ? rec.map(r=>'<div class="rec"><span class="k">'+r.k+'</span><span class="v">'+r.v+'</span></div>').join('')
    : '<div class="empty">No records yet.</div>';
  // challenges
  const ch=activeChallenges();
  $('chal').innerHTML=ch.map(c=>
    '<div class="ch'+(c.done?' done':'')+'"><div class="ch-top"><span class="n">'+c.name+
    '</span><span class="x">+'+c.xp+' xp</span></div>'+
    '<div class="ch-bar"><i style="width:'+c.pctv.toFixed(0)+'%"></i></div>'+
    '<div class="ch-n">'+(c.unit==='km'?c.have.toFixed(1):Math.round(c.have))+' / '+c.goal+' '+c.unit+
    (c.done?' · complete':'')+'</div></div>').join('');
  renderCalendar();
  // rank
  const lvl=Number($('lvl').textContent)||1;
  $('rankName').textContent=rankOf(lvl);
  claimChallenges();
}

/* ---------- route extras ---------- */
function rainNote(r){
  const wet=r.runs.filter(d=>d.wx&&isWet(d.wx.code)).map(d=>d.dur);
  const dry=r.runs.filter(d=>d.wx&&!isWet(d.wx.code)).map(d=>d.dur);
  if(wet.length<2||dry.length<2)return '';
  const diff=(median(wet)-median(dry))/60;
  if(Math.abs(diff)<0.5)return ' · rain makes no odds here';
  return ' · <b>'+(diff>0?'+':'−')+Math.abs(diff).toFixed(1)+' min</b> in the wet ('+
    wet.length+' wet, '+dry.length+' dry)';
}
function costNote(r){
  const c=r.runs.map(d=>costOf(d)).filter(v=>v!=null);
  if(!c.length)return '';
  const per=c.reduce((a,b)=>a+b,0)/c.length;
  return ' · <b>€'+per.toFixed(2)+'</b> a run, about €'+(per*2*230).toFixed(0)+' a year twice daily';
}

let rMap,rLayer,curRoute=null;
function openRoute(key){
  const r=buildRoutes().find(x=>x.key===key);if(!r)return;
  curRoute=r;
  $('rTitle').textContent=r.name;
  const runs=r.runs.slice().sort((a,b)=>a.dur-b.dur);
  const best=runs[0], last=r.runs[0];
  $('rSel').innerHTML=r.runs.map(d=>
    '<option value="'+d.id+'">'+fmtDate(d.start)+' · '+mins(d.dur)+
    (d.id===best.id?' (best)':'')+'</option>').join('');
  $('rSelB').innerHTML=r.runs.map(d=>
    '<option value="'+d.id+'"'+(d.id===best.id?' selected':'')+'>'+fmtDate(d.start)+' · '+mins(d.dur)+
    (d.id===best.id?' (best)':'')+'</option>').join('');
  $('rSel').value=last.id;
  $('sheetRoute').classList.add('on');
  drawCompare();
}
function drawCompare(){
  const a=drives.find(d=>d.id===$('rSel').value);
  const b=drives.find(d=>d.id===$('rSelB').value);
  if(!a||!b)return;
  const cmp=compareRuns(a,b);
  const tot=(a.dur-b.dur)/60;
  $('rDelta').innerHTML=(tot<=0?'Quicker by ':'Slower by ')+
    '<b>'+Math.abs(tot).toFixed(1)+' min</b> overall';
  $('rDelta').className='r-delta '+(tot<=0?'good':'bad');
  const info=[];
  if(a.wx)info.push(wxLine(a));
  if(b.wx)info.push('vs '+wxLine(b));
  $('rWx').textContent=info.join(' · ');
  setTimeout(()=>{
    if(typeof L==='undefined'||!cmp){
      $('rmap').innerHTML='<div class="empty" style="border:0">Not enough overlap to compare.</div>';return}
    if(!rMap){
      rMap=L.map('rmap');
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        {maxZoom:19,attribution:'© OpenStreetMap'}).addTo(rMap);
    }
    if(rLayer)rMap.removeLayer(rLayer);
    const all=[],segs=[];
    cmp.segs.forEach(s=>{
      all.push([s.lat0,s.lng0]);
      const col=s.delta<-1.5?'#5FA05F':s.delta>1.5?'#D2402A':'#847E6C';
      segs.push(L.polyline([[s.lat0,s.lng0],[s.lat1,s.lng1]],
        {color:col,weight:6,opacity:.9}));
    });
    rLayer=L.layerGroup(segs).addTo(rMap);
    rMap.invalidateSize();
    if(all.length)rMap.fitBounds(L.latLngBounds(all).pad(.12));
  },60);
}

/* ---------- leave by ----------
   bestWindow() already works out which quarter hour has been quickest on a
   route, but it only ever appeared on the route card, after the fact. This
   puts it in front of you while you are still deciding whether to go. */
function medianNear(runs,mins,within){
  const near=runs.filter(d=>{
    const t=new Date(d.start), m=t.getHours()*60+t.getMinutes();
    let diff=Math.abs(m-mins);
    if(diff>720)diff=1440-diff;
    return diff<=within;
  });
  return near.length>=2?{med:median(near.map(d=>d.dur)),n:near.length}:null;
}
function leaveCard(pos){
  const here=buildRoutes().filter(r=>
    r.from&&hav(r.from.lat,r.from.lng,pos.lat,pos.lng)<PLACE_R);
  if(!here.length)return '';
  const now=new Date(), nowM=now.getHours()*60+now.getMinutes();
  const out=[];
  here.slice(0,2).forEach(r=>{
    const w=bestWindow(r.runs);
    if(!w)return;
    const parts=w.label.split(':');
    const winM=(+parts[0])*60+(+parts[1]);
    let delta=winM-nowM;
    if(delta<-720)delta+=1440; else if(delta>720)delta-=1440;
    const soon=medianNear(r.runs,nowM,45);
    let line;
    if(Math.abs(delta)<=8){
      line='<b>'+esc(r.name)+'</b> is quickest right about now \u2014 '+
        mins(w.med)+' across '+w.n+' runs.';
    }else if(delta>0&&delta<=180){
      const gain=soon?soon.med-w.med:0;
      line='<b>'+esc(r.name)+'</b> has been quickest leaving around '+w.label+
        ', in '+delta+' min'+
        (gain>60?' \u2014 '+mins(w.med)+' then against '+mins(soon.med)+' now':
                 ' ('+mins(w.med)+', '+w.n+' runs)')+'.';
    }else{
      line='<b>'+esc(r.name)+'</b> has been quickest leaving around '+w.label+
        ' ('+mins(w.med)+', '+w.n+' runs).'+
        (soon?' From here at this hour you have averaged '+mins(soon.med)+'.':'');
    }
    out.push(line);
  });
  if(!out.length)return '';
  return '<div class="nudge">'+out.join('<br>')+'</div>';
}
function showLeave(){
  const el=$('leave');
  if(!el||!navigator.geolocation||rec)return;
  navigator.geolocation.getCurrentPosition(
    p=>{try{el.innerHTML=leaveCard({lat:p.coords.latitude,lng:p.coords.longitude})}catch(e){}},
    ()=>{},
    {enableHighAccuracy:false,maximumAge:600000,timeout:8000});
}

/* ---------- place names via Nominatim (one call per place, on request) ---------- */
async function nameePlaces(){
  const rs=buildRoutes();
  if(!rs.length)return toast('No repeated routes to name yet.');
  settings.placeNames=settings.placeNames||{};
  const seen=new Map();
  rs.forEach(r=>{r.runs.forEach(()=>{});
    seen.set(r.from.lat.toFixed(3)+','+r.from.lng.toFixed(3),r.from);
    seen.set(r.to.lat.toFixed(3)+','+r.to.lng.toFixed(3),r.to)});
  const todo=[...seen.entries()].filter(([k])=>
    !settings.placeNames[k]||settings.placeNames[k]==='Unknown');
  if(!todo.length)return toast('All places already named.');
  toast('Looking up '+todo.length+' places…');
  let ok=0,bad=0;
  for(const [k,p] of todo){
    try{
      const r=await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat='+
        p.lat+'&lon='+p.lng+'&zoom=16&addressdetails=1');
      const j=await r.json();
      const a=j.address||{};
      const nm=a.suburb||a.neighbourhood||a.village||a.town||a.city_district||
        a.city||a.municipality||j.name;
      if(nm){settings.placeNames[k]=nm;ok++}else bad++;
    }catch(e){bad++}
    await new Promise(r=>setTimeout(r,1200));   // Nominatim asks for max 1 req/sec
  }
  await saveV2(K_SET,settings);render();
  toast(ok?'Named '+ok+' place'+(ok>1?'s':'')+(bad?', '+bad+' not found':'')+'.'
          :'Could not reach the name service — try again in a minute.');
}
/* use the looked-up names when building route labels */
function placeLabel(p){
  const k=p.lat.toFixed(3)+','+p.lng.toFixed(3);
  const v=settings.placeNames&&settings.placeNames[k];
  return (v&&v!=='Unknown')?v:null;
}

/* ---------- CSV out, GPX in ---------- */
function toCsv(){
  const head='start,name,km,duration_s,moving_s,top_kmh,climb_m,twist_deg_per_km,'+
    'smoothness,peak_g,litres,cost_eur,temp_c,weather\n';
  return head+drives.slice().sort((a,b)=>a.start-b.start).map(d=>[
    new Date(d.start).toISOString(),JSON.stringify(d.name),km(d.dist).toFixed(2),
    Math.round(d.dur),Math.round(d.dur-(d.idle||0)),Math.round(d.top*3.6),gainOf(d)||0,
    d.twist!=null?d.twist:'',smoothOf(d)!=null?smoothOf(d):'',gOf(d)!=null?gOf(d):'',
    (fuelOf(d)||'')&&fuelOf(d).toFixed(2),(costOf(d)||'')&&costOf(d).toFixed(2),
    d.wx?d.wx.t:'',d.wx?(WX[d.wx.code]||''):''
  ].join(',')).join('\n');
}
function parseGpx(text){
  const doc=new DOMParser().parseFromString(text,'application/xml');
  const trks=[...doc.getElementsByTagName('trk')];
  const out=[];
  trks.forEach(trk=>{
    const tp=[...trk.getElementsByTagName('trkpt')];
    if(tp.length<4)return;
    const t0=new Date(tp[0].getElementsByTagName('time')[0]?.textContent||Date.now()).getTime();
    let dist=0,top=0,pts=[];
    for(let i=0;i<tp.length;i++){
      const la=+tp[i].getAttribute('lat'),lo=+tp[i].getAttribute('lon');
      const ele=tp[i].getElementsByTagName('ele')[0];
      const tm=tp[i].getElementsByTagName('time')[0];
      const t=tm?(new Date(tm.textContent).getTime()-t0)/1000:i;
      if(i){const d=hav(pts[i-1][0],pts[i-1][1],la,lo);dist+=d;
        const dt=t-pts[i-1][2];if(dt>0)top=Math.max(top,d/dt)}
      pts.push([+la.toFixed(5),+lo.toFixed(5),Math.round(t),0,ele?Math.round(+ele.textContent):null]);
    }
    for(let i=1;i<pts.length;i++){
      const dt=pts[i][2]-pts[i-1][2];
      if(dt>0)pts[i][3]=+(hav(pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1])/dt*3.6).toFixed(1);
    }
    let gain=0;
    for(let i=1;i<pts.length;i++){
      if(pts[i][4]!=null&&pts[i-1][4]!=null){const da=pts[i][4]-pts[i-1][4];if(da>0)gain+=da}
    }
    out.push({id:'gpx'+t0,name:driveName(t0),start:t0,
      dur:pts[pts.length-1][2],dist,top,pts,gain:Math.round(gain),idle:0,
      g:null,smooth:null,twist:twistOf(pts),carId:settings.activeCar||null,imported:true});
  });
  return out;
}

/* ---------- handlers for the new controls ---------- */
$('rClose').onclick=()=>$('sheetRoute').classList.remove('on');
$('rSel').onchange=drawCompare;
$('rSelB').onchange=drawCompare;
$('rRename').onclick=()=>{if(curRoute){renameRoute(curRoute.key);
  $('rTitle').textContent=settings.routeNames[curRoute.key]||curRoute.name}};
$('shShare').onclick=()=>{if(curDrive)shareDrive(curDrive)};
$('btnNamePlaces').onclick=nameePlaces;
$('btnWx').onclick=backfillWeather;
$('btnCsv').onclick=()=>{
  if(!drives.length)return toast('Nothing to export yet.');
  dl('odo-'+new Date().toISOString().slice(0,10)+'.csv',toCsv(),'text/csv');
  toast('CSV downloaded.');
};
$('btnGpxIn').onclick=()=>$('gpxIn').click();
$('gpxIn').onchange=async e=>{
  const files=[...e.target.files];if(!files.length)return;
  let added=0;
  for(const f of files){
    try{
      const txt=await f.text();
      const inc=parseGpx(txt);
      const have=new Set(drives.map(d=>d.id));
      inc.forEach(d=>{if(!have.has(d.id)&&d.dist>150){drives.push(d);added++}});
    }catch(err){}
  }
  coverCache=null;roadCache=null;shapeCache=null;routeElevCache=null;borderCache=null;fogCache=null;regionCache=null;regionNameCache=null;await saveV2(K_DRV,drives);render();
  toast(added?added+' tracks imported.':'Nothing usable in that file.');
  e.target.value='';
};

/* remember which drive the sheet is showing, for the share button */
let curDrive=null;
const _openDrive=openDrive;
openDrive=function(id){curDrive=id;_openDrive(id);
  const d=drives.find(x=>x.id===id);
  if(d){
    $('shTwist').textContent=d.twist!=null?Math.round(d.twist)+'°':'–';
    $('shSmooth').textContent=smoothOf(d)!=null?smoothOf(d):'–';
    $('shNew').textContent=d.newCells?((d.newCells*CELL/1000).toFixed(1)+' km'):'0';
    $('shWx').textContent=d.wx?Math.round(d.wx.t)+'°':'–';
    const fr=firstTimeSegments(0,0,d.id);
    $('shNew').textContent=fr.km>0.05?fr.km.toFixed(1)+' km':'0';
    $('shNewNote').innerHTML=fr.km>0.05
      ? 'The green highlight marks the '+fr.km.toFixed(1)+' km you had never driven before this day.'
      : 'Every road on this drive was one you had already driven.';
    $('shWx').title=wxLine(d);
  }
};

document.querySelectorAll('#logSel button').forEach(b=>{
  b.onclick=async()=>{settings.logKind=b.dataset.l;await saveV2(K_SET,settings);renderLogbook()};
});

/* ---------- stats selectors ---------- */
document.querySelectorAll('#periodSel button').forEach(b=>{
  b.onclick=async()=>{settings.statPeriod=b.dataset.p;await saveV2(K_SET,settings);renderStats()};
});
document.querySelectorAll('#modeSel button').forEach(b=>{
  b.onclick=async()=>{settings.statMode=b.dataset.m;await saveV2(K_SET,settings);renderStats()};
});

/* ============ boot ============ */
(async()=>{
  try{await IDB.open();idbOk=true}catch(e){idbOk=false}
  drives=await loadV2(K_DRV,[]);
  cars=await loadV2(K_CAR,[]);
  settings=Object.assign({activeCar:null,routeNames:{},claimed:{}},await loadV2(K_SET,{}));

  // one-off migration: copy anything still living in localStorage into IndexedDB,
  // and work out twistiness for drives recorded before it existed
  let dirty=false;
  drives.forEach(d=>{
    // twistV 3: earlier figures counted GPS wobble as cornering, so recompute
    // once rather than trusting what is stored
    if(d.twistV!==3){d.twist=twistOf(d.pts);d.twistV=3;dirty=true}
    if(d.newCells===undefined){d.newCells=0;dirty=true}
    if(d.accel===undefined){d.accel=accelOf(d);dirty=true}
    if(d.gainClean===undefined){d.gainClean=cleanGain(d.pts);dirty=true}
    // cornering and braking worked out from gps, for phones that report no
    // motion sensor. Kept beside d.g and d.smooth, never written over them.
    if(d.ggV!==3){const gg=ggOf(d);
      d.gGps=gg?gg.g:null;
      d.smoothGps=gg?gg.smooth:null;
      d.ggV=3;dirty=true}
  });
  if(settings.pbV!==1){if(markPbs())dirty=true;settings.pbV=1}
  else if(markPbs())dirty=true;
  if(idbOk||dirty){await saveV2(K_DRV,drives);await saveV2(K_CAR,cars);await saveV2(K_SET,settings)}

  render();
  diagnose();
  showLeave();
  if($('build'))$('build').textContent='Build '+BUILD;
  if('serviceWorker' in navigator){
    // if a worker was already driving this page and a new one takes over,
    // reload once so the whole app is running the same code
    const had=!!navigator.serviceWorker.controller;
    let reloading=false;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(!had||reloading)return;
      reloading=true;location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
})();

/* ================================================================
   Stats tab: a small SVG chart layer, styled like the rest of the dial
   ================================================================ */
const CH={w:340,h:150,pl:34,pr:8,pt:12,pb:20};
const AX='#847E6C';
function axes(o){
  const {pl,pr,pt,pb,w,h}=Object.assign({},CH,o||{});
  return {pl,pr,pt,pb,w,h,
    x:(f)=>pl+f*(w-pl-pr),
    y:(f)=>h-pb-f*(h-pt-pb)};
}
function svgWrap(inner,o){
  const g=Object.assign({},CH,o||{});
  return '<svg class="ch" viewBox="0 0 '+g.w+' '+g.h+'">'+inner+'</svg>';
}
function txt(x,y,s,cls,anchor){
  return '<text x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'"'+
    (anchor?' text-anchor="'+anchor+'"':'')+(cls?' class="'+cls+'"':'')+'>'+s+'</text>';
}
function shortDate(ts){
  return new Date(ts).toLocaleDateString(undefined,{day:'numeric',month:'short'});
}
function niceMax(v){
  if(v<=0)return 1;
  const p=Math.pow(10,Math.floor(Math.log10(v)));
  const n=v/p;
  return (n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*p;
}

/* ---------- period filter ---------- */
function periodDrives(){
  const p=settings.statPeriod||'all';
  if(p==='all')return drives.slice().sort((a,b)=>a.start-b.start);
  const cut=Date.now()-Number(p)*86400000;
  return drives.filter(d=>d.start>=cut).sort((a,b)=>a.start-b.start);
}

/* ---------- 1. cumulative XP / km / new road ---------- */
function chartCumulative(ds){
  const mode=settings.statMode||'xp';
  if(ds.length<2)return '<div class="empty">Two drives and this starts drawing.</div>';
  const a=axes({h:190});
  let run=0;
  const pts=ds.map(d=>{
    run+= mode==='xp'?driveXp(d) : mode==='km'?km(d.dist) : (d.newCells||0)*CELL/1000;
    return {t:d.start,v:run};
  });
  const t0=pts[0].t,t1=pts[pts.length-1].t,span=Math.max(t1-t0,1);
  const vmax=niceMax(run);
  const X=t=>a.x((t-t0)/span), Y=v=>a.y(v/vmax);
  let out='';
  // level thresholds behind the curve
  if(mode==='xp'){
    let lastY=1e9;
    for(let n=2;n<=400;n++){
      const th=need(n);
      if(th>vmax)break;
      const yy=Y(th);
      if(lastY-yy<15)continue;          // keep the labels legible
      lastY=yy;
      out+='<line class="grid" x1="'+a.pl+'" y1="'+yy.toFixed(1)+'" x2="'+(a.w-a.pr)+
        '" y2="'+yy.toFixed(1)+'"/>'+txt(a.w-a.pr-2,yy-3,'L'+n,'tick','end');
    }
  }
  const line=pts.map((p,i)=>(i?'L':'M')+X(p.t).toFixed(1)+' '+Y(p.v).toFixed(1)).join('');
  out+='<path class="fill" d="'+line+'L'+X(t1).toFixed(1)+' '+a.y(0)+'L'+X(t0).toFixed(1)+' '+a.y(0)+'Z"/>';
  out+='<path class="line" d="'+line+'"/>';
  out+='<circle class="dot" cx="'+X(t1).toFixed(1)+'" cy="'+Y(run).toFixed(1)+'" r="3.5"/>';
  out+=txt(a.pl-4,a.y(1)+4,String(Math.round(vmax)),'tick','end');
  out+=txt(a.pl-4,a.y(0),'0','tick','end');
  out+=txt(a.pl,a.h-6,shortDate(t0),'tick');
  out+=txt(a.w-a.pr,a.h-6,shortDate(t1),'tick','end');
  const unit=mode==='xp'?'xp':'km';
  return svgWrap(out,{h:190})+'<div class="ch-note"><b>'+Math.round(run).toLocaleString()+
    ' '+unit+'</b> over '+Math.round(span/86400000)+' days</div>';
}

/* ---------- 2. speed histogram ---------- */
function chartSpeed(ds){
  const bins=new Array(20).fill(0);          // 0-200 km/h in 10s
  ds.forEach(d=>{
    const p=d.pts||[];
    for(let i=1;i<p.length;i++){
      const dt=p[i][2]-p[i-1][2];
      if(dt<=0||dt>120)continue;
      const s=p[i][3]||0;
      bins[Math.min(19,Math.floor(s/10))]+=dt;
    }
  });
  const tot=bins.reduce((a,b)=>a+b,0);
  if(tot<60)return '<div class="empty">Not enough recorded time yet.</div>';
  const last=Math.max(6,bins.reduce((m,v,i)=>v>tot*0.001?i:m,0));
  const a=axes({h:170,pl:30});
  const max=Math.max(...bins);
  let out='';
  for(let i=0;i<=last;i++){
    const bw=(a.w-a.pl-a.pr)/(last+1);
    const x=a.pl+i*bw;
    let hgt=(a.y(0)-a.pt)*(bins[i]/max);
    if(bins[i]>0)hgt=Math.max(hgt,2);
    out+='<rect class="chbar" x="'+(x+1).toFixed(1)+'" y="'+(a.y(0)-hgt).toFixed(1)+
      '" width="'+(bw-2).toFixed(1)+'" height="'+hgt.toFixed(1)+
      '" style="fill:'+speedColor(i*10+5)+'"/>';
    if(i%2===0)out+=txt(x+bw/2,a.h-6,String(i*10),'tick','middle');
  }
  const med=(()=>{let acc=0;for(let i=0;i<bins.length;i++){acc+=bins[i];
    if(acc>=tot/2)return i*10+5}return 0})();
  out+=txt(a.pl-4,a.y(0),'0','tick','end');
  out+=txt(a.pl-4,a.pt+8,Math.round(max/60)+'m','tick','end');
  return svgWrap(out,{h:170})+'<div class="ch-note">Half your driving time is spent below <b>'+
    med+' km/h</b>. The tail on the right is where the good roads are.</div>';
}

/* ---------- 3. when you drive ---------- */
function chartWeekHour(ds){
  const g=Array.from({length:7},()=>new Array(24).fill(0));
  ds.forEach(d=>{
    const p=d.pts||[];
    for(let i=1;i<p.length;i++){
      const t=new Date(d.start+p[i][2]*1000);
      const day=(t.getDay()+6)%7;
      g[day][t.getHours()]+=hav(p[i-1][0],p[i-1][1],p[i][0],p[i][1]);
    }
  });
  const max=Math.max(...g.flat());
  if(max<=0)return '<div class="empty">Nothing to plot yet.</div>';
  const days=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  let out='<div class="grid-wrap"><div class="grid-days">'+
    days.map(d=>'<span>'+d+'</span>').join('')+'</div><div class="grid-cells">';
  for(let d=0;d<7;d++)for(let h=0;h<24;h++){
    const v=g[d][h], lvl=v?Math.min(4,1+Math.floor(v/max*3.99)):0;
    out+='<i class="l'+lvl+'" title="'+days[d]+' '+h+':00 · '+km(v).toFixed(1)+' km"></i>';
  }
  out+='</div></div><div class="grid-hours"><span>00</span><span>06</span><span>12</span>'+
    '<span>18</span><span>23</span></div>';
  return out;
}

/* ---------- 4. compass rose ---------- */
function chartCompass(ds){
  const N=16, bins=new Array(N).fill(0);
  ds.forEach(d=>{
    const p=d.pts||[];
    for(let i=1;i<p.length;i++){
      const dist=hav(p[i-1][0],p[i-1][1],p[i][0],p[i][1]);
      if(dist<20||(p[i][3]||0)<20)continue;
      const br=bearing(p[i-1][0],p[i-1][1],p[i][0],p[i][1]);
      bins[Math.floor(((br+360/N/2)%360)/(360/N))]+=dist;
    }
  });
  const max=Math.max(...bins);
  if(max<=0)return '<div class="empty">Nothing to plot yet.</div>';
  const S=240,c=S/2,R=S/2-26;
  let out='';
  [0.33,0.66,1].forEach(f=>out+='<circle class="grid" cx="'+c+'" cy="'+c+'" r="'+(R*f).toFixed(1)+'" fill="none"/>');
  bins.forEach((v,i)=>{
    if(v<=0)return;
    const r=R*Math.sqrt(v/max);
    const a0=(i*360/N-360/N/2-90)*Math.PI/180, a1=(i*360/N+360/N/2-90)*Math.PI/180;
    const p=(ang,rad)=>[(c+Math.cos(ang)*rad).toFixed(1),(c+Math.sin(ang)*rad).toFixed(1)];
    const A=p(a0,r),B=p(a1,r);
    out+='<path class="wedge" d="M'+c+' '+c+'L'+A[0]+' '+A[1]+
      'A'+r.toFixed(1)+' '+r.toFixed(1)+' 0 0 1 '+B[0]+' '+B[1]+'Z" opacity="'+
      (0.35+0.6*(v/max)).toFixed(2)+'"/>';
  });
  ['N','E','S','W'].forEach((l,i)=>{
    const ang=(i*90-90)*Math.PI/180;
    out+=txt(c+Math.cos(ang)*(R+14),c+Math.sin(ang)*(R+14)+4,l,'tick','middle');
  });
  const domi=bins.indexOf(max), dirs=['N','NNE','NE','ENE','E','ESE','SE','SSE',
    'S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return '<svg class="ch rose" viewBox="0 0 '+S+' '+S+'">'+out+'</svg>'+
    '<div class="ch-note">Most of your driving runs <b>'+dirs[domi]+'</b> and back.</div>';
}

/* ---------- 5. monthly distance and cost ---------- */
function chartMonthly(ds){
  const m=new Map();
  ds.forEach(d=>{
    const t=new Date(d.start), k=t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0');
    if(!m.has(k))m.set(k,{km:0,cost:0});
    const o=m.get(k);o.km+=km(d.dist);o.cost+=costOf(d)||0;
  });
  const keys=[...m.keys()].sort().slice(-14);
  if(keys.length<2)return '<div class="empty">Needs two months of driving.</div>';
  const a=axes({h:170,pl:32,pr:30});
  const vals=keys.map(k=>m.get(k).km), costs=keys.map(k=>m.get(k).cost);
  const max=niceMax(Math.max(...vals)), cmax=niceMax(Math.max(...costs,1));
  const bw=(a.w-a.pl-a.pr)/keys.length;
  let out='',lp='';
  keys.forEach((k,i)=>{
    const x=a.pl+i*bw, h=(a.y(0)-a.pt)*(m.get(k).km/max);
    out+='<rect class="chbar amber" x="'+(x+2).toFixed(1)+'" y="'+(a.y(0)-h).toFixed(1)+
      '" width="'+(bw-4).toFixed(1)+'" height="'+h.toFixed(1)+'"/>';
    const cy=a.y(m.get(k).cost/cmax);
    lp+=(i?'L':'M')+(x+bw/2).toFixed(1)+' '+cy.toFixed(1);
    if(i===0||i===keys.length-1||keys.length<8)
      out+=txt(x+bw/2,a.h-6,k.slice(2).replace('-','/'),'tick','middle');
  });
  if(Math.max(...costs)>0){
    out+='<path class="line cost" d="'+lp+'"/>';
    out+=txt(a.w-2,a.y(1)+4,'€'+Math.round(cmax),'tick','end');
  }
  out+=txt(a.pl-4,a.y(1)+4,String(Math.round(max)),'tick','end');
  out+=txt(a.pl-4,a.y(0),'0','tick','end');
  out+=txt(a.pl+4,a.pt+6,'km per month'+(Math.max(...costs)>0?' · line is fuel cost':''),'tick');
  return svgWrap(out,{h:170});
}

/* ---------- 6. record progression ---------- */
function chartRecords(){
  const ds=drives.slice().sort((a,b)=>a.start-b.start);
  if(ds.length<3)return '<div class="empty">Records need a few more drives.</div>';
  function step(key,fn,unit,fmt){
    const pts=[];let best=0;
    ds.forEach(d=>{const v=fn(d);if(v>best){best=v;pts.push({t:d.start,v})}});
    if(pts.length<2)return '';
    const a=axes({h:120,pl:36});
    const t0=ds[0].start,t1=Date.now(),span=Math.max(t1-t0,1);
    const vmax=best*1.12;
    const X=t=>a.x((t-t0)/span), Y=v=>a.y(v/vmax);
    let d='M'+X(pts[0].t).toFixed(1)+' '+Y(pts[0].v).toFixed(1);
    for(let i=1;i<pts.length;i++)
      d+='L'+X(pts[i].t).toFixed(1)+' '+Y(pts[i-1].v).toFixed(1)+
         'L'+X(pts[i].t).toFixed(1)+' '+Y(pts[i].v).toFixed(1);
    d+='L'+X(t1).toFixed(1)+' '+Y(best).toFixed(1);
    const days=Math.round((t1-pts[pts.length-1].t)/86400000);
    let out='<path class="line" d="'+d+'"/>';
    pts.forEach(p=>out+='<circle class="dot" cx="'+X(p.t).toFixed(1)+'" cy="'+Y(p.v).toFixed(1)+'" r="2.6"/>');
    out+=txt(a.pl+4,a.pt+6,key+' · now '+fmt(best),'tick');
    out+=txt(a.w-a.pr,a.pt+6,'standing '+days+' days','tick','end');
    return '<div class="ch-block">'+svgWrap(out,{h:120})+'</div>';
  }
  const out=step('Top speed',d=>d.top*3.6,'km/h',v=>Math.round(v)+' km/h')+
            step('Longest drive',d=>km(d.dist),'km',v=>v.toFixed(1)+' km')+
            step('Twistiest road',d=>d.twist||0,'°/km',v=>Math.round(v)+'°/km');
  return out||'<div class="empty">No record has been beaten twice yet.</div>';
}

/* ---------- 7. route trend ---------- */
function chartRouteTrend(){
  const rs=buildRoutes();
  if(!rs.length)return '<div class="empty">No repeated route yet.</div>';
  const r=rs[0];
  const runs=r.runs.slice().sort((a,b)=>a.start-b.start);
  if(runs.length<3)return '<div class="empty">Run it a few more times.</div>';
  const a=axes({h:170,pl:36});
  const t0=runs[0].start,t1=runs[runs.length-1].start,span=Math.max(t1-t0,1);
  const durs=runs.map(d=>d.dur);
  const lo=Math.min(...durs)*0.94, hi=Math.max(...durs)*1.06;
  const X=t=>a.x((t-t0)/span), Y=v=>a.y((v-lo)/(hi-lo));
  const sorted=durs.slice().sort((x,y)=>x-y);
  const q=f=>sorted[Math.floor(f*(sorted.length-1))];
  let out='<rect class="band" x="'+a.pl+'" y="'+Y(q(.75)).toFixed(1)+
    '" width="'+(a.w-a.pl-a.pr)+'" height="'+(Y(q(.25))-Y(q(.75))).toFixed(1)+'"/>';
  out+='<line class="md" x1="'+a.pl+'" y1="'+Y(r.med).toFixed(1)+'" x2="'+(a.w-a.pr)+
    '" y2="'+Y(r.med).toFixed(1)+'"/>';
  const many=runs.length>25;
  if(many){
    // a 7-run rolling median: the trend, without the day-to-day noise
    const roll=runs.map((_,i)=>{
      const w=runs.slice(Math.max(0,i-3),Math.min(runs.length,i+4)).map(x=>x.dur);
      return {t:runs[i].start,v:median(w)};
    });
    out+='<path class="line" d="'+roll.map((p,i)=>(i?'L':'M')+X(p.t).toFixed(1)+' '+
      Y(p.v).toFixed(1)).join('')+'"/>';
  }else{
    out+='<path class="line thin" d="'+runs.map((d,i)=>(i?'L':'M')+X(d.start).toFixed(1)+' '+
      Y(d.dur).toFixed(1)).join('')+'"/>';
  }
  runs.forEach(d=>out+='<circle class="dot '+(d.wx&&isWet(d.wx.code)?'wet':'dry')+
    '" cx="'+X(d.start).toFixed(1)+'" cy="'+Y(d.dur).toFixed(1)+'" r="'+(many?2:3)+'"/>');
  out+=txt(a.pl+4,a.pt+6,r.name+' · median '+mins(r.med),'tick');
  out+=txt(a.pl-4,Y(q(.75))+3,mins(q(.75)),'tick','end');
  out+=txt(a.pl-4,Y(q(.25))+3,mins(q(.25)),'tick','end');
  out+=txt(a.pl,a.h-6,shortDate(t0),'tick');
  out+=txt(a.w-a.pr,a.h-6,shortDate(t1),'tick','end');
  const trend=(()=>{
    if(runs.length<10)return '';
    const first=median(runs.slice(0,Math.floor(runs.length/3)).map(d=>d.dur));
    const last=median(runs.slice(-Math.floor(runs.length/3)).map(d=>d.dur));
    const dm=(last-first)/60;
    if(Math.abs(dm)<0.4)return ' Holding steady across the period.';
    return ' It has got <b>'+Math.abs(dm).toFixed(1)+' min '+(dm>0?'slower':'quicker')+
      '</b> since you started logging it.';
  })();
  return svgWrap(out,{h:170})+'<div class="ch-note">Blue dots are runs in the wet.'+trend+'</div>';
}

/* ---------- 8. weather split ---------- */
function chartWeather(ds){
  const g={dry:{km:0,t:0,d:0},wet:{km:0,t:0,d:0},snow:{km:0,t:0,d:0},fog:{km:0,t:0,d:0}};
  ds.forEach(d=>{
    if(!d.wx)return;
    const c=d.wx.code;
    const k=isSnow(c)?'snow':isWet(c)?'wet':(c===45||c===48)?'fog':'dry';
    g[k].km+=km(d.dist);g[k].t+=Math.max(d.dur-(d.idle||0),1);g[k].d++;
  });
  const tot=Object.values(g).reduce((a,o)=>a+o.km,0);
  if(tot<=0)return '<div class="empty">No weather data yet — try "Fetch past weather" in the Log tab.</div>';
  const order=['dry','wet','fog','snow'],col={dry:'#E8A33D',wet:'#4E86A8',fog:'#847E6C',snow:'#EFE9D9'};
  let bar='<div class="stackbar">'+order.filter(k=>g[k].km>0).map(k=>
    '<i style="width:'+(g[k].km/tot*100).toFixed(1)+'%;background:'+col[k]+'" title="'+k+'"></i>').join('')+'</div>';
  let rows=order.filter(k=>g[k].d>0).map(k=>{
    const sp=g[k].km/(g[k].t/3600);
    return '<div class="rec"><span class="k"><i class="sw" style="background:'+col[k]+'"></i>'+k+
      ' · '+g[k].d+' drives</span><span class="v">'+g[k].km.toFixed(0)+' km · '+
      sp.toFixed(0)+' km/h</span></div>';
  }).join('');
  let note='';
  if(g.dry.d>=2&&g.wet.d>=2){
    const sd=g.dry.km/(g.dry.t/3600), sw=g.wet.km/(g.wet.t/3600);
    const diff=(sd-sw)/sd*100;
    note='<div class="ch-note">You average <b>'+Math.abs(diff).toFixed(0)+'% '+
      (diff>0?'slower':'faster')+'</b> in the wet.</div>';
  }
  return bar+'<div class="recs" style="margin-top:10px">'+rows+'</div>'+note;
}

/* ---------- 9. new road per month ---------- */
function chartNewRoad(){
  const ds=drives.slice().sort((a,b)=>a.start-b.start);
  if(ds.length<2)return '<div class="empty">Nothing to plot yet.</div>';
  const seen=new Set(), m=new Map();
  ds.forEach(d=>{
    const t=new Date(d.start), k=t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0');
    let fresh=0;
    (d.pts||[]).forEach(p=>{const c=cellKey(p[0],p[1]);
      if(!seen.has(c)){seen.add(c);fresh++}});
    m.set(k,(m.get(k)||0)+fresh*CELL/1000);
  });
  const keys=[...m.keys()].sort().slice(-14);
  if(keys.length<2)return '<div class="empty">Needs two months of driving.</div>';
  const a=axes({h:150,pl:32});
  const max=niceMax(Math.max(...keys.map(k=>m.get(k))));
  const bw=(a.w-a.pl-a.pr)/keys.length;
  let out='';
  keys.forEach((k,i)=>{
    const x=a.pl+i*bw, h=(a.y(0)-a.pt)*(m.get(k)/max);
    out+='<rect class="chbar teal" x="'+(x+2).toFixed(1)+'" y="'+(a.y(0)-h).toFixed(1)+
      '" width="'+(bw-4).toFixed(1)+'" height="'+h.toFixed(1)+'"/>';
    if(i===0||i===keys.length-1||keys.length<8)
      out+=txt(x+bw/2,a.h-6,k.slice(2).replace('-','/'),'tick','middle');
  });
  out+=txt(a.pl-4,a.y(1)+4,String(Math.round(max)),'tick','end');
  out+=txt(a.pl-4,a.y(0),'0','tick','end');
  out+=txt(a.pl+4,a.pt+6,'km of road driven for the first time','tick');
  return svgWrap(out,{h:150});
}

/* ---------- render ---------- */
function renderStats(){
  if(!$('statCum'))return;
  const ds=periodDrives();
  document.querySelectorAll('#periodSel button').forEach(b=>
    b.classList.toggle('on',b.dataset.p===(settings.statPeriod||'all')));
  document.querySelectorAll('#modeSel button').forEach(b=>
    b.classList.toggle('on',b.dataset.m===(settings.statMode||'xp')));
  $('statCum').innerHTML=chartCumulative(ds);
  $('statSpeed').innerHTML=chartSpeed(ds);
  $('statWeek').innerHTML=chartWeekHour(ds);
  $('statRose').innerHTML=chartCompass(ds);
  $('statBorders').innerHTML=bordersHtml();
  $('statRegions').innerHTML=regionsHtml();
  $('statMonth').innerHTML=chartMonthly(ds);
  $('statRec').innerHTML=chartRecords();
  $('statRoute').innerHTML=chartRouteTrend();
  $('statWx').innerHTML=chartWeather(ds);
  $('statNew').innerHTML=chartNewRoad();
}

/* ================================================================
   Sun position, acceleration records, road scoring
   ================================================================ */

/* ---------- where the sun was (NOAA approximation, no network) ---------- */
function sunElevation(lat,lng,ts){
  const d=new Date(ts);
  const rad=Math.PI/180;
  const start=Date.UTC(d.getUTCFullYear(),0,0);
  const doy=(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-start)/86400000;
  const frac=(d.getUTCHours()+d.getUTCMinutes()/60+d.getUTCSeconds()/3600)/24;
  const g=(357.529+0.98560028*(doy+frac))*rad;                 // mean anomaly
  const q=280.459+0.98564736*(doy+frac);                       // mean longitude
  const L=(q+1.915*Math.sin(g)+0.020*Math.sin(2*g))*rad;       // ecliptic longitude
  const e=(23.439-0.00000036*(doy+frac))*rad;                  // obliquity
  const dec=Math.asin(Math.sin(e)*Math.sin(L));
  const eqt=4*((q*rad-0.0057183-Math.atan2(Math.cos(e)*Math.sin(L),Math.cos(L)))/rad%360);
  const tst=(frac*1440+eqt+4*lng)%1440;
  const ha=(tst/4-180)*rad;
  const el=Math.asin(Math.sin(lat*rad)*Math.sin(dec)+
    Math.cos(lat*rad)*Math.cos(dec)*Math.cos(ha));
  return el/rad;
}
function lightOf(d){
  if(!d.pts||!d.pts.length)return null;
  const p=d.pts[0];
  const a=sunElevation(p[0],p[1],d.start);
  const b=sunElevation(p[0],p[1],d.start+d.dur*1000);
  const band=e=>e<-6?'night':e<-0.5?'twilight':e<6?'golden':'day';
  return {start:+a.toFixed(1),end:+b.toFixed(1),band:band(a),
    crossed:band(a)!==band(b)?band(b):null};
}
/* how much of every drive ran in the dark, sampled along the route */
function lightTotals(ds){
  const out={night:0,twilight:0,golden:0,day:0};
  ds.forEach(d=>{
    const p=d.pts||[];
    for(let i=1;i<p.length;i++){
      const dist=hav(p[i-1][0],p[i-1][1],p[i][0],p[i][1]);
      const e=sunElevation(p[i][0],p[i][1],d.start+p[i][2]*1000);
      out[e<-6?'night':e<-0.5?'twilight':e<6?'golden':'day']+=dist;
    }
  });
  return out;
}

/* ---------- acceleration records ---------- */
/* GPS speed at roughly 1 Hz is not a drag strip, but it is consistent, so
   the numbers are comparable against each other even if a touch optimistic */
function accelRun(pts,from,to){
  if(!pts||pts.length<4)return null;
  let best=null;
  for(let i=0;i<pts.length-1;i++){
    if(pts[i][3]>from)continue;
    if(pts[i+1][3]<=pts[i][3])continue;
    // interpolate the moment we crossed `from`
    const t0=interpT(pts,i,from);
    if(t0==null)continue;
    for(let j=i+1;j<pts.length;j++){
      if(pts[j][3]<pts[j-1][3]-6)break;          // lifted off, run is over
      if(pts[j][3]>=to){
        const t1=interpT(pts,j-1,to);
        if(t1!=null&&t1>t0){const dt=t1-t0;if(!best||dt<best)best=dt}
        break;
      }
    }
  }
  return best?+best.toFixed(2):null;
}
function interpT(pts,i,v){
  const a=pts[i],b=pts[i+1];
  if(!b)return null;
  if(b[3]===a[3])return a[2];
  const f=(v-a[3])/(b[3]-a[3]);
  if(f<0||f>1)return null;
  return a[2]+(b[2]-a[2])*f;
}
/* a genuine full-throttle pull, not thirty seconds of easing up to speed:
   anything slower than these is traffic, not a record */
const ACC_CAP={a100:22,a50:12,a50100:16};
function accelOf(d){
  const raw={a100:accelRun(d.pts,0,100),a50:accelRun(d.pts,0,50),a50100:accelRun(d.pts,50,100)};
  Object.keys(raw).forEach(k=>{if(raw[k]!=null&&raw[k]>ACC_CAP[k])raw[k]=null});
  return raw;
}
function bestAccel(){
  const out={a100:null,a50:null,a50100:null,when:{}};
  drives.forEach(d=>{
    const a=d.accel||accelOf(d);
    ['a100','a50','a50100'].forEach(k=>{
      if(a[k]!=null&&(out[k]==null||a[k]<out[k])){out[k]=a[k];out.when[k]=d.start}
    });
  });
  return out;
}

/* ---------- best roads you have personally driven ---------- */
const SEG_LEN=2000;
function segmentDrives(){
  const segs=[];
  drives.forEach(d=>{
    const p=d.pts||[];
    if(p.length<8)return;
    let acc=0,startIdx=0;
    for(let i=1;i<p.length;i++){
      acc+=hav(p[i-1][0],p[i-1][1],p[i][0],p[i][1]);
      if(acc>=SEG_LEN||i===p.length-1){
        if(acc>SEG_LEN*0.6){
          const slice=p.slice(startIdx,i+1);
          segs.push(scoreSegment(slice,acc,d));
        }
        startIdx=i;acc=0;
      }
    }
  });
  // one entry per stretch of road: same place, same direction, keep the best
  const seen=new Map();
  segs.filter(Boolean).forEach(s=>{
    if(seen.has(s.key)){
      const o=seen.get(s.key);
      o.runs++;
      if(s.score>o.score)seen.set(s.key,Object.assign(s,{runs:o.runs}));
    }else{s.runs=1;seen.set(s.key,s)}
  });
  return [...seen.values()].sort((a,b)=>b.score-a.score);
}
function scoreSegment(pts,dist,drive){
  const twist=twistOf(pts);
  if(twist==null)return null;
  let gain=0,lo=1e9,hi=-1e9,moving=0,stopped=0;
  for(let i=1;i<pts.length;i++){
    const a=pts[i-1][4],b=pts[i][4];
    if(a!=null&&b!=null){if(b>a)gain+=b-a;lo=Math.min(lo,b);hi=Math.max(hi,b)}
    const dt=pts[i][2]-pts[i-1][2];
    if(dt>0){if((pts[i][3]||0)<8)stopped+=dt;else moving+=dt}
  }
  const relief=(hi>-1e9?hi-lo:0);
  const flow=moving+stopped>0?moving/(moving+stopped):1;
  const avg=pts.reduce((a,p)=>a+(p[3]||0),0)/pts.length;
  // curvature carries it, relief and uninterrupted flow support it,
  // and crawling traffic drags it down however bendy the road is
  const score=Math.round(
    Math.min(twist,260)/260*56 +
    Math.min(relief,120)/120*17 +
    flow*13 +
    Math.min(avg,100)/100*8 +
    (drive.rating?drive.rating/5*6:0));
  const mid=pts[Math.floor(pts.length/2)];
  const br=bearing(pts[0][0],pts[0][1],pts[pts.length-1][0],pts[pts.length-1][1]);
  return {key:cellKey(mid[0],mid[1])+'|'+Math.round(br/45),
    lat:mid[0],lng:mid[1],pts,dist,twist,relief:Math.round(relief),
    gain:Math.round(gain),avg:Math.round(avg),flow,score,
    driveId:drive.id,when:drive.start};
}

/* ================================================================
   Replay, including two runs racing each other
   ================================================================ */
let rp={map:null,layer:null,timer:null,t:0,playing:false,a:null,b:null,speed:4,markers:[]};
function openReplay(id,againstId){
  const a=drives.find(d=>d.id===id);if(!a||!a.pts||a.pts.length<3)return;
  const b=againstId?drives.find(d=>d.id===againstId):null;
  rp.a=a;rp.b=b;rp.t=0;rp.playing=false;rp.speed=4;
  $('rpTitle').textContent=b?'Race · '+a.name:'Replay · '+a.name;
  $('rpRange').max=Math.round(Math.max(a.dur,b?b.dur:0));
  $('rpRange').value=0;
  // offer any other run of the same route to race against
  const route=buildRoutes().find(r=>r.runs.some(x=>x.id===a.id));
  const opts=route?route.runs.filter(x=>x.id!==a.id):[];
  $('rpAgainst').innerHTML='<option value="">Solo replay</option>'+
    opts.map(d=>'<option value="'+d.id+'"'+(b&&b.id===d.id?' selected':'')+'>vs '+
      fmtDate(d.start)+' · '+mins(d.dur)+'</option>').join('');
  $('sheetReplay').classList.add('on');
  $('rpPlay').textContent='Play';
  setTimeout(()=>{
    if(typeof L==='undefined'){$('rpmap').innerHTML=
      '<div class="empty" style="border:0">Replay needs the map to load.</div>';return}
    if(!rp.map){
      rp.map=L.map('rpmap',{zoomControl:false});
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        {maxZoom:19,attribution:'© OpenStreetMap'}).addTo(rp.map);
    }
    if(rp.layer)rp.map.removeLayer(rp.layer);
    const lineA=a.pts.map(p=>[p[0],p[1]]);
    const base=[L.polyline(lineA,{color:'#4A4433',weight:5,opacity:.8})];
    rp.trace=L.polyline([],{color:'#E8A33D',weight:5});
    base.push(rp.trace);
    rp.markers=[L.circleMarker(lineA[0],{radius:7,color:'#E8A33D',fillColor:'#E8A33D',fillOpacity:1,weight:2})];
    base.push(rp.markers[0]);
    if(b){
      rp.traceB=L.polyline([],{color:'#4E86A8',weight:4,opacity:.9});
      base.push(rp.traceB);
      rp.markers.push(L.circleMarker([b.pts[0][0],b.pts[0][1]],
        {radius:6,color:'#4E86A8',fillColor:'#4E86A8',fillOpacity:1,weight:2}));
      base.push(rp.markers[1]);
    }
    rp.layer=L.layerGroup(base).addTo(rp.map);
    rp.map.invalidateSize();rp.map.fitBounds(L.latLngBounds(lineA).pad(.1));
    drawFrame(0);
  },60);
}
const CUM=new WeakMap();
function atTime(d,t){
  const p=d.pts;
  if(t<=0)return {lat:p[0][0],lng:p[0][1],spd:p[0][3]||0,dist:0,i:0};
  let i=1;while(i<p.length-1&&p[i][2]<t)i++;
  const a=p[i-1],b=p[i];
  const f=Math.max(0,Math.min(1,(t-a[2])/Math.max(b[2]-a[2],1e-6)));
  let cum=CUM.get(d);
  if(!cum){cum=cumDist(p);CUM.set(d,cum)}     // cached off the object, never serialised
  return {lat:a[0]+(b[0]-a[0])*f,lng:a[1]+(b[1]-a[1])*f,
    spd:(a[3]||0)+((b[3]||0)-(a[3]||0))*f,
    dist:cum[i-1]+(cum[i]-cum[i-1])*f,i};
}
function drawFrame(t){
  const a=rp.a;if(!a)return;
  const pa=atTime(a,Math.min(t,a.dur));
  if(rp.trace){
    const upto=a.pts.filter(p=>p[2]<=t).map(p=>[p[0],p[1]]);
    upto.push([pa.lat,pa.lng]);
    rp.trace.setLatLngs(upto);
    rp.markers[0].setLatLng([pa.lat,pa.lng]);
  }
  $('rpSpeed').textContent=Math.round(pa.spd);
  $('rpDist').textContent=km(pa.dist).toFixed(1);
  $('rpClock').textContent=hms(Math.min(t,a.dur));
  if(rp.b){
    const pb=atTime(rp.b,Math.min(t,rp.b.dur));
    const uptoB=rp.b.pts.filter(p=>p[2]<=t).map(p=>[p[0],p[1]]);
    uptoB.push([pb.lat,pb.lng]);
    if(rp.traceB){rp.traceB.setLatLngs(uptoB);rp.markers[1].setLatLng([pb.lat,pb.lng])}
    const gap=pa.dist-pb.dist;                       // metres ahead
    const rel=gap>=0?'ahead':'behind';
    $('rpGap').innerHTML='<b>'+Math.abs(Math.round(gap))+' m</b> '+rel;
    $('rpGap').className='rp-gap '+(gap>=0?'good':'bad');
  }else $('rpGap').innerHTML='<b>'+Math.round(pa.spd)+'</b> km/h';
  $('rpRange').value=Math.round(t);
}
function playPause(){
  if(rp.playing){stopReplay();return}
  rp.playing=true;$('rpPlay').textContent='Pause';
  let last=performance.now();
  const end=Math.max(rp.a.dur,rp.b?rp.b.dur:0);
  rp.timer=setInterval(()=>{
    const now=performance.now();
    rp.t+=(now-last)/1000*rp.speed;last=now;
    if(rp.t>=end){rp.t=end;drawFrame(rp.t);stopReplay();return}
    drawFrame(rp.t);
  },60);
}
function stopReplay(){
  rp.playing=false;clearInterval(rp.timer);rp.timer=null;
  if($('rpPlay'))$('rpPlay').textContent='Play';
}

/* ================================================================
   Season / year in review
   ================================================================ */
function reviewCards(months){
  const cut=Date.now()-months*30.44*86400000;
  const ds=drives.filter(d=>d.start>=cut);
  if(ds.length<3)return null;
  const tot=ds.reduce((a,d)=>a+d.dist,0);
  const hrs=ds.reduce((a,d)=>a+d.dur,0)/3600;
  const byMonth=new Map();
  ds.forEach(d=>{const t=new Date(d.start),k=t.toLocaleDateString(undefined,{month:'long'});
    byMonth.set(k,(byMonth.get(k)||0)+d.dist)});
  const bigMonth=[...byMonth.entries()].sort((a,b)=>b[1]-a[1])[0];
  const fastest=ds.slice().sort((a,b)=>b.top-a.top)[0];
  const twisty=ds.filter(d=>d.twist!=null).sort((a,b)=>b.twist-a.twist)[0];
  const longest=ds.slice().sort((a,b)=>b.dist-a.dist)[0];
  const light=lightTotals(ds);
  const rs=buildRoutes().map(r=>({r,n:r.runs.filter(d=>d.start>=cut).length}))
    .sort((a,b)=>b.n-a.n)[0];
  const newKm=ds.reduce((a,d)=>a+(d.newCells||0),0)*CELL/1000;
  const days=new Set(ds.map(d=>dayKey(d.start))).size;
  const cards=[
    {k:'Distance',v:km(tot).toFixed(0)+' km',s:'across '+ds.length+' drives on '+days+' days'},
    {k:'Time at the wheel',v:hrs.toFixed(0)+' h',s:(hrs/24).toFixed(1)+' full days of your life'},
    {k:'Busiest month',v:bigMonth?bigMonth[0]:'–',s:bigMonth?km(bigMonth[1]).toFixed(0)+' km':''},
    {k:'In the dark',v:km(light.night).toFixed(0)+' km',s:
      Math.round(light.night/Math.max(tot,1)*100)+'% of everything you drove'},
    {k:'Golden hour',v:km(light.golden).toFixed(0)+' km',s:'sun low, roads orange'},
    {k:'Longest single drive',v:km(longest.dist).toFixed(0)+' km',s:fmtDate(longest.start)},
    {k:'Fastest you went',v:Math.round(fastest.top*3.6)+' km/h',s:fmtDate(fastest.start)}
  ];
  if(twisty)cards.push({k:'Twistiest road',v:Math.round(twisty.twist)+'°/km',
    s:twistLabel(twisty.twist)+' · '+fmtDate(twisty.start)});
  if(rs&&rs.n>1)cards.push({k:'Most repeated route',v:rs.r.name,s:rs.n+' runs, median '+mins(rs.r.med)});
  if(newKm>0)cards.push({k:'Road you had never driven',v:newKm.toFixed(0)+' km',s:'first time on all of it'});
  const l=ds.reduce((a,d)=>a+(fuelOf(d)||0),0);
  if(l>0)cards.push({k:'Fuel burned',v:l.toFixed(0)+' L',s:'about €'+
    ds.reduce((a,d)=>a+(costOf(d)||0),0).toFixed(0)});
  return cards;
}

/* ================================================================
   Diary: a photo, a note and a rating per drive
   ================================================================ */
const PHOTO_KEY=id=>'odo.photo.'+id;
async function savePhoto(id,dataUrl){
  if(idbOk){try{await IDB.set(PHOTO_KEY(id),dataUrl);return true}catch(e){}}
  try{localStorage.setItem(PHOTO_KEY(id),dataUrl);return true}
  catch(e){toast('No room for the photo — IndexedDB is unavailable here.');return false}
}
async function getPhoto(id){
  if(idbOk){try{const v=await IDB.get(PHOTO_KEY(id));if(v)return v}catch(e){}}
  try{return localStorage.getItem(PHOTO_KEY(id))}catch(e){return null}
}
async function delPhoto(id){
  if(idbOk){try{await IDB.set(PHOTO_KEY(id),null)}catch(e){}}
  try{localStorage.removeItem(PHOTO_KEY(id))}catch(e){}
}
/* shrink before storing: a phone photo is several MB, this lands around 200 kB */
function shrink(file,max){
  return new Promise((res,rej)=>{
    const img=new Image(), url=URL.createObjectURL(file);
    img.onload=()=>{
      const s=Math.min(1,max/Math.max(img.width,img.height));
      const c=document.createElement('canvas');
      c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);
      c.getContext('2d').drawImage(img,0,0,c.width,c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg',0.82));
    };
    img.onerror=()=>{URL.revokeObjectURL(url);rej('bad image')};
    img.src=url;
  });
}
async function setRating(id,n){
  const d=drives.find(x=>x.id===id);if(!d)return;
  d.rating=(d.rating===n)?null:n;
  await saveV2(K_DRV,drives);
  renderStars(id);renderDrives();renderRoads();
}
function renderStars(id){
  const d=drives.find(x=>x.id===id);if(!d)return;
  $('shStars').innerHTML=[1,2,3,4,5].map(n=>
    '<button class="star'+((d.rating||0)>=n?' on':'')+'" data-star="'+n+'">★</button>').join('')+
    '<span class="star-note">'+(d.rating?'rated '+d.rating+'/5':'rate this drive')+'</span>';
  $('shStars').querySelectorAll('.star').forEach(b=>
    b.onclick=()=>setRating(id,Number(b.dataset.star)));
}
async function renderDiary(id){
  const d=drives.find(x=>x.id===id);if(!d)return;
  renderStars(id);
  $('shNote').value=d.note||'';
  const ph=await getPhoto(id);
  $('shPhoto').innerHTML=ph
    ? '<img src="'+ph+'" alt="Photo from this drive"><button class="mini" id="shPhotoDel">Remove photo</button>'
    : '';
  if(ph)$('shPhotoDel').onclick=async()=>{await delPhoto(id);d.hasPhoto=false;
    await saveV2(K_DRV,drives);renderDiary(id);renderDrives()};
}

/* ================================================================
   Best roads you have driven
   ================================================================ */
let roadCache=null;
function renderRoads(){
  const box=$('roads');if(!box)return;
  const segs=roadCache||(roadCache=segmentDrives());
  if(!segs.length){
    box.innerHTML='<div class="empty">Drive a bit further and the good stretches will show up here.</div>';
    return;
  }
  const top=segs.slice(0,10);
  box.innerHTML=top.map((s,i)=>{
    const lab=twistLabel(s.twist);
    const title=lab.charAt(0).toUpperCase()+lab.slice(1)+' · '+Math.round(s.twist)+'°/km';
    return '<button class="road" data-drive="'+s.driveId+'">'+
      '<div class="road-rank">'+(i+1)+'</div>'+glyph(s.pts)+
      '<div class="d-main"><div class="d-title">'+title+'</div>'+
      '<div class="d-sub">'+(s.dist/1000).toFixed(1)+' km · '+s.relief+' m · '+
      s.avg+' km/h'+(s.runs>1?' · '+s.runs+'×':'')+'</div></div>'+
      '<div class="d-dist">'+s.score+'<s>score</s></div></button>';
  }).join('');
  box.querySelectorAll('.road').forEach(b=>b.onclick=()=>openDrive(b.dataset.drive));
  const best=segs[0];
  $('roadNote').innerHTML='Scored on curvature, elevation and how freely you moved. '+
    'Your best stretch so far rates <b>'+best.score+'/100</b>'+
    (segs.length>10?' out of '+segs.length+' stretches':'')+'.';
}

/* ================================================================
   Which way to go next
   ================================================================ */
function thinnestDirection(){
  if(!drives.length)return null;
  const home=drives[0].pts&&drives[0].pts[0];
  if(!home)return null;
  const N=8,bins=new Array(N).fill(0);
  const dirs=['N','NE','E','SE','S','SW','W','NW'];
  coverage().cells.forEach((v,k)=>{
    const [a,b]=k.split(':').map(Number);
    const dLat=CELL/111320, dLng=CELL/(111320*Math.cos(home[0]*Math.PI/180));
    const lat=a*dLat, lng=b*dLng;
    const dist=hav(home[0],home[1],lat,lng);
    if(dist<3000)return;
    const br=bearing(home[0],home[1],lat,lng);
    bins[Math.floor(((br+22.5)%360)/45)]++;
  });
  const min=Math.min(...bins), idx=bins.indexOf(min);
  const max=Math.max(...bins);
  if(max<8)return null;
  return {dir:dirs[idx],cells:min,best:dirs[bins.indexOf(max)],bestCells:max};
}

/* ---------- render hooks for the new panels ---------- */
function renderAccel(){
  const b=bestAccel();
  const rows=[['0–100 km/h',b.a100,'a100'],['0–50 km/h',b.a50,'a50'],['50–100 km/h',b.a50100,'a50100']];
  const any=rows.some(r=>r[1]!=null);
  $('statAccel').innerHTML=any
    ? rows.map(r=>'<div class="rec"><span class="k">'+r[0]+'</span><span class="v">'+
        (r[1]!=null?r[1].toFixed(2)+' s':'–')+'</span></div>').join('')+
      '<div class="rec"><span class="k" style="text-transform:none;letter-spacing:0">'+
      'From 1 Hz GPS, so treat these as consistent rather than exact.</span><span class="v"></span></div>'
    : '<div class="empty">No full-throttle run recorded yet.</div>';
}
function renderLight(){
  const t=lightTotals(periodDrives());
  const tot=t.night+t.twilight+t.golden+t.day;
  if(tot<=0){$('statLight').innerHTML='<div class="empty">Nothing to plot yet.</div>';return}
  const parts=[['day','Daylight','#E8A33D'],['golden','Golden hour','#C4892C'],
    ['twilight','Twilight','#7A6A8A'],['night','Dark','#3F5B6B']];
  $('statLight').innerHTML='<div class="stackbar">'+parts.filter(p=>t[p[0]]>0).map(p=>
    '<i style="width:'+(t[p[0]]/tot*100).toFixed(1)+'%;background:'+p[2]+'" title="'+p[1]+'"></i>').join('')+
    '</div><div class="recs" style="margin-top:10px">'+parts.filter(p=>t[p[0]]>0).map(p=>
    '<div class="rec"><span class="k"><i class="sw" style="background:'+p[2]+'"></i>'+p[1]+
    '</span><span class="v">'+km(t[p[0]]).toFixed(0)+' km</span></div>').join('')+'</div>'+
    '<div class="ch-note">Worked out from the sun\'s angle at your position and time — no guessing at clock hours.</div>';
}
function renderReview(){
  const months=Number(settings.revRange||12);
  document.querySelectorAll('#revSel button').forEach(b=>
    b.classList.toggle('on',b.dataset.r===String(months)));
  const cards=reviewCards(months);
  $('review').innerHTML=cards
    ? cards.map(c=>'<div class="rev"><div class="k">'+c.k+'</div><div class="v">'+c.v+
        '</div><div class="s">'+c.s+'</div></div>').join('')
    : '<div class="empty">Not enough drives in this period yet.</div>';
}
const COMPASS=['N','NE','E','SE','S','SW','W','NW'];
function compassOf(br){return COMPASS[Math.floor(((br+22.5)%360)/45)]}

/* ---------- where to go next ----------
   thinnestDirection() says which way the map is emptiest, which is true but
   not actionable: an empty sector may be farmland, water, or simply nowhere
   anyone would want to go. This names somewhere specific instead, out of
   roads you have already driven and already scored, picked on how good you
   found it and how long it has been since. It all comes from your own
   drives, so it cannot invent a road that is not there. */
function homePlace(){
  const tally=new Map();
  buildRoutes().forEach(r=>[r.from,r.to].forEach(q=>{
    if(!q)return;
    const k=q.lat.toFixed(3)+','+q.lng.toFixed(3);
    const e=tally.get(k)||{p:q,n:0};
    e.n+=r.runs.length;tally.set(k,e);
  }));
  let best=null;
  tally.forEach(e=>{if(!best||e.n>best.n)best=e});
  if(best)return best.p;
  const f=drives[0]&&drives[0].pts&&drives[0].pts[0];
  return f?{lat:f[0],lng:f[1]}:null;
}
function tripFuel(metres){
  const c=cars.find(x=>x.id===settings.activeCar)||cars[0];
  if(!c)return null;
  const rate=measuredL100(c)||c.l100;
  if(!rate)return null;
  const l=km(metres)*rate/100;
  const st=fuelStats(c);
  const price=(st&&st.last&&st.last.pricePerL)||c.price;
  return {l,cost:price?l*price:null};
}
function driveSuggestion(){
  const home=homePlace();
  if(!home)return '';
  const segs=roadCache||(roadCache=segmentDrives());
  if(segs.length<3)return '';
  const now=Date.now(), MON=1000*86400*30.4;
  const cand=segs.map(x=>{
    const away=hav(home.lat,home.lng,x.lat,x.lng);
    return {x,away,rank:x.score+Math.min((now-x.when)/MON,12)*2.5};
  }).filter(c=>c.away>3000&&c.away<70000);
  if(!cand.length)return '';
  cand.sort((a,b)=>b.rank-a.rank);
  const c=cand[0], x=c.x;
  const trip=c.away*2+x.dist;
  const avg=Math.max(40,Math.min(90,x.avg||60));
  const f=tripFuel(trip);
  const when=new Date(x.when).toLocaleDateString(undefined,{month:'long',year:'numeric'});
  return '<b>Head '+compassOf(bearing(home.lat,home.lng,x.lat,x.lng))+'.</b> A '+
    twistLabel(x.twist)+' stretch about '+(c.away/1000).toFixed(0)+
    ' km out that you scored <b>'+x.score+'/100</b>'+
    (x.runs>1?' over '+x.runs+' runs':'')+', best run '+when+
    '. There and back is roughly '+(trip/1000).toFixed(0)+' km and '+
    Math.round(trip/1000/avg*60)+' min'+
    (f&&f.cost!=null?', about \u20ac'+f.cost.toFixed(2)+' of fuel':
     f?', about '+f.l.toFixed(1)+' L of fuel':'')+'.';
}
function renderNudge(){
  const n=thinnestDirection();
  const dir=n
    ? 'You have barely been <b>'+n.dir+'</b> of home — it is your emptiest direction, against '+
      n.bestCells+' cells covered to the '+n.best+'. Worth a Sunday.'
    : 'Drive a bit more and this will tell you which direction from home you have neglected.';
  let sug='';
  try{sug=driveSuggestion()}catch(e){}
  $('nudge').innerHTML=sug?sug+'<br><br>'+dir:dir;
}

/* ---------- handlers: replay, diary, review ---------- */
$('rpClose').onclick=()=>{stopReplay();$('sheetReplay').classList.remove('on')};
$('rpPlay').onclick=playPause;
$('rpFaster').onclick=()=>{
  rp.speed=rp.speed>=32?1:rp.speed*2;
  $('rpRate').textContent=rp.speed+'×';
};
$('rpRange').oninput=e=>{stopReplay();rp.t=Number(e.target.value);drawFrame(rp.t)};
$('rpAgainst').onchange=e=>{stopReplay();openReplay(rp.a.id,e.target.value||null)};
$('shReplay').onclick=()=>{if(curDrive){$('sheet').classList.remove('on');openReplay(curDrive)}};

$('shAddPhoto').onclick=()=>$('photoIn').click();
$('photoIn').onchange=async e=>{
  const f=e.target.files[0];if(!f||!curDrive)return;
  try{
    const url=await shrink(f,1280);
    if(await savePhoto(curDrive,url)){
      const d=drives.find(x=>x.id===curDrive);
      if(d){d.hasPhoto=true;await saveV2(K_DRV,drives)}
      renderDiary(curDrive);renderDrives();toast('Photo saved to this device.');
    }
  }catch(err){toast('Could not read that image.')}
  e.target.value='';
};
$('shSaveNote').onclick=async()=>{
  if(!curDrive)return;
  const d=drives.find(x=>x.id===curDrive);if(!d)return;
  d.note=$('shNote').value.slice(0,500);
  await saveV2(K_DRV,drives);renderDrives();toast('Note saved.');
};
document.querySelectorAll('#revSel button').forEach(b=>{
  b.onclick=async()=>{settings.revRange=b.dataset.r;await saveV2(K_SET,settings);renderReview()};
});
$('btnRevShare').onclick=()=>{
  const cards=reviewCards(Number(settings.revRange||12));
  if(!cards)return toast('Not enough drives yet.');
  const W=1080,H=1350,c=document.createElement('canvas');
  c.width=W;c.height=H;const x=c.getContext('2d');
  x.fillStyle='#0D0C08';x.fillRect(0,0,W,H);
  const g=x.createRadialGradient(W/2,0,0,W/2,0,W);
  g.addColorStop(0,'rgba(232,163,61,.18)');g.addColorStop(1,'transparent');
  x.fillStyle=g;x.fillRect(0,0,W,H);
  x.fillStyle='#EFE9D9';x.font='700 44px "Saira Condensed",sans-serif';x.letterSpacing='14px';
  x.fillText('ODO',80,110);
  x.fillStyle='#847E6C';x.font='400 24px "IBM Plex Mono",monospace';x.letterSpacing='3px';
  x.fillText((settings.revRange==='3'?'LAST THREE MONTHS':'LAST TWELVE MONTHS'),80,158);
  cards.slice(0,8).forEach((cd,i)=>{
    const y=250+i*130;
    x.fillStyle='#847E6C';x.font='400 20px "IBM Plex Mono",monospace';x.letterSpacing='2px';
    x.fillText(cd.k.toUpperCase(),80,y);
    x.fillStyle='#E8A33D';x.font='600 52px "Saira Condensed",sans-serif';x.letterSpacing='0px';
    x.fillText(String(cd.v),80,y+56);
    x.fillStyle='#6E6A5E';x.font='400 22px "Saira",sans-serif';
    x.fillText(cd.s,80,y+88);
  });
  c.toBlob(async b=>{
    const file=new File([b],'odo-review.png',{type:'image/png'});
    if(navigator.canShare&&navigator.canShare({files:[file]})){
      try{await navigator.share({files:[file],title:'My driving year'})}catch(e){}
    }else{
      const u=URL.createObjectURL(b);const a=document.createElement('a');
      a.href=u;a.download='odo-review.png';a.click();
      setTimeout(()=>URL.revokeObjectURL(u),1000);toast('Card saved to downloads.');
    }
  },'image/png');
};

/* extend the drive sheet with the new readouts */
const _openDrive2=openDrive;
openDrive=function(id){
  _openDrive2(id);
  const d=drives.find(x=>x.id===id);if(!d)return;
  const a=d.accel||accelOf(d);
  $('shA100').textContent=a.a100!=null?a.a100.toFixed(1)+'s':'–';
  $('shA50').textContent=a.a50!=null?a.a50.toFixed(1)+'s':'–';
  $('shA50100').textContent=a.a50100!=null?a.a50100.toFixed(1)+'s':'–';
  const l=lightOf(d);
  $('shLight').textContent=l?l.band:'–';
  renderDiary(id);
  renderXpBreak(id);
};

/* ================================================================
   The logbook: an observation engine, not a template.
   Each detector looks at a period and either stays quiet or returns one
   sentence with a score. The writer picks the few most interesting and
   arranges them. Most months, most detectors say nothing.
   ================================================================ */

/* ---------- numbers a person would say out loud ---------- */
function hkm(m){
  const k=m/1000;
  if(k<10)return k.toFixed(1)+' km';
  if(k<60)return Math.round(k)+' km';
  const r=Math.round(k/50)*50;
  if(Math.abs(k-r)<r*0.012)return r.toLocaleString()+' km';
  return (k<r?'just under ':'just over ')+r.toLocaleString()+' km';
}
const WORDS=['no','one','two','three','four','five','six','seven','eight','nine','ten',
  'eleven','twelve'];
function spell(n){return (n>=0&&n<=12&&Number.isInteger(n))?WORDS[n]:n.toLocaleString()}
const DIRW={N:'north',NE:'north-east',E:'east',SE:'south-east',S:'south',
  SW:'south-west',W:'west',NW:'north-west'};
function dirWord(d){return DIRW[d]||d}
function routeLabel(r){
  return /^[A-Z] → [A-Z]$/.test(r.name) ? 'your most-driven route' : r.name;
}
function hhrs(s){
  const h=s/3600;
  if(h<1.5)return Math.round(s/60)+' minutes';
  if(h<10)return h.toFixed(1).replace('.0','')+' hours';
  return 'about '+Math.round(h)+' hours';
}
function hmin(s){
  const m=s/60;
  return m<1.5? Math.round(s)+' seconds' : (m<10? m.toFixed(1).replace('.0','') : Math.round(m))+' minutes';
}
function monthName(ts){return new Date(ts).toLocaleDateString(undefined,{month:'long'})}
function monthYear(ts){return new Date(ts).toLocaleDateString(undefined,{month:'long',year:'numeric'})}
function dayName(n){return ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][n]}
function inDays(n){
  if(n<=0)return 'any day now';
  if(n<14)return 'in about '+Math.round(n)+' days';
  if(n<60)return 'in about '+Math.round(n/7)+' weeks';
  return 'around '+new Date(Date.now()+n*86400000).toLocaleDateString(undefined,{month:'long'});
}

/* ---------- periods ---------- */
function periodsOf(kind,count){
  const out=[],now=new Date();
  for(let i=0;i<count;i++){
    let a,b,label;
    if(kind==='month'){
      const d=new Date(now.getFullYear(),now.getMonth()-i,1);
      a=d.getTime();b=new Date(d.getFullYear(),d.getMonth()+1,1).getTime();
      label=monthYear(a);
    }else if(kind==='week'){
      const d=new Date(now);d.setHours(0,0,0,0);
      d.setDate(d.getDate()-((d.getDay()+6)%7)-i*7);
      a=d.getTime();b=a+7*86400000;
      label='Week of '+new Date(a).toLocaleDateString(undefined,{day:'numeric',month:'short'});
    }else{
      const d=new Date(now.getFullYear()-i,0,1);
      a=d.getTime();b=new Date(d.getFullYear()+1,0,1).getTime();
      label=String(d.getFullYear());
    }
    out.push({kind,a,b,label});
  }
  return out.reverse();
}

/* ---------- everything a detector might want to know ---------- */
function buildCtx(p){
  const ds=drives.filter(d=>d.start>=p.a&&d.start<p.b).sort((a,b)=>a.start-b.start);
  const before=drives.filter(d=>d.start<p.a);
  const span=p.b-p.a;
  const prev=drives.filter(d=>d.start>=p.a-span&&d.start<p.a);
  const sum=(arr,f)=>arr.reduce((x,d)=>x+f(d),0);
  const c={
    p,ds,before,prev,n:ds.length,
    km:sum(ds,d=>d.dist), kmPrev:sum(prev,d=>d.dist),
    secs:sum(ds,d=>d.dur),
    days:new Set(ds.map(d=>dayKey(d.start))).size,
    newKm:sum(ds,d=>(d.newCells||0))*CELL/1000,
    newKmPrev:sum(prev,d=>(d.newCells||0))*CELL/1000,
    light:ds.length?lightTotals(ds):{night:0,twilight:0,golden:0,day:0},
    lightPrev:prev.length?lightTotals(prev):{night:0,twilight:0,golden:0,day:0},
    fuel:sum(ds,d=>fuelOf(d)||0), cost:sum(ds,d=>costOf(d)||0),
    costPrev:sum(prev,d=>costOf(d)||0)
  };
  const max=(arr,f)=>arr.length?Math.max(...arr.map(f)):0;
  c.topNow=max(ds,d=>d.top); c.topBefore=max(before,d=>d.top);
  c.longNow=max(ds,d=>d.dist); c.longBefore=max(before,d=>d.dist);
  c.twistNow=max(ds.filter(d=>d.twist!=null),d=>d.twist);
  c.twistBefore=max(before.filter(d=>d.twist!=null),d=>d.twist);
  const acc=arr=>{const v=arr.map(d=>(d.accel||{}).a100).filter(x=>x!=null);
    return v.length?Math.min(...v):null};
  c.accNow=acc(ds); c.accBefore=acc(before);
  const sm=arr=>{const v=arr.map(smoothOf).filter(x=>x!=null);
    return v.length?v.reduce((a,b)=>a+b,0)/v.length:null};
  c.smoothNow=sm(ds); c.smoothPrev=sm(prev);
  c.gNow=max(ds.filter(d=>gOf(d)!=null),gOf);
  c.gBefore=max(before.filter(d=>gOf(d)!=null),gOf);
  // biggest single day
  const byDay=new Map();
  ds.forEach(d=>byDay.set(dayKey(d.start),(byDay.get(dayKey(d.start))||0)+d.dist));
  c.bigDay=[...byDay.entries()].sort((a,b)=>b[1]-a[1])[0]||null;
  c.routes=buildRoutes();
  c.total=sum(drives.filter(d=>d.start<p.b),d=>d.dist);
  return c;
}

/* ---------- the detectors ---------- */
const DETECTORS=[
/* --- records --- */
{id:'rec-long',cat:'record',f:c=>{
  if(!c.before.length||c.longNow<=c.longBefore)return null;
  const worth=c.longBefore>c.longNow*0.6;
  return {s:88,tone:'good',h:'A new longest drive: '+hkm(c.longNow)+'.',
    t:'You set a new longest drive at '+hkm(c.longNow)+'.',
    c:worth?'The record before it had stood at '+hkm(c.longBefore)+'.'
      :'Nothing you had driven before came close.'};
}},
{id:'near-long',cat:'record',f:c=>{
  if(!c.before.length||c.longNow>=c.longBefore)return null;
  const gap=c.longBefore-c.longNow;
  if(gap>c.longBefore*0.04||gap<50)return null;
  return {s:78,tone:'bad',h:'You missed your longest ever drive by '+Math.round(gap)+' m.',
    t:'One drive came within '+Math.round(gap)+' m of your longest ever.',
    c:'Either bad luck or a failure of nerve.'};
}},
{id:'rec-acc',cat:'record',f:c=>{
  if(c.accNow==null)return null;
  if(c.accBefore!=null&&c.accNow>=c.accBefore)return null;
  return {s:80,tone:'good',h:'A new best 0–100 at '+c.accNow.toFixed(1)+' seconds.',
    t:'Your best 0–100 came down to '+c.accNow.toFixed(1)+' seconds.',
    c:c.accBefore!=null?'It shaved '+(c.accBefore-c.accNow).toFixed(1)+
      ' seconds off the run that stood before it.'
      :'It is the first full-throttle pull the log has caught.'};
}},
{id:'rec-twist',cat:'record',f:c=>{
  if(!c.twistNow||c.twistNow<=c.twistBefore||c.twistNow<45)return null;
  return {s:72,tone:'good',h:'The twistiest road you have driven yet.',
    t:'You found the twistiest road in your log, turning through '+
      Math.round(c.twistNow)+'° every kilometre.',
    c:'It turned through '+Math.round(c.twistNow)+'° in every kilometre.'};
}},
{id:'rec-g',cat:'machine',f:c=>{
  if(!c.gNow||c.gNow<=c.gBefore||c.gNow<0.35)return null;
  return {s:55,tone:'good',t:'At the hardest point you pulled '+c.gNow.toFixed(2)+
    ' g, more than any drive before it.'};
}},
/* --- distance and rhythm --- */
{id:'dist-swing',cat:'distance',f:c=>{
  if(!c.prev.length||!c.km)return null;
  const r=c.km/c.kmPrev;
  if(r>0.85&&r<1.18)return null;
  const pct=Math.abs(Math.round((r-1)*100));
  return {s:58,tone:r>1?'good':'bad',h:'You covered '+hkm(c.km)+'.',
    t:'You covered '+hkm(c.km)+', '+pct+'% '+(r>1?'more':'less')+' than the period before.',
    c:'That is '+pct+'% '+(r>1?'more':'less')+' than the period before.'};
}},
{id:'quietest',cat:'distance',f:c=>{
  if(c.p.kind!=='month'||!c.km)return null;
  const months=[];
  for(let i=1;i<=12;i++){
    const d=new Date(new Date(c.p.a).getFullYear(),new Date(c.p.a).getMonth()-i,1);
    const a=d.getTime(),b=new Date(d.getFullYear(),d.getMonth()+1,1).getTime();
    const k=drives.filter(x=>x.start>=a&&x.start<b).reduce((s,x)=>s+x.dist,0);
    if(k>0)months.push({label:monthName(a),k,a});
  }
  if(months.length<2)return null;
  const lower=months.find(m=>m.k<c.km);
  const higher=months.find(m=>m.k>c.km);
  if(!higher&&months.length>=3)
    return {s:70,tone:'good',h:'Your biggest month of driving yet.',
      t:'It was your biggest month of driving yet, ahead of '+months[0].label+'.',
      c:'It went past '+months[0].label+', which had held the record until now.'};
  if(!lower&&months.length>=3)
    return {s:66,tone:'bad',h:'Your quietest month in '+spell(months.length)+' months.',
      t:'It was the quietest month in the '+spell(months.length)+' you have on record.',
      c:'Nothing else on record comes in lower.'};
  const since=months.findIndex(m=>m.k<c.km);
  if(since>=2)return {s:60,tone:'bad',t:'It was your quietest stretch since '+months[since].label+'.'};
  return null;
}},
{id:'round-total',cat:'milestone',f:c=>{
  const before=c.total-c.km, step=1000000;   // every 1000 km
  const crossed=Math.floor(c.total/step)-Math.floor(before/step);
  if(crossed<=0)return null;
  const mark=(Math.floor(c.total/step)*1000).toLocaleString();
  return {s:86,tone:'good',h:'The odometer rolled past '+mark+' km.',
    t:'Somewhere in there the odometer rolled past '+mark+' km.',
    c:'It happened somewhere in the middle of it, without ceremony.'};
}},
{id:'days-out',cat:'rhythm',f:c=>{
  if(!c.n||c.p.kind==='week')return null;
  const total=Math.round((Math.min(c.p.b,Date.now())-c.p.a)/86400000);
  if(!total)return null;
  const pct=Math.round(c.days/total*100);
  if(pct>=85)return {s:52,tone:'neutral',
    t:'You drove on '+c.days+' of '+total+' days — barely a day off.'};
  if(pct<=25)return {s:48,tone:'bad',
    t:'The car moved on only '+spell(c.days)+' days out of '+total+'.'};
  return null;
}},
/* --- the commute --- */
{id:'commute-drift',cat:'commute',f:c=>{
  const r=c.routes.map(r=>({r,runs:r.runs.filter(d=>d.start>=c.p.a&&d.start<c.p.b)}))
    .filter(x=>x.runs.length>=4).sort((a,b)=>b.runs.length-a.runs.length)[0];
  if(!r)return null;
  const inPeriod=median(r.runs.map(d=>d.dur));
  const baseRuns=r.r.runs.filter(d=>d.start<c.p.a);
  if(baseRuns.length<4)return null;
  const base=median(baseRuns.map(d=>d.dur));
  const diff=(inPeriod-base)/60;
  if(Math.abs(diff)<0.75)return null;
  const lab=routeLabel(r.r);
  return {s:76,tone:diff>0?'bad':'good',
    h:(lab.charAt(0).toUpperCase()+lab.slice(1))+' '+(diff>0?'lost':'found')+' '+
      hmin(Math.abs(diff)*60)+' a run.',
    t:'Across '+spell(r.runs.length)+' runs, '+lab+' came in '+hmin(Math.abs(diff)*60)+' '+
      (diff>0?'slower':'quicker')+' than its long-run average.',
    c:'That is measured across '+spell(r.runs.length)+
      ' runs, so it is a pattern rather than one bad day.'};
}},
{id:'commute-weekday',cat:'commute',f:c=>{
  const r=c.routes.map(r=>({r,runs:r.runs.filter(d=>d.start>=c.p.a&&d.start<c.p.b)}))
    .filter(x=>x.runs.length>=8).sort((a,b)=>b.runs.length-a.runs.length)[0];
  if(!r)return null;
  const by=new Map();
  r.runs.forEach(d=>{const k=(new Date(d.start).getDay()+6)%7;
    if(!by.has(k))by.set(k,[]);by.get(k).push(d.dur)});
  const rows=[...by.entries()].filter(x=>x[1].length>=2)
    .map(([k,v])=>({k,m:median(v)})).sort((a,b)=>b.m-a.m);
  if(rows.length<3)return null;
  const worst=rows[0],best=rows[rows.length-1];
  const diff=(worst.m-best.m)/60;
  if(diff<1.5)return null;
  return {s:64,tone:'bad',h:dayName(worst.k)+'s are your worst day on the road.',
    t:dayName(worst.k)+'s cost '+hmin(diff*60)+' more than '+dayName(best.k)+
      's on exactly the same stretch.',
    c:'They cost '+hmin(diff*60)+' more than '+dayName(best.k)+'s on the same stretch.'};
}},
{id:'depart-drift',cat:'commute',f:c=>{
  const r=c.routes.map(r=>({r,runs:r.runs.filter(d=>d.start>=c.p.a&&d.start<c.p.b)
    .sort((a,b)=>a.start-b.start)})).filter(x=>x.runs.length>=8)
    .sort((a,b)=>b.runs.length-a.runs.length)[0];
  if(!r)return null;
  const mins=d=>{const t=new Date(d.start);return t.getHours()*60+t.getMinutes()};
  const half=Math.floor(r.runs.length/2);
  const early=median(r.runs.slice(0,half).map(mins));
  const late=median(r.runs.slice(half).map(mins));
  const shift=late-early;
  if(Math.abs(shift)<4)return null;
  const dEarly=median(r.runs.slice(0,half).map(d=>d.dur));
  const dLate=median(r.runs.slice(half).map(d=>d.dur));
  const saved=(dEarly-dLate)/60;
  const shifted='you were leaving '+Math.abs(Math.round(shift))+' minutes '+
    (shift>0?'later':'earlier')+' by the end of the period';
  const effect=Math.abs(saved)>0.6
    ? 'It '+(saved>0?'bought you ':'cost you ')+hmin(Math.abs(saved)*60)+' a run.'
    : 'It made no measurable difference either way.';
  return {s:82,tone:saved>0.6?'good':(saved<-0.6?'bad':'neutral'),
    h:'You drifted to leaving '+Math.abs(Math.round(shift))+' minutes '+
      (shift>0?'later':'earlier')+'.',
    t:'Without meaning to, '+shifted+'. '+effect, c:effect};
}},
{id:'route-best',cat:'commute',f:c=>{
  for(const r of c.routes){
    const inP=r.runs.filter(d=>d.start>=c.p.a&&d.start<c.p.b);
    if(!inP.length)continue;
    const bestIn=Math.min(...inP.map(d=>d.dur));
    const bestBefore=r.runs.filter(d=>d.start<c.p.a).map(d=>d.dur);
    if(!bestBefore.length)continue;
    if(bestIn<Math.min(...bestBefore))
      return {s:68,t:'You set a new best on '+r.name+' at '+mins(bestIn)+'.'};
  }
  return null;
}},
{id:'route-rain',cat:'weather',f:c=>{
  const r=c.routes[0];if(!r)return null;
  const inP=r.runs.filter(d=>d.start>=c.p.a&&d.start<c.p.b&&d.wx);
  const wet=inP.filter(d=>isWet(d.wx.code)).map(d=>d.dur);
  const dry=inP.filter(d=>!isWet(d.wx.code)).map(d=>d.dur);
  if(wet.length<2||dry.length<2)return null;
  const diff=(median(wet)-median(dry))/60;
  if(Math.abs(diff)<0.6)return null;
  return {s:44,tone:'bad',t:'Rain added '+hmin(Math.abs(diff)*60)+' to '+
    routeLabel(r)+' on average.'};
}},
/* --- exploration --- */
{id:'new-road',cat:'explore',f:c=>{
  if(!c.n)return null;
  if(c.newKm<0.4)
    return {s:62,tone:'bad',h:'Not one new road.',
      t:'You did not drive a single road you had not already driven.',
      c:'Every metre was ground you had already covered.'};
  if(c.newKmPrev>0&&c.newKm>c.newKmPrev*2)
    return {s:64,tone:'good',h:Math.round(c.newKm)+' km of road you had never driven.',
      t:'Some '+Math.round(c.newKm)+' km of it was road you had never driven before.',
      c:'That is more than double the period before.'};
  return {s:46,tone:'good',t:'About '+Math.round(c.newKm)+
    ' km of what you drove was new ground.'};
}},
{id:'direction-gap',cat:'explore',sticky:1,f:c=>{
  const n=thinnestDirection();
  if(!n||n.cells>n.bestCells*0.25)return null;
  return {s:66,tone:'bad',
    h:'Almost everything you drive lies '+dirWord(n.best)+' of home.',
    t:'Almost everything you drive lies '+dirWord(n.best)+' of home, and the roads to the '+
      dirWord(n.dir)+' remain more or less untouched.',
    c:'The roads to the '+dirWord(n.dir)+' remain more or less untouched.'};
}},
{id:'far-point',cat:'explore',f:c=>{
  if(!c.ds.length||!drives[0]||!drives[0].pts)return null;
  const home=drives[0].pts[0];
  let far=0,when=null;
  c.ds.forEach(d=>(d.pts||[]).forEach(p=>{
    const x=hav(home[0],home[1],p[0],p[1]);
    if(x>far){far=x;when=d.start}
  }));
  const beforeFar=Math.max(0,...c.before.flatMap(d=>(d.pts||[]).map(p=>
    hav(home[0],home[1],p[0],p[1]))));
  if(far<=beforeFar||far<20000)return null;
  return {s:58,tone:'good',t:'You got '+hkm(far)+
    ' from home, further out than you had ever been.'};
}},
/* --- light --- */
{id:'commute-dark',cat:'light',f:c=>{
  const r=c.routes.map(r=>({r,runs:r.runs.filter(d=>d.start>=c.p.a&&d.start<c.p.b)}))
    .filter(x=>x.runs.length>=5).sort((a,b)=>b.runs.length-a.runs.length)[0];
  if(!r)return null;
  const dark=x=>x.filter(d=>{
    const p=(d.pts||[])[0];if(!p)return false;
    return sunElevation(p[0],p[1],d.start+d.dur*1000)<-0.5;
  }).length;
  const now=dark(r.runs)/r.runs.length;
  const prevRuns=r.r.runs.filter(d=>d.start>=c.p.a-(c.p.b-c.p.a)&&d.start<c.p.a);
  if(prevRuns.length<5)return null;
  const was=dark(prevRuns)/prevRuns.length;
  if(now-was<0.25)return null;
  return {s:84,tone:'neutral',
    h:Math.round(now*100)+'% of your runs home now finish after sunset.',
    t:'On '+routeLabel(r.r)+', '+Math.round(now*100)+'% of runs now finish after sunset, '+
      'against '+Math.round(was*100)+'% the period before.',
    c:'It was '+Math.round(was*100)+'% the period before. The year is turning.'};
}},
{id:'night-share',cat:'light',f:c=>{
  const tot=c.light.night+c.light.twilight+c.light.golden+c.light.day;
  if(tot<=0)return null;
  const share=c.light.night/tot;
  const totP=c.lightPrev.night+c.lightPrev.twilight+c.lightPrev.golden+c.lightPrev.day;
  const shareP=totP>0?c.lightPrev.night/totP:null;
  if(share<0.08)return null;
  let t=hkm(c.light.night)+' of it was driven in the dark';
  if(shareP!=null&&Math.abs(share-shareP)>0.08)
    t+=', up from '+Math.round(shareP*100)+'% to '+Math.round(share*100)+'% of your driving';
  return {s:54,t:t+'.'};
}},
{id:'golden',cat:'light',f:c=>{
  if(c.light.golden<8000)return null;
  return {s:36,tone:'good',t:hkm(c.light.golden)+
    ' of it fell in the golden hour, with the sun low on the horizon.'};
}},
/* --- machine --- */
{id:'smooth-trend',cat:'machine',f:c=>{
  if(c.smoothNow==null||c.smoothPrev==null)return null;
  const d=c.smoothNow-c.smoothPrev;
  if(Math.abs(d)<4)return null;
  return {s:48,tone:d>0?'good':'bad',
    t:'Your smoothness score '+(d>0?'climbed':'slipped')+' '+
    spell(Math.abs(Math.round(d)))+' points to '+Math.round(c.smoothNow)+'.'};
}},
{id:'fuel-spend',cat:'cost',f:c=>{
  if(c.cost<=0)return null;
  let t='Fuel came to about €'+Math.round(c.cost);
  if(c.costPrev>0){
    const d=(c.cost-c.costPrev)/c.costPrev;
    if(Math.abs(d)>0.15)t+=', '+Math.abs(Math.round(d*100))+'% '+(d>0?'more':'less')+' than before';
  }
  return {s:42,t:t+'.'};
}},
{id:'consumption',cat:'cost',f:c=>{
  const car=cars.find(x=>x.id===settings.activeCar)||cars[0];
  if(!car)return null;
  const st=fuelStats(car);
  if(!st||st.n<4||st.trend==null||Math.abs(st.trend)<0.4)return null;
  return {s:64,tone:st.trend>0?'bad':'good',
    h:'Fuel consumption has '+(st.trend>0?'crept up':'come down')+' to '+
      st.avg.toFixed(1)+' L/100 km.',
    t:'Measured across '+st.n+' tanks, consumption is '+
      Math.abs(st.trend).toFixed(1)+' L/100 km '+(st.trend>0?'higher':'lower')+
      ' than when you started logging fill-ups.',
    c:'That is '+Math.abs(st.trend).toFixed(1)+' L/100 km '+
      (st.trend>0?'worse':'better')+' than your first few tanks.'};
}},
/* --- maintenance --- */
{id:'service',cat:'maintenance',sticky:1,f:c=>{
  if(!cars.length)return null;
  const rate=c.km/1000/Math.max((Math.min(c.p.b,Date.now())-c.p.a)/86400000,1); // km/day
  let best=null;
  cars.forEach(car=>{
    const total=carKm(car);
    (car.services||[]).forEach(s=>{
      const left=s.lastKm+s.everyKm-total;
      if(left<=0){
        if(!best||best.left>left)best={left,name:s.name,over:true};
      }else if(rate>0.5){
        const days=left/rate;
        if(days<75&&(!best||days<best.days))best={left,days,name:s.name,over:false};
      }
    });
  });
  if(!best)return null;
  const nm=best.name.toLowerCase();
  if(best.over)return {s:90,tone:'bad',h:'The '+nm+' is overdue.',
    t:'The '+nm+' is overdue by '+Math.round(-best.left)+' km.',
    c:'You are '+Math.round(-best.left)+' km past it.'};
  return {s:70,tone:'neutral',h:'The '+nm+' is coming up.',
    t:'At this rate the '+nm+' falls due '+inDays(best.days)+'.',
    c:'At this rate it falls due '+inDays(best.days)+'.'};
}},
/* --- absence: what you have stopped doing --- */
{id:'no-long',cat:'absence',sticky:1,f:c=>{
  const last=drives.filter(d=>d.dist>=50000).sort((a,b)=>b.start-a.start)[0];
  const ref=Math.min(c.p.b,Date.now());
  if(!last){
    if(c.total>200000)return {s:60,t:'You have still never done a drive over 50 km.'};
    return null;
  }
  const days=(ref-last.start)/86400000;
  if(days<45)return null;
  return {s:74,tone:'bad',h:'No long drive in '+Math.round(days)+' days.',
    t:'It has been '+Math.round(days)+' days since you drove more than 50 km in one go.',
    c:'The last one over 50 km was on '+shortDate(last.start)+'.'};
}},
{id:'no-weekend',cat:'absence',sticky:1,f:c=>{
  if(c.n<6)return null;
  const wk=c.ds.filter(d=>{const g=new Date(d.start).getDay();return g===0||g===6});
  if(wk.length)return null;
  return {s:58,tone:'bad',h:'Not a single weekend drive.',
    t:'Not one weekend drive — everything logged was a working day.',
    c:'Everything logged was a working day.'};
}},
{id:'streak',cat:'rhythm',sticky:1,f:c=>{
  const s=streak();
  if(s<5)return null;
  return {s:44,tone:'good',t:'You are '+spell(s)+' days into an unbroken streak.'};
}},
/* --- forward looking --- */
{id:'next-ref',cat:'forward',sticky:1,f:c=>{
  const totKm=c.total/1000;
  const ref=REFS.find(r=>r.km>totKm);
  if(!ref)return null;
  const left=ref.km-totKm;
  const rate=c.km/1000/Math.max((Math.min(c.p.b,Date.now())-c.p.a)/86400000,1);
  if(left>totKm*1.5)return null;
  return {s:56,tone:'good',h:'You are '+hkm(left*1000)+' short of '+ref.t+'.',
    t:'You are still '+hkm(left*1000)+' short of '+ref.t+
      (rate>0.5?', which arrives '+inDays(left/rate):'')+'.',
    c:rate>0.5?'At this rate it arrives '+inDays(left/rate)+'.':'You will get there eventually.'};
}},
{id:'old-record',cat:'forward',sticky:1,f:c=>{
  if(drives.length<12)return null;
  const cands=[];
  const sorted=drives.slice().sort((a,b)=>a.start-b.start);
  let bt=0,bd=0,btw=0,tTop=null,tLong=null,tTw=null;
  sorted.forEach(d=>{
    if(d.top>bt){bt=d.top;tTop=d.start}
    if(d.dist>bd){bd=d.dist;tLong=d.start}
    if(d.twist!=null&&d.twist>btw){btw=d.twist;tTw=d.start}
  });
  const ref=Math.min(c.p.b,Date.now());
  if(tTop)cands.push({n:'top speed',days:(ref-tTop)/86400000});
  if(tLong)cands.push({n:'longest drive',days:(ref-tLong)/86400000});
  if(tTw)cands.push({n:'twistiest road',days:(ref-tTw)/86400000});
  const old=cands.sort((a,b)=>b.days-a.days)[0];
  if(!old||old.days<60)return null;
  return {s:50,t:'Your '+old.n+' record has stood untouched for '+
    Math.round(old.days/7)+' weeks.'};
}},
{id:'level',cat:'forward',sticky:1,f:c=>{
  const xp=drives.filter(d=>d.start<c.p.b).reduce((a,d)=>a+driveXp(d),0);
  const lvl=levelOf(xp), left=need(lvl+1)-xp;
  const inXp=c.ds.reduce((a,d)=>a+driveXp(d),0);
  const rate=inXp/Math.max((Math.min(c.p.b,Date.now())-c.p.a)/86400000,1);
  if(rate<=0)return null;
  return {s:38,t:'You are level '+lvl+' ('+rankOf(lvl)+'), '+left.toLocaleString()+
    ' xp from the next one, '+inDays(left/rate)+'.'};
}}
];

/* ---------- the writer ---------- */
function observe(p,recent,isCurrent){
  const c=buildCtx(p);
  if(!c.n)return {p,c,empty:true};
  const found=[];
  const prevIds=recent&&recent.length?recent[recent.length-1]:null;
  const window=new Set();
  (recent||[]).forEach(s=>s.forEach(id=>window.add(id)));
  DETECTORS.forEach(d=>{
    // looking ahead only makes sense from where you actually are
    if(!isCurrent&&(d.cat==='forward'||d.cat==='maintenance'))return;
    let r=null;
    try{r=d.f(c)}catch(e){r=null}
    if(!r||!r.t)return;
    let score=r.s, text=r.t;
    const said=prevIds&&prevIds.has(d.id);
    if(d.sticky&&window.has(d.id)&&score<85)return;
    if(said){
      // a standing state repeated verbatim is dull; a live trend continuing is not
      score*=0.6;
      text='Again, '+text.charAt(0).toLowerCase()+text.slice(1);
    }
    found.push({id:d.id,cat:d.cat,score,text,head:r.h||null,cont:r.c||null,
      tone:r.tone||'neutral'});
  });
  found.sort((a,b)=>b.score-a.score);
  const picked=[],cats=new Set();
  const limit=p.kind==='week'?2:p.kind==='year'?7:5;
  for(const o of found){
    if(picked.length>=limit)break;
    if(cats.has(o.cat))continue;          // one observation per subject
    cats.add(o.cat);picked.push(o);
  }
  // close on something ahead of you where possible
  const fwdIdx=picked.findIndex(o=>o.cat==='forward'||o.cat==='maintenance');
  if(fwdIdx>=0&&fwdIdx<picked.length-1)picked.push(picked.splice(fwdIdx,1)[0]);
  return {p,c,picked,ids:new Set(picked.map(o=>o.id))};
}
function logEntries(kind,count){
  const ps=periodsOf(kind,count);
  const out=[];
  const memory=[];                          // rolling window of what was already said
  const depth=kind==='week'?3:kind==='year'?1:2;
  ps.forEach((p,i)=>{
    const o=observe(p,memory,i===ps.length-1);
    if(o.empty)return;
    memory.push(o.ids);
    while(memory.length>depth)memory.shift();
    out.push(o);
  });
  return out.reverse();                    // newest first
}
/* stitch the observations into a paragraph rather than stacking them:
   contrast when the mood flips, continuation when it does not, and never
   three sentences in a row opening the same way */
const SOFT=/^(you|your|it|its|that|this|they|almost|not|rain|fuel|everything|somewhere|nothing|half|only|about|some|the|a|an|one|every|across|by|at|on|in|nothing|either|the)\b/i;
function decap(t){return SOFT.test(t)?t.charAt(0).toLowerCase()+t.slice(1):t}
const CONTRAST=['That said, ','Against that, ','Even so, '];
const CARRY=['And ','On top of that, ','Meanwhile, '];
const ELSE_=['Elsewhere, ','Further afield, ','Beyond that, '];
function weave(items,seed){
  let out='',lastTone=null,youRun=0,used=new Set();
  const pick=(arr)=>{
    for(let i=0;i<arr.length;i++){
      const c=arr[(seed+i)%arr.length];
      if(!used.has(c)){used.add(c);return c}
    }
    return arr[seed%arr.length];
  };
  items.forEach((it,i)=>{
    let t=it.text, lead='';
    const opensYou=/^You\b/.test(t);
    if(i>0){
      const flip=lastTone&&it.tone!=='neutral'&&lastTone!=='neutral'&&it.tone!==lastTone;
      if(flip)lead=pick(CONTRAST);
      else if(opensYou&&youRun>=1)lead=pick(CARRY);
      else if(it.cat==='explore'||it.cat==='absence')lead=pick(ELSE_);
      if(lead)t=decap(t);
    }
    youRun=/^You\b/.test(lead?lead:t)?youRun+1:0;
    lastTone=it.tone;
    out+=(out?' ':'')+lead+t;
  });
  return out;
}
function entryText(o){
  if(o.empty)return {head:'Nothing logged.',body:'No drives recorded in this period.'};
  if(!o.picked.length)return {head:'A quiet one.',
    body:'Nothing in this period stood out enough to be worth writing down.'};
  const first=o.picked[0];
  const head=first.head||first.text;
  // the headline item contributes a continuation; everything else stands alone
  const rest=o.picked.slice(1);
  if(first.head&&first.cont)
    rest.unshift({text:first.cont,tone:first.tone,cat:first.cat});
  const seed=Math.abs(new Date(o.p.a).getMonth()+new Date(o.p.a).getDate());
  let body=weave(rest,seed);
  if(!body)body='Beyond that, a quiet one — nothing much worth reporting.';
  return {head,body};
}

/* ---------- logbook rendering ---------- */
let logCache={};
function renderLogbook(){
  const box=$('logbook');if(!box)return;
  const kind=settings.logKind||'month';
  document.querySelectorAll('#logSel button').forEach(b=>
    b.classList.toggle('on',b.dataset.l===kind));
  const count=kind==='week'?8:kind==='year'?4:12;
  const entries=logEntries(kind,count);
  logCache[kind]=entries;
  if(!entries.length){
    box.innerHTML='<div class="empty">Once you have a few drives logged, this writes itself.</div>';
    return;
  }
  box.innerHTML=entries.map((o,i)=>{
    const t=entryText(o);
    const c=o.c;
    return '<article class="entry'+(i===0?' now':'')+'">'+
      '<div class="entry-date">'+o.p.label+(i===0?' <span>so far</span>':'')+'</div>'+
      '<h3 class="entry-head">'+t.head+'</h3>'+
      '<p class="entry-body">'+t.body+'</p>'+
      '<div class="entry-foot"><span>'+hkm(c.km)+' · '+c.n+' drives · '+(c.secs/3600).toFixed(0)+' h</span>'+
      '<span class="foot-btns">'+
      (c.newKm>0.4?'<button class="mini" data-map="'+o.p.a+':'+o.p.b+'">See new roads</button>':'')+
      '<button class="mini" data-say="'+kind+':'+i+'">Read aloud</button></span></div>'+
      '</article>';
  }).join('');
  box.querySelectorAll('[data-say]').forEach(b=>b.onclick=()=>speak(b.dataset.say,b));
  box.querySelectorAll('[data-map]').forEach(b=>b.onclick=async()=>{
    const [a,bb]=b.dataset.map.split(':').map(Number);
    settings.heatNew='custom';
    settings.heatRange={a,b:bb,label:'in '+new Date(a).toLocaleDateString(undefined,
      {month:'long',year:'numeric'})};
    await saveV2(K_SET,settings);
    document.querySelectorAll('#heatSel button').forEach(x=>x.classList.remove('on'));
    $('btnAll').onclick();
  });
}
function speak(ref,btn){
  if(!('speechSynthesis' in window))return toast('This browser cannot read aloud.');
  if(speechSynthesis.speaking){
    speechSynthesis.cancel();
    document.querySelectorAll('[data-say]').forEach(b=>b.textContent='Read aloud');
    return;
  }
  const [kind,i]=ref.split(':');
  const o=(logCache[kind]||[])[Number(i)];
  if(!o)return;
  const t=entryText(o);
  const u=new SpeechSynthesisUtterance(o.p.label+'. '+t.head+' '+t.body);
  u.rate=0.98;u.pitch=1;
  const nl=speechSynthesis.getVoices().find(v=>/en-GB|en_GB/.test(v.lang));
  if(nl)u.voice=nl;
  u.onend=()=>{btn.textContent='Read aloud'};
  btn.textContent='Stop';
  speechSynthesis.speak(u);
}

/* ================================================================
   Which roads were new, and when
   ================================================================ */
/* Replays every drive in order, so a stretch counts as new only on the day you
   first reached it — works on drives recorded long before this existed. */
function firstTimeSegments(a,b,driveId){
  const seen=new Set(), out=[];
  let metres=0;
  const ds=drives.slice().sort((x,y)=>x.start-y.start);
  ds.forEach(d=>{
    const inScope=driveId?d.id===driveId:(d.start>=a&&d.start<b);
    const p=d.pts||[];
    let run=null;
    for(let i=1;i<p.length;i++){
      const k=cellKey(p[i][0],p[i][1]);
      const fresh=!seen.has(k);
      if(fresh)seen.add(k);
      if(inScope&&fresh){
        metres+=hav(p[i-1][0],p[i-1][1],p[i][0],p[i][1]);
        if(run)run.push([p[i][0],p[i][1]]);
        else run=[[p[i-1][0],p[i-1][1]],[p[i][0],p[i][1]]];
      }else if(run){out.push(run);run=null}
    }
    if(run)out.push(run);
  });
  return {runs:out,km:metres/1000};
}
function heatPeriod(){
  const k=settings.heatNew||'month';
  const now=new Date();
  if(k==='off')return null;
  if(k==='week'){const d=new Date(now);d.setHours(0,0,0,0);
    d.setDate(d.getDate()-((d.getDay()+6)%7));return {a:d.getTime(),b:Date.now(),label:'this week'}}
  if(k==='month')return {a:new Date(now.getFullYear(),now.getMonth(),1).getTime(),
    b:Date.now(),label:'this month'};
  if(k==='year')return {a:new Date(now.getFullYear(),0,1).getTime(),b:Date.now(),label:'this year'};
  if(settings.heatRange)return Object.assign({},settings.heatRange);
  return null;
}

/* ================================================================
   Fuel: what you actually put in, not what we guessed
   ================================================================ */
/* A tank is the stretch between two fill-ups. The litres you just put in
   replaced what you burned since the last one, so litres ÷ that distance is
   real consumption. Distance comes from your odometer readings when you give
   them (exact, and it catches drives you never recorded) and from logged
   drives when you don't. Partial fills carry forward until the next full one. */
function tanks(car){
  const fills=(car.fills||[]).slice().sort((a,b)=>a.ts-b.ts);
  if(fills.length<2)return [];
  const out=[];
  let carryL=0,carryKm=0,carryPart=0;
  for(let i=1;i<fills.length;i++){
    const prev=fills[i-1],f=fills[i];
    let dist=null,method='gps';
    if(f.odo!=null&&prev.odo!=null&&f.odo>prev.odo){dist=f.odo-prev.odo;method='odo'}
    else{
      dist=km(drives.filter(d=>d.carId===car.id&&d.start>prev.ts&&d.start<=f.ts)
        .reduce((a,d)=>a+d.dist,0));
    }
    if(!dist||dist<1){carryL+=f.litres;carryKm+=dist||0;carryPart++;continue}
    if(f.full===false){carryL+=f.litres;carryKm+=dist;carryPart++;continue}
    const litres=carryL+f.litres, kmv=carryKm+dist;
    const cost=(f.cost||0)+ (carryL?0:0);
    out.push({ts:f.ts,km:kmv,litres,cost:f.cost||0,
      l100:litres/kmv*100, eurPerKm:f.cost?f.cost/kmv:null,
      pricePerL:f.cost&&f.litres?f.cost/f.litres:null,
      method,partials:carryPart});
    carryL=0;carryKm=0;carryPart=0;
  }
  return out;
}
function measuredL100(car){
  const t=tanks(car);
  if(!t.length)return null;
  const recent=t.slice(-6);
  const l=recent.reduce((a,x)=>a+x.litres,0), k=recent.reduce((a,x)=>a+x.km,0);
  return k>0?l/k*100:null;
}
function fuelStats(car){
  const t=tanks(car);
  if(!t.length)return null;
  const l100=t.map(x=>x.l100);
  const spend=(car.fills||[]).reduce((a,f)=>a+(f.cost||0),0);
  const litres=(car.fills||[]).reduce((a,f)=>a+(f.litres||0),0);
  const totKm=t.reduce((a,x)=>a+x.km,0);
  return {n:t.length,avg:measuredL100(car),best:Math.min(...l100),worst:Math.max(...l100),
    spend,litres,totKm,perKm:totKm?spend/totKm:null,
    last:t[t.length-1],trend:t.length>=4
      ? (median(l100.slice(-3))-median(l100.slice(0,3))) : null};
}
async function addFill(cid){
  const car=cars.find(x=>x.id===cid);if(!car)return;
  const litres=prompt('How many litres?','');
  if(litres===null||!Number(litres))return;
  const cost=prompt('What did it cost, in €? (blank to skip)','');
  const odo=prompt('Odometer reading on the dash, in km (blank to use logged drives instead)',
    String(Math.round(carKm(car))));
  const full=confirm('Did you fill it right up?\n\nOK = full tank, Cancel = partial fill');
  car.fills=car.fills||[];
  car.fills.push({id:'f'+Date.now(),ts:Date.now(),litres:Number(litres),
    cost:cost?Number(cost)||null:null, odo:odo?Number(odo)||null:null, full});
  await saveV2(K_CAR,cars);
  render();
  const t=tanks(car);
  if(t.length){
    const last=t[t.length-1];
    toast(last.l100.toFixed(1)+' L/100 km over the last '+Math.round(last.km)+' km.');
  }else toast('Logged. The next fill-up gives you a consumption figure.');
}
async function delFill(cid,fid){
  const car=cars.find(x=>x.id===cid);if(!car)return;
  car.fills=(car.fills||[]).filter(f=>f.id!==fid);
  await saveV2(K_CAR,cars);render();
}
function renderFuel(car){
  const st=fuelStats(car), fills=(car.fills||[]).slice().sort((a,b)=>b.ts-a.ts);
  if(!fills.length)
    return '<div class="fuel"><div class="c-meta">No fill-ups logged. Add two and you get real consumption.</div>'+
      '<div class="row" style="margin-top:8px"><button class="ghost key" data-fill="'+car.id+
      '">Log a fill-up</button></div></div>';
  const t=tanks(car);
  let head='';
  if(st){
    const tr=st.trend;
    head='<div class="fuel-head"><div class="fuel-n">'+st.avg.toFixed(1)+
      '<s>L/100 km measured</s></div><div class="fuel-sub">'+
      'best '+st.best.toFixed(1)+' · worst '+st.worst.toFixed(1)+
      (st.perKm?' · €'+st.perKm.toFixed(2)+'/km':'')+
      (tr!=null&&Math.abs(tr)>0.25?' · '+(tr>0?'up':'down')+' '+Math.abs(tr).toFixed(1)+
        ' since you started':'')+'</div></div>';
  }
  const rows=fills.slice(0,6).map(f=>{
    const tk=t.find(x=>x.ts===f.ts);
    return '<div class="fill"><div><div class="fill-d">'+
      new Date(f.ts).toLocaleDateString(undefined,{day:'numeric',month:'short'})+
      (f.full===false?' · partial':'')+
      (tk?(tk.method==='odo'?' · from odometer':' · from logged drives'):'')+'</div>'+
      '<div class="fill-s">'+f.litres.toFixed(1)+' L'+(f.cost?' · €'+f.cost.toFixed(2):'')+
      (f.cost&&f.litres?' · €'+(f.cost/f.litres).toFixed(3)+'/L':'')+'</div></div>'+
      '<div class="fill-v">'+(tk?tk.l100.toFixed(1)+'<s>L/100</s>':'<s>baseline</s>')+'</div>'+
      '<button class="mini" data-delfill="'+car.id+'|'+f.id+'">×</button></div>';
  }).join('');
  return '<div class="fuel">'+head+rows+
    '<div class="row" style="margin-top:10px"><button class="ghost key" data-fill="'+car.id+
    '">Log a fill-up</button></div>'+
    (st&&st.n?'<div class="c-meta" style="margin-top:8px">'+st.litres.toFixed(0)+
      ' L bought'+(st.spend?', €'+st.spend.toFixed(0)+' spent':'')+
      ' across '+st.n+' full tank'+(st.n>1?'s':'')+'.'+
      (t.some(x=>x.method==='gps')
        ? ' Tanks measured from logged drives only count kilometres the app recorded — '+
          'enter the dash odometer each time for exact figures.':'')+
      '</div>':'')+'</div>';
}

/* ================================================================
   XP with a bit of ceremony
   ================================================================ */
const RANKS2=[
  {lvl:1, name:'Learner',      col:'#4E86A8'},   // cold, then warming
  {lvl:5, name:'Commuter',     col:'#5FA05F'},
  {lvl:10,name:'Regular',      col:'#A8B04A'},
  {lvl:16,name:'Road tripper', col:'#E8A33D'},
  {lvl:24,name:'Long hauler',  col:'#E67E2E'},
  {lvl:34,name:'Pathfinder',   col:'#D2402A'},
  {lvl:46,name:'Ironbutt',     col:'#C4356B'},
  {lvl:60,name:'Cartographer', col:'#9B5CD6'},
  {lvl:80,name:'Legend',       col:'#F2ECDC'}
];
const ROMAN=['I','II','III','IV','V'];
function rankInfo(lvl){
  let i=0;
  RANKS2.forEach((r,n)=>{if(lvl>=r.lvl)i=n});
  const r=RANKS2[i], next=RANKS2[i+1];
  const span=(next?next.lvl:r.lvl+20)-r.lvl;
  const into=lvl-r.lvl;
  const tiers=Math.min(5,Math.max(3,Math.round(span/4)));
  const tier=Math.min(tiers,1+Math.floor(into/span*tiers));
  return {name:r.name,col:r.col,tier,tiers,roman:ROMAN[tier-1],
    next:next?next.name:null,nextAt:next?next.lvl:null};
}
/* every source of xp, itemised, so the number is never mysterious */
function xpBreakdown(d){
  const out=[];
  const dist=Math.round(km(d.dist)*10);
  out.push({k:'Distance',v:dist,d:km(d.dist).toFixed(1)+' km'});
  out.push({k:'Drive logged',v:5,d:null});
  if(d.dist>=25000)out.push({k:'Long run',v:20,d:'over 25 km'});
  const h=new Date(d.start).getHours();
  if(h>=21||h<6)out.push({k:'After dark',v:10,d:null});
  // sensor only: a gps-derived score has nothing to calibrate against,
  // so it is shown but never paid for
  if(d.smooth!=null&&d.smooth>=90)out.push({k:'Smooth',v:15,d:d.smooth+'/100'});
  // ramps in from 80°/km instead of appearing all at once at 140
  if(d.twist!=null&&d.twist>=80)
    out.push({k:'Twisty road',v:Math.round((d.twist-80)/2.5),d:Math.round(d.twist)+'°/km'});
  if(d.newCells)out.push({k:'New road',v:d.newCells*2,
    d:(d.newCells*CELL/1000).toFixed(1)+' km first time'});
  const climb=gainOf(d);
  if(climb!=null&&climb>=10)
    out.push({k:'Climbing',v:Math.round(climb/100*15),d:climb+' m up'});
  if(d.dur>=7200)out.push({k:'Endurance',v:d.dur>=14400?70:30,
    d:(d.dur/3600).toFixed(1)+' h at the wheel'});
  if(d.wx){
    if(isSnow(d.wx.code))out.push({k:'Snow and ice',v:30,d:WX[d.wx.code]||null});
    else if(isWet(d.wx.code)&&d.dist>4000)
      out.push({k:'Rain',v:(d.wx.mm||0)>=2?18:10,d:WX[d.wx.code]||null});
    else if(d.wx.code===45||d.wx.code===48)out.push({k:'Fog',v:12,d:null});
  }
  const l=lightOf(d);
  if(l&&l.crossed&&(l.band==='twilight'||l.crossed==='twilight'||
     l.band==='golden'||l.crossed==='golden'))
    out.push({k:'Through the change of light',v:25,d:'sunrise or sunset'});
  const sh=shapeOf(d);
  if(sh.gaps)out.push({k:'Filled a gap',v:sh.gaps*6,
    d:spell(sh.gaps)+' enclosed cell'+(sh.gaps>1?'s':'')});
  if(sh.rev)out.push({k:'Other direction',v:30,d:'first run the other way'});
  /* a gps-derived clean run is shown in the sheet but never paid for */
  if(Array.isArray(d.joltT)){
    const cb=comboOf(d);
    if(cb&&cb.mult>1)out.push({k:'Clean run',v:comboXp(cb),
      d:mins(cb.secs)+' unbroken · ×'+cb.mult.toFixed(1)});
  }
  const bp=borderPushes().get(d.id);
  if(bp)out.push({k:'Pushed the border',v:Math.min(60,20+Math.round(bp.by/1000)*4),
    d:dirWord(bp.dir)+' by '+(bp.by/1000).toFixed(1)+' km'});
  if(d.pb)out.push({k:'Route best',v:40,d:'quickest run on this route at the time'});
  /* last, so it lifts everything above it and nothing lifts it */
  const ab=ageBoost(d);
  if(ab){
    const add=Math.round(out.reduce((a,x)=>a+x.v,0)*(ab.mult-1));
    if(add>0)out.push({k:'Old car',v:add,
      d:ab.year+' · '+ab.age+' years · +'+Math.round((ab.mult-1)*100)+'%'});
  }
  return out;
}
function renderXpBreak(id){
  const d=drives.find(x=>x.id===id);if(!d||!$('shXp'))return;
  const items=xpBreakdown(d);
  const tot=items.reduce((a,x)=>a+x.v,0);
  $('shXp').innerHTML='<div class="xp-list">'+items.map(x=>
    '<div class="xp-row"><span class="k">'+x.k+(x.d?' <s>'+x.d+'</s>':'')+
    '</span><span class="v">+'+x.v+'</span></div>').join('')+
    '<div class="xp-row total"><span class="k">Total</span><span class="v">+'+tot+'</span></div></div>';
}

/* ---------- the level-up moment ---------- */
function celebrate(level,gained,drive){
  const r=rankInfo(level);
  const box=$('levelUp');if(!box)return;
  box.style.setProperty('--rank',r.col);
  $('luLevel').textContent=level;
  $('luRank').innerHTML=r.name+' <span>'+r.roman+'</span>';
  $('luSub').textContent=r.nextAt
    ? r.nextAt-level+' levels to '+r.next
    : 'Nothing above this.';
  $('luXp').innerHTML=drive
    ? xpBreakdown(drive).map(x=>'<div class="xp-row"><span class="k">'+x.k+
        '</span><span class="v">+'+x.v+'</span></div>').join('')+
      '<div class="xp-row total"><span class="k">This drive</span><span class="v">+'+
      driveXp(drive)+'</span></div>'
    : '';
  box.classList.add('on');
  // roll the numeral like the odometer drums
  const el=$('luLevel');
  el.animate?el.animate([{transform:'translateY(30px)',opacity:0},{transform:'none',opacity:1}],
    {duration:520,easing:'cubic-bezier(.2,1.3,.4,1)'}):null;
}
function floatXp(n){
  const host=$('xpFloat');if(!host)return;
  const s=document.createElement('span');
  s.className='xp-pop';s.textContent='+'+n+' xp';
  host.appendChild(s);
  setTimeout(()=>s.remove(),1800);
}
/* ---------- where your xp comes from ---------- */
function renderXpSources(){
  if(!$('statXp'))return;
  const tot={};
  periodDrives().forEach(d=>xpBreakdown(d).forEach(x=>tot[x.k]=(tot[x.k]||0)+x.v));
  const entries=Object.entries(tot).sort((a,b)=>b[1]-a[1]);
  const sum=entries.reduce((a,x)=>a+x[1],0);
  if(!sum){$('statXp').innerHTML='<div class="empty">No xp yet.</div>';return}
  const col={'Distance':'#E8A33D','Drive logged':'#8C8455','New road':'#5FA05F',
    'Twisty road':'#D2402A','Smooth':'#4E86A8','Long run':'#C4892C','After dark':'#7A6A8A'};
  $('statXp').innerHTML='<div class="stackbar">'+entries.map(([k,v])=>
    '<i style="width:'+(v/sum*100).toFixed(1)+'%;background:'+(col[k]||'#847E6C')+
    '" title="'+k+'"></i>').join('')+'</div><div class="recs" style="margin-top:10px">'+
    entries.map(([k,v])=>'<div class="rec"><span class="k"><i class="sw" style="background:'+
    (col[k]||'#847E6C')+'"></i>'+k+'</span><span class="v">'+v.toLocaleString()+'</span></div>').join('')+
    '</div><div class="ch-note">Distance is the floor. Everything else you have to go and earn.</div>';
}

/* ================================================================
   Elevation, properly
   ================================================================ */
/* Raw GPS altitude wanders by several metres even standing still, so counting
   every small rise turns a flat motorway into a mountain. Smooth the profile,
   then only bank a climb once it has gone up HYST metres without reversing —
   the same trick the cycling services use. */
const HYST=10;
function cleanGain(pts,hyst){
  const H=hyst||HYST;
  const alt=(pts||[]).map(p=>p[4]).filter(v=>v!=null&&isFinite(v));
  if(alt.length<8)return null;
  const w=5, sm=[];
  for(let i=0;i<alt.length;i++){
    let s=0,n=0;
    for(let j=Math.max(0,i-w);j<=Math.min(alt.length-1,i+w);j++){s+=alt[j];n++}
    sm.push(s/n);
  }
  let gain=0, anchor=sm[0], peak=sm[0], rising=true;
  for(let i=1;i<sm.length;i++){
    const v=sm[i];
    if(rising){
      if(v>peak)peak=v;
      else if(peak-v>H){                    // turned over: bank the climb
        if(peak-anchor>=H)gain+=peak-anchor;
        anchor=v;rising=false;
      }
    }else{
      if(v<anchor)anchor=v;
      else if(v-anchor>H){peak=v;rising=true}
    }
  }
  if(rising&&peak-anchor>=H)gain+=peak-anchor;
  return Math.round(gain);
}

/* On a road you drive twice a day, the GPS error averages out while the road
   stays put. Stack the runs, take the median altitude at each 50 m along the
   route, and small rises that vanish into the noise on any single run come
   back — so a 4 m bridge finally counts. */
let routeElevCache=null;
function buildRouteElevation(){
  const map=new Map();
  buildRoutes().forEach(r=>{
    const runs=r.runs.filter(d=>(d.pts||[]).some(p=>p[4]!=null)).slice(0,24);
    if(runs.length<5)return;
    const step=50, bins=Math.floor(r.dist/step);
    if(bins<10)return;
    const cols=Array.from({length:bins+1},()=>[]);
    runs.forEach(d=>{
      const cum=cumDist(d.pts);
      let j=1;
      for(let b=0;b<=bins;b++){
        const target=b*step;
        while(j<cum.length-1&&cum[j]<target)j++;
        const a=d.pts[j-1], c=d.pts[j];
        if(!a||!c||a[4]==null||c[4]==null)continue;
        const f=Math.max(0,Math.min(1,(target-cum[j-1])/Math.max(cum[j]-cum[j-1],1e-6)));
        cols[b].push(a[4]+(c[4]-a[4])*f);
      }
    });
    const prof=cols.filter(v=>v.length>=Math.max(3,runs.length*0.5))
      .map((v,b)=>[0,0,b,90,median(v)]);
    if(prof.length<10)return;
    const g=cleanGain(prof,3);               // noise is far lower here, so a finer threshold
    if(g==null)return;
    r.runs.forEach(d=>map.set(d.id,{gain:g,n:runs.length}));
  });
  return map;
}
function routeElev(){
  if(!routeElevCache)routeElevCache=buildRouteElevation();
  return routeElevCache;
}
function gainOf(d){
  const re=routeElev().get(d.id);
  if(re)return re.gain;                      // measured across every run of this route
  return d.gainClean!=null?d.gainClean:null;
}
function gainSource(d){
  const re=routeElev().get(d.id);
  return re?('averaged over '+re.n+' runs of this route'):null;
}

/* ================================================================
   Extra xp: the shape of your driving, and looking after the car
   ================================================================ */
/* a cell you filled that was already surrounded on all four sides —
   the little holes left behind in your own coverage */
function neighbourKeys(k){
  const [a,b]=k.split(':').map(Number);
  return [(a+1)+':'+b,(a-1)+':'+b,a+':'+(b+1),a+':'+(b-1)];
}
function replayShape(){
  const seen=new Set(), out=new Map();
  const ds=drives.slice().sort((a,b)=>a.start-b.start);
  const dirSeen=new Set();
  ds.forEach(d=>{
    let gaps=0;
    (d.pts||[]).forEach(p=>{
      const k=cellKey(p[0],p[1]);
      if(!seen.has(k)){
        if(neighbourKeys(k).every(n=>seen.has(n)))gaps++;
        seen.add(k);
      }
    });
    // first time down a road in the opposite direction
    let rev=false;
    const p=d.pts||[];
    if(p.length>4){
      const a=cellKey(p[0][0],p[0][1]), b=cellKey(p[p.length-1][0],p[p.length-1][1]);
      if(dirSeen.has(b+'>'+a)&&!dirSeen.has(a+'>'+b))rev=true;
      dirSeen.add(a+'>'+b);
    }
    out.set(d.id,{gaps,rev});
  });
  return out;
}
let shapeCache=null;
function shapeOf(d){
  if(!shapeCache)shapeCache=replayShape();
  return shapeCache.get(d.id)||{gaps:0,rev:false};
}
/* three or more different routes inside one week */
function varietyXp(){
  const rs=buildRoutes();
  if(rs.length<2)return 0;
  const weeks=new Map();
  rs.forEach(r=>r.runs.forEach(d=>{
    const k=weekId(d.start);
    if(!weeks.has(k))weeks.set(k,new Set());
    weeks.get(k).add(r.key);
  }));
  let xp=0;
  weeks.forEach(set=>{if(set.size>=3)xp+=50});
  return xp;
}
/* small, steady rewards for actually maintaining the thing */
function serviceXp(){
  let xp=0;
  cars.forEach(c=>(c.services||[]).forEach(s=>
    (s.log||[]).forEach(l=>{xp+=15;if(l.early)xp+=10})));
  return xp;
}
/* a tank that beat your own measured average */
function economyXp(){
  let xp=0;
  cars.forEach(c=>{
    const t=tanks(c);
    if(t.length<3)return;
    const avg=measuredL100(c);
    t.forEach(x=>{if(avg&&x.l100<avg*0.97)xp+=40});
  });
  return xp;
}
function bonusXp(){return varietyXp()+serviceXp()+economyXp()+regionXp()}
