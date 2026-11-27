'use strict';

class SurveyViewport {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.mode = '3d';
    this.planRotation = 0;
    this.alignPlanToPhone = false;
    this.cut = true;
    this.fit();
    new ResizeObserver(() => this.draw()).observe(canvas);
    window.screen.orientation?.addEventListener('change', () => {
      if (this.alignPlanToPhone) this.draw();
    });
    canvas.addEventListener('pointerdown', event => {
      if (this.mode !== '3d' || event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      this.drag = [event.clientX, event.clientY];
    });
    canvas.addEventListener('pointermove', event => {
      if (!this.drag) return;
      this.azimuth += (event.clientX - this.drag[0]) * 0.009;
      this.elevation = Math.max(0.12, Math.min(1.43, this.elevation + (event.clientY - this.drag[1]) * 0.009));
      this.drag = [event.clientX, event.clientY];
      this.draw();
    });
    const endDrag = () => { this.drag = null; };
    canvas.addEventListener('lostpointercapture', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', event => {
      if (this.mode !== '3d' || !this.model || this.model.error) return;
      event.preventDefault();
      this.zoomBy(event.deltaY > 0 ? 0.9 : 1.1);
    }, { passive: false });
  }

  update(model, profile) {
    this.model = model;
    this.profile = profile;
    this.draw();
  }

  setMode(mode) {
    this.mode = mode;
    this.canvas.classList.toggle('plan', mode === 'plan');
    this.fit();
  }

  fit() {
    this.zoom = 1;
    this.azimuth = -0.65;
    this.elevation = 0.61;
    this.draw();
  }

  zoomBy(factor) {
    this.zoom = Math.max(0.6, Math.min(3, this.zoom * factor));
    this.draw();
  }

  setHeadingGuide(guide, rotation = 0, alignToPhone = false) {
    if (this.headingGuide?.index === guide?.index && this.headingGuide?.angle === guide?.angle &&
        this.planRotation === rotation && this.alignPlanToPhone === alignToPhone) return;
    this.headingGuide = guide;
    this.planRotation = rotation;
    this.alignPlanToPhone = alignToPhone;
    this.draw();
  }

  get planScreenOffset() {
    return this.alignPlanToPhone ? (window.screen.orientation?.angle ?? 0) - 90 : 0;
  }

  draw() {
    const { canvas, context: ctx } = this;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const density = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * density);
    const pixelHeight = Math.round(height * density);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineJoin = 'round';
    if (this.mode === 'plan' && this.profile?.points?.length > 1) this.drawPlan(width, height);
    else if (this.mode === 'plan' && this.headingGuide) this.drawHeading([width / 2, height / 2]);
    else if (this.mode === '3d' && this.model && !this.model.error) this.drawModel(width, height);
    else {
      ctx.textAlign = 'center';
      ctx.font = '600 15px "Segoe UI", sans-serif';
      ctx.fillStyle = '#4b5774';
      ctx.fillText(this.profile?.points?.length > 1 ? 'Kiểm tra đường bao trong chế độ Mặt bằng' :
        'Nhập kích thước để xem hình', width / 2, height / 2, width - 24);
    }
  }

  fitProjection(points, width, height, padding) {
    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    const scale = this.zoom * Math.min(Math.max(width - padding * 2, 40) / Math.max(maxX - minX, 1),
      Math.max(height - padding * 2, 40) / Math.max(maxY - minY, 1));
    return ([x, y]) => [width / 2 + (x - (minX + maxX) / 2) * scale, height / 2 + (y - (minY + maxY) / 2) * scale];
  }

  path(points, closed = true) {
    this.context.beginPath();
    points.forEach(([x, y], index) => index === 0 ? this.context.moveTo(x, y) : this.context.lineTo(x, y));
    if (closed) this.context.closePath();
  }

  drawPlan(width, height) {
    const ctx = this.context;
    const { points, error } = this.profile;
    const rotation = (this.planRotation + this.planScreenOffset) * Math.PI / 180;
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    const project = ([x, y]) => [x * cosine + y * sine, x * sine - y * cosine];
    const outer = this.model?.outer ?? points;
    const fit = this.fitProjection(outer.map(project), width, height, width > 460 ? 78 : 52);
    const innerScreen = points.map(point => fit(project(point)));
    const outerScreen = outer.map(point => fit(project(point)));
    if (!error) {
      this.path(outerScreen);
      ctx.fillStyle = '#aaa6fa';
      ctx.fill();
      this.path(innerScreen);
      ctx.fillStyle = '#f5f5ff';
      ctx.fill();
    }
    this.path(innerScreen, !error);
    ctx.lineWidth = error ? 2 : 1.5;
    ctx.strokeStyle = error ? '#9a4e16' : '#594bb6';
    ctx.stroke();
    const edgeCount = error ? points.length - 1 : points.length;
    ctx.font = '600 12px "Segoe UI", sans-serif';
    ctx.lineWidth = 1;
    for (let i = 0; i < edgeCount; i++) {
      const next = (i + 1) % points.length;
      const [a, b] = [innerScreen[i], innerScreen[next]];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 28) continue;
      const [nx, ny] = [-dy / length, dx / length];
      const offset = 18;
      const start = [a[0] + nx * offset, a[1] + ny * offset];
      const end = [b[0] + nx * offset, b[1] + ny * offset];
      ctx.strokeStyle = '#7475a2';
      this.path([a, start, end, b], false);
      ctx.stroke();
      const label = Math.hypot(points[next][0] - points[i][0], points[next][1] - points[i][1])
        .toLocaleString('vi-VN', { maximumFractionDigits: 1 });
      this.label(label, (start[0] + end[0]) / 2 + nx * 3, (start[1] + end[1]) / 2 + ny * 3);
    }
    ctx.fillStyle = error ? '#9a4e16' : '#5145ac';
    for (const [x, y] of innerScreen) {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.headingGuide) {
      const origin = (this.profile.traverse ?? points)[this.headingGuide.index];
      this.drawHeading(origin ? fit(project(origin)) : [width / 2, height / 2]);
    }
  }

  drawHeading([x, y]) {
    const ctx = this.context;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((this.planScreenOffset - this.headingGuide.angle) * Math.PI / 180);
    this.path([[0, 0], [62, 0]], false);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.strokeStyle = '#3328a9';
    ctx.lineWidth = 4;
    ctx.stroke();
    this.path([[57, -7], [67, 0], [57, 7]]);
    ctx.fillStyle = '#3328a9';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  label(text, x, y) {
    const ctx = this.context;
    const width = ctx.measureText(text).width + 10;
    ctx.fillStyle = '#f8f9ff';
    ctx.fillRect(x - width / 2, y - 9, width, 18);
    ctx.fillStyle = '#424063';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.textBaseline = 'alphabetic';
  }

  drawModel(width, height) {
    const ctx = this.context;
    const { meshes, inner, outer, height: wallHeight } = this.model;
    const sa = Math.sin(this.azimuth);
    const ca = Math.cos(this.azimuth);
    const se = Math.sin(this.elevation);
    const ce = Math.cos(this.elevation);
    const project = ([x, y, z]) => [x * ca - y * sa, -(x * sa + y * ca) * se - z * ce,
      (x * sa + y * ca) * ce - z * se];
    const projected = meshes.map((mesh, index) => {
      if (mesh.kind === 'floor' || !this.cut) return mesh.vertices.map(project);
      const [a, b] = [inner[index - 1], inner[index % inner.length]];
      const near = ((b[1] - a[1]) * sa - (b[0] - a[0]) * ca) < -0.001;
      return mesh.vertices.map(([x, y, z]) => project([x, y, near && z > 0 ? Math.min(wallHeight * 0.16, 450) : z]));
    });
    const fit = this.fitProjection(projected.flat(), width, height, width > 600 ? 74 : 55);
    const shadow = outer.map(([x, y]) => {
      const [screenX, screenY] = fit(project([x, y, -this.model.slab]));
      return [screenX + 5, screenY + 9];
    });
    this.path(shadow);
    ctx.shadowColor = '#23265248';
    ctx.shadowBlur = 22;
    ctx.fillStyle = '#32346c22';
    ctx.fill();
    ctx.shadowBlur = 0;
    const faces = meshes.flatMap((mesh, i) => mesh.faces.map(face => {
      const points = face.map(index => projected[i][index]);
      const [a, b, c] = points;
      const winding = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const original = face.map(index => mesh.vertices[index]);
      const horizontal = original.every(point => point[2] === original[0][2]);
      const depth = points.reduce((sum, point) => sum + point[2], 0) / points.length;
      const dx = original[1][0] - original[0][0];
      const dy = original[1][1] - original[0][1];
      const lighting = (dy - dx * 0.55) / Math.max(Math.hypot(dx, dy), 1);
      return { points, winding, depth, horizontal, lighting, kind: mesh.kind };
    })).filter(face => face.winding < -0.0001).sort((a, b) => b.depth - a.depth);
    ctx.lineWidth = 1;
    for (const face of faces) {
      this.path(face.points.map(fit));
      if (face.kind === 'floor') ctx.fillStyle = face.horizontal ? '#e2e0fe' : '#9f98dc';
      else if (face.horizontal) ctx.fillStyle = '#eeeaff';
      else ctx.fillStyle = face.lighting > 0 ? '#aca5ef' : '#8074d4';
      ctx.fill();
      if (face.kind === 'wall' || !face.horizontal) {
        ctx.strokeStyle = '#5146a3a0';
        ctx.stroke();
      }
    }
    this.drawAxes(project, height);
  }

  drawAxes(project, height) {
    const ctx = this.context;
    const origin = [35, height - 65];
    const axes = [
      [[1, 0, 0], 'X', '#a33d47'],
      [[0, 1, 0], 'Y', '#157455'],
      [[0, 0, 1], 'Z', '#444fba']
    ];
    ctx.font = '700 11px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2;
    for (const [axis, label, color] of axes) {
      const [x, y] = project(axis);
      this.path([origin, [origin[0] + x * 22, origin[1] + y * 22]], false);
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.fillText(label, origin[0] + x * 31, origin[1] + y * 31);
    }
    ctx.textBaseline = 'alphabetic';
  }
}
