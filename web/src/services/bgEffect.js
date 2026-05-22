// Background blur / image replacement via MediaPipe Tasks Vision.
// Verbatim port of static/modules/bg-effect.js.

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

let visionModulePromise = null;
function loadVisionModule() {
  if (!visionModulePromise) {
    visionModulePromise = import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
  }
  return visionModulePromise;
}

let segmenter = null;
async function getSegmenter() {
  if (segmenter) return segmenter;
  const vision = await loadVisionModule();
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
  segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  });
  return segmenter;
}

export class BgEffect {
  constructor(sourceTrack, { mode = 'blur', blurPx = 14, imageUrl = null } = {}) {
    this.sourceTrack = sourceTrack;
    this.mode = mode;
    this.blurPx = blurPx;
    this.bgImage = null;
    this.stopped = false;

    if (mode === 'image' && imageUrl) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { this.bgImage = img; };
      img.src = imageUrl;
    }

    const { width = 640, height = 360, frameRate = 24 } = sourceTrack.getSettings();
    this.width = width;
    this.height = height;

    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.srcObject = new MediaStream([sourceTrack]);

    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');

    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = width;
    this.maskCanvas.height = height;
    this.maskCtx = this.maskCanvas.getContext('2d');

    this.personCanvas = document.createElement('canvas');
    this.personCanvas.width = width;
    this.personCanvas.height = height;
    this.personCtx = this.personCanvas.getContext('2d');

    this.outStream = this.canvas.captureStream(frameRate);
    this.outTrack = this.outStream.getVideoTracks()[0];
  }

  async start() {
    await this.video.play().catch(() => {});
    this.seg = await getSegmenter();
    this._loop();
  }

  _loop = () => {
    if (this.stopped) return;
    const v = this.video;
    if (v.readyState >= 2 && v.videoWidth) {
      if (v.videoWidth !== this.width || v.videoHeight !== this.height) {
        this.width = v.videoWidth;
        this.height = v.videoHeight;
        this.canvas.width = this.maskCanvas.width = this.personCanvas.width = this.width;
        this.canvas.height = this.maskCanvas.height = this.personCanvas.height = this.height;
      }
      try {
        this.seg.segmentForVideo(v, performance.now(), (res) => this._draw(res));
      } catch {}
    }
    if ('requestVideoFrameCallback' in v) {
      v.requestVideoFrameCallback(this._loop);
    } else {
      requestAnimationFrame(this._loop);
    }
  };

  _draw(result) {
    const { ctx, maskCtx, personCtx, width: w, height: h } = this;
    const mask = result.categoryMask;
    if (!mask) return;
    const maskData = mask.getAsUint8Array();
    const img = maskCtx.createImageData(w, h);
    const px = img.data;
    for (let i = 0, j = 0; i < maskData.length; i++, j += 4) {
      const isPerson = maskData[i] === 0;
      px[j] = 255; px[j + 1] = 255; px[j + 2] = 255;
      px[j + 3] = isPerson ? 255 : 0;
    }
    maskCtx.putImageData(img, 0, 0);

    personCtx.save();
    personCtx.clearRect(0, 0, w, h);
    personCtx.drawImage(this.maskCanvas, 0, 0, w, h);
    personCtx.globalCompositeOperation = 'source-in';
    personCtx.drawImage(this.video, 0, 0, w, h);
    personCtx.restore();

    if (this.mode === 'image' && this.bgImage) {
      const iw = this.bgImage.naturalWidth;
      const ih = this.bgImage.naturalHeight;
      const ratio = Math.max(w / iw, h / ih);
      const dw = iw * ratio, dh = ih * ratio;
      const dx = (w - dw) / 2, dy = (h - dh) / 2;
      ctx.drawImage(this.bgImage, dx, dy, dw, dh);
    } else {
      ctx.save();
      ctx.filter = `blur(${this.blurPx}px)`;
      ctx.drawImage(this.video, 0, 0, w, h);
      ctx.restore();
    }
    ctx.drawImage(this.personCanvas, 0, 0, w, h);
  }

  stop() {
    this.stopped = true;
    try { this.outTrack.stop(); } catch {}
    try { this.video.srcObject = null; } catch {}
  }
}
