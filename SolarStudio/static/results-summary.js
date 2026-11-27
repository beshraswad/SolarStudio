const format = new Intl.NumberFormat('en',{maximumFractionDigits:2});
const units = ' kWh/m²';

export function summarize(model,result) {
  const faces=new Map();
  let worst=0, energyError=0, lossError=0, invalid=0, hotspot=0;
  const losses=result.total.map((total,i)=>
    result.loss[i]+result.diffuseLoss[i]+result.groundLoss[i]);
  for (const [i,triangle] of model.patches.entries()) {
    const values=[result.total[i],result.direct[i],result.diffuse[i],result.ground[i],result.open[i],
      result.loss[i],result.diffuseLoss[i],result.groundLoss[i]];
    if (values.some(value=>!Number.isFinite(value) || value<0)) invalid++;
    const residual=Math.abs(values[0]-values[1]-values[2]-values[3]);
    if (residual>energyError) {energyError=residual;worst=i;}
    lossError=Math.max(lossError,Math.abs(values[4]-values[0]-losses[i]));
    if (losses[i]>losses[hotspot]) hotspot=i;
    if (model.types[i]!=='roof') continue;
    const [a,b,c]=triangle;
    const u=b.map((value,k)=>value-a[k]), v=c.map((value,k)=>value-a[k]);
    const area=Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])/2;
    const id=model.faces[i];
    if (!faces.has(id)) faces.set(id,{id,area:0,weighted:0,patch:i});
    const face=faces.get(id);
    face.area+=area;
    face.weighted+=area*result.total[i];
  }
  const ranks=[...faces.values()].filter(f=>f.area>0)
    .map(f=>({...f,mean:f.weighted/f.area})).sort((a,b)=>b.mean-a.mean || a.id-b.id);
  const year=result.settings.year;
  const expected=year%4===0 && (year%100!==0 || year%400===0) ? 8784 : 8760;
  return {ranks,losses,hotspot,worst,energyError,lossError,invalid,expected};
}

export function createResultsSummary({onHighlight,onToggle}) {
  const button=document.getElementById('results-summary');
  const panel=document.getElementById('summary-panel');
  const content=document.getElementById('summary-content');
  let active=false, lastResult, lastModel, metrics;
  function element(tag,text) {
    const node=document.createElement(tag);
    if (text!==undefined) node.textContent=text;
    return node;
  }
  function section(title) {
    const node=element('section');
    node.append(element('h3',title));
    content.append(node);
    return node;
  }
  function finding(parent,title,description,patch,face=false) {
    const row=element('button');
    row.className='summary-finding';
    row.append(element('strong',title),element('small',description));
    row.onclick=()=>onHighlight(patch,face);
    parent.append(row);
  }
  function detail(parent,label,description) {
    const node=element('details');
    node.dataset.key=label;
    node.append(element('summary','Show calculation'),element('p',description));
    parent.append(node);
  }
  function update(model,result,selected) {
    if (!active) return;
    const opened=new Set([...content.querySelectorAll('details[open]')].map(node=>node.dataset.key));
    content.replaceChildren();
    if (!result || !model) {
      content.append(element('p','Run annual analysis for the current site and orientation to see the summary.'));
      return;
    }
    if (result!==lastResult || model!==lastModel) {
      metrics=summarize(model,result);
      lastResult=result;lastModel=model;
    }
    const {ranks,losses,hotspot,worst,energyError,lossError,invalid,expected}=metrics;
    content.append(element('p',result.settings.year+' UTC · '+format.format(model.patches.length)+' surface patches'));
    const checks=section('Internal run checks');
    const list=element('ul');
    list.append(element('li',(result.hours===expected?'Pass':'Review')+' · '+format.format(result.hours)+' of '+format.format(expected)+' weather hours.'),
      element('li',invalid ? 'Review · '+invalid+' patches have invalid values.' : 'Pass · all component values are finite and nonnegative.'));
    checks.append(list);
    const closure=energyError<=.021 && lossError<=.026;
    finding(checks,(closure?'Pass':'Review')+' · energy balance',
      'Component sums reconcile at the displayed precision. Click to inspect the largest rounding residual.',worst);
    if (!closure) checks.querySelector('button small').textContent='A component sum differs beyond the rounding tolerance.';
    detail(checks,'checks','Maximum absolute residual is '+format.format(energyError)+units+' for beam + diffuse + reflection and '
      +format.format(lossError)+units+' for the open reference minus modeled irradiation. The checks allow for rounding of each exported term.');
    const roofs=section('Area-weighted roof ranking');
    const scroll=element('div');
    scroll.className='summary-rank';
    roofs.append(scroll);
    for (const [i,face] of ranks.entries()) {
      finding(scroll,(i+1)+'. Roof face '+(face.id+1),format.format(face.mean)+units+' across '
        +format.format(face.area)+' m².',face.patch,true);
    }
    if (!ranks.length) roofs.append(element('p','No roof faces were included in this run.'));
    if (ranks.length) {
      const first=ranks[0];
      detail(roofs,'ranks','Each face mean is Σ(patch area × patch irradiation) ÷ Σ(patch area). Face '
        +(first.id+1)+': '+format.format(first.weighted)+' kWh ÷ '+format.format(first.area)+' m² = '+format.format(first.mean)+units+'.');
    }
    const shade=section('Largest shading hotspot');
    function breakdown(i) {
      return [['Beam',result.loss[i]],['Diffuse',result.diffuseLoss[i]],['Ground reflection',result.groundLoss[i]]];
    }
    if (losses[hotspot] > .005) {
      const lead=breakdown(hotspot).sort((a,b)=>b[1]-a[1])[0][0];
      finding(shade,'Patch '+(hotspot+1)+' · face '+(model.faces[hotspot]+1),'This '+model.types[hotspot]
        +' patch lost '+format.format(losses[hotspot])+units+'. '+lead+' was the largest contributor.',hotspot);
      detail(shade,'hotspot','Ranked by total annual loss per square metre across roofs and walls. The open reference uses the same weather and orientation with no geometry blocking the sun, sky or ground.');
    } else shade.append(element('p','The run found no geometry-related annual loss at the reported precision.'));
    const patch=section('Selected patch loss');
    if (selected<0) patch.append(element('p','Click a surface patch to see its loss breakdown.'));
    else {
      const values=breakdown(selected);
      finding(patch,'Patch '+(selected+1)+' · '+format.format(losses[selected])+units+' lost',
        values.map(([name,value])=>name+' '+format.format(value)).join(' · ')+units,selected);
      detail(patch,'patch','Each loss is its unobstructed component minus the geometry-aware component. Open total '
        +format.format(result.open[selected])+units+' minus modeled total '+format.format(result.total[selected])+units
        +'. The three rounded losses sum to '+format.format(losses[selected])+units+'.');
    }
    const benchmark=section('Benchmark comparisons');
    benchmark.append(element('p','No matched independent benchmark was run. The internal checks above test consistency within this simulation.'));
    content.querySelectorAll('details').forEach(node=>node.open=opened.has(node.dataset.key));
  }
  function open(value) {
    active=value;
    panel.hidden=!value;
    button.setAttribute('aria-pressed',value);
    onToggle(value);
  }
  button.onclick=()=>open(!active);
  document.getElementById('results-close').onclick=()=>open(false);
  return {update,open};
}

