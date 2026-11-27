import * as T from 'three';

const $=id=>document.getElementById(id);
const colors=['#075945','#365dcc','#bd4829','#7e3988','#785b00','#087285','#b92b62','#4f6480','#25723d','#7047bd','#955724','#2764a5'];
const formatted=new Intl.NumberFormat('en',{maximumFractionDigits:2});
const fmt=x=>x==null?'—':formatted.format(x);
function node(tag,text) {
  const el=document.createElement(tag);
  if(text!==undefined) el.textContent=text;
  return el;
}
function button(text,action) {
  const el=node('button',text);
  el.className='outline';
  el.onclick=action;
  return el;
}
function table(headers,rows) {
  const el=node('table'), head=el.createTHead().insertRow(), body=el.createTBody();
  for (const column of headers) head.append(node('th',column));
  for (const values of rows) {
    const row=body.insertRow();
    for (const value of values) row.insertCell().textContent=value;
  }
  return el;
}
function chart(target, timestamps, lines, unit) {
  target.replaceChildren();
  if (!timestamps.length || !lines.length) return;
  const canvas=node('canvas');
  canvas.setAttribute('aria-label','Hourly profile in '+unit);
  canvas.role='img';
  const key=node('div');
  key.className='study-chart-key';
  for (const line of lines) {
    const label=node('span',(line.dash?'┄ ':'━ ')+line.label);
    label.style.color=line.color;
    key.append(label);
  }
  target.append(canvas,key);
  const width=Math.max(280,canvas.clientWidth), height=205, ratio=Math.min(2,devicePixelRatio);
  canvas.width=width*ratio;canvas.height=height*ratio;
  const ctx=canvas.getContext('2d');
  ctx.scale(ratio,ratio);
  const lo=Math.min(0,...lines.flatMap(line=>line.values));
  const hi=Math.max(1,...lines.flatMap(line=>line.values));
  const x=i=>50+i*(width-63)/Math.max(1,timestamps.length-1);
  const y=v=>height-26-(v-lo)/(hi-lo)*(height-50);
  ctx.font='12px system-ui';
  ctx.fillStyle='#324c56';
  ctx.fillText(unit,9,15);
  for(let i=0;i<=4;i++){
    const v=lo+i*(hi-lo)/4;
    ctx.strokeStyle='#dce5e7';ctx.beginPath();ctx.moveTo(47,y(v));ctx.lineTo(width-12,y(v));ctx.stroke();
    ctx.fillText(Math.round(v),4,y(v)+4);
  }
  for (let i=0;i<timestamps.length;i+=Math.max(1,Math.floor(timestamps.length/5))) {
    ctx.fillText(timestamps[i].slice(11,16),x(i)-14,height-7);
  }
  for (const line of lines) {
    ctx.strokeStyle=line.color;ctx.lineWidth=line.dash?1.4:2;
    ctx.setLineDash(Array.isArray(line.dash)?line.dash:line.dash?[5,4]:[]);ctx.beginPath();
    line.values.forEach((value,i)=>i?ctx.lineTo(x(i),y(value)):ctx.moveTo(x(i),y(value)));
    ctx.stroke();
  }
}
export function createStudy({scene,geometry,clear,getModel,getSettings,snapshot,onActivate,onMap}) {
  const overlays=new T.Group(), maps=new T.Group();
  scene.add(maps,overlays);
  const selected=new Set(), targets=new Set();
  let revision=0, data, timer, request, pending=false, pickingTarget=false;
  const comparing=()=>$('study-compare').checked;
  const status=message=>$('study-status').textContent=message;
  function body() {
    const date=$('date').value, offset=$('offset').value;
    return {...getSettings(),date,offset,instant:date+'T'+$('time').value+':00'+offset,
      period:$('study-period').value,faces:[...selected],targets:comparing()?[...targets]:[],
      compare:comparing()};
  }
  function draw() {
    clear(overlays);clear(maps);
    onMap(false);
    const model=getModel();
    if(!model || $('study-workspace').hidden) return;
    const kind=$('study-map').value;
    const comparison=comparing() && kind!=='scene' && data?.faces?.some(f=>f.baseline);
    const delta=kind==='delta';
    const extent=comparison ? (delta
      ? Math.max(1,...data.faces.map(f=>Math.abs(f.delta||0)))
      : Math.max(1,...data.faces.flatMap(f=>[f.energy,f.baselineEnergy||0]))) : 1;
    const blue=new T.Color('#2153b0'), neutral=new T.Color('#f5f6ed'), red=new T.Color('#bb391c');
    $('study-map-legend').replaceChildren();
    if(comparison) {
      onMap(true);
      const scale=node('span');
      scale.className='study-scale';
      scale.style.background=delta?'linear-gradient(90deg,#2153b0,#f5f6ed,#bb391c)':'linear-gradient(90deg,#2153b0,#f5f6ed,#bb391c)';
      $('study-map-legend').append(scale,node('span',(delta?'−'+fmt(extent)+' to +':'0 to ')+fmt(extent)+' kWh/m² · matched face averages'));
    }
    {
      [...selected].forEach((face,i)=>{
        const tris=model.triangles.filter((t,j)=>model.triangleFaces[j]===face);
        if(!tris.length) return;
        const g=geometry(tris);
        const edges=new T.LineSegments(new T.EdgesGeometry(g,20),new T.LineBasicMaterial({color:colors[i%colors.length],depthTest:false}));
        edges.renderOrder=18;overlays.add(edges);
        const item=data?.faces?.find(f=>f.id===face+1);
        const mapped=comparison && item?.baseline;
        let color=new T.Color(colors[i%colors.length]);
        if(mapped) {
          const value=kind==='before'?item.baselineEnergy:delta?item.delta:item.energy;
          const t=delta?(value/extent+1)/2:value/extent;
          color=t<.5?blue.clone().lerp(neutral,2*t):neutral.clone().lerp(red,2*t-1);
        }
        const fill=new T.Mesh(g,new T.MeshBasicMaterial({color,side:T.DoubleSide,
          transparent:!mapped,opacity:mapped?1:.18,depthWrite:false,
          polygonOffset:true,polygonOffsetFactor:-3,polygonOffsetUnits:-3}));
        fill.renderOrder=8;maps.add(fill);
      });
    }
  }
  function controls() {
    $('study-clear').disabled=!selected.size;
    $('study-view-count').hidden=!selected.size;
    $('study-view-count').textContent=selected.size+' '+(selected.size===1?'face':'faces')+' selected';
    $('study-selection-title').textContent='Selected faces'+' ('+selected.size+')';
    $('study-selection').replaceChildren(...[...selected].map((face,i)=>{
      const chip=button('Face '+(face+1)+' ×',()=>{selected.delete(face);changed();});
      chip.style.borderLeft='3px solid '+colors[i%colors.length];
      return chip;
    }));
    const available=!pending && !!data?.faces?.length;
    $('study-csv').disabled=$('study-pdf').disabled=!available;
  }
  function display() {
    const host=$('study-results'), plot=$('study-chart');
    host.replaceChildren();plot.replaceChildren();
    if(!data) return;
    if (data.unmatched.length) host.append(node('p','Unmatched or outside target selection: '+data.unmatched.map(i=>'Face '+i).join(', ')+'.'));
    if(!data.faces.length) return;
    const hasHeat=data.absorptivity!=null;
    const heat=hasHeat && $('study-chart-mode').value==='heat';
    host.append(node('p',fmt(data.area)+' m² · '+fmt(data.mean)+' kWh/m² area-weighted · '+fmt(data.incident)+' kWh incident · '+data.hours+' hours'));
    if(hasHeat) host.append(node('p',fmt(data.absorbed)+' kWh absorbed across selected faces · absorptivity '+fmt(data.absorptivity)));
    host.append(table(['Face','Area m²','Tilt','True azimuth','Direct sun h','Peak W/m²','Peak midpoint','kWh/m²',
      ...(comparing()?['Targets only','Change']:[]),...(hasHeat?['Peak absorbed W','Absorbed kWh']:[])],
      data.faces.map(f=>[f.id,fmt(f.area),fmt(f.tilt)+'°',f.azimuth==null?'Flat':fmt(f.azimuth)+'°',
        fmt(f.hours),fmt(f.peak),f.peakTime.slice(0,16).replace('T',' '),fmt(f.energy),
        ...(comparing()?[fmt(f.baselineEnergy),fmt(f.delta)]:[]),...(hasHeat?[fmt(f.peakHeat),fmt(f.absorbed)]:[])])));
    if(comparing()) {
      const notes=data.faces.flatMap(f=>(f.blockers||[]).map(b=>'Face '+f.id+': Object '+b.object+' intercepts direct sun on '+fmt(b.percent)+'% of face area.'));
      host.append(node('p',notes.join(' ')||'No external obstruction was the first ray hit on these faces at the selected instant.'));
    }
    host.append(node('p','Hour midpoints · UTC'+data.timezone+' · '+data.source));
    const lines=[];
    data.faces.forEach(f=>{
      const color=colors[[...selected].indexOf(f.id-1)%colors.length]||colors[0];
      const difference=comparing() && $('study-map').value==='delta' && f.baseline;
      const basePresent=comparing() && f.baseline;
      const factor=heat?f.area*data.absorptivity:1;
      const totals=f.series[3].map((v,i)=>(v-(difference?f.baseline[3][i]:0))*factor);
      lines.push({label:'Face '+f.id+(difference?' change':basePresent?' with obstructions':''),color,values:totals});
      if(basePresent && !difference) lines.push({label:'Face '+f.id+' targets only',color,values:f.baseline[3].map(v=>v*factor),dash:true});
      if($('study-components').checked) ['Beam','Diffuse','Ground'].forEach((name,j)=>lines.push({
        label:'Face '+f.id+' '+name,color,values:f.series[j].map((v,i)=>(v-(difference?f.baseline[j][i]:0))*factor),
        dash:[[8,4],[3,4],[2,3,7,3]][j]
      }));
    });
    if(heat && !comparing() && data.faces.length>1) lines.push({label:'All selected faces',color:'#182b35',
      values:data.timestamps.map((_,i)=>data.faces.reduce((sum,face)=>sum+face.heat[i],0))});
    chart(plot,data.timestamps,lines,heat?'Absorbed W':'W/m²');
  }
  async function fetchStudy(exportType) {
    if(!getModel()) return;
    if(comparing() && !targets.size) {
      status('Mark at least one solid as a target.');
      return;
    }
    if(!selected.size) {
      status('Select at least one face to see results.');
      return;
    }
    clearTimeout(timer);
    request?.abort();
    request=new AbortController();
    const token=++revision;
    pending=true;controls();status(exportType?'Preparing export…':'Tracing hourly exposure…');
    try {
      const payload=body();
      if($('study-heat').checked) {
        const alpha=$('study-alpha');
        if(!alpha.value || !alpha.checkValidity()) throw new Error('Enter absorptivity from 0 to 1.');
        payload.absorptivity=Number(alpha.value);
      }
      if(exportType) payload.export=exportType;
      if(exportType==='pdf') payload.snapshot=snapshot();
      const reply=await fetch('/api/study',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:request.signal
      });
      if(!reply.ok) throw new Error((await reply.json()).error||'Study failed.');
      if(token!==revision) return;
      if(exportType) {
        const href=URL.createObjectURL(await reply.blob()), link=node('a');
        link.href=href;link.download='selected-surfaces.'+exportType;document.body.append(link);link.click();link.remove();
        setTimeout(()=>URL.revokeObjectURL(href),30000);
      } else {
        const response=await reply.json();
        if(token!==revision) return;
        data=response;
      }
      status('');
      display();draw();
    } catch(error) {if(token===revision) status(error.message);}
    finally {if(token===revision){pending=false;controls();}}
  }
  function changed() {
    revision++;data=null;pending=false;
    request?.abort();
    clearTimeout(timer);controls();display();draw();
    if(!$('study-workspace').hidden) timer=setTimeout(()=>fetchStudy(),230);
  }
  function options() {
    const roles=$('study-roles');roles.replaceChildren();
    const picker=$('study-face-id'), old=picker.value;
    picker.replaceChildren();
    const model=getModel();
    if(!model) return;
    const faceTypes=new Map();
    model.faces.forEach((face,i)=>{if(!faceTypes.has(face))faceTypes.set(face,model.types[i]);});
    for (const [face,type] of faceTypes) {
      picker.add(new Option('Face '+(face+1)+' · '+type+' · Object '+model.faceObjects[face],face));
    }
    if([...picker.options].some(option=>option.value===old)) picker.value=old;
    const objects=[...new Set(Object.values(model.faceObjects))].sort((a,b)=>a-b);
    for (const id of objects) {
      const label=node('label'), input=node('input');
      input.type='checkbox';input.checked=targets.has(id);
      input.onchange=()=>{if(input.checked)targets.add(id);else targets.delete(id);options();changed();};
      label.append(input,node('span','Object '+id+' target'));roles.append(label);
    }
  }
  $('study-compare').onchange=()=>{
    $('study-scenario').hidden=!comparing();
    cancelPick();
    const model=getModel();
    if(comparing() && model && !targets.size) {
      for (const face of selected) targets.add(model.faceObjects[face]);
      if(!targets.size) targets.add(Math.min(...Object.values(model.faceObjects)));
    }
    $('study-map').value=comparing()?'delta':'scene';
    onActivate();
    options();changed();
  };
  $('study-toggle').onclick=()=>{
    if($('study-workspace').hidden) {
      $('study-workspace').hidden=false;
      $('study-toggle').setAttribute('aria-expanded',true);
      changed();
    }
    onActivate();
    $('study-workspace').scrollIntoView({block:'start'});
  };
  $('study-view-count').onclick=$('study-toggle').onclick;
  $('study-map').onchange=()=>{onActivate();display();draw();};
  $('study-components').onchange=display;
  $('study-chart-mode').onchange=display;
  $('study-heat').onchange=()=>{
    $('study-heat-options').hidden=!$('study-heat').checked;
    changed();
  };
  $('study-pick-target').onclick=()=>{
    const activate=!pickingTarget;
    if (activate) onActivate();
    pickingTarget=activate;
    $('study-pick-target').setAttribute('aria-pressed',pickingTarget);
    status(pickingTarget?'Click a solid to toggle whether it is a target.':'');
    if(pickingTarget) $('viewport').scrollIntoView({block:'center'});
  };
  $('study-period').onchange=changed;
  $('study-update').onclick=()=>fetchStudy();
  $('study-clear').onclick=()=>{selected.clear();changed();};
  $('study-viewer').onclick=()=>{onActivate();$('viewport').scrollIntoView({block:'center'});};
  $('study-add-face').onclick=()=>{
    const picker=$('study-face-id');
    if(picker.value==='' || selected.size>=12) return;
    selected.add(Number(picker.value));changed();
  };
  $('study-csv').onclick=()=>fetchStudy('csv');
  $('study-pdf').onclick=()=>fetchStudy('pdf');
  $('study-alpha').onchange=changed;
  let previousWidth=0;
  new ResizeObserver(([entry])=>{
    if(entry.contentRect.width===previousWidth) return;
    previousWidth=entry.contentRect.width;
    if(data) display();
  }).observe($('study-workspace'));
  function cancelPick(){
    pickingTarget=false;
    $('study-pick-target').setAttribute('aria-pressed','false');
  }
  return {
    pick(hit){
      if($('study-workspace').hidden) return;
      if(!hit) return;
      const face=getModel().faces[hit.faceIndex];
      if(comparing()&&pickingTarget){
        const object=getModel().faceObjects[face];
        if(targets.has(object))targets.delete(object);else targets.add(object);
        pickingTarget=false;$('study-pick-target').setAttribute('aria-pressed','false');
        options();changed();return;
      }
      if(selected.has(face)) selected.delete(face);
      else if(selected.size<12) selected.add(face);
      else return status('Select up to twelve faces.');
      changed();
    },
    reset(){
      selected.clear();targets.clear();cancelPick();
      $('study-compare').checked=false;$('study-scenario').hidden=true;$('study-map').value='scene';
      options();changed();
    },
    cancelPick,
    reportInputs:body,
    showModel(){cancelPick();$('study-map').value='scene';display();draw();},
    changed,
  };
}

