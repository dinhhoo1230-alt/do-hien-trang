'use strict';

const SurveyGeometry = (() => {
  const EPSILON = 0.00001;
  const MAX_DISTANCE = 10000000;
  const MIN_EDGE = 1;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const nextIndex = (i, points) => (i + 1) % points.length;

  function parseNumber(value) {
    const number = String(value ?? '').trim().replace(',', '.');
    return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(number) ? Number(number) : NaN;
  }

  function parseDistance(value, defaultUnit = 'mm') {
    const match = String(value ?? '').trim().match(/^([+]?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*(mm|cm|m|in|ft)?$/i);
    if (!match) return NaN;
    const units = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
    const mm = parseNumber(match[1]) * units[(match[2] || defaultUnit).toLowerCase()];
    return mm >= MIN_EDGE && mm <= MAX_DISTANCE ? mm : NaN;
  }

  function signedArea(points) {
    return points.reduce((sum, point, index) => {
      const next = points[nextIndex(index, points)];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2;
  }

  function segmentsIntersect(a, b, c, d) {
    const abC = cross(a, b, c);
    const abD = cross(a, b, d);
    const cdA = cross(c, d, a);
    const cdB = cross(c, d, b);
    const onSegment = (p, u, v) => p.every((value, i) =>
      value >= Math.min(u[i], v[i]) - EPSILON && value <= Math.max(u[i], v[i]) + EPSILON);
    const touches = (turn, point, u, v) => Math.abs(turn) < EPSILON && onSegment(point, u, v);
    return ((abC > EPSILON && abD < -EPSILON || abD > EPSILON && abC < -EPSILON) &&
      (cdA > EPSILON && cdB < -EPSILON || cdB > EPSILON && cdA < -EPSILON)) ||
      touches(abC, c, a, b) || touches(abD, d, a, b) || touches(cdA, a, c, d) || touches(cdB, b, c, d);
  }

  function validOutline(points) {
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const afterA = nextIndex(i, points);
      const b = points[afterA];
      const c = points[nextIndex(afterA, points)];
      const dot = (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]);
      if (distance(a, b) < MIN_EDGE || Math.abs(cross(a, b, c)) < EPSILON && dot > 0) return false;
      for (let j = i + 2; j < points.length; j++) {
        const afterJ = nextIndex(j, points);
        if (afterJ !== i && segmentsIntersect(a, b, points[j], points[afterJ])) return false;
      }
    }
    return Math.abs(signedArea(points)) >= 1;
  }

  function outline(room) {
    if (room.shape === 'rectangle') {
      const length = parseDistance(room.length);
      const width = parseDistance(room.width);
      if (!Number.isFinite(length) || !Number.isFinite(width)) {
        return { error: 'Nhập chiều dài và chiều rộng hợp lệ (từ 1 mm).' };
      }
      return { points: [[0, 0], [length, 0], [length, width], [0, width]] };
    }
    const points = [[0, 0]];
    const tolerance = parseNumber(room.tolerance);
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 500) {
      return { error: 'Dung sai khép kín phải nằm trong khoảng 0–500 mm.', points };
    }
    if (room.edges.length < 3) return { error: 'Đường bao cần ít nhất 3 cạnh.', points };
    for (const [index, edge] of room.edges.entries()) {
      const length = parseDistance(edge.length);
      const heading = index === 0 ? 0 : parseNumber(edge.heading);
      if (!Number.isFinite(length) || !Number.isFinite(heading) || Math.abs(heading) > 360) {
        return { error: 'Nhập độ dài và hướng hợp lệ cho tất cả các cạnh.', points };
      }
      const [x, y] = points.at(-1);
      const radians = heading * Math.PI / 180;
      points.push([x + length * Math.cos(radians), y + length * Math.sin(radians)]);
    }
    const gap = distance(points[0], points.at(-1));
    if (gap > tolerance + EPSILON) {
      return { error: 'Đường bao chưa khép kín trong dung sai. Kiểm tra lại cạnh hoặc hướng.', points, gap };
    }
    const closed = points.slice(0, -1);
    if (!validOutline(closed)) {
      return { error: 'Đường bao có cạnh giao nhau, cạnh quay ngược hoặc diện tích quá nhỏ.', points, gap };
    }
    return { points: signedArea(closed) > 0 ? closed : [...closed].reverse(), traverse: closed, gap };
  }

  function offsetOutline(points, thickness) {
    return points.map((point, i) => {
      const previous = points[(i + points.length - 1) % points.length];
      const next = points[nextIndex(i, points)];
      const lengthBefore = distance(previous, point);
      const lengthAfter = distance(point, next);
      const normalBefore = [(point[1] - previous[1]) / lengthBefore, (previous[0] - point[0]) / lengthBefore];
      const normalAfter = [(next[1] - point[1]) / lengthAfter, (point[0] - next[0]) / lengthAfter];
      const divisor = 1 + normalBefore[0] * normalAfter[0] + normalBefore[1] * normalAfter[1];
      return point.map((coordinate, axis) => coordinate + thickness * (normalBefore[axis] + normalAfter[axis]) / divisor);
    });
  }

  function triangulate(points) {
    const remaining = points.map((_, index) => index);
    const triangles = [];
    while (remaining.length > 3) {
      const ear = remaining.findIndex((center, i) => {
        const before = remaining[(i + remaining.length - 1) % remaining.length];
        const after = remaining[(i + 1) % remaining.length];
        const [a, b, c] = [before, center, after].map(index => points[index]);
        if (cross(a, b, c) <= EPSILON) return false;
        return !remaining.some(index => index !== before && index !== center && index !== after &&
          cross(a, b, points[index]) >= -EPSILON &&
          cross(b, c, points[index]) >= -EPSILON &&
          cross(c, a, points[index]) >= -EPSILON);
      });
      if (ear === -1) throw new Error('Không chia được mặt sàn. Hãy kiểm tra các góc của đường bao.');
      triangles.push([remaining[(ear + remaining.length - 1) % remaining.length], remaining[ear], remaining[(ear + 1) % remaining.length]]);
      remaining.splice(ear, 1);
    }
    triangles.push(remaining);
    return triangles;
  }

  function prism(name, kind, points, bottom, top) {
    const size = points.length;
    const vertices = [...points.map(point => [...point, bottom]), ...points.map(point => [...point, top])];
    const ring = points.map((_, index) => index);
    const quad = size === 4 && points.every((point, i) =>
      cross(point, points[(i + 1) % size], points[(i + 2) % size]) > EPSILON);
    const cap = quad ? [ring] : triangulate(points);
    const sides = points.map((_, index) => {
      const next = nextIndex(index, points);
      return [index, next, next + size, index + size];
    });
    return { name, kind, vertices, solidFaces: [[...ring].reverse(), ...sides, ring.map(index => index + size)], faces: [
      ...cap.map(indices => [...indices].reverse()),
      ...sides,
      ...cap.map(indices => indices.map(index => index + size))
    ] };
  }

  function build(room, profile = outline(room)) {
    if (profile.error) return { error: profile.error };
    const height = parseDistance(room.height);
    const thickness = parseDistance(room.wall);
    const slab = parseDistance(room.slab);
    if (![height, thickness, slab].every(Number.isFinite)) {
      return { error: 'Nhập chiều cao, dày tường và dày sàn hợp lệ (từ 1 mm).' };
    }
    const inner = profile.points;
    const outer = offsetOutline(inner, thickness);
    const wallProfiles = inner.map((point, i) => {
      const j = nextIndex(i, inner);
      return [point, outer[i], outer[j], inner[j]];
    });
    if (outer.some(point => point.some(coordinate => !Number.isFinite(coordinate))) ||
        !validOutline(outer) || signedArea(outer) <= signedArea(inner) ||
        wallProfiles.some(points => !validOutline(points) || signedArea(points) <= 0)) {
      return { error: 'Độ dày tường không vừa với đường bao. Hãy chỉnh độ dày hoặc kiểm tra các góc.' };
    }
    try {
      const meshes = [prism('Sàn', 'floor', inner, -slab, 0), ...wallProfiles.map((points, i) =>
        prism('Tường ' + (i + 1), 'wall', points, -slab, height))];
      return { meshes, inner, outer, height, slab, area: signedArea(inner), perimeter: inner.reduce(
        (sum, point, index) => sum + distance(point, inner[nextIndex(index, inner)]), 0) };
    } catch (error) {
      return { error: error.message };
    }
  }

  function escapeXml(value) {
    return String(value).replace(/[<>&"']/g, character =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]);
  }

  function collada(name, meshes) {
    const geometries = meshes.map(({ name, vertices, faces }, index) => {
      const id = 'part-' + index;
      const coordinates = vertices.flat().map(value => Number(value.toFixed(6))).join(' ');
      return '<geometry id="' + id + '" name="' + escapeXml(name) + '"><mesh>' +
        '<source id="' + id + '-positions"><float_array id="' + id + '-array" count="' + vertices.length * 3 + '">' +
        coordinates + '</float_array><technique_common><accessor source="#' + id + '-array" count="' +
        vertices.length + '" stride="3"><param name="X" type="float"/><param name="Y" type="float"/>' +
        '<param name="Z" type="float"/></accessor></technique_common></source>' +
        '<vertices id="' + id + '-vertices"><input semantic="POSITION" source="#' + id + '-positions"/></vertices>' +
        '<polylist count="' + faces.length + '"><input semantic="VERTEX" source="#' + id + '-vertices" offset="0"/>' +
        '<vcount>' + faces.map(face => face.length).join(' ') + '</vcount><p>' + faces.flat().join(' ') +
        '</p></polylist></mesh></geometry>';
    });
    const nodes = meshes.map(({ name }, i) => '<node id="object-' + i + '" name="' + escapeXml(name) +
      '"><instance_geometry url="#part-' + i + '"/></node>');
    const now = new Date().toISOString();
    return '<?xml version="1.0" encoding="utf-8"?>\n<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">\n' +
      '<asset><contributor><authoring_tool>Đo Hiện Trạng</authoring_tool></contributor><created>' + now +
      '</created><modified>' + now + '</modified><unit name="millimeter" meter="0.001"/><up_axis>Z_UP</up_axis></asset>\n' +
      '<library_geometries>' + geometries.join('\n') + '</library_geometries>\n' +
      '<library_visual_scenes><visual_scene id="survey"><node id="room" name="' + escapeXml(name) +
      '">' + nodes.join('\n') + '</node></visual_scene></library_visual_scenes><scene><instance_visual_scene url="#survey"/></scene>\n</COLLADA>\n';
  }

  return { build, outline, collada, parseDistance, parseNumber };
})();

if (typeof module !== 'undefined') module.exports = SurveyGeometry;
