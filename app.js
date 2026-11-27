'use strict';

const $ = id => document.getElementById(id);
const geometry = SurveyGeometry;
const viewport = new SurveyViewport($('viewport'));
const localExporter = location.protocol === 'http:' && location.hostname === '127.0.0.1';
const storageKey = 'do-hien-trang-project-v1';
const roomLimit = 150;
const edgeLimit = 100;
const fmt = (value, digits = 2) => value.toLocaleString('vi-VN', { maximumFractionDigits: digits });
const fieldNames = { length: 'Chiều dài', width: 'Chiều rộng', height: 'Chiều cao thông thủy', wall: 'Dày tường', slab: 'Dày sàn' };
const fieldPlaceholders = { length: '4200', width: '3400', height: '2800', wall: '150', slab: '100', tolerance: '20' };
const disto = { service: '3ab10100-f831-4395-b29d-570977d5bf94', distance: '3ab10101-f831-4395-b29d-570977d5bf94' };
const id = () => window.crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);

function newRoom(name) {
  return { id: id(), name, shape: 'rectangle', length: '', width: '', height: '', wall: '150', slab: '100', tolerance: '20',
    edges: Array.from({ length: 4 }, (_, index) => ({ length: '', heading: String(index * 90) })), demo: false };
}

function sampleProject() {
  const living = { ...newRoom('Phòng khách mẫu'), length: '5400', width: '3900', height: '2850', demo: true };
  const kitchen = { ...newRoom('Bếp chữ L mẫu'), shape: 'polygon', height: '2700', demo: true,
    edges: [[4600, 0], [2100, 90], [2100, 180], [1600, 90], [2500, 180], [3700, 270]]
      .map(([length, heading]) => ({ length: String(length), heading: String(heading) })) };
  return { version: 1, name: 'Khảo sát mẫu', active: living.id, rooms: [living, kitchen] };
}

function validateProject(data) {
  const textOf = (value, max = 80) => typeof value === 'string' && value.length <= max;
  if (data?.version !== 1 || !textOf(data.name) || !Array.isArray(data.rooms) ||
      !data.rooms.length || data.rooms.length > roomLimit) throw new Error('Tệp không đúng định dạng dự phòng.');
  const seen = new Set();
  for (const room of data.rooms) {
    if (!room || !textOf(room.name) || !textOf(room.id) || !room.id || seen.has(room.id) ||
        !['rectangle', 'polygon'].includes(room.shape) || ![...Object.keys(fieldNames), 'tolerance'].every(key => textOf(room[key], 32)) ||
        typeof room.demo !== 'boolean' || !Array.isArray(room.edges) || room.edges.length < 3 || room.edges.length > edgeLimit ||
        !room.edges.every(edge => edge && textOf(edge.length, 32) && textOf(edge.heading, 32))) {
      throw new Error('Tệp chứa dữ liệu không gian không hợp lệ.');
    }
    seen.add(room.id);
  }
  if (!seen.has(data.active)) data.active = data.rooms[0].id;
  return data;
}

let project;
try {
  const stored = localStorage.getItem(storageKey);
  project = stored ? validateProject(JSON.parse(stored)) : sampleProject();
} catch {
  project = sampleProject();
  $('save-status').textContent = 'Không đọc được bản lưu';
}
let model;
let previousFocusedField = '';
let messageTimer;
let device;
let characteristic;
let connecting = false;
let horizontal;
let nativeExportAvailable = false;
let exporting = false;
const room = () => project.rooms.find(candidate => candidate.id === project.active);

function escapeHtml(value) {
  return String(value).replace(/[<>&"']/g, character =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[character]);
}

function persist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(project));
    $('save-status').textContent = 'Đã lưu trên máy này';
  } catch {
    $('save-status').textContent = 'Chưa lưu · Hãy tạo bản dự phòng';
  }
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => { $('toast').hidden = true; }, 4300);
}

function renderRooms() {
  const list = $('room-list');
  list.replaceChildren();
  $('room-count').textContent = project.rooms.length;
  $('add-room').disabled = project.rooms.length >= roomLimit;
  for (const entry of project.rooms) {
    const button = document.createElement('button');
    button.className = 'room-entry';
    button.type = 'button';
    button.dataset.room = entry.id;
    button.setAttribute('aria-current', String(entry.id === project.active));
    const glyph = document.createElement('span');
    glyph.className = 'room-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = entry.shape === 'rectangle' ? '□' : '◩';
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = entry.name.trim() || 'Không gian';
    const shape = document.createElement('small');
    shape.textContent = entry.shape === 'rectangle' ? 'Hình chữ nhật' : 'Đường bao nhiều cạnh';
    copy.append(name, shape);
    button.append(glyph, copy);
    list.append(button);
  }
}

function renderModel() {
  const active = room();
  const name = active.name.trim() || 'Không gian';
  $('room-title').textContent = name;
  $('room-breadcrumb').textContent = name;
  $('demo-label').hidden = !active.demo;
  const profile = geometry.outline(active);
  model = geometry.build(active, profile);
  const valid = !model.error;
  $('model-error').hidden = valid;
  $('model-error').textContent = model.error ?? '';
  $('export').disabled = !valid;
  $('area').textContent = valid ? fmt(model.area / 1000000) + ' m²' : '—';
  $('perimeter').textContent = valid ? fmt(model.perimeter / 1000, 3) + ' m' : '—';
  const height = geometry.parseDistance(active.height);
  $('height-stat').textContent = Number.isFinite(height) ? fmt(height / 1000, 3) + ' m' : '—';
  $('view-legend').textContent = profile.gap === undefined ? 'Kích thước thông thủy · Đơn vị mm' :
    'Sai số khép kín ' + fmt(profile.gap, 2) + ' mm · Dung sai ' + active.tolerance + ' mm';
  $('footer-status').textContent = active.demo ? 'Thêm không gian để nhập số đo công trình của bạn.' :
    (valid ? 'Mô hình sẵn sàng xuất' : 'Hoàn tất số đo để xuất mô hình');
  $('viewport').setAttribute('aria-label', valid
    ? 'Bản xem trước ' + name + ', diện tích ' + $('area').textContent + ', cao ' + $('height-stat').textContent
    : 'Bản xem trước ' + name + '. ' + model.error);
  viewport.update(model, profile);
}

function field(key, label = fieldNames[key]) {
  return '<label>' + label + '<input data-field="' + key + '" maxlength="32" inputmode="decimal" value="' +
    escapeHtml(room()[key]) + '" placeholder="' + fieldPlaceholders[key] + '"></label>';
}

function edgeRow(edge, index) {
  const label = 'Cạnh ' + (index + 1);
  return '<div class="edge-row"><span>' + (index + 1) + '</span><input aria-label="' + label + ' độ dài" data-edge="' +
    index + '" data-part="length" maxlength="32" inputmode="decimal" placeholder="mm" value="' + escapeHtml(edge.length) +
    '"><input aria-label="' + label + ' hướng" data-edge="' + index + '" data-part="heading" maxlength="32" inputmode="decimal" ' +
    (index === 0 ? 'readonly value="0"' : 'placeholder="°" value="' + escapeHtml(edge.heading) + '"') +
    '><button type="button" class="icon-button" data-remove-edge="' + index + '" aria-label="Xóa ' + label.toLowerCase() +
    '"' + (room().edges.length === 3 ? ' disabled' : '') + '>×</button></div>';
}

function renderEditor() {
  const active = room();
  const rectangle = active.shape === 'rectangle';
  const dimensions = rectangle
    ? '<div class="field-grid measure-row">' + field('length') + field('width') + '</div>'
    : '<p class="field-note">Đi dọc chu vi, ghi cả cạnh cuối về điểm đầu. Lấy cạnh đầu là 0°, góc dương ngược chiều kim đồng hồ.</p>' +
      '<div class="edge-labels" aria-hidden="true"><span></span><span>Độ dài (mm)</span><span>Hướng (°)</span></div>' +
      active.edges.map(edgeRow).join('') +
      '<div class="edge-tools"><button class="button" id="add-edge"' + (active.edges.length >= edgeLimit ? ' disabled' : '') + '>+ Thêm cạnh</button>' +
      field('tolerance', 'Dung sai (mm)') + '</div>';
  $('measure-content').innerHTML =
    '<label>Tên không gian<input data-field="name" maxlength="80" value="' + escapeHtml(active.name) + '"></label>' +
    '<label class="measure-row">Kiểu mặt bằng<select id="shape" data-field="shape"><option value="rectangle">Hình chữ nhật</option>' +
    '<option value="polygon">Đường bao nhiều cạnh</option></select></label>' +
    dimensions + '<div class="measure-row">' + field('height') + '</div><h3>Tường và sàn</h3>' +
    '<div class="field-grid">' + field('wall') + field('slab') + '</div>' +
    '<p class="field-note">Tường dựng ra ngoài đường bao trong phòng.</p>' +
    '<div class="measure-foot"><button class="text-button danger" id="delete-room">Xóa không gian</button></div>';
  $('shape').value = active.shape;
  populateTargets();
  refreshHeadingChoices();
}

function populateTargets() {
  const select = $('measurement-target');
  const active = room();
  const current = select.value;
  const entries = Object.entries(fieldNames).filter(([key]) => active.shape === 'rectangle' || !['length', 'width'].includes(key));
  if (active.shape === 'polygon') {
    entries.unshift(...active.edges.map((_, index) => ['edge:' + index, 'Cạnh ' + (index + 1) + ' · Độ dài']));
  }
  select.replaceChildren(new Option('Chọn một kích thước', ''), ...entries.map(([value, label]) => new Option(label, value)));
  select.value = entries.some(([key]) => key === current) ? current : '';
}

function renderAll() {
  $('project-name').value = project.name;
  renderRooms();
  renderEditor();
  renderModel();
}

function selectRoom(roomId) {
  closeHeadingPanel();
  project.active = roomId;
  previousFocusedField = '';
  $('measurement-target').value = '';
  renderRooms();
  renderEditor();
  renderModel();
  persist();
}

$('project-name').addEventListener('input', event => {
  project.name = event.target.value;
  persist();
});

$('room-list').addEventListener('click', event => {
  const entry = event.target.closest('[data-room]');
  if (!entry || entry.dataset.room === project.active) return;
  selectRoom(entry.dataset.room);
  $('room-list').querySelector('[aria-current=true]')?.focus();
});

$('add-room').addEventListener('click', () => {
  if (project.rooms.length >= roomLimit) return;
  let number = project.rooms.length + 1;
  while (project.rooms.some(entry => entry.name === 'Không gian ' + number)) number++;
  const entry = newRoom('Không gian ' + number);
  project.rooms.push(entry);
  selectRoom(entry.id);
  const name = $('measure-content').querySelector('[data-field=name]');
  name.focus();
  name.select();
});

$('measure-content').addEventListener('focusin', event => {
  const { field, edge, part } = event.target.dataset;
  if (field && Object.hasOwn(fieldNames, field)) previousFocusedField = field;
  if (part === 'length') previousFocusedField = 'edge:' + edge;
});

$('measure-content').addEventListener('input', event => {
  const { field, edge, part } = event.target.dataset;
  if (part) room().edges[Number(edge)][part] = event.target.value;
  else if (field) room()[field] = event.target.value;
  else return;
  if (field === 'shape') {
    resetHeadingMode();
    previousFocusedField = '';
    $('measurement-target').value = '';
    renderEditor();
    $('shape').focus();
  }
  if (field === 'shape' || field === 'name') renderRooms();
  if (part === 'length' || field === 'height' || field === 'wall') syncHeadingMeasurements();
  renderModel();
  persist();
});

$('measure-content').addEventListener('click', event => {
  const active = room();
  const control = event.target.closest('button');
  if (!control) return;
  if (control.id === 'delete-room') {
    if (!window.confirm('Xóa “' + (active.name.trim() || 'Không gian') + '” cùng các số đo?')) return;
    const index = project.rooms.indexOf(active);
    project.rooms.splice(index, 1);
    if (!project.rooms.length) project.rooms.push(newRoom('Không gian 1'));
    selectRoom(project.rooms[Math.min(index, project.rooms.length - 1)].id);
    $('add-room').focus();
    return;
  }
  const adding = control.id === 'add-edge';
  const removing = control.dataset.removeEdge !== undefined;
  if (!adding && !removing) return;
  if (adding && active.edges.length < edgeLimit) active.edges.push({ length: '', heading: '' });
  if (removing && active.edges.length > 3) {
    if (control.dataset.removeEdge === '0' && (active.headingReference || temporaryHeadingReference)) {
      const offset = geometry.parseNumber(active.edges[1].heading);
      for (const edge of active.edges.slice(1)) {
        const angle = geometry.parseNumber(edge.heading);
        edge.heading = Number.isFinite(angle) && Number.isFinite(offset) ? formatPlanHeading(angle - offset) : '';
      }
      delete active.headingReference;
      temporaryHeadingReference = undefined;
      headingViewZero = undefined;
      $('heading-edge').value = '0';
    }
    active.edges.splice(Number(control.dataset.removeEdge), 1);
  }
  previousFocusedField = '';
  $('measurement-target').value = '';
  renderEditor();
  renderModel();
  persist();
  const focusIndex = adding ? active.edges.length - 1 : Math.min(Number(control.dataset.removeEdge), active.edges.length - 1);
  $('measure-content').querySelector('[data-edge="' + focusIndex + '"][data-part="length"]')?.focus();
});

function switchView(mode) {
  const plan = mode === 'plan';
  $('view-plan').setAttribute('aria-pressed', String(plan));
  $('view-3d').setAttribute('aria-pressed', String(!plan));
  $('cut-control').hidden = plan;
  $('view-hint').textContent = plan ? 'Hình chiếu bằng · mm' : 'Kéo để xoay · Cuộn để thu phóng';
  viewport.setMode(mode);
}

$('view-plan').onclick = () => switchView('plan');
$('view-3d').onclick = () => {
  closeHeadingPanel();
  switchView('3d');
};
$('zoom-in').onclick = () => viewport.zoomBy(1.2);
$('zoom-out').onclick = () => viewport.zoomBy(1 / 1.2);
$('fit').onclick = () => viewport.fit();
$('cut-walls').addEventListener('change', event => {
  viewport.cut = event.target.checked;
  viewport.draw();
});

const headingSensor = new SurveyOrientation.Sensor(renderHeadingPanel);
const headingPanel = $('heading-panel');
const headingEdge = $('heading-edge');
const headingMeasurements = [$('heading-length'), $('heading-height'), $('heading-wall')];
let headingSimulation = false;
let temporaryHeadingReference;
let headingViewZero;

function resetHeadingMode() {
  headingSensor.stop();
  headingSimulation = false;
  temporaryHeadingReference = undefined;
  headingViewZero = undefined;
  headingEdge.value = '0';
}

function closeHeadingPanel() {
  headingPanel.hidden = true;
  $('heading-tool').setAttribute('aria-expanded', 'false');
  resetHeadingMode();
  viewport.setHeadingGuide(null);
}

function refreshHeadingChoices() {
  if (headingPanel.hidden) return;
  const current = headingEdge.value;
  headingEdge.replaceChildren(...room().edges.map((_, index) => new Option(index === 0 ? 'Cạnh 1 · Mốc 0°' : 'Cạnh ' + (index + 1), index)));
  if (current && Number(current) < room().edges.length) headingEdge.value = current;
  syncHeadingMeasurements();
  renderHeadingPanel();
}

function syncHeadingMeasurements() {
  const active = room();
  if (headingPanel.hidden || active.shape !== 'polygon') return;
  const edge = active.edges[Number(headingEdge.value)];
  for (const input of headingMeasurements) {
    const value = input.dataset.field ? active[input.dataset.field] : edge.length;
    if (input.value !== value) input.value = value;
  }
}

function headingSample() {
  return headingSimulation ? { source: 'simulation', angle: Number($('heading-dial').value), level: true } : headingSensor.sample;
}

function headingReference(sample) {
  return [temporaryHeadingReference, room().headingReference].find(reference =>
    reference?.source === sample.source && Number.isFinite(reference.angle));
}

function canUseHeading(sample) {
  return Boolean(sample?.level && (headingSimulation || headingSensor.stable));
}

function formatPlanHeading(angle) {
  return String(Number(SurveyOrientation.normalize(Math.round(angle * 10) / 10).toFixed(1)));
}

function renderHeadingPanel() {
  if (headingPanel.hidden) return;
  const polygon = room().shape === 'polygon';
  $('heading-rectangle').hidden = polygon;
  $('heading-controls').hidden = !polygon;
  if (!polygon) return;
  const index = Number(headingEdge.value);
  const sample = headingSample();
  const reference = sample && headingReference(sample);
  const viewZero = sample && headingViewZero?.source === sample.source ? headingViewZero : undefined;
  const planar = sample?.level ? SurveyOrientation.planAngle(sample.angle, viewZero?.angle ?? reference?.angle) : null;
  const rotation = viewZero && reference ? SurveyOrientation.planAngle(viewZero.angle, reference.angle) : 0;
  const ready = canUseHeading(sample);
  const capture = $('heading-capture');
  capture.disabled = !(ready && (reference || !index));
  capture.textContent = index ? 'Chốt hướng cạnh ' + (index + 1) : 'Chốt hướng mốc';
  $('heading-zero').disabled = !ready;
  $('heading-restore-zero').hidden = !viewZero;
  $('heading-value-label').textContent = viewZero ? 'So với mốc vừa đặt' : 'Mũi tên trên mặt bằng';
  $('heading-sensor').disabled = headingSensor.waiting || (!headingSimulation && Boolean(sample));
  $('heading-simulator').hidden = !headingSimulation;
  $('heading-simulate').setAttribute('aria-pressed', String(headingSimulation));
  $('heading-simulate').textContent = headingSimulation ? 'Tắt mô phỏng' : 'Mô phỏng';
  $('heading-value').textContent = planar === null ? '—' : fmt(Number(formatPlanHeading(planar)), 1) + '°';
  $('heading-dial').setAttribute('aria-valuetext', $('heading-dial').value + ' độ theo chiều kim đồng hồ');
  let status = headingSensor.status || 'Bật cảm biến. Giữ máy nằm ngang, hướng đầu máy từ đầu đến cuối cạnh.';
  if (sample) {
    if (!sample.level) status = 'Hạ điện thoại nằm ngang, để màn hình hướng lên.';
    else if (!reference && index) status = 'Chọn Cạnh 1 và chốt hướng mốc trước.';
    else if (!headingSimulation && !headingSensor.stable) status = 'Giữ điện thoại ổn định…';
    else if (headingSimulation) status = 'Kéo thanh để giả lập xoay điện thoại, rồi chốt hướng.';
    else status = 'Hướng đầu máy từ đầu đến cuối cạnh, rồi chốt.';
    if (sample.level && Number.isFinite(sample.accuracy)) status += ' La bàn báo sai số khoảng ±' + fmt(sample.accuracy, 1) + '°.';
  }
  if ($('heading-status').textContent !== status) $('heading-status').textContent = status;
  viewport.setHeadingGuide(planar === null ? null : { index, angle: planar }, rotation, true);
}

$('heading-tool').onclick = () => {
  if (!headingPanel.hidden) return closeHeadingPanel();
  switchView('plan');
  headingPanel.hidden = false;
  $('heading-tool').setAttribute('aria-expanded', 'true');
  refreshHeadingChoices();
};
$('heading-convert').onclick = () => {
  const active = room();
  if (active.edges.every((edge, index) => !edge.length && edge.heading === String(index * 90))) {
    active.edges.forEach((edge, index) => {
      edge.length = index % 2 ? active.width : active.length;
      edge.heading = index ? '' : '0';
    });
  }
  $('shape').value = 'polygon';
  $('shape').dispatchEvent(new Event('input', { bubbles: true }));
  $('heading-sensor').focus();
};
$('heading-sensor').onclick = () => {
  headingSimulation = false;
  headingViewZero = undefined;
  headingSensor.start();
};
$('heading-simulate').onclick = () => {
  headingSensor.stop();
  headingSimulation = !headingSimulation;
  headingViewZero = undefined;
  renderHeadingPanel();
};
headingEdge.onchange = () => {
  syncHeadingMeasurements();
  renderHeadingPanel();
};
$('heading-dial').oninput = renderHeadingPanel;
for (const input of headingMeasurements) {
  input.onfocus = () => { previousFocusedField = input.dataset.field ?? 'edge:' + headingEdge.value; };
  input.oninput = () => {
    const selector = input.dataset.field ? '[data-field="' + input.dataset.field + '"]' :
      '[data-edge="' + headingEdge.value + '"][data-part="length"]';
    const editorInput = $('measure-content').querySelector(selector);
    editorInput.value = input.value;
    editorInput.dispatchEvent(new Event('input', { bubbles: true }));
  };
}
$('heading-zero').onclick = () => {
  const sample = headingSample();
  if (!canUseHeading(sample)) return;
  headingViewZero = { source: sample.source, angle: sample.angle };
  renderHeadingPanel();
  toast('Đã đặt hướng đang chĩa làm 0° để xem mặt bằng.');
};
$('heading-restore-zero').onclick = () => {
  headingViewZero = undefined;
  renderHeadingPanel();
  $('heading-zero').focus();
};
$('heading-capture').onclick = () => {
  const sample = headingSample();
  if (!canUseHeading(sample)) return;
  const active = room();
  const index = Number(headingEdge.value);
  const reference = headingReference(sample);
  if (index && !reference) return;
  const angle = index ? formatPlanHeading(SurveyOrientation.planAngle(sample.angle, reference.angle)) : '0';
  if (!index) {
    const anchor = { source: sample.source, angle: sample.angle };
    if (sample.source === 'relative' || headingSimulation) temporaryHeadingReference = anchor;
    else active.headingReference = anchor;
  }
  active.edges[index].heading = angle;
  headingEdge.value = String(Math.min(index + 1, active.edges.length - 1));
  renderEditor();
  renderModel();
  persist();
  toast('Cạnh ' + (index + 1) + ' · Đã lưu ' + fmt(Number(angle), 1) + '°' + (headingSimulation ? ' (mô phỏng)' : ''));
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !headingPanel.hidden && !headingSimulation) {
    headingSensor.stop();
    temporaryHeadingReference = undefined;
    headingViewZero = undefined;
    renderHeadingPanel();
  }
});

function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileName(value, fallback) {
  return value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/[. ]+$/, '').slice(0, 80) || fallback;
}

$('export').onclick = () => {
  if (model.error) return;
  $('export-room').textContent = (room().name.trim() || 'Không gian') + ' · Sàn và tường toàn chiều cao';
  $('download-skp').disabled = !nativeExportAvailable || exporting;
  $('export-status').textContent = exporting ? 'Đang tạo tệp SketchUp…' : nativeExportAvailable ?
    'Mở trực tiếp tệp SKP trong SketchUp. Để nhập DAE, dùng File → Import.' :
    'Tải DAE rồi dùng File → Import trong SketchUp. Để xuất SKP, chuyển bản dự phòng JSON sang ứng dụng Windows.';
  $('export-dialog').showModal();
};

$('download-skp').onclick = async () => {
  if (exporting || model.error) return;
  const label = fileName(room().name, 'khong-gian');
  exporting = true;
  $('download-skp').disabled = true;
  $('export-status').textContent = 'Đang tạo tệp SketchUp…';
  try {
    const result = await fetch('/export-skp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(room()),
      signal: AbortSignal.timeout(33000)
    });
    if (!result.ok) throw new Error((await result.json()).error);
    download(await result.blob(), label + '.skp', 'application/octet-stream');
    $('export-status').textContent = 'Đã tạo tệp SKP.';
    $('export-dialog').close();
    toast('Đã xuất ' + label + '.skp');
  } catch (error) {
    $('export-status').textContent = error.name === 'TypeError' || error.name === 'TimeoutError' ?
      'Không truy cập được bộ xuất SKP. Bạn vẫn có thể tải DAE.' : error.message;
  } finally {
    exporting = false;
    $('download-skp').disabled = !nativeExportAvailable;
  }
};

$('download-dae').onclick = () => {
  if (model.error) return;
  const label = fileName(room().name, 'khong-gian');
  download(geometry.collada(label, model.meshes), label + '.dae', 'model/vnd.collada+xml');
  $('export-dialog').close();
  toast('Đã tạo tệp DAE. Mở SketchUp và chọn File → Import.');
};
$('backup').onclick = () => download(JSON.stringify(project, null, 2), fileName(project.name, 'cong-trinh') + '.json', 'application/json');
$('restore').onclick = () => $('restore-file').click();
$('restore-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 3000000) throw new Error('Tệp dự phòng lớn hơn 3 MB.');
    const loaded = validateProject(JSON.parse(await file.text()));
    if (!window.confirm('Thay công trình đang mở bằng “' + (loaded.name.trim() || 'Công trình') + '”?')) return;
    closeHeadingPanel();
    project = loaded;
    previousFocusedField = '';
    $('measurement-target').value = '';
    renderAll();
    persist();
    toast('Đã mở bản dự phòng.');
  } catch (error) {
    toast(error instanceof SyntaxError ? 'Tệp dự phòng không phải JSON hợp lệ.' : error.message);
  }
});

const deviceDialog = $('device-dialog');
document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => button.closest('dialog').close(); });
$('help').onclick = () => $('help-dialog').showModal();
$('device-button').onclick = () => {
  populateTargets();
  const select = $('measurement-target');
  if ([...select.options].some(option => option.value === previousFocusedField)) select.value = previousFocusedField;
  deviceDialog.showModal();
};
deviceDialog.addEventListener('close', () => {
  $('measurement-target').value = '';
  previousFocusedField = '';
});

function applyMeasurement(mm) {
  if (!Number.isFinite(mm)) return 'Số đo không hợp lệ. Hãy kiểm tra giá trị và đơn vị.';
  const select = $('measurement-target');
  const key = select.value;
  if (!deviceDialog.open || !key) return 'Hãy chọn ô nhận để lưu số đo.';
  const active = room();
  const text = String(Math.round(mm * 100) / 100);
  if (key.startsWith('edge:')) active.edges[Number(key.slice(5))].length = text;
  else active[key] = text;
  const label = select.selectedOptions[0].textContent;
  select.value = '';
  previousFocusedField = '';
  renderEditor();
  renderModel();
  persist();
  return 'Đã điền ' + fmt(mm, 2) + ' mm vào ' + label + '.';
}

function readKeyboard() {
  const input = $('keyboard-reading');
  const mm = geometry.parseDistance(input.value, $('keyboard-unit').value);
  const selected = $('measurement-target').value;
  $('keyboard-status').textContent = applyMeasurement(mm);
  if (Number.isFinite(mm) && selected) input.value = '';
}
$('apply-keyboard').onclick = readKeyboard;
$('keyboard-reading').addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  readKeyboard();
});

function updateSlope() {
  $('slope-apply-status').hidden = true;
  const length = geometry.parseDistance($('slope-length').value);
  const angle = geometry.parseNumber($('slope-angle').value);
  if (!Number.isFinite(length) || !Number.isFinite(angle) || Math.abs(angle) > 90) {
    horizontal = NaN;
    $('apply-horizontal').disabled = true;
    $('slope-result').textContent = 'Nhập khoảng cách và góc từ −90° đến 90°.';
    return;
  }
  horizontal = length * Math.cos(angle * Math.PI / 180);
  const vertical = length * Math.sin(angle * Math.PI / 180);
  $('apply-horizontal').disabled = horizontal < 1;
  $('slope-result').textContent = 'Khoảng ngang ' + fmt(horizontal, 2) + ' mm · Chênh cao ' + fmt(vertical, 2) + ' mm';
}
$('slope-length').addEventListener('input', updateSlope);
$('slope-angle').addEventListener('input', updateSlope);
$('apply-horizontal').onclick = () => {
  const status = $('slope-apply-status');
  status.textContent = applyMeasurement(horizontal);
  status.hidden = false;
};

function setBleStatus(message) {
  $('ble-status').textContent = message;
  const connected = Boolean(characteristic && device?.gatt.connected);
  $('device-dot').classList.toggle('connected', connected);
  $('connect-ble').disabled = connected || connecting;
  $('disconnect-ble').disabled = !connected;
}

function clearBluetooth() {
  characteristic?.removeEventListener('characteristicvaluechanged', readDistance);
  device?.removeEventListener('gattserverdisconnected', handleDisconnect);
  if (device?.gatt.connected) device.gatt.disconnect();
  characteristic = undefined;
  device = undefined;
}
function handleDisconnect() {
  clearBluetooth();
  setBleStatus('Mất kết nối với thước. Bấm kết nối để thử lại.');
}
function readDistance(event) {
  const data = event.target.value;
  const mm = data?.byteLength === 4 ? data.getFloat32(0, true) * 1000 : NaN;
  if (!Number.isFinite(mm) || !Number.isFinite(geometry.parseDistance(mm))) {
    setBleStatus('Đã nhận gói dữ liệu nhưng không đọc được khoảng cách.');
    return;
  }
  const reading = Math.round(mm * 1000) / 1000;
  setBleStatus(deviceDialog.open && $('measurement-target').value ? applyMeasurement(reading) :
    'Đã nhận ' + fmt(reading, 2) + ' mm. Chọn ô nhận rồi gửi phép đo mới để lưu.');
}

$('connect-ble').onclick = async () => {
  if (!navigator.bluetooth) {
    setBleStatus('Web Bluetooth không khả dụng. Mở ứng dụng bằng Chrome hoặc Edge trên Windows và kiểm tra Bluetooth.');
    return;
  }
  connecting = true;
  setBleStatus('Đang tìm thước Leica DISTO…');
  let status;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [disto.service] }, { namePrefix: 'DISTO' }, { namePrefix: 'Leica DISTO' }],
      optionalServices: [disto.service]
    });
    device.addEventListener('gattserverdisconnected', handleDisconnect);
    const gatt = await device.gatt.connect();
    const service = await gatt.getPrimaryService(disto.service);
    characteristic = await service.getCharacteristic(disto.distance);
    characteristic.addEventListener('characteristicvaluechanged', readDistance);
    await characteristic.startNotifications();
    status = 'Đã kết nối ' + (device?.name || 'Leica DISTO') + '. Chọn ô nhận và gửi số đo từ thước.';
  } catch (error) {
    clearBluetooth();
    status = error.name === 'NotFoundError' ? 'Chưa chọn thước hoặc chưa tìm thấy thước phù hợp.' :
      'Kết nối chưa thành công. Kiểm tra thước đang bật Bluetooth và chưa kết nối ứng dụng khác.';
  } finally {
    connecting = false;
    setBleStatus(status);
  }
};

$('disconnect-ble').onclick = () => {
  clearBluetooth();
  setBleStatus('Đã ngắt Bluetooth.');
};

renderAll();
if (localExporter) {
  fetch('/capabilities').then(response => response.json()).then(capabilities => {
    nativeExportAvailable = capabilities.skp === true;
    if (nativeExportAvailable && $('export-dialog').open && !exporting) {
      $('download-skp').disabled = false;
      $('export-status').textContent = 'Mở trực tiếp tệp SKP trong SketchUp. Để nhập DAE, dùng File → Import.';
    }
  }).catch(() => {});
}
