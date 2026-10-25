import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { carStart, rampGeometry, type MidairFrame, type MidairScene } from "./midair";

type View = "cinematic" | "side" | "top";
const COLORS = { A: 0xff4d5e, B: 0x3d8bff } as const;

/** Presentation only: cars are posed from saved Rapier frames. Shared camera presets give the critic synced views. */
export class MidairRenderer {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  private readonly world = new THREE.Scene();
  private readonly root = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(36, 1, 0.02, 200);
  private readonly controls: OrbitControls;
  private readonly observer: ResizeObserver;
  private cars: THREE.Group[] = [];
  private spec: MidairScene | null = null;
  private frame: MidairFrame | null = null;
  private view: View = "cinematic";
  private raf = 0;
  private disposed = false;

  constructor(private readonly host: HTMLElement) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
    this.renderer.domElement.setAttribute("aria-label", "Two-car ramp simulation");
    host.appendChild(this.renderer.domElement);
    this.world.background = new THREE.Color(0xf2c48d);
    this.world.fog = new THREE.Fog(0xf2c48d, 12, 40);
    this.world.add(this.root);
    this.world.add(new THREE.HemisphereLight(0xfff0d8, 0x5a4a48, 1.9));
    const sun = new THREE.DirectionalLight(0xffc27a, 2.6);
    sun.position.set(-5, 6, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 4, bottom: -4, near: 0.5, far: 25 });
    sun.shadow.normalBias = 0.02;
    this.world.add(sun);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize();
    const loop = () => {
      if (this.disposed) return;
      this.controls.update();
      this.renderer.render(this.world, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  load(scene: MidairScene, ghost?: MidairScene): void {
    clear(this.root);
    this.spec = scene;
    const mat = (c: number, r = 0.7) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(40, 20), mat(0x55545c, 0.95));
    road.rotation.x = -Math.PI / 2;
    road.receiveShadow = true;
    this.root.add(road);
    const curb = new THREE.Mesh(new THREE.BoxGeometry(40, 0.12, 2), mat(0xb9c3cf, 0.9));
    curb.position.set(0, 0.06, 3.2);
    this.root.add(curb);
    const drawRamp = (s: MidairScene, which: "A" | "B", m: THREE.Material) => {
      const g = rampGeometry(s, which);
      const t = 0.03;
      const plank = new THREE.Mesh(new THREE.BoxGeometry(g.length, t, s.rampWidth), m);
      plank.position.set(g.baseX + g.dir * ((g.length / 2) * Math.cos(g.a) + (t / 2) * Math.sin(g.a)), (g.length / 2) * Math.sin(g.a) - (t / 2) * Math.cos(g.a), g.z);
      plank.rotation.z = g.dir * g.a;
      plank.castShadow = plank.receiveShadow = true;
      this.root.add(plank);
      return g;
    };
    for (const which of ["A", "B"] as const) {
      const g = drawRamp(scene, which, mat(0xd8b07a, 0.8));
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.18, g.lipY, 0.3), mat(0x9b2f2f, 0.6));
      box.position.set(g.lipX + g.dir * 0.09, g.lipY / 2, g.z);
      box.castShadow = true;
      this.root.add(box);
      // Lane stripe: where the car runs.
      const lane = new THREE.Mesh(new THREE.PlaneGeometry(6, scene.car.width), new THREE.MeshBasicMaterial({ color: COLORS[which], transparent: true, opacity: 0.18 }));
      lane.rotation.x = -Math.PI / 2;
      lane.position.set(g.baseX - g.dir * 3, 0.003, g.z);
      this.root.add(lane);
    }
    if (ghost)
      for (const which of ["A", "B"] as const)
        if (rampGeometry(ghost, which).z !== rampGeometry(scene, which).z) drawRamp(ghost, which, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false }));
    this.cars = (["A", "B"] as const).map((which) => {
      const grp = new THREE.Group();
      const { car } = scene;
      const body = new THREE.Mesh(new THREE.BoxGeometry(car.length, car.height, car.width), mat(COLORS[which], 0.35));
      body.castShadow = true;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(car.length * 0.4, car.height * 0.6, car.width * 0.7), mat(0x1a1a1f, 0.4));
      roof.position.set(-0.03, car.height * 0.7, 0);
      grp.add(body, roof);
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          const w = new THREE.Mesh(new THREE.CylinderGeometry(car.wheelRadius, car.wheelRadius, 0.05, 18), mat(0x111111, 0.9));
          w.rotation.x = Math.PI / 2;
          w.position.set(sx * (car.length / 2 - car.wheelRadius), -car.height / 2 - 0.01, sz * (car.width / 2 - 0.01));
          grp.add(w);
        }
      const s = carStart(scene, which);
      grp.position.set(s.x, car.wheelRadius + 0.05 + car.height / 2, s.z);
      if (s.dir < 0) grp.rotation.y = Math.PI;
      this.root.add(grp);
      return grp;
    });
    this.setView(this.view);
  }

  setFrame(frame: MidairFrame): void {
    this.frame = frame;
    frame.cars.forEach((c, i) => {
      const g = this.cars[i];
      if (!g) return;
      g.position.set(c.position.x, c.position.y, c.position.z);
      g.quaternion.set(c.rotation.x, c.rotation.y, c.rotation.z, c.rotation.w);
    });
  }

  setView(view: View): void {
    this.view = view;
    if (!this.spec) return;
    const pose = viewPose(this.spec, view);
    this.camera.fov = pose.fov;
    this.camera.up.set(...pose.up);
    this.camera.position.set(...pose.position);
    this.controls.target.set(...pose.target);
    this.controls.enabled = view === "cinematic";
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  /** Synchronized sheet: top row SIDE, bottom row TOP-DOWN, same simulation times. Restores the live view. */
  captureSheet(scene: MidairScene, frames: MidairFrame[], requested: number[]): { jpegBase64: string; times: number[] } {
    if (!frames.length) throw new Error("Cannot capture a simulation with no frames");
    const saved = { spec: this.spec, frame: this.frame, view: this.view, size: this.renderer.getSize(new THREE.Vector2()), ratio: this.renderer.getPixelRatio(), aspect: this.camera.aspect };
    const width = 400, height = 240, label = 24, cols = Math.min(5, requested.length);
    const sheet = document.createElement("canvas");
    sheet.width = width * cols;
    sheet.height = (height + label) * 2;
    const ctx = sheet.getContext("2d");
    if (!ctx) throw new Error("Canvas capture is unavailable");
    const times: number[] = [];
    try {
      this.load(scene);
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      requested.slice(0, cols).forEach((want, i) => {
        const frame = frames.reduce((a, b) => (Math.abs(b.t - want) < Math.abs(a.t - want) ? b : a), frames[0]!);
        this.setFrame(frame);
        (["side", "top"] as View[]).forEach((v, row) => {
          this.setView(v);
          this.renderer.render(this.world, this.camera);
          const x = i * width, y = row * (height + label);
          ctx.drawImage(this.renderer.domElement, x, y, width, height);
          ctx.fillStyle = "#130f14";
          ctx.fillRect(x, y + height, width, label);
          ctx.fillStyle = "#ffe8cc";
          ctx.font = "12px monospace";
          ctx.fillText(`${v === "side" ? "SIDE" : "TOP-DOWN"} · SIM t=${frame.t.toFixed(2)} s`, x + 8, y + height + 16);
        });
        times.push(+frame.t.toFixed(3));
      });
      return { jpegBase64: sheet.toDataURL("image/jpeg", 0.88).split(",")[1]!, times };
    } finally {
      if (saved.spec) this.load(saved.spec);
      if (saved.frame) this.setFrame(saved.frame);
      this.renderer.setPixelRatio(saved.ratio);
      this.renderer.setSize(saved.size.x, saved.size.y, false);
      this.camera.aspect = saved.aspect;
      this.setView(saved.view);
    }
  }

  /** Client point → lateral (z) position on the road plane, for lane dragging. */
  roadZ(clientX: number, clientY: number): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    this.camera.updateMatrixWorld();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    return hit ? hit.z : null;
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.controls.dispose();
    clear(this.root);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}

/** Camera presets (pure) — the same for play and for the critic's sheet. */
export function viewPose(scene: MidairScene, view: View) {
  const a = rampGeometry(scene, "A"), b = rampGeometry(scene, "B");
  const sa = carStart(scene, "A"), sb = carStart(scene, "B");
  const lo = Math.min(sa.x, a.baseX) - 0.3, hi = Math.max(sb.x, b.baseX) + 0.3;
  const cx = (lo + hi) / 2, zc = (a.z + b.z) / 2;
  if (view === "top") return { fov: 30, position: [cx, (hi - lo) * 1.15, zc + 0.001] as [number, number, number], target: [cx, 0, zc] as [number, number, number], up: [0, 0, -1] as [number, number, number] };
  if (view === "side") return { fov: 22, position: [cx, 0.55, (hi - lo) * 1.55 + zc] as [number, number, number], target: [cx, 0.35, zc] as [number, number, number], up: [0, 1, 0] as [number, number, number] };
  return { fov: 38, position: [cx - 1.1, 2.1, zc + 3.7] as [number, number, number], target: [cx, 0.25, zc] as [number, number, number], up: [0, 1, 0] as [number, number, number] };
}

function clear(root: THREE.Group): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) mat.dispose();
  });
  root.clear();
}
