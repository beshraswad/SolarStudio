import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const viewer = document.querySelector('#viewer');
const detail = document.querySelector('#detail');
const prompt = 'Select a roof or wall to inspect it.';
const palette = ['#1328a0','#087bd3','#04b7ba','#37d782','#a3ea33','#f7ef0a','#ffba08','#fa7104','#e84906'];
const colors = palette.map(value => new THREE.Color(value));
const format = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const world = ([x, y, z]) => [x, z, -y];

async function start() {
  const response = await fetch('./villa.json');
  if (!response.ok) throw new Error('Villa results could not be loaded.');
  const data = await response.json();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e1ebe7');
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 450);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  viewer.append(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.maxPolarAngle = Math.PI * 0.52;
  controls.target.set(0, 4, 0);
  camera.position.set(54, 49, 55);
  controls.update();
  controls.saveState();
  document.querySelector('#reset').onclick = () => controls.reset();

  const model = new THREE.Group();
  scene.add(model);
  for (const face of Object.keys(data.summary)) {
    const positions = [], shades = [];
    data.faces.forEach((id, index) => {
      if (String(id) !== face) return;
      const bandValue = Math.floor(data.total[index] / 10) * 10;
      const position = THREE.MathUtils.clamp(bandValue / data.scale, 0, 1) * (colors.length - 1);
      const lower = Math.floor(position);
      const color = colors[lower].clone().lerp(colors[Math.min(lower + 1, colors.length - 1)], position - lower);
      for (const vertex of data.patches[index]) {
        positions.push(...world(vertex));
        shades.push(color.r, color.g, color.b);
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(shades, 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.userData.face = face;
    model.add(mesh);
  }
  const grid = new THREE.GridHelper(100, 40, '#9aac9f', '#bdcdc4');
  grid.position.y = -0.04;
  scene.add(grid);
  const resize = () => {
    camera.aspect = viewer.clientWidth / viewer.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(viewer.clientWidth, viewer.clientHeight);
    render();
  };
  const render = () => renderer.render(scene, camera);
  let selected;
  function select(mesh) {
    if (selected) selected.material.color.set('white');
    selected = mesh;
    if (!mesh) {
      detail.textContent = prompt;
    } else {
      mesh.material.color.set('#c3d9ff');
      const id = mesh.userData.face;
      const face = data.summary[id];
      const azimuth = face.azimuth === null ? '' : ` · ${format.format(face.azimuth)}° azimuth`;
      detail.textContent = `Face ${Number(id) + 1} · ${face.kind} · ${format.format(face.area)} m² · ${format.format(face.tilt)}° tilt${azimuth} | ${format.format(face.mean)} kWh/m² annual average`;
    }
    render();
  }
  const ray = new THREE.Raycaster();
  let down;
  renderer.domElement.onpointerdown = event => { down = [event.clientX, event.clientY]; };
  renderer.domElement.onpointerup = event => {
    if (!down || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 5) return;
    const rect = viewer.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1,
      1 - (event.clientY - rect.top) / rect.height * 2), camera);
    select(ray.intersectObjects(model.children.filter(mesh => mesh.visible))[0]?.object);
  };
  const filters = document.querySelectorAll('[data-filter]');
  filters.forEach(button => button.onclick = () => {
    const filter = button.dataset.filter;
    filters.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    model.children.forEach(mesh => {
      mesh.visible = filter === 'all' || data.summary[mesh.userData.face].kind === filter;
    });
    if (selected && !selected.visible) select(null);
    render();
  });
  document.querySelector('#gradient').style.background = `linear-gradient(90deg,${palette.join(',')})`;
  for (let i = 0; i <= 4; i++) {
    const tick = document.createElement('span');
    tick.textContent = format.format(data.scale * i / 4);
    document.querySelector('#ticks').append(tick);
  }
  detail.textContent = prompt;
  controls.addEventListener('change', render);
  new ResizeObserver(resize).observe(viewer);
  resize();
}

start().catch(error => { detail.textContent = 'Unable to display the villa. Check that WebGL is enabled and reload.'; console.error(error); });
