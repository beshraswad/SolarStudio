(function(){
const target = document.getElementById('worked-project');
document.querySelector('nav a[href="/"]').addEventListener('click',event=>{
  if (document.referrer === location.origin+'/') {
    event.preventDefault();
    history.back();
  }
});
const append = (tag, text) => {
  const node = document.createElement(tag);
  node.textContent = text;
  target.append(node);
  return node;
};
const n = (x, digits=4) => Number(x.toFixed(digits)).toString();
const tuple = values => '('+values.map(x=>n(x,6)).join(',\\,')+')';
function equation(tex) {
  const node = append('div','');
  node.className = 'equation';
  katex.render(tex,node,{displayMode:true,output:'mathml'});
}
async function showProject() {
  try {
    const context = JSON.parse(sessionStorage.getItem('solar-worked-calculation') || 'null');
    if (context?.error) throw new Error(context.error);
    const response = await fetch('/api/worked-calculation',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(context)});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The project calculation could not be loaded.');
    target.replaceChildren();
    const {settings:s,annual:a,hour:h} = data;
    append('h2','Worked calculation · '+data.project);
    append('p','Patch '+data.patch+' · Face '+data.face+' · '+s.lat+'°, '+s.lon+'° · '+s.year+' UTC weather year');
    append('h3','Surface orientation and view factors');
    equation(String.raw`\Delta = ${n(-s.north)}^\circ,\quad \mathbf n_{\rm model}=${tuple(data.normal)},\quad \mathbf n_{\rm ENU}=${tuple(data.enu)}`);
    const [x,y] = data.normal.map(v=>n(v,8)), d = n(-s.north);
    equation(String.raw`n_E=${x}\cos(${d}^\circ)+(${y})\sin(${d}^\circ)\approx${n(data.enu[0],8)}`);
    equation(String.raw`n_N=-\left(${x}\right)\sin(${d}^\circ)+(${y})\cos(${d}^\circ)\approx${n(data.enu[1],8)}`);
    equation(String.raw`\beta = \arccos(${n(data.enu[2],8)})=${n(data.tilt,2)}^\circ`
      +(data.azimuth === null ? '' : String.raw`,\quad A_s=\operatorname{atan2}(${n(data.enu[0],8)},${n(data.enu[1],8)})\bmod 360^\circ = ${n(data.azimuth,2)}^\circ`));
    if (data.azimuth === null) append('p','This horizontal patch has no surface azimuth.');
    equation(String.raw`a_i=${n(data.area,6)}\,\mathrm{m^2},\quad F_{\rm sky}=${n(data.sky,6)},\quad F_{\rm ground}=${n(data.ground,6)}`);
    const openSky=(1+data.enu[2])/2, openGround=(1-data.enu[2])/2;
    equation(String.raw`F_{\rm sky,open}=\frac{1+${n(data.enu[2],8)}}{2}\approx${n(openSky,6)},\quad F_{\rm ground,open}=\frac{1-${n(data.enu[2],8)}}{2}\approx${n(openGround,6)}`);
    equation(String.raw`F_{\rm sky}\approx${n(openSky,6)}\cdot${n(data.sky/openSky,6)}\approx${n(data.sky,6)}`
      +(openGround>1e-8 ? String.raw`,\quad F_{\rm ground}\approx${n(openGround,6)}\cdot${n(data.ground/openGround,6)}\approx${n(data.ground,6)}`
        : String.raw`,\quad F_{\rm ground}=0`));
    if (!a || !h) {
      append('p','Run annual analysis in the workspace to see the hourly weather substitution and annual sum for these settings.');
      return;
    }
    append('h3','Hourly NASA POWER substitution');
    append('p','Requested local time '+h.requested+' · Weather midpoint '+h.midpoint
      +(h.clamped ? ' · The requested time is outside the weather record. This is the nearest available interval.' : ''));
    equation(String.raw`\alpha=${n(h.elevation,3)}^\circ,\quad \Phi=90^\circ-\alpha=${n(h.zenith,3)}^\circ,\quad A=${n(h.azimuth,3)}^\circ`);
    equation(String.raw`(\mathrm{GHI},\mathrm{DNI},\mathrm{DHI})=${tuple([h.ghi,h.dni,h.dhi])}\,\mathrm{Wh/m^2},\quad \Delta t=1\,\mathrm{h}`);
    const alpha=h.elevation*Math.PI/180, az=h.azimuth*Math.PI/180;
    const sun=[Math.cos(alpha)*Math.sin(az),Math.cos(alpha)*Math.cos(az),Math.sin(alpha)];
    equation(String.raw`c=\mathbf n\cdot\mathbf s=${tuple(data.enu)}\cdot${tuple(sun)}\approx${n(h.cosine,6)},\quad V_{\rm sun}=${h.visible}`);
    equation(String.raw`G_{\rm beam}=${n(h.dni)}\cdot\max(0,${n(h.cosine,6)})\cdot${h.visible}=${n(h.beam)}\,\mathrm{W/m^2}`);
    equation(String.raw`G_{\rm sky}=${n(h.dhi)}\cdot${n(data.sky,6)}=${n(h.sky)}\,\mathrm{W/m^2}`);
    equation(String.raw`G_{\rm ground}=0.20\cdot${n(h.ghi)}\cdot${n(data.ground,6)}=${n(h.ground)}\,\mathrm{W/m^2}`);
    equation(String.raw`G_{\rm POA}\approx${[h.beam,h.sky,h.ground].map(x=>n(x)).join('+')}\approx${n(h.poa)}\,\mathrm{W/m^2}`);
    append('h3','Annual result for this patch');
    append('p','Integrated over '+a.hours.toLocaleString()+' hourly intervals. Substitutions are displayed with rounded values.');
    equation(String.raw`H_{\rm POA}\approx${[a.direct,a.diffuse,a.ground].map(x=>n(x,2)).join('+')}\approx${n(a.total,2)}\,\mathrm{kWh/m^2}`);
    if (a.faceArea > 0) equation(String.raw`\bar H_{\rm face}=\frac{\sum_i a_iH_i}{\sum_i a_i}\approx\frac{${n(a.faceWeighted,3)}}{${n(a.faceArea,3)}}\approx${n(a.faceWeighted/a.faceArea,2)}\,\mathrm{kWh/m^2}`);
    if (a.open > 0) equation(String.raw`\mathrm{loss}=100\left(1-\frac{${n(a.total,2)}}{${n(a.open,2)}}\right)\approx ${n(100*(1-a.total/a.open),2)}\%`);
    equation(String.raw`H_{\rm beam,loss}=${n(a.loss,2)}\,\mathrm{kWh/m^2},\quad t_{\rm direct}=${a.sunHours}\,\mathrm{h}`);
    const panels = data.placement;
    if (panels) {
      append('h3','Applied PV layout estimate');
      equation(String.raw`P_{\rm DC}=\frac{${panels.count}\cdot${n(panels.watts)}}{1000}=${n(panels.kwp,3)}\,\mathrm{kWp}`);
      equation(String.raw`E_{\rm annual}\approx\frac{${n(panels.watts)}}{1000}\cdot${n(panels.ratio)}\cdot${n(panels.poaSum,2)}\approx${n(panels.generation,2)}\,\mathrm{kWh}`);
      if (panels.target != null) equation(String.raw`E_{\rm short}=\max(0,${n(panels.target,2)}-${n(panels.generation,2)})\approx${n(panels.shortfall,2)}\,\mathrm{kWh}`);
    }
  } catch (error) {
    target.replaceChildren();
    append('h2','Worked calculation');
    append('p',error.message+' Open the workspace and select a patch to refresh this calculation.');
  }
}
showProject();
})();
