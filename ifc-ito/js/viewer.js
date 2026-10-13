/*
 * Optional 3D viewer: web-ifc (WASM) for tessellation and three.js for display.
 * Both libraries are loaded from a CDN; when they are not available the rest
 * of the application keeps working without 3D.
 *
 * Besides rendering, the viewer computes geometric quantities per element
 * (volume, surface area, bounding box dimensions) from the triangulated
 * geometry, comparable to the computed quantities in model checkers.
 */
(function (root) {
  'use strict';

  const WEBIFC_VERSION = '0.0.74';

  function Viewer(container, opts) {
    this.container = container;
    this.opts = opts || {};
    this.meshesById = new Map(); // expressID -> [mesh]
    this.baseMaterials = new Map();
    this.ready = false;
  }

  Viewer.available = function () {
    return typeof THREE !== 'undefined' && typeof WebIFC !== 'undefined' && THREE.OrbitControls;
  };

  Viewer.prototype.init = function () {
    if (this.renderer) return;
    const c = this.container;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 5000);
    camera.up.set(0, 0, 1);
    camera.position.set(20, -20, 15);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    c.appendChild(renderer.domElement);
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f94, 0.85));
    const dl = new THREE.DirectionalLight(0xffffff, 0.65);
    dl.position.set(30, -40, 60);
    scene.add(dl);
    this.group = new THREE.Group();
    scene.add(this.group);
    this.scene = scene; this.camera = camera; this.renderer = renderer; this.controls = controls;
    this.raycaster = new THREE.Raycaster();
    this.highlightMat = new THREE.MeshLambertMaterial({ color: 0xffb020, emissive: 0x6a3a00, side: THREE.DoubleSide });
    this.ghostMat = new THREE.MeshLambertMaterial({ color: 0x9aa4a8, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide });

    const resize = () => {
      const w = this.container.clientWidth || 1; const h = this.container.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    this._resize = resize;
    window.addEventListener('resize', resize);
    resize();

    let down = null;
    renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    renderer.domElement.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const id = this.pick(e);
      if (this.opts.onPick) this.opts.onPick(id, e.shiftKey || e.ctrlKey || e.metaKey);
    });
    const loop = () => {
      requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();
  };

  Viewer.prototype.pick = function (e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(v, this.camera);
    const objs = this.group.children.filter((m) => m.visible && m.material !== this.ghostMat);
    const hit = this.raycaster.intersectObjects(objs, false)[0];
    return hit ? hit.object.userData.id : null;
  };

  // Loads the model geometry. Returns Map(expressID -> computed quantities).
  Viewer.prototype.load = async function (bytes, onProgress) {
    this.init();
    this.clear();
    if (!this.api) {
      const api = new WebIFC.IfcAPI();
      const base = root.ITO_WASM_BASE || ('https://cdn.jsdelivr.net/npm/web-ifc@' + WEBIFC_VERSION + '/');
      api.SetWasmPath(base, true);
      await api.Init(undefined, true);
      this.api = api;
    }
    const api = this.api;
    const modelID = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });
    const quantities = new Map();
    const matCache = new Map();
    const tmp = new THREE.Matrix4();
    let count = 0;
    const self = this;
    api.StreamAllMeshes(modelID, (mesh) => {
      const id = mesh.expressID;
      const placed = mesh.geometries;
      const q = quantities.get(id) || { volume: 0, area: 0, topArea: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (let i = 0; i < placed.size(); i++) {
        const pg = placed.get(i);
        const geom = api.GetGeometry(modelID, pg.geometryExpressID);
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        const pos = new Float32Array(verts.length / 2);
        const nor = new Float32Array(verts.length / 2);
        for (let k = 0, j = 0; k < verts.length; k += 6, j += 3) {
          pos[j] = verts[k]; pos[j + 1] = verts[k + 1]; pos[j + 2] = verts[k + 2];
          nor[j] = verts[k + 3]; nor[j + 1] = verts[k + 4]; nor[j + 2] = verts[k + 5];
        }
        const bg = new THREE.BufferGeometry();
        bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        bg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        bg.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
        tmp.fromArray(pg.flatTransformation);
        bg.applyMatrix4(tmp);
        // web-ifc is Y-up; rotate to Z-up to match IFC convention
        bg.rotateX(Math.PI / 2);
        accumulate(q, bg);
        const col = pg.color;
        const key = [col.x, col.y, col.z, col.w].map((v) => v.toFixed(3)).join(',');
        let mat = matCache.get(key);
        if (!mat) {
          mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(col.x, col.y, col.z), transparent: col.w < 1, opacity: col.w, side: THREE.DoubleSide, depthWrite: col.w >= 1 });
          matCache.set(key, mat);
        }
        const m = new THREE.Mesh(bg, mat);
        m.userData.id = id;
        self.baseMaterials.set(m, mat);
        self.group.add(m);
        let arr = self.meshesById.get(id);
        if (!arr) { arr = []; self.meshesById.set(id, arr); }
        arr.push(m);
        geom.delete();
      }
      quantities.set(id, q);
      count++;
      if (onProgress && count % 200 === 0) onProgress(count);
    });
    api.CloseModel(modelID);
    this.fit();
    this.ready = true;
    const out = new Map();
    quantities.forEach((q, id) => {
      out.set(id, {
        volume: Math.abs(q.volume),
        area: q.area,
        topArea: q.topArea,
        dx: q.max[0] - q.min[0], dy: q.max[1] - q.min[1], dz: q.max[2] - q.min[2],
        zMin: q.min[2], zMax: q.max[2]
      });
    });
    return out;
  };

  function accumulate(q, bg) {
    const p = bg.attributes.position.array;
    const index = bg.index.array;
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (p[i + a] < q.min[a]) q.min[a] = p[i + a];
        if (p[i + a] > q.max[a]) q.max[a] = p[i + a];
      }
    }
    for (let t = 0; t < index.length; t += 3) {
      const i0 = index[t] * 3; const i1 = index[t + 1] * 3; const i2 = index[t + 2] * 3;
      const ax = p[i0], ay = p[i0 + 1], az = p[i0 + 2];
      const bx = p[i1], by = p[i1 + 1], bz = p[i1 + 2];
      const cx = p[i2], cy = p[i2 + 1], cz = p[i2 + 2];
      // signed volume of tetrahedron with origin
      q.volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      q.area += len / 2;
      if (len > 0 && nz / len > 0.7) q.topArea += len / 2;
    }
  }

  Viewer.prototype.clear = function () {
    if (!this.group) return;
    this.group.children.slice().forEach((m) => { m.geometry.dispose(); this.group.remove(m); });
    this.meshesById.clear();
    this.baseMaterials.clear();
    this.ready = false;
  };

  Viewer.prototype.fit = function (ids) {
    const box = new THREE.Box3();
    if (ids && ids.length) {
      ids.forEach((id) => (this.meshesById.get(id) || []).forEach((m) => box.expandByObject(m)));
    } else {
      this.group.children.forEach((m) => { if (m.visible) box.expandByObject(m); });
    }
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
    const dir = new THREE.Vector3(1, -1.2, 0.8).normalize();
    this.camera.position.copy(c).addScaledVector(dir, r * 2.4);
    this.camera.near = r / 100; this.camera.far = r * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
  };

  // state: {colors: Map(id->'#hex'), visible: Set|null, ghost: bool, selected: Set}
  Viewer.prototype.apply = function (state) {
    if (!this.group) return;
    const colorMats = this._colorMats || (this._colorMats = new Map());
    const colorMat = (hex) => {
      let m = colorMats.get(hex);
      if (!m) { m = new THREE.MeshLambertMaterial({ color: new THREE.Color(hex), side: THREE.DoubleSide }); colorMats.set(hex, m); }
      return m;
    };
    this.group.children.forEach((m) => {
      const id = m.userData.id;
      const inSet = !state.visible || state.visible.has(id);
      if (state.selected && state.selected.has(id)) { m.material = this.highlightMat; m.visible = true; return; }
      if (!inSet) {
        m.visible = !!state.ghost;
        m.material = this.ghostMat;
        return;
      }
      m.visible = true;
      const hex = state.colors && state.colors.get(id);
      m.material = hex ? colorMat(hex) : this.baseMaterials.get(m);
    });
  };

  Viewer.prototype.snapshot = function () {
    return this.renderer ? this.renderer.domElement.toDataURL('image/png') : null;
  };

  root.ITO = root.ITO || {};
  root.ITO.Viewer = Viewer;
})(typeof window !== 'undefined' ? window : globalThis);
