import * as T from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { createPlanner } from './panel-planner.js';
import { createResultsSummary } from './results-summary.js';
import { createStudy } from './study-workspace.js';

const $ = id => document.getElementById(id);
const viewport = $('canvas');
const state = { north: 0, mode: 'annual', filter: 'roof', view: 'orbit', selected: -1 };
const format = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const energy = new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bands = ['#1328a0','#1051cb','#087bd3','#009ccd','#04b7ba','#11c9a1','#37d782','#6ce35b',
  '#a3ea33','#d4ef0b','#f7ef0a','#ffdb05','#ffba08','#ff9707','#fa7104','#e84906'].map(value=>new T.Color(value));
const liveScale = 1200;
const annualBandWidth = 10;
const annualBandCount = {value:0};
let gradientBandCount, gradientValue;
function annualGradient(count) {
  if (gradientBandCount === count) return gradientValue;
  const stops=[];
  for (let i=0;i<count;i++) {
    const position=i*15/Math.max(1,count-1);
    const low=Math.floor(position);
    const color=bands[low].clone().lerp(bands[Math.min(15,low+1)],position-low);
    stops.push('#'+color.getHexString()+' '+(100*i/count)+'% '+(100*(i+1)/count)+'%');
  }
  gradientBandCount=count;
  gradientValue='linear-gradient(90deg,'+stops.join(',')+')';
  return gradientValue;
}
const world = ([x,y,z]) => new T.Vector3(x,z,-y);
const modelPoint = point => [point.x,-point.z,point.y];
const mod = angle => ((angle % 360) + 360) % 360;
const bearing = (a,b) => mod(T.MathUtils.radToDeg(Math.atan2(b[0]-a[0],b[1]-a[1])));
const degree = value => Number.isFinite(value) ? format.format(value) + '°' : '—';
let renderer;
try {
  renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
} catch (error) {
  $('status').textContent = 'WebGL is required. Enable graphics acceleration or open another browser.';
  $('status').classList.add('error');
  throw error;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
viewport.append(renderer.domElement);
const scene = new T.Scene();
const camera = new T.OrthographicCamera(-10,10,10,-10,0.01,2000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.51;
controls.minZoom = 0.28;
controls.maxZoom = 12;
const group = new T.Group(), annotations = new T.Group(), solar = new T.Group(), resultMarks = new T.Group();
scene.add(group, annotations, solar, resultMarks);
const ray = new T.Raycaster(), pointer = new T.Vector2();
const groundPlane = new T.Plane(new T.Vector3(0,1,0),0);
let mesh, grid, roofGuides, frame = 28;
let previewRequest = 0;
let previewController;
let playback, sunMarker, sunRadius;
let vertexGroups, vertexCounts, groupValues;
let compassGround, northDraft, readingRequest = 0;
const compassTexture = new T.TextureLoader().load('/static/compass.png');
compassTexture.colorSpace = T.SRGBColorSpace;
const monthNames = Array.from({length:12}, (_,i) =>
  new Intl.DateTimeFormat('en',{month:'long',timeZone:'UTC'}).format(new Date(Date.UTC(2024,i,1))));
$('playback-month').replaceChildren(...monthNames.map((name,i)=>new Option(name,i)));

async function api(url, data, signal) {
  const options = data === undefined ? {} : data instanceof FormData
    ? {method:'POST',body:data}
    : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)};
  const response = await fetch(url,{...options,signal});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request failed.');
  return result;
}
function clear(group) {
  for (const child of [...group.children]) {
    child.geometry?.dispose();
    child.material?.dispose();
    group.remove(child);
  }
}
function geometry(triangles) {
  const geo = new T.BufferGeometry();
  geo.setAttribute('position', new T.Float32BufferAttribute(
    triangles.flatMap(vertices => vertices.flatMap(vertex => world(vertex).toArray())), 3));
  geo.computeVertexNormals();
  return geo;
}
function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
function resize() {
  const {clientWidth:w,clientHeight:h} = viewport;
  if (!w || !h) return;
  const vertical = frame * Math.max(1, 1.04*h/w);
  camera.left = -vertical*w/h/2;
  camera.right = -camera.left;
  camera.top = vertical/2;
  camera.bottom = -camera.top;
  camera.updateProjectionMatrix();
  renderer.setSize(w,h,false);
}
new ResizeObserver(resize).observe(viewport);
function setView(view) {
  state.view = view;
  $('orbit').setAttribute('aria-pressed', view === 'orbit');
  $('top').setAttribute('aria-pressed', view === 'top');
  controls.enableRotate = view === 'orbit';
  camera.up.set(0,1,0);
  controls.target.set(0, (state.model?.size[2] || 0) * .32, 0);
  camera.position.copy(controls.target).add(view === 'top'
    ? new T.Vector3(0,frame,0.00001) : new T.Vector3(-frame*.82,frame*.75,frame*1.01));
  camera.zoom = 1;
  controls.update();
  resize();
  hint();
}
function focusPoints(points, direction) {
  if (!points.length) return;
  const vertices=points.map(world);
  const center=new T.Box3().setFromPoints(vertices).getCenter(new T.Vector3());
  const offset=direction || camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(offset,frame*1.3);
  camera.zoom=1;
  camera.updateProjectionMatrix();
  controls.update();
  camera.updateMatrixWorld();
  let span=0;
  for (const vertex of vertices) {
    const p=vertex.clone().project(camera);
    span=Math.max(span,Math.abs(p.x),Math.abs(p.y));
  }
  camera.zoom=T.MathUtils.clamp(.74/Math.max(span,.045),controls.minZoom,controls.maxZoom);
  camera.updateProjectionMatrix();
}
function drawBuilding(model) {
  clear(group);
  scene.remove(grid);
  grid?.geometry.dispose();
  grid?.material.dispose();
  const span = Math.max(...model.size);
  frame = Math.hypot(model.size[0],model.size[1],model.size[2]) * 1.01;
  grid = new T.GridHelper(span * 7, 100, 0xa4bab3, 0xb7ccc4);
  grid.position.y = -.035;
  grid.material.transparent = true;
  grid.material.opacity = .55;
  scene.add(grid);
  if (compassGround) {
    scene.remove(compassGround);
    compassGround.children[0].geometry.dispose();
    compassGround.children[0].material.dispose();
  }
  compassGround = new T.Group();
  const rose = new T.Mesh(new T.PlaneGeometry(span*1.43,span*1.43),
    new T.MeshBasicMaterial({map:compassTexture,transparent:true,opacity:.7,depthWrite:false}));
  rose.rotation.x = -Math.PI/2;
  compassGround.add(rose);
  compassGround.position.y = .01;
  compassGround.visible = false;
  scene.add(compassGround);
  const base = new T.Mesh(geometry(model.triangles),new T.MeshBasicMaterial({color:0xa4b0b0,side:T.DoubleSide}));
  group.add(base);
  const geo = geometry(model.patches);
  geo.setAttribute('color',new T.Float32BufferAttribute(new Float32Array(geo.attributes.position.count*3),3));
  geo.setAttribute('solarValue',new T.Float32BufferAttribute(new Float32Array(geo.attributes.position.count),1));
  const shared = new Map();
  vertexGroups = Int32Array.from(model.patches.flatMap((tri,i)=>tri.map(vertex=>{
    const key = model.faces[i]+':'+vertex.map(value=>value.toFixed(5)).join(',');
    if (!shared.has(key)) shared.set(key,shared.size);
    return shared.get(key);
  })));
  vertexCounts = new Uint32Array(shared.size);
  vertexGroups.forEach(index=>vertexCounts[index]++);
  groupValues = new Float32Array(shared.size);
  const material = new T.MeshBasicMaterial({
    vertexColors:true, side:T.DoubleSide, polygonOffset:true, polygonOffsetFactor:-1, polygonOffsetUnits:-1,
  });
  material.onBeforeCompile = shader=>{
    shader.uniforms.uBands = {value:bands};
    shader.uniforms.uAnnualBandCount = annualBandCount;
    shader.vertexShader = 'attribute float solarValue; varying float vSolarValue;\n'+shader.vertexShader
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvSolarValue = solarValue;');
    shader.fragmentShader = 'varying float vSolarValue; uniform vec3 uBands[16]; uniform float uAnnualBandCount;\n'+shader.fragmentShader
      .replace('#include <color_fragment>',`#include <color_fragment>
        if (vSolarValue >= 0.0) {
          int band = int(min(15.0, floor(vSolarValue * 16.0)));
          diffuseColor.rgb = uBands[band];
          if (uAnnualBandCount > 0.0) {
            float index = min(floor(vSolarValue * uAnnualBandCount), uAnnualBandCount - 1.0);
            float shade = index * 15.0 / max(1.0, uAnnualBandCount - 1.0);
            int lo = int(floor(shade));
            diffuseColor.rgb = mix(uBands[lo], uBands[min(lo+1,15)], fract(shade));
          }
        }`);
  };
  mesh = new T.Mesh(geo,material);
  group.add(mesh);
  const edgeGeo = new T.BufferGeometry().setFromPoints(model.edges.flat().map(world));
  const outlines = new T.LineSegments(edgeGeo,new T.LineBasicMaterial({color:0x293e44,transparent:true,opacity:.29}));
  outlines.renderOrder = 2;
  group.add(outlines);
  roofGuides = new T.LineSegments(
    new T.BufferGeometry().setFromPoints(model.roofEdges.flat().map(world)),
    new T.LineBasicMaterial({color:0x176353,depthTest:false,transparent:true,opacity:.65})
  );
  roofGuides.renderOrder = 4;
  roofGuides.visible = false;
  group.add(roofGuides);
  setView('orbit');
}
function current() {
  for (const id of ['lat','lon','year']) {
    if (!$(id).value || !$(id).checkValidity()) throw new Error('Enter valid site coordinates and a completed weather year.');
  }
  const coord = id => Math.round(Number($(id).value)*10000)/10000;
  return {model:state.model?.id, lat:coord('lat'), lon:coord('lon'), year:+$('year').value, north:state.north};
}
function matching() {
  if (!state.result) return false;
  try {
    const config = current();
    return ['lat','lon','year','north'].every(key =>
      Math.abs(config[key] - state.result.settings[key]) < 1e-8);
  } catch { return false; }
}
function activeLayer(i) {
  return state.filter === 'all' || state.model.types[i] === state.filter;
}
function liveValue(i, frame = state.sun) {
  const {direction,irradiance,mask,lit} = frame;
  const [ghi,dni,dhi] = irradiance;
  const [x,y,z] = state.model.normals[i];
  const facing = Math.max(0,x*direction[0]+y*direction[1]+z*direction[2]);
  const visible = mask ? (mask[i >> 3] & (1 << (i & 7))) !== 0 : lit[i];
  return (visible ? dni*facing : 0)+dhi*state.model.skyFactor[i]+.2*ghi*state.model.groundFactor[i];
}
function paint(updateSummary = true) {
  if (!mesh) return;
  const attribute = mesh.geometry.attributes.color;
  const scalar = mesh.geometry.attributes.solarValue;
  const normal = state.model.normals;
  const result = matching() ? state.result : undefined;
  const live = state.mode === 'shadow' && state.sun;
  const annual = state.mode === 'annual' && result;
  const face = annual && state.detail && state.selected >= 0 ? state.model.faces[state.selected] : null;
  let min = 0, max = live ? liveScale : result?.scale || 2000;
  if (face !== null) {
    const samples = result.total.filter((_,i)=>state.model.faces[i]===face);
    min = Math.min(...samples);
    max = Math.max(...samples);
  }
  const uniform = face !== null && min === max;
  const interval = Number($('contour-step').value) || annualBandWidth;
  if (annual && face === null) max = Math.ceil(max/interval)*interval;
  const bandCount = annual && face === null ? max / interval : 0;
  annualBandCount.value = bandCount;
  groupValues.fill(0);
  if (live || annual) {
    for (let i=0; i<normal.length; i++) {
      const value = live ? liveValue(i) : result.total[i];
      for (let j=0; j<3; j++) groupValues[vertexGroups[3*i+j]] += value;
    }
  }
  const color = new T.Color();
  for (let i=0; i<normal.length; i++) {
    const lighting = .78 + .18*normal[i][2] + .06*(-normal[i][0]-normal[i][1]);
    color.setHex(0xbfcac8).multiplyScalar(lighting);
    const colored = (live || annual) && activeLayer(i) && (face === null || state.model.faces[i] === face);
    for (let j=0; j<3; j++) {
      const v = 3*i+j, group = vertexGroups[v];
      attribute.setXYZ(v,color.r,color.g,color.b);
      const level = uniform ? .5 : T.MathUtils.clamp((groupValues[group]/vertexCounts[group]-min)/(max-min),0,1);
      scalar.setX(v,colored ? level : -1);
    }
  }
  attribute.needsUpdate = true;
  scalar.needsUpdate = true;
  $('legend').hidden = state.studyMap || !(annual || live);
  $('legend-title').textContent = live ? 'Clear-sky irradiance' : face === null ? 'Annual irradiation' : 'Face '+(face+1)+' · detail';
  $('legend-units').textContent = uniform ? 'Same value on every modeled patch' : live ? 'W/m²'
    : bandCount ? interval+' kWh/m² per band' : 'kWh/m²';
  $('contour-label').hidden=!bandCount;
  const swatch = $('legend').querySelector('.gradient');
  swatch.style.background = uniform ? '#'+bands[8].getHexString()
    : bandCount ? annualGradient(bandCount) : '';
  $('face-detail').hidden = !annual;
  $('face-detail').disabled = state.selected < 0;
  $('face-detail').setAttribute('aria-pressed',face !== null);
  [...$('ticks').children].forEach((tick,i)=>{
    tick.hidden = uniform ? i !== 0 : face !== null && max-min < .04 && i !== 0 && i !== 4;
    const value = min+(max-min)*i/4;
    tick.textContent = face !== null ? energy.format(value)+(uniform ? ' kWh/m²' : '') : format.format(value);
  });
  const frame = live || state.readout;
  const selectedLive = frame && state.selected >= 0;
  $('patch-live').hidden = !selectedLive;
  if (selectedLive) $('patch-live').textContent = format.format(liveValue(state.selected,frame))+' W/m² · clear sky';
  if (!updateSummary) return;
  resultsSummary.update(state.model,result,state.selected);
  const roofIndices = state.model.types.flatMap((type,i) => type === 'roof' ? [i] : []);
  const roofAreas = roofIndices.map(i => {
    const [a,b,c] = state.model.patches[i].map(world);
    return b.sub(a).cross(c.sub(a)).length()/2;
  });
  const area = roofAreas.reduce((a,b) => a+b,0);
  $('roof-average').textContent = result && area
    ? format.format(roofIndices.reduce((total,i,j) => total+result.total[i]*roofAreas[j],0)/area) : '—';
  $('weather-summary').textContent = $('year').value || '—';
  $('hour-count').textContent = result ? format.format(result.hours) + ' hourly records' : 'NASA POWER · hourly';
  const check = state.mode === 'annual' && result?.check;
  $('comparison').hidden = !check;
  if (check) $('comparison-label').textContent = energy.format(check.difference)+' kWh/m² less from shade';
  inspect();
}
function line(points, color, opacity=1) {
  return new T.Line(new T.BufferGeometry().setFromPoints(points),
    new T.LineBasicMaterial({color,opacity,transparent:opacity<1,depthTest:false}));
}
function redrawSelection() {
  clear(annotations);
  if (state.selected >= 0) {
    const vertices = state.model.patches[state.selected].map(world);
    const selection = line([...vertices,vertices[0]],0x173834);
    selection.renderOrder = 5;
    annotations.add(selection);
  }
  const pair = state.edge || (state.arrowStart && state.arrowEnd ? [state.arrowStart,state.arrowEnd] : undefined);
  if (pair) {
    const [a,b] = pair.map(world);
    const direction = b.clone().sub(a);
    const length = direction.length();
    if (length > .001) {
      direction.normalize();
      const side = new T.Vector3(-direction.z,0,direction.x).normalize();
      const head = b.clone().addScaledVector(direction,-Math.min(length*.32,frame*.04));
      const width = Math.min(length*.13,frame*.017);
      for (const points of [[a,b],[head.clone().addScaledVector(side,width),b,head.clone().addScaledVector(side,-width)]]) {
        const segment = line(points,0x0a7254);
        segment.renderOrder = 8;
        annotations.add(segment);
      }
    }
  }
}
function inspect() {
  const i = state.selected;
  const result = matching() ? state.result : undefined;
  const isPatch = i >= 0;
  const n = state.model?.normals[i];
  $('patch-name').textContent = isPatch ? (state.model.types[i] === 'roof' ? 'Roof' : 'Wall') + ' patch ' + (i+1) : 'No patch selected';
  $('patch-face').textContent = isPatch ? 'Face ' + (state.model.faces[i]+1) : 'Click the model';
  $('tilt').textContent = n ? degree(T.MathUtils.radToDeg(Math.acos(T.MathUtils.clamp(n[2],-1,1)))) : '—';
  $('azimuth').textContent = n && Math.hypot(n[0],n[1]) > 1e-5 ? degree(mod(bearing([0,0],n)-state.north)) : '—';
  if (n && Math.hypot(n[0],n[1]) <= 1e-5) $('azimuth').textContent = 'Flat';
  $('annual-export').disabled = !result;
  $('hourly-export').disabled = !result || !isPatch;
  for (const [id,key] of [['patch-total','total'],['direct','direct'],['diffuse','diffuse'],['ground','ground'],['loss','loss']]) {
    $(id).textContent = isPatch && result ? energy.format(result[key][i]) : '—';
  }
}
function hint() {
  if (roofGuides) roofGuides.visible = state.tool === 'edge';
  const message = {
    draw: state.arrowStart ? 'Click the tip of the true north arrow' : 'Click the base of the true north arrow',
    edge: state.edge ? 'Set the bearing in Project setup' : 'Click a roof edge to set its bearing',
  }[state.tool];
  $('view-help').textContent = message || (state.view === 'top'
    ? 'Right-drag to pan · Scroll to zoom' : 'Drag to orbit · Scroll to zoom');
}
function endTool() {
  state.tool = null;
  state.edge = state.arrowStart = state.arrowEnd = undefined;
  $('bearing-box').hidden = true;
  $('draw-north').setAttribute('aria-pressed','false');
  $('edge-north').setAttribute('aria-pressed','false');
  redrawSelection();
  hint();
}
function beginTool(tool) {
  const open = state.tool !== tool;
  endTool();
  if (!open || !state.model) return;
  state.tool = tool;
  state.filter = 'roof';
  updateFilter();
  setView('top');
  $(tool === 'draw' ? 'draw-north' : 'edge-north').setAttribute('aria-pressed','true');
  hint();
}
function setNorth(north) {
  state.north = mod(north);
  if (northDraft !== undefined) {
    northDraft = state.north;
    $('orientation-angle').value = Number(northDraft.toFixed(4));
    $('orientation-slider').value = northDraft;
  }
  clearPreview();
  setMode('annual');
  planner.analysisChanged();
  refreshReadings();
  studyWorkspace.changed();
  status('True north updated. Run analysis to refresh results.');
}
function select(i) {
  clear(resultMarks);
  state.selected = i;
  if (i < 0) state.detail = false;
  paint();
  redrawSelection();
}
function highlightResult(i, wholeFace) {
  const model=state.model, face=model.faces[i];
  state.filter=model.types[i];
  state.detail=false;
  updateFilter();
  setMode('annual');
  select(i);
  const triangles=model.triangles.filter((_,j)=>model.triangleFaces[j]===face);
  if (!triangles.length) return;
  if (wholeFace) {
    const tint=new T.Mesh(geometry(triangles),new T.MeshBasicMaterial({
      color:0x00e0c0,transparent:true,opacity:.27,side:T.DoubleSide,depthWrite:false,
      polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2
    }));
    tint.renderOrder=5;
    resultMarks.add(tint);
  } else {
    const tri=model.patches[i].map(world);
    const center=tri[0].clone().add(tri[1]).add(tri[2]).divideScalar(3);
    const marker=new T.Mesh(new T.SphereGeometry(Math.max(.12,frame*.005),16,10),
      new T.MeshBasicMaterial({color:0x004e51,depthTest:false}));
    marker.position.copy(center);
    marker.renderOrder=16;
    resultMarks.add(marker);
  }
  const n=world(model.normals[i]);
  if (!wholeFace && model.types[i]==='roof') setView('top');
  let view=camera.position.clone().sub(controls.target).normalize();
  if ((state.view==='top' && model.types[i]==='wall') || view.dot(n)<.18) {
    setView('orbit');
    view=n.clone().add(new T.Vector3(.2,.62,.15)).normalize();
  }
  focusPoints(triangles.flat(),view);
}
function compare(key) {
  const point = state.result?.check?.[key];
  if (!point) return;
  endTool();
  state.filter = 'roof';
  updateFilter();
  select(point.index);
}
function updateFilter() {
  document.querySelectorAll('[data-filter]').forEach(button =>
    button.setAttribute('aria-pressed', button.dataset.filter === state.filter));
  if (state.model && (state.selected < 0 || !activeLayer(state.selected))) {
    select(state.model.types.findIndex((_,i)=>activeLayer(i)));
  }
  paint();
}
function getEdge(event) {
  const box = renderer.domElement.getBoundingClientRect();
  const point = new T.Vector2(event.clientX-box.left,event.clientY-box.top);
  const pixel = vertex => {
    const p = world(vertex).project(camera);
    return new T.Vector2((p.x+1)*box.width/2,(1-p.y)*box.height/2);
  };
  let best = 12, edge;
  const model = state.model;
  for (const candidate of model.roofEdges) {
    const [a,b] = candidate.map(pixel), segment = b.clone().sub(a);
    if (segment.lengthSq() < 4) continue;
    const t = T.MathUtils.clamp(point.clone().sub(a).dot(segment)/segment.lengthSq(),0,1);
    const distance = point.distanceTo(a.addScaledVector(segment,t));
    if (distance < best) { best = distance; edge = candidate; }
  }
  return edge;
}
let start;
renderer.domElement.addEventListener('pointerdown',event => {
  start = [event.clientX,event.clientY];
});
renderer.domElement.addEventListener('pointerup',event => {
  if (!state.model || !start || event.button !== 0 || Math.hypot(event.clientX-start[0],event.clientY-start[1]) > 5) return;
  const box = renderer.domElement.getBoundingClientRect();
  pointer.set(2*(event.clientX-box.left)/box.width-1,1-2*(event.clientY-box.top)/box.height);
  ray.setFromCamera(pointer,camera);
  if (state.tool === 'draw') {
    const hit = ray.ray.intersectPlane(groundPlane,new T.Vector3());
    if (!hit) return;
    const p = modelPoint(hit);
    p[2] = state.model.size[2]+.1;
    if (!state.arrowStart) state.arrowStart = p;
    else if (Math.hypot(p[0]-state.arrowStart[0],p[1]-state.arrowStart[1]) > frame*.02) {
      state.arrowEnd = p;
      setNorth(bearing(state.arrowStart,p));
      state.tool = null;
      $('draw-north').setAttribute('aria-pressed','false');
      redrawSelection();
    }
    hint();
    return;
  }
  if (state.tool === 'edge') {
    const edge = getEdge(event);
    if (edge) {
      state.edge = edge;
      $('bearing-box').hidden = false;
      redrawSelection();
      hint();
    }
    return;
  }
  const hit = ray.intersectObject(mesh)[0];
  if (planner.pick(hit,event,box)) return;
  studyWorkspace.pick(hit);
  if (hit && activeLayer(hit.faceIndex)) select(hit.faceIndex);
});
function clearPreview() {
  previewRequest++;
  previewController?.abort();
  playback?.controller.abort();
  playback = null;
  state.sun = null;
  clear(solar);
  sunMarker = null;
  $('transport').hidden = true;
  if (state.readout) showReadings(state.readout);
}
function openAnnual() {
  clearPreview();
  setMode('annual');
}
function releaseViewport() {
  if (!$('panel-planner').hidden) planner.open(false);
  editOrientation(false);
  studyWorkspace.cancelPick();
}
function activateSunTool() {
  releaseViewport();
  studyWorkspace.showModel();
}
function showReadings(frame) {
  $('sun-elevation').textContent = degree(frame?.elevation);
  $('sun-zenith').textContent = degree(frame ? 90-frame.elevation : NaN);
  $('sun-azimuth').textContent = degree(frame && Math.hypot(frame.direction[0],frame.direction[1]) > 1e-8 ? frame.azimuth : NaN);
  $('sun-longitude').textContent = $('lon').value ? degree(Number($('lon').value)) : '—';
  ['live-ghi','live-dni','live-dhi'].forEach((id,i)=>{
    $(id).textContent = frame ? format.format(frame.irradiance[i])+' W/m²' : '—';
  });
}
async function refreshReadings() {
  const token = ++readingRequest;
  state.readout = null;
  if (state.mode === 'annual' || !state.sun) showReadings();
  paint(false);
  try {
    const config = current();
    if (!config.model || !$('date').value || !$('time').value) return;
    const instant = $('date').value+'T'+$('time').value+':00'+offset();
    const frame = await api('/api/preview',{...config,instant});
    if (token !== readingRequest) return;
    state.readout = frame;
    if (state.mode === 'annual' || !state.sun) {
      showReadings(frame);
      paint(false);
    }
  } catch {
    if (token === readingRequest && state.mode === 'annual') showReadings();
  }
}
function setMode(mode) {
  state.mode = mode;
  if (mode === 'annual' && playback) pausePlayback();
  showReadings(mode === 'annual' ? state.readout : state.sun || state.readout);
  $('annual').setAttribute('aria-pressed',mode==='annual');
  $('shadow').setAttribute('aria-pressed',mode==='shadow');
  $('view-title').textContent = mode === 'annual' ? 'Annual irradiation' : 'Live solar contour';
  $('view-caption').textContent = mode === 'annual' ? 'Select a surface patch to inspect its results.'
    : state.sun?.caption || 'Showing the sun path in model coordinates.';
  solar.visible = mode==='shadow';
  $('transport').hidden = mode !== 'shadow' || !playback?.frames;
  paint();
}
function offset() {
  const value = $('offset').value;
  if (!/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(value)) throw new Error('Enter a UTC offset such as +04:00.');
  return value;
}
function drawPath(path) {
  clear(solar);
  sunRadius = Math.max(...state.model.size)*.63;
  const horizon = Array.from({length:97},(_,i)=>{
    const angle = i * Math.PI/48;
    return new T.Vector3(Math.cos(angle)*sunRadius,0,Math.sin(angle)*sunRadius);
  });
  solar.add(new T.Line(new T.BufferGeometry().setFromPoints(horizon),
    new T.LineBasicMaterial({color:0x627d80,opacity:.4,transparent:true})));
  const above = [], below = [];
  const points = path.map(vector=>world(vector).multiplyScalar(sunRadius));
  for (let i=1; i<points.length; i++) {
    const a = points[i-1], b = points[i];
    const target = a.y >= 0 ? above : below;
    if ((a.y >= 0) === (b.y >= 0)) target.push(a,b);
    else {
      const cross = a.clone().lerp(b,a.y/(a.y-b.y));
      target.push(a,cross);
      (b.y >= 0 ? above : below).push(cross,b);
    }
  }
  solar.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(above),
    new T.LineBasicMaterial({color:0xbb7810,depthTest:false})));
  const night = new T.LineSegments(new T.BufferGeometry().setFromPoints(below),
    new T.LineDashedMaterial({color:0x627d92,dashSize:sunRadius*.055,gapSize:sunRadius*.035,
      opacity:.55,transparent:true}));
  night.computeLineDistances();
  solar.add(night);
  sunMarker = new T.Mesh(new T.SphereGeometry(sunRadius*.033,20,12),
    new T.MeshBasicMaterial({color:0xffbc36,depthTest:false}));
  sunMarker.renderOrder = 9;
  solar.add(sunMarker);
}
function moveSun(direction) {
  sunMarker.position.copy(direction).multiplyScalar(sunRadius);
  sunMarker.material.color.setHex(direction.y > 0 ? 0xffbc36 : 0x63839b);
}
function updateSun(frame, caption) {
  state.sun = frame;
  moveSun(world(frame.direction));
  showReadings(frame);
  frame.caption = caption + (frame.elevation > 0
    ? ' · Modeled clear-sky irradiance.' : ' · Sun below the horizon.');
  $('view-caption').textContent = frame.caption;
  paint(false);
}
async function preview() {
  activateSunTool();
  clearPreview();
  const token = previewRequest;
  previewController = new AbortController();
  setMode('shadow');
  status('Preparing sun preview…');
  try {
    const settings = current();
    const instant = $('date').value+'T'+$('time').value+':00'+offset();
    const result = await api('/api/preview',{...settings,instant},previewController.signal);
    if (token !== previewRequest) return;
    drawPath(result.path);
    state.readout = result;
    setMode('shadow');
    updateSun(result,'Full-day path · '+$('date').value);
    status('Gold shows daylight. The dashed line shows the path below the horizon.');
  } catch (error) {
    if (token === previewRequest) status(error.message,true);
  }
}
function pausePlayback() {
  playback.running = false;
  playback.lastTime = null;
  $('playback-toggle').textContent = 'Play';
  $('playback-toggle').setAttribute('aria-label','Resume solar playback');
}
function resumePlayback() {
  playback.running = true;
  playback.lastTime = null;
  $('playback-toggle').textContent = 'Pause';
  $('playback-toggle').setAttribute('aria-label','Pause solar playback');
}
function showFrame(session) {
  const time = session.minute;
  const index = Math.min(96, Math.round(time/15));
  if (session.index !== index) {
    session.index = index;
    updateSun(session.frames[index],session.average
      ? monthNames[session.month]+' '+session.year+' average day' : 'Selected day · '+session.date);
  }
  const base = Math.min(95, Math.floor(time/15));
  const direction = world(session.frames[base].direction)
    .lerp(world(session.frames[base+1].direction),(time-base*15)/15).normalize();
  moveSun(direction);
  const minute = Math.floor(time);
  if (minute !== session.shownMinute) {
    session.shownMinute = minute;
    $('playback-scrub').value = minute;
    $('playback-clock').textContent = String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');
  }
}
function getFrames(session, month) {
  if (!session.cache.has(month)) {
    const monthDate = session.year+'-'+String(month+1).padStart(2,'0')+'-01';
    const date = session.average ? monthDate : session.date;
    const request = api('/api/playback',{
      ...session.config, start:date+'T00:00:00'+session.offset, average:session.average,
    },session.controller.signal).then(({frames})=>frames.map(frame=>({
      ...frame, mask:Uint8Array.from(atob(frame.mask),character=>character.charCodeAt(0)),
    }))).catch(error=>{
      session.cache.delete(month);
      throw error;
    });
    session.cache.set(month,request);
  }
  return session.cache.get(month);
}
async function showMonth(session, month, runAfterLoading) {
  const revision = ++session.revision;
  pausePlayback();
  session.frames = null;
  $('transport').hidden = true;
  status(session.average ? 'Preparing '+monthNames[month]+' average day…' : 'Preparing day playback…');
  try {
    const frames = await getFrames(session,month);
    if (playback !== session || revision !== session.revision) return;
    Object.assign(session,{month,frames,minute:0,index:-1,shownMinute:-1});
    $('playback-month').value = month;
    $('playback-month').hidden = !session.average;
    drawPath(frames.map(frame=>frame.direction));
    setMode('shadow');
    showFrame(session);
    if (runAfterLoading) resumePlayback();
    status(session.average ? 'Playing 12 representative days from weather year '+session.year+'.'
      : 'Day playback uses local clock time and 15-minute shadow samples.');
    if (session.average && month < 11) getFrames(session,month+1).catch(()=>{});
  } catch (error) {
    if (playback === session && revision === session.revision) status(error.message,true);
  }
}
function startPlayback(average) {
  try {
    const config = current();
    const utcOffset = offset();
    if (!average && !$('date').value) throw new Error('Choose a date for day playback.');
    activateSunTool();
    clearPreview();
    setMode('shadow');
    playback = {average,config,offset:utcOffset,year:config.year,date:$('date').value,
      cache:new Map(),revision:0,running:false,controller:new AbortController()};
    showMonth(playback,0,true);
  } catch (error) { status(error.message,true); }
}
async function run() {
  if (!state.model) return;
  releaseViewport();
  studyWorkspace.showModel();
  openAnnual();
  $('run').disabled = true;
  const modelId = state.model.id;
  try {
    const config = current();
    status('Preparing NASA POWER weather and tracing hourly sun rays…');
    const {job} = await api('/api/analyze',config);
    while (state.model.id === modelId) {
      await new Promise(resolve => setTimeout(resolve,800));
      const reply = await api('/api/jobs/'+job);
      if (state.model.id !== modelId) return;
      if (reply.status === 'complete') {
        if (state.result?.check && matching() && Object.keys(reply.result.settings).every(
          key => reply.result.settings[key] === state.result.settings[key])) {
          reply.result.check = state.result.check;
        }
        state.result = reply.result;
        planner.analysisChanged();
        paint();
        if (state.mode==='annual') status(matching() ? format.format(reply.result.hours)+' hours analyzed.' : 'Settings changed. Run again to update results.');
        return;
      }
    }
  } catch (error) {
    if (state.model.id === modelId) status(error.message,true);
  } finally {
    $('run').disabled = false;
  }
}
async function load(file) {
  for (const id of ['run','import','load-villa','preview','play-day','play-year']) $(id).disabled = true;
  try {
    status(file ? 'Tessellating STEP model…' : 'Loading villa and weather results…');
    const demo = !file;
    let model, result;
    if (demo) {
      [model,result] = await Promise.all([api('/api/model'),api('/api/demo')]);
      for (const id of ['lat','lon','year']) $(id).value = result.settings[id];
    } else {
      const body = new FormData();
      body.append('model',file);
      model = await api('/api/import',body);
    }
    state.model=model;
    studyWorkspace.reset();
    clear(resultMarks);
    state.placement=null;
    planner.reset();
    state.readout=null;
    state.result=result;
    state.filter='roof';
    state.selected=-1;
    state.detail=false;
    state.north=result?.settings.north || 0;
    editOrientation(false);
    clearPreview();
    endTool();
    drawBuilding(model);
    $('project-name').textContent=model.name.replaceAll('_',' ');
    $('file-name').textContent=demo ? 'Villa STEP model' : model.filename;
    $('model-meta').textContent=format.format(model.patches.length)+' patches · STEP';
    updateSiteLabel();
    const initial = demo ? (result.check?.shaded?.index ?? result.total.indexOf(Math.max(...result.total)))
      : Math.max(0,model.types.indexOf('roof'));
    if (model.types[initial] !== 'roof') state.filter = 'all';
    select(initial);
    updateFilter();
    setMode('annual');
    refreshReadings();
    status(demo ? format.format(result.hours)+' hours analyzed · cached weather.' : 'Model ready. Check site and north, then run analysis.');
  } catch (error) {
    status(error.message,true);
  } finally {
    $('run').disabled = !state.model;
    $('preview').disabled = !state.model;
    $('play-day').disabled = $('play-year').disabled = !state.model;
    $('import').disabled = $('load-villa').disabled = false;
  }
}
function updateSiteLabel() {
  const lat = $('lat').value, lon = $('lon').value;
  $('location').textContent = +lat === 24.4539 && +lon === 54.3773 ? 'ABU DHABI, UAE'
    : (lat || '—')+'°, '+(lon || '—')+'°';
}
function editOrientation(open) {
  if (!compassGround) return;
  if (open) {
    endTool();
    northDraft = state.north;
    $('orientation-angle').value = Number(northDraft.toFixed(4));
    $('orientation-slider').value = northDraft;
  } else {
    northDraft = undefined;
    endTool();
  }
  compassGround.visible = open;
  $('orientation-box').hidden = !open;
  $('compass-button').setAttribute('aria-pressed',open);
}
function saveCsv(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(href),30000);
}
function exportAnnual() {
  if (!matching()) return;
  const {model,result,north} = state;
  const header = 'patch_id,face_id,surface,latitude_deg,longitude_deg,year_utc,north_model_deg,hourly_records,centroid_x_model_m,centroid_y_model_m,centroid_z_model_m,area_m2,tilt_deg,azimuth_deg_true,sky_factor,ground_factor,beam_kwh_m2,sky_kwh_m2,ground_kwh_m2,annual_poa_kwh_m2,face_average_kwh_m2,open_poa_kwh_m2,beam_loss_kwh_m2,total_loss_pct,direct_sun_hours';
  const areas = model.patches.map(tri=>{
    const [a,b,c] = tri.map(world);
    return b.sub(a).cross(c.sub(a)).length()/2;
  });
  const faceTotals = new Map();
  areas.forEach((area,i)=>{
    const face = model.faces[i], [sum,weight] = faceTotals.get(face) || [0,0];
    faceTotals.set(face,[sum+area*result.total[i],weight+area]);
  });
  const rows = model.patches.map((tri,i)=>{
    const [x,y,z] = model.normals[i];
    const center = tri[0].map((_,axis)=>(tri[0][axis]+tri[1][axis]+tri[2][axis])/3);
    const [sum,weight] = faceTotals.get(model.faces[i]);
    const tilt = T.MathUtils.radToDeg(Math.acos(T.MathUtils.clamp(z,-1,1)));
    const azimuth = Math.hypot(x,y)>1e-5 ? mod(bearing([0,0],[x,y])-north) : '';
    const open = result.open[i];
    return [i+1,model.faces[i]+1,model.types[i],result.settings.lat,result.settings.lon,result.settings.year,north,result.hours,
      ...center,areas[i],tilt,azimuth,model.skyFactor[i],model.groundFactor[i],result.direct[i],result.diffuse[i],
      result.ground[i],result.total[i],sum/weight,open,result.loss[i],open>0 ? 100*(1-result.total[i]/open) : '',
      result.sunHours[i]].map(value=>typeof value==='number' ? +value.toFixed(8) : value).join(',');
  });
  saveCsv(new Blob([[header,...rows].join('\r\n')+'\r\n'],{type:'text/csv'}),`annual-patches-${result.settings.year}.csv`);
}
async function exportHourly() {
  if (!matching() || state.selected < 0) return;
  const patch = state.selected, config = current();
  $('hourly-export').disabled = true;
  try {
    const response = await fetch('/api/hourly.csv',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...config,patch})});
    if (!response.ok) throw new Error('Hourly CSV export failed.');
    saveCsv(await response.blob(),`patch-${patch+1}-${config.year}-hourly.csv`);
  } catch (error) { status(error.message,true); }
  finally { inspect(); }
}
$('annual-export').onclick=exportAnnual;
$('hourly-export').onclick=exportHourly;
$('calculations-link').onclick=()=>{
  try {
    const config = current();
    if (!config.model) throw new Error('Open a model to see its calculations.');
    const patch = Math.max(0,state.selected);
    const result = matching() ? state.result : null;
    const instant = $('date').value+'T'+$('time').value+':00'+offset();
    const placement = state.placement?.annual === result ? state.placement?.placement : null;
    sessionStorage.setItem('solar-worked-calculation',JSON.stringify({
      ...config,patch,instant,analysis:result?.analysis,placement
    }));
  } catch (error) {
    sessionStorage.setItem('solar-worked-calculation',JSON.stringify({error:error.message}));
  }
};
$('compass-button').onclick=()=>{
  if (!$('orientation-box').hidden) return editOrientation(false);
  releaseViewport();
  if (playback || state.mode==='shadow') openAnnual();
  editOrientation(true);
};
$('orientation-close').onclick=()=>editOrientation(false);
$('orientation-angle').oninput=()=>{
  if ($('orientation-angle').value === '') return;
  northDraft = mod(Number($('orientation-angle').value));
  $('orientation-slider').value = northDraft;
};
$('orientation-slider').oninput=()=>{
  northDraft = Number($('orientation-slider').value);
  $('orientation-angle').value = northDraft;
};
$('orientation-apply').onclick=()=>{
  if (!$('orientation-angle').value || !Number.isFinite(northDraft)) return;
  const value = northDraft;
  editOrientation(false);
  if (Math.abs(value-state.north) < 1e-8) return;
  setNorth(value);
  if (!$('run').disabled) run();
};
$('year').max = new Date().getFullYear()-1;
$('run').onclick=run;
$('import').onclick=()=>{
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.step,.stp';
  picker.addEventListener('change',()=>{
    if (picker.files[0]) load(picker.files[0]);
  },{once:true});
  picker.click();
};
$('load-villa').onclick=()=>load();
$('orbit').onclick=()=>{endTool();setView('orbit');};
$('top').onclick=()=>setView('top');
$('draw-north').onclick=()=>beginTool('draw');
$('edge-north').onclick=()=>beginTool('edge');
$('flip-edge').onclick=()=>{state.edge=[...state.edge].reverse();redrawSelection();};
$('apply-bearing').onclick=()=>{
  if (!state.edge || !$('bearing').value || !$('bearing').checkValidity()) {
    status('Enter a bearing between 0° and 360°.',true);
    return;
  }
  setNorth(bearing(...state.edge)-Number($('bearing').value));
  state.tool=null;
  $('bearing-box').hidden=true;
  $('edge-north').setAttribute('aria-pressed','false');
  hint();
};
document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{
  state.filter=button.dataset.filter;updateFilter();
});
$('annual').onclick=()=>{releaseViewport();studyWorkspace.showModel();openAnnual();status('Annual view.');};
$('shadow').onclick=()=>{
  if (!state.sun) return preview();
  activateSunTool();
  setMode('shadow');
};
$('preview').onclick=preview;
$('face-detail').onclick=()=>{state.detail=!state.detail;paint();};
$('contour-step').onchange=()=>paint();
$('play-day').onclick=()=>startPlayback(false);
$('play-year').onclick=()=>startPlayback(true);
$('playback-toggle').onclick=()=>{
  if (!playback?.frames) return;
  if (playback.running) pausePlayback();
  else if (playback.minute >= 1440) showMonth(playback,
    playback.average ? (playback.month+1)%12 : 0,true);
  else resumePlayback();
};
$('playback-restart').onclick=()=>{
  if (playback?.frames) showMonth(playback,0,playback.running);
};
$('playback-month').onchange=()=>{
  if (playback?.frames) showMonth(playback,+$('playback-month').value,playback.running);
};
$('playback-scrub').oninput=()=>{
  if (!playback?.frames) return;
  pausePlayback();
  playback.minute = +$('playback-scrub').value;
  showFrame(playback);
};
$('compare-shaded').onclick=()=>compare('shaded');
$('compare-clear').onclick=()=>compare('clear');
for (const id of ['lat','lon','year']) $(id).addEventListener('input',()=>{
  updateSiteLabel();
  clearPreview();
  setMode('annual');
  planner.analysisChanged();
  refreshReadings();
  status('Site or weather settings changed. Run analysis to refresh results.');
});
for (const id of ['date','time','offset']) $(id).addEventListener('change',()=>{
  clearPreview();
  if (state.mode==='shadow') preview();
  else refreshReadings();
});
for (const id of ['lat','lon','year','date','time','offset']) {
  $(id).addEventListener('change',()=>studyWorkspace.changed());
}
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape') return;
  releaseViewport();
  if(playback || state.mode==='shadow') openAnnual();
});
renderer.setAnimationLoop(now=>{
  controls.update();
  if (playback?.running && playback.frames) {
    const elapsed = playback.lastTime === null ? 0 : Math.min(now-playback.lastTime,100);
    playback.lastTime = now;
    const duration = playback.average ? 6500 : 12000;
    playback.minute = Math.min(1440,playback.minute + elapsed * 1440 / duration * +$('playback-speed').value);
    showFrame(playback);
    if (playback.minute === 1440) {
      if (playback.average && playback.month < 11) showMonth(playback,playback.month+1,true);
      else {
        pausePlayback();
        if (playback.average && matching()) {
          state.detail = false;
          setMode('annual');
          status('Year playback complete. Showing the annual contour for design.');
        } else {
          status(playback.average ? 'Year playback complete. Run annual analysis for the design contour.'
            : 'Day playback complete. Use Annual to view the design contour.');
        }
      }
    }
  }
  const n = T.MathUtils.degToRad(northDraft ?? state.north);
  if (compassGround) compassGround.rotation.y = -n;
  const north = world([Math.sin(n),Math.cos(n),0]).add(controls.target).project(camera);
  const base = controls.target.clone().project(camera);
  const angle = Math.atan2((north.x-base.x)*viewport.clientWidth,(north.y-base.y)*viewport.clientHeight);
  $('needle').style.transform='rotate('+angle+'rad)';
  renderer.render(scene,camera);
});
const resultsSummary = createResultsSummary({
  onHighlight:(patch,face)=>{
    highlightResult(patch,face);
    $('viewport').scrollIntoView({block:'nearest'});
  },
  onToggle:open=>{
    if (!open) clear(resultMarks);
    paint();
    if (open) {
      releaseViewport();
      openAnnual();
      $('summary-panel').scrollIntoView({block:'start'});
    }
  },
});
const planner = createPlanner({
  scene, world, modelPoint, geometry, line, clear, camera, api,
  getModel:()=>state.model, getAnnual:()=>matching() ? state.result : null,
  getSettings:current,
  onOpen:()=>{
    editOrientation(false);
    studyWorkspace.showModel();
    state.detail=false;
    state.filter='roof';
    updateFilter();
    openAnnual();
  },
  onFocus:points=>focusPoints(points),
  onApply:layout=>{state.placement=layout;},
});
const studyWorkspace = createStudy({
  scene, geometry, clear, getModel:()=>state.model, getSettings:current,
  onActivate:()=>{releaseViewport();state.detail=false;openAnnual();},
  onMap:active=>{state.studyMap=active;if(mesh){mesh.visible=!active;paint(false);}},
  snapshot:()=>{
    renderer.render(scene,camera);
    return renderer.domElement.toDataURL('image/png');
  },
});
$('figure-close').onclick=()=>$('figure-dialog').close();
$('figure-report').onclick=async()=>{
  if (!state.model) return;
  const grid=$('figure-grid'), dialog=$('figure-dialog'), download=$('figure-pdf');
  const config=studyWorkspace.reportInputs();
  const ids=config.faces.map(i=>i+1);
  const patch=state.selected;
  grid.replaceChildren();
  download.hidden=true;
  $('figure-context').textContent=state.model.name+' · '+config.year+' UTC weather year · UTC'+config.offset
    +' · '+(ids.length?'Faces '+ids.join(', '):'No study faces selected')
    +(patch>=0?' · Patch '+(patch+1):'');
  $('figure-status').textContent='Preparing 10 figures…';
  dialog.showModal();
  try {
    const result=await api('/api/figure-report',{...config,patch,analysis:matching()?state.result.analysis:null});
    const base='/api/figure-report/'+result.id+'/';
    download.href=base+'report.pdf';
    download.download='solar-analysis-report.pdf';
    download.hidden=false;
    result.titles.forEach((title,index)=>{
      const card=document.createElement('figure');
      const preview=document.createElement('img');
      const caption=document.createElement('figcaption');
      const label=document.createElement('span');
      const link=document.createElement('a');
      preview.src=base+(index+1)+'.png';
      preview.alt=title;
      preview.width=1152;
      preview.height=945;
      label.textContent=(index+1)+'. '+title;
      link.href=preview.src;
      link.download='solar-figure-'+(index+1)+'.png';
      link.textContent='Download PNG';
      caption.append(label,link);card.append(preview,caption);grid.append(card);
    });
    $('figure-status').textContent='Five pages · two figures per page';
  } catch(error) {
    $('figure-status').textContent=error.message;
  }
};
load();

