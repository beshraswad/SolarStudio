import * as T from 'three';

export function createPlanner({scene, world, modelPoint, geometry, line, clear, camera, api, getModel, getAnnual, getSettings, onOpen, onApply, onFocus}) {
  const $ = id=>document.getElementById(id);
  const overlay = new T.Group();
  scene.add(overlay);
  const selected = new Set();
  let active=false, exclusions=[], draft=null, editing=null, preview=null, applied=null, revision=0;
  const format = new Intl.NumberFormat('en',{maximumFractionDigits:1});
  const numeric=['length','width','watts','target','setback','spacing','ratio'];
  function status(message='', error=false) {
    $('panel-status').textContent=message;
    $('panel-status').classList.toggle('error',error);
  }
  function invalidate() {
    revision++;
    preview=null;
    refresh();
  }
  function polygon(points,closed,color) {
    const vertices=points.map(world);
    if (closed && vertices.length) vertices.push(vertices[0]);
    if (vertices.length>1) {
      const segment=line(vertices,color);
      segment.renderOrder=15;
      overlay.add(segment);
    }
  }
  function render() {
    clear(overlay);
    const model=getModel();
    if (!model) return;
    if (active && selected.size) {
      const triangles=model.triangles.filter((_,i)=>selected.has(model.triangleFaces[i]));
      const selectedMesh=new T.Mesh(geometry(triangles),new T.MeshBasicMaterial({
        color:0x4da498,transparent:true,opacity:.28,depthWrite:false,side:T.DoubleSide,
        polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2
      }));
      overlay.add(selectedMesh);
    }
    const layout=preview || applied;
    if (layout?.modules.length) {
      const triangles=[], frames=[], edges=[];
      for (const module of layout.modules) {
        const normal=model.normals[model.faces.indexOf(module.face)];
        const corners=module.corners.map(point=>point.map((v,i)=>v+normal[i]*.045));
        const [a,b,c,d]=corners;
        frames.push([a,b,c],[a,c,d]);
        const center=a.map((_,i)=>(a[i]+b[i]+c[i]+d[i])/4);
        const [p,q,r,s]=corners.map(point=>point.map((value,i)=>.92*value+.08*center[i]+.003*normal[i]));
        triangles.push([p,q,r],[p,r,s]);
        const mid=(x,y)=>x.map((value,i)=>(value+y[i])/2+.004*normal[i]);
        edges.push(mid(p,q),mid(s,r));
      }
      overlay.add(new T.Mesh(geometry(frames),new T.MeshBasicMaterial({
        color:preview ? 0xf5fff7 : 0xc7e6ed,side:T.DoubleSide
      })));
      overlay.add(new T.Mesh(geometry(triangles),new T.MeshBasicMaterial({
        color:preview ? 0x123953 : 0x14283a,side:T.DoubleSide
      })));
      overlay.add(new T.LineSegments(
        new T.BufferGeometry().setFromPoints(edges.map(world)),
        new T.LineBasicMaterial({color:0x7296ae})
      ));
    }
    if (!active) return;
    for (const item of exclusions) polygon(item.points,true,0xb22339);
    if (draft) polygon(draft.points,false,0xb22339);
    const points=editing ? editing.item.points : draft?.points || [];
    if (points.length) {
      const markers=new T.Points(new T.BufferGeometry().setFromPoints(points.map(world)),
        new T.PointsMaterial({color:0xca344e,size:7,sizeAttenuation:false,depthTest:false}));
      markers.renderOrder=16;
      overlay.add(markers);
    }
  }
  function refresh() {
    const chips=$('panel-faces');
    chips.replaceChildren(...[...selected].map(face=>{
      const button=document.createElement('button');
      button.textContent='Face '+(face+1)+' ×';
      button.onclick=()=>{selected.delete(face);draft=null;editing=null;invalidate();};
      return button;
    }));
    const list=$('panel-exclusions');
    list.replaceChildren(...exclusions.map((item,i)=>{
      const row=document.createElement('div');
      const label=document.createElement('span');
      label.textContent='Face '+(item.face+1)+' · polygon '+(i+1);
      const edit=document.createElement('button');
      edit.textContent=editing?.item===item ? 'Done' : 'Edit';
      edit.className='outline';
      edit.onclick=()=>{
        draft=null;
        editing=editing?.item===item ? null : {item,vertex:-1};
        selected.add(item.face);
        invalidate();
      };
      const remove=document.createElement('button');
      remove.textContent='Delete';
      remove.onclick=()=>{editing=null;exclusions.splice(i,1);invalidate();};
      row.append(label,edit,remove);
      return row;
    }));
    $('panel-pen').setAttribute('aria-pressed',Boolean(draft));
    $('panel-pen').textContent=draft ? 'Cancel pen' : 'Draw exclusion';
    $('panel-finish').hidden=!draft;
    $('panel-finish').disabled=!draft || draft.points.length<3;
    $('panel-undo').hidden=!draft;
    $('panel-undo').disabled=!draft?.points.length;
    $('panel-apply').disabled=!preview?.count;
    $('panel-hint').textContent=editing ? (editing.vertex<0
      ? 'Click a polygon vertex, then click its new position on the same face.'
      : 'Click the new vertex position on the same face.') : draft
      ? 'Click points on one selected roof, then close the polygon.'
      : 'Click roof faces in the model to add or remove them.';
    const layout=preview || applied;
    $('panel-summary').hidden=!layout;
    $('panel-focus').hidden=!layout?.count;
    $('panel-summary').replaceChildren();
    if (layout) {
      const line=document.createElement('div');
      line.textContent=(preview?'Preview':'Applied')+' · '+layout.count+' panels · '+format.format(layout.kwp)+' kWp';
      const yieldLine=document.createElement('strong');
      yieldLine.textContent=format.format(layout.generation)+' kWh/year estimated';
      $('panel-summary').append(line,yieldLine);
      if (layout.target != null) {
        const load=document.createElement('div');
        load.textContent=layout.shortfall > .01 ? 'Best layout found · Shortfall for this layout '+format.format(layout.shortfall)+' kWh/year'
          : 'Target met · '+format.format(layout.target)+' kWh/year';
        $('panel-summary').append(load);
      }
    }
    render();
  }
  function open(value) {
    if (value && !getModel()) return;
    active=value;
    if (!active) {draft=null;editing=null;revision++;preview=null;}
    $('panel-planner').hidden=!active;
    if (active) onOpen();
    document.querySelectorAll('.details > .inspector, .details > .preview').forEach(node=>node.hidden=active);
    $('place-panels').setAttribute('aria-pressed',active);
    refresh();
  }
  function pick(hit,event,box) {
    if (!active) return false;
    const model=getModel();
    if (!hit || model.types[hit.faceIndex]!=='roof') return true;
    const face=model.faces[hit.faceIndex], point=modelPoint(hit.point);
    if (draft) {
      if (!selected.has(face) || (draft.face!==null && draft.face!==face)) {
        status('Use points on one selected roof face.',true);
        return true;
      }
      if (draft.points.length >= 100) return true;
      draft.face=face;
      draft.points.push(point);
    } else if (editing) {
      if (face!==editing.item.face) return true;
      if (editing.vertex>=0) {
        editing.item.points[editing.vertex]=point;
        editing.vertex=-1;
      } else {
        let nearest=13;
        editing.item.points.forEach((vertex,i)=>{
          const p=world(vertex).project(camera);
          const distance=Math.hypot((p.x+1)*box.width/2+box.left-event.clientX,
            (1-p.y)*box.height/2+box.top-event.clientY);
          if (distance<nearest) {nearest=distance;editing.vertex=i;}
        });
      }
    } else {
      if (selected.has(face)) selected.delete(face);
      else selected.add(face);
    }
    status();
    invalidate();
    return true;
  }
  async function generate() {
    if (draft) return status('Close or cancel the unfinished polygon.',true);
    const model=getModel(), annual=getAnnual();
    if (!annual) return status('Run annual analysis for the current settings first.',true);
    if (!selected.size) return status('Click one or more roof faces first.',true);
    const values={};
    for (const key of numeric) {
      const input=$('panel-'+key);
      if (!input.checkValidity() || (key!=='target' && !input.value)) {
        return status('Check the value for '+key+'.',true);
      }
      values[key]=Number(input.value);
    }
    const token=++revision;
    $('panel-preview').disabled=true;
    status('Testing module spacing, setbacks and exclusions…');
    try {
      const result=await api('/api/panels',{...values,...getSettings(),model:model.id,faces:[...selected],exclusions,
        mode:$('panel-mode').value,analysis:annual.analysis});
      if (revision!==token || getAnnual()!==annual) return;
      preview=result;
      preview.annual=annual;
      status(result.count ? 'Review the preview on the model, then apply it.' : 'No modules fit with these settings.');
      refresh();
      if (result.count) onFocus(result.modules.flatMap(module=>module.corners));
    } catch (error) {if (revision===token) status(error.message,true);}
    finally {$('panel-preview').disabled=false;}
  }
  $('place-panels').onclick=()=>open(!active);
  $('panel-close').onclick=()=>open(false);
  $('panel-pen').onclick=()=>{
    if (!selected.size) return status('Select a roof face before drawing an exclusion.',true);
    editing=null;
    draft=draft ? null : {face:null,points:[]};
    status();
    refresh();
  };
  $('panel-finish').onclick=()=>{
    if (draft?.points.length>=3) {
      exclusions.push(draft);
      draft=null;
      invalidate();
    }
  };
  $('panel-undo').onclick=()=>{draft?.points.pop();refresh();};
  for (const key of numeric) $('panel-'+key).addEventListener('input',()=>{
    if (key==='target') {
      const mode=$('panel-mode'), available=+$('panel-target').value>0;
      mode.options[1].disabled=!available;
      if (!available) mode.value='fill';
    }
    invalidate();
  });
  $('panel-mode').onchange=invalidate;
  $('panel-preview').onclick=generate;
  $('panel-focus').onclick=()=>{
    const layout=preview || applied;
    if (layout?.count) onFocus(layout.modules.flatMap(module=>module.corners));
  };
  $('panel-apply').onclick=()=>{
    if (!preview?.count || preview.annual!==getAnnual()) return status('Regenerate the preview for the current analysis.',true);
    applied=preview;
    preview=null;
    onApply(applied);
    status('Layout applied to the current model.');
    refresh();
  };
  return {pick, open, reset(){
    selected.clear();exclusions=[];preview=null;applied=null;status();open(false);
  }, analysisChanged(){
    if (preview && preview.annual!==getAnnual()) invalidate();
    if (applied && applied.annual!==getAnnual()) status('The applied layout uses the prior analysis. Preview again to update its estimate.');
  }};
}

