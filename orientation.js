'use strict';

const SurveyOrientation = (() => {
  const degrees = Math.PI / 180;
  const normalize = angle => (angle % 360 + 360) % 360;
  const signedAngle = angle => normalize(angle + 180) - 180;
  const planAngle = (heading, reference = 0) => normalize(reference - heading);

  function direction(yaw, pitch) {
    const horizontal = Math.cos(pitch * degrees);
    return [Math.cos(yaw * degrees) * horizontal, Math.sin(yaw * degrees) * horizontal, Math.sin(pitch * degrees)];
  }

  function readAim(event) {
    if (![event.alpha, event.beta, event.gamma].every(Number.isFinite)) return;
    const [a, b, g] = [event.alpha, event.beta, event.gamma].map(angle => angle * degrees);
    // Device Orientation rotation Z-X'-Y'' applied to the rear camera axis (0, 0, -1).
    const ray = [
      -Math.cos(a) * Math.sin(g) - Math.sin(a) * Math.sin(b) * Math.cos(g),
      -Math.sin(a) * Math.sin(g) + Math.cos(a) * Math.sin(b) * Math.cos(g),
      -Math.cos(b) * Math.cos(g)
    ];
    const source = event.absolute || event.type === 'deviceorientationabsolute' ? 'absolute' : 'relative';
    return { source, level: true, ray };
  }

  function aimInRoom([x, y, z], [forwardX, forwardY]) {
    return [forwardX * x + forwardY * y, forwardX * y - forwardY * x, z];
  }

  function aimAngles([x, y, z]) {
    const yaw = Math.hypot(x, y) < 0.00001 ? null : signedAngle(Math.atan2(y, x) / degrees);
    return { yaw, pitch: Math.asin(Math.max(-1, Math.min(1, z))) / degrees };
  }

  function read(event) {
    const { alpha, beta, gamma, webkitCompassHeading, webkitCompassAccuracy } = event;
    if (![beta, gamma].every(Number.isFinite)) return;
    const level = Math.cos(beta * degrees) * Math.cos(gamma * degrees) >= Math.cos(25 * degrees);
    if (Number.isFinite(webkitCompassHeading) && webkitCompassHeading >= 0 &&
        !(Number.isFinite(webkitCompassAccuracy) && webkitCompassAccuracy < 0)) {
      return { source: 'compass', angle: normalize(webkitCompassHeading), level, accuracy: webkitCompassAccuracy };
    }
    if (!Number.isFinite(alpha)) return;
    const source = event.absolute || event.type === 'deviceorientationabsolute' ? 'absolute' : 'relative';
    // Near horizontal, the standard alpha increases in the opposite direction to a compass bearing.
    return { source, angle: normalize(-alpha), level };
  }

  class Sensor {
    constructor(onChange, aim = false) {
      this.onChange = onChange;
      this.session = 0;
      this.receive = event => {
        const sample = aim ? readAim(event) : read(event);
        if (!sample) return;
        const priority = ['relative', 'absolute', 'compass'];
        if (this.sample && priority.indexOf(sample.source) < priority.indexOf(this.sample.source)) return;
        const now = performance.now();
        const reference = this.stableSample;
        const moved = reference && (aim
          ? sample.ray.reduce((dot, axis, index) => dot + axis * reference.ray[index], 0) < Math.cos(1.5 * degrees)
          : Math.abs(signedAngle(sample.angle - reference.angle)) > 1.5);
        if (!this.sample || this.sample.source !== sample.source || !sample.level || !this.sample.level || moved) {
          this.stableSample = sample;
          this.stableSince = now;
        }
        this.sample = sample;
        this.onChange();
      };
    }

    get stable() {
      return this.sample?.level && performance.now() - this.stableSince >= 350;
    }

    stop() {
      this.session++;
      clearInterval(this.timer);
      window.removeEventListener('deviceorientation', this.receive);
      window.removeEventListener('deviceorientationabsolute', this.receive);
      this.sample = undefined;
      this.status = '';
      this.waiting = false;
    }

    async start() {
      this.stop();
      const session = this.session;
      const orientation = window.DeviceOrientationEvent;
      try {
        if (!window.isSecureContext) throw new Error('Mở trang qua HTTPS trên điện thoại để bật cảm biến.');
        if (!orientation) throw new Error('Trình duyệt này không cung cấp cảm biến hướng.');
        if (typeof orientation.requestPermission === 'function') {
          this.waiting = true;
          this.status = 'Đang chờ bạn cấp quyền cảm biến…';
          this.onChange();
          const permission = await orientation.requestPermission(true);
          if (session !== this.session) return;
          if (permission !== 'granted') throw new Error('Chưa có quyền cảm biến hướng.');
        }
        this.status = 'Đang chờ tín hiệu từ điện thoại…';
        this.waiting = true;
        const startedAt = performance.now();
        window.addEventListener('deviceorientation', this.receive);
        window.addEventListener('deviceorientationabsolute', this.receive);
        this.timer = setInterval(() => {
          if (this.sample) this.waiting = false;
          else if (performance.now() - startedAt > 4000) {
            this.waiting = false;
            this.status = 'Chưa nhận được tín hiệu cảm biến. Bạn có thể thử lại hoặc dùng mô phỏng.';
          }
          this.onChange();
        }, 120);
      } catch (error) {
        if (session !== this.session) return;
        this.waiting = false;
        this.status = error instanceof Error ? error.message : 'Không bật được cảm biến hướng.';
      }
      this.onChange();
    }
  }

  return { Sensor, normalize, planAngle, direction, readAim, aimInRoom, aimAngles };
})();
