/**
 * GPU presence layer — WebGL / Canvas / Navigator fingerprint stubs.
 *
 * Patches Happy DOM's window object before any page scripts execute,
 * providing a coherent, internally consistent GPU identity to fingerprinting
 * scripts that cross-correlate navigator, WebGL, and canvas signals.
 *
 * Threat model coverage:
 *   L3 (browser environment) — primary target: Cloudflare Turnstile,
 *   FingerprintJS, basic DataDome, navigator.webdriver checks.
 *   Realistic net recovery: 50–70% of sites currently falling to CACHE/MOBILE.
 *
 * Explicitly out of scope:
 *   DataDome Picasso, F5 Shape Security, Akamai JA4 TLS fingerprinting,
 *   hardware-verified WAFs, canvas-rendered GUIs.
 *
 * Spec: hollow-gpu-presence-layer-spec.md v0.2
 */

import type { Window } from 'happy-dom';
import type { LayoutBox } from './yoga-layout';

// ─── Types ────────────────────────────────────────────────────────────────────

export type YogaLayoutMap = Map<Element, LayoutBox>;

interface ShaderPrecisionEntry {
  rangeMin: number;
  rangeMax: number;
  precision: number;
}

interface ShaderPrecisionProfile {
  vertexHighpFloat:     ShaderPrecisionEntry;
  vertexMediumpFloat:   ShaderPrecisionEntry;
  vertexLowpFloat:      ShaderPrecisionEntry;
  fragmentHighpFloat:   ShaderPrecisionEntry;
  fragmentMediumpFloat: ShaderPrecisionEntry;
  fragmentLowpFloat:    ShaderPrecisionEntry;
}

interface GPUProfile {
  vendor:           string;
  renderer:         string;
  unmaskedVendor:   string;
  unmaskedRenderer: string;

  MAX_TEXTURE_SIZE:                 number;
  MAX_RENDERBUFFER_SIZE:            number;
  MAX_VERTEX_UNIFORM_VECTORS:       number;
  MAX_FRAGMENT_UNIFORM_VECTORS:     number;
  MAX_VARYING_VECTORS:              number;
  MAX_VERTEX_ATTRIBS:               number;
  MAX_VERTEX_TEXTURE_IMAGE_UNITS:   number;
  MAX_TEXTURE_IMAGE_UNITS:          number;
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: number;
  MAX_CUBE_MAP_TEXTURE_SIZE:        number;

  shaderPrecision:     ShaderPrecisionProfile;
  hardwareConcurrency: number;
  deviceMemory:        number;
  platform:            string;
  canvasProfile:       string;
}

// ─── Hardware profiles ────────────────────────────────────────────────────────

const PROFILE_NVIDIA_RTX: GPUProfile = {
  vendor:           'Google Inc. (NVIDIA)',
  renderer:         'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
  unmaskedVendor:   'NVIDIA Corporation',
  unmaskedRenderer: 'NVIDIA GeForce RTX 3060',

  MAX_TEXTURE_SIZE:                 32768,
  MAX_RENDERBUFFER_SIZE:            32768,
  MAX_VERTEX_UNIFORM_VECTORS:       4096,
  MAX_FRAGMENT_UNIFORM_VECTORS:     4096,
  MAX_VARYING_VECTORS:              31,
  MAX_VERTEX_ATTRIBS:               16,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS:   32,
  MAX_TEXTURE_IMAGE_UNITS:          32,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 48,
  MAX_CUBE_MAP_TEXTURE_SIZE:        32768,

  // Desktop: mediump emulates highp (32-bit results)
  shaderPrecision: {
    vertexHighpFloat:     { rangeMin: 127, rangeMax: 127, precision: 23 },
    vertexMediumpFloat:   { rangeMin: 127, rangeMax: 127, precision: 23 },
    vertexLowpFloat:      { rangeMin: 127, rangeMax: 127, precision: 23 },
    fragmentHighpFloat:   { rangeMin: 127, rangeMax: 127, precision: 23 },
    fragmentMediumpFloat: { rangeMin: 127, rangeMax: 127, precision: 23 },
    fragmentLowpFloat:    { rangeMin: 127, rangeMax: 127, precision: 23 },
  },

  hardwareConcurrency: 12,
  deviceMemory:        16,
  platform:            'Win32',
  canvasProfile:       'directwrite-nvidia',
};

const PROFILE_APPLE_M2: GPUProfile = {
  vendor:           'Apple',
  renderer:         'Apple M2',
  unmaskedVendor:   'Apple Inc.',
  unmaskedRenderer: 'Apple M2',

  MAX_TEXTURE_SIZE:                 8192,
  MAX_RENDERBUFFER_SIZE:            8192,
  MAX_VERTEX_UNIFORM_VECTORS:       1024,
  MAX_FRAGMENT_UNIFORM_VECTORS:     1024,
  MAX_VARYING_VECTORS:              31,
  MAX_VERTEX_ATTRIBS:               16,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS:   16,
  MAX_TEXTURE_IMAGE_UNITS:          16,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
  MAX_CUBE_MAP_TEXTURE_SIZE:        8192,

  // Apple Silicon: TRUE 16-bit mediump — not emulated
  shaderPrecision: {
    vertexHighpFloat:     { rangeMin: 127, rangeMax: 127, precision: 23 },
    vertexMediumpFloat:   { rangeMin: 14,  rangeMax: 14,  precision: 10 },
    vertexLowpFloat:      { rangeMin: 2,   rangeMax: 2,   precision: 8  },
    fragmentHighpFloat:   { rangeMin: 127, rangeMax: 127, precision: 23 },
    fragmentMediumpFloat: { rangeMin: 14,  rangeMax: 14,  precision: 10 },
    fragmentLowpFloat:    { rangeMin: 2,   rangeMax: 2,   precision: 8  },
  },

  hardwareConcurrency: 8,
  deviceMemory:        8,
  platform:            'MacIntel', // Chrome on Apple Silicon still reports MacIntel
  canvasProfile:       'coretext-apple-silicon',
};

const PROFILE_INTEL_IRIS: GPUProfile = {
  vendor:           'Google Inc. (Intel)',
  renderer:         'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)',
  unmaskedVendor:   'Intel Inc.',
  unmaskedRenderer: 'Intel(R) Iris(R) Xe Graphics',

  MAX_TEXTURE_SIZE:                 16384,
  MAX_RENDERBUFFER_SIZE:            16384,
  MAX_VERTEX_UNIFORM_VECTORS:       1024,
  MAX_FRAGMENT_UNIFORM_VECTORS:     1024,
  MAX_VARYING_VECTORS:              16, // Intel iGPU characteristic — not 31
  MAX_VERTEX_ATTRIBS:               16,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS:   16,
  MAX_TEXTURE_IMAGE_UNITS:          16,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
  MAX_CUBE_MAP_TEXTURE_SIZE:        16384,

  // Intel desktop: mediump emulates highp
  shaderPrecision: {
    vertexHighpFloat:     { rangeMin: 127, rangeMax: 127, precision: 23 },
    vertexMediumpFloat:   { rangeMin: 127, rangeMax: 127, precision: 23 },
    vertexLowpFloat:      { rangeMin: 127, rangeMax: 127, precision: 23 },
    fragmentHighpFloat:   { rangeMin: 127, rangeMax: 127, precision: 23 },
    fragmentMediumpFloat: { rangeMin: 127, rangeMax: 127, precision: 23 },
    fragmentLowpFloat:    { rangeMin: 127, rangeMax: 127, precision: 23 },
  },

  hardwareConcurrency: 8,
  deviceMemory:        8,
  platform:            'Win32',
  canvasProfile:       'directwrite-intel',
};

// ─── Extension list ───────────────────────────────────────────────────────────

const EXTENSIONS = [
  'ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_color_buffer_half_float',
  'EXT_disjoint_timer_query', 'EXT_float_blend', 'EXT_frag_depth',
  'EXT_shader_texture_lod', 'EXT_texture_compression_bptc',
  'EXT_texture_compression_rgtc', 'EXT_texture_filter_anisotropic',
  'WEBKIT_EXT_texture_filter_anisotropic', 'OES_element_index_uint',
  'OES_standard_derivatives', 'OES_texture_float', 'OES_texture_float_linear',
  'OES_texture_half_float', 'OES_texture_half_float_linear',
  'OES_vertex_array_object', 'WEBGL_color_buffer_float',
  'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb',
  'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders', 'WEBGL_depth_texture',
  'WEBGL_draw_buffers', 'WEBGL_lose_context', 'WEBGL_multi_draw',
];

// ─── Prototype poisoning defence ──────────────────────────────────────────────

/**
 * Wraps fn in a Proxy so that toString() returns the native code string.
 * Fingerprinting scripts check:
 *   canvas.getContext.toString() === "function getContext() { [native code] }"
 * Without this wrapper our patch is immediately detectable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeNativeLooking<T extends (...args: any[]) => any>(fn: T, name: string): T {
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === 'toString') return () => `function ${name}() { [native code] }`;
      if (prop === 'length')   return fn.length;
      if (prop === 'name')     return name;
      return Reflect.get(target, prop);
    },
  }) as T;
}

// ─── WebGL stubs ──────────────────────────────────────────────────────────────

function buildWebGLStub(profile: GPUProfile): object {
  const stub = {
    getParameter(pname: number): unknown {
      switch (pname) {
        case 0x9245: return profile.unmaskedVendor;
        case 0x9246: return profile.unmaskedRenderer;
        case 0x1F00: return profile.vendor;
        case 0x1F01: return profile.renderer;
        case 0x1F02: return 'WebGL 1.0';
        case 0x8B8C: return 'WebGL GLSL ES 1.0';
        case 0x0D33: return profile.MAX_TEXTURE_SIZE;
        case 0x8D57: return profile.MAX_RENDERBUFFER_SIZE;
        case 0x8B4A: return profile.MAX_VERTEX_UNIFORM_VECTORS;
        case 0x8B49: return profile.MAX_FRAGMENT_UNIFORM_VECTORS;
        case 0x8DFC: return profile.MAX_VARYING_VECTORS;
        case 0x8869: return profile.MAX_VERTEX_ATTRIBS;
        case 0x8B4C: return profile.MAX_VERTEX_TEXTURE_IMAGE_UNITS;
        case 0x8872: return profile.MAX_TEXTURE_IMAGE_UNITS;
        case 0x8B4D: return profile.MAX_COMBINED_TEXTURE_IMAGE_UNITS;
        case 0x851C: return profile.MAX_CUBE_MAP_TEXTURE_SIZE;
        case 0x0B45: return new Float32Array([1, 1]);
        case 0x846E: return new Float32Array([1, 1]);
        default:     return null;
      }
    },

    getExtension(name: string): unknown {
      if (name === 'WEBGL_debug_renderer_info') {
        return { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 };
      }
      return EXTENSIONS.includes(name) ? {} : null;
    },

    getSupportedExtensions: () => EXTENSIONS,

    getShaderPrecisionFormat(shaderType: number, precisionType: number): ShaderPrecisionEntry {
      const sp = profile.shaderPrecision;
      const isVertex = shaderType === 0x8B31;
      if (precisionType === 0x8DF2) {
        const p = isVertex ? sp.vertexHighpFloat   : sp.fragmentHighpFloat;
        return { rangeMin: p.rangeMin, rangeMax: p.rangeMax, precision: p.precision };
      }
      if (precisionType === 0x8DF1) {
        const p = isVertex ? sp.vertexMediumpFloat  : sp.fragmentMediumpFloat;
        return { rangeMin: p.rangeMin, rangeMax: p.rangeMax, precision: p.precision };
      }
      const p = isVertex ? sp.vertexLowpFloat : sp.fragmentLowpFloat;
      return { rangeMin: p.rangeMin, rangeMax: p.rangeMax, precision: p.precision };
    },

    // Picasso and shader-timing challenges fail here by design —
    // readPixels returns empty, these sites stay in fallback tiers.
    readPixels:       () => {},
    createBuffer:     () => ({}),
    createShader:     () => ({}),
    createProgram:    () => ({}),
    createTexture:    () => ({}),
    createFramebuffer:() => ({}),
    bindBuffer:       () => {},
    bindTexture:      () => {},
    bufferData:       () => {},
    compileShader:    () => {},
    linkProgram:      () => {},
    useProgram:       () => {},
    clearColor:       () => {},
    clear:            () => {},
    viewport:         () => {},
    drawArrays:       () => {},
    getError:         () => 0,
    isContextLost:    () => false,
    drawingBufferWidth:  300,
    drawingBufferHeight: 150,
  };

  return stub;
}

/** WebGL2 stub — superset of WebGL1 with updated version strings. */
function buildWebGL2Stub(profile: GPUProfile): object {
  const base = buildWebGLStub(profile) as Record<string, unknown>;

  return {
    ...base,
    getParameter(pname: number): unknown {
      // Override version strings for WebGL2
      if (pname === 0x1F02) return 'WebGL 2.0';
      if (pname === 0x8B8C) return 'WebGL GLSL ES 3.00';
      return (base.getParameter as (pname: number) => unknown)(pname);
    },
  };
}

// ─── Component 1 — patchGetContext ────────────────────────────────────────────

function patchGetContext(window: Window, profile: GPUProfile): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any;
  if (!win.HTMLCanvasElement?.prototype) return;

  const proto  = win.HTMLCanvasElement.prototype;
  const original = proto.getContext as (contextType: string, ...args: unknown[]) => unknown;

  Object.defineProperty(proto, 'getContext', {
    value: makeNativeLooking(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function getContext(this: any, contextType: string, ...args: unknown[]) {
        if (contextType === 'webgl' || contextType === 'experimental-webgl') {
          return buildWebGLStub(profile);
        }
        if (contextType === 'webgl2') {
          return buildWebGL2Stub(profile);
        }
        return original.call(this, contextType, ...args);
      },
      'getContext',
    ),
    writable:     true,
    configurable: true,
  });
}

// ─── Component 2 — patchComputedStyle ────────────────────────────────────────

function patchComputedStyle(window: Window, yogaLayout: YogaLayoutMap): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const original = (win.getComputedStyle as (...args: any[]) => CSSStyleDeclaration).bind(win);

  Object.defineProperty(win, 'getComputedStyle', {
    value: makeNativeLooking(
      function getComputedStyle(element: Element, pseudo?: string | null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const computed = original(element, pseudo) as any;
        const layout   = yogaLayout.get(element);
        const el       = element as HTMLElement;

        return new Proxy(computed, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          get(target: any, prop: string) {
            switch (prop) {
              case 'transform':
                return layout
                  ? `matrix(1, 0, 0, 1, ${layout.x}, ${layout.y})`
                  : target[prop] || 'none';
              case 'transformOrigin':      return '50% 50% 0';
              case 'willChange':           return el.style?.willChange || 'auto';
              case 'filter':               return el.style?.filter || 'none';
              case 'backdropFilter':       return el.style?.backdropFilter || 'none';
              case 'webkitBackdropFilter': return el.style?.backdropFilter || 'none';
              case 'perspective':          return 'none';
              case 'backfaceVisibility':   return 'visible';
              case 'webkitFontSmoothing':  return 'antialiased';
              case 'isolation':            return 'auto';
              default: return target[prop];
            }
          },
        });
      },
      'getComputedStyle',
    ),
    writable:     true,
    configurable: true,
  });
}

// ─── Component 3 — patchCanvas2D ─────────────────────────────────────────────

function generateFakeDataURL(seed: number, _type: string): string {
  const prefix = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ';
  const noise  = btoa(
    String.fromCharCode(
      ...Array.from({ length: 48 }, (_, i) => pseudoRandom(seed + i * 7) & 0xFF),
    )
  );
  return prefix + noise;
}

function hostnameToSeed(hostname: string): number {
  return hostname
    .split('')
    .reduce((acc, c, i) => (acc + c.charCodeAt(0) * (i + 1) * 2654435761) >>> 0, 0);
}

function profileSeed(profile: GPUProfile): number {
  return profile.renderer
    .split('')
    .reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 0);
}

function pseudoRandom(seed: number): number {
  seed = ((seed >>> 16) ^ seed) * 0x45d9f3b;
  seed = ((seed >>> 16) ^ seed) * 0x45d9f3b;
  return ((seed >>> 16) ^ seed) >>> 0;
}

function patchCanvas2D(window: Window, profile: GPUProfile, hostname: string): void {
  const seed = hostnameToSeed(hostname) ^ profileSeed(profile);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win  = window as any;

  if (!win.HTMLCanvasElement?.prototype) return;
  const proto = win.HTMLCanvasElement.prototype;

  Object.defineProperty(proto, 'toDataURL', {
    value: makeNativeLooking(
      function toDataURL(type = 'image/png') {
        return generateFakeDataURL(seed, type as string);
      },
      'toDataURL',
    ),
    writable:     true,
    configurable: true,
  });

  const ctx2dProto = win.CanvasRenderingContext2D?.prototype;
  if (ctx2dProto) {
    Object.defineProperty(ctx2dProto, 'getImageData', {
      value: makeNativeLooking(
        function getImageData(sx: number, sy: number, sw: number, sh: number) {
          const data = new Uint8ClampedArray(sw * sh * 4);
          for (let i = 0; i < data.length; i += 4) {
            const n = pseudoRandom(seed + i);
            data[i]     = 240 + (n & 0x0F);
            data[i + 1] = 240 + ((n >> 4) & 0x0F);
            data[i + 2] = 240 + ((n >> 8) & 0x0F);
            data[i + 3] = 255;
          }
          return { data, width: sw, height: sh, colorSpace: 'srgb' };
        },
        'getImageData',
      ),
      writable:     true,
      configurable: true,
    });
  }
}

// ─── Component 4 — patchNavigator ────────────────────────────────────────────

function patchNavigator(window: Window, profile: GPUProfile): void {
  const patches: Record<string, unknown> = {
    hardwareConcurrency: profile.hardwareConcurrency,
    deviceMemory:        profile.deviceMemory,
    platform:            profile.platform,
    webdriver:           false,
  };

  for (const [key, value] of Object.entries(patches)) {
    Object.defineProperty(window.navigator, key, {
      get:          makeNativeLooking(() => value, 'get ' + key),
      configurable: true,
    });
  }
}

// ─── Profile selection ────────────────────────────────────────────────────────

function selectProfile(hostname: string): GPUProfile {
  const profiles = [PROFILE_NVIDIA_RTX, PROFILE_APPLE_M2, PROFILE_INTEL_IRIS];
  return profiles[hostnameToSeed(hostname) % profiles.length];
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Apply the GPU presence layer to a Happy DOM window.
 *
 * Must be called BEFORE document.write() — page scripts must never
 * see the unpatched APIs.
 *
 * @param window   Happy DOM Window instance
 * @param options  hostname drives deterministic profile selection;
 *                 yogaLayout enables computed style approximation
 */
export function applyGPUPresenceLayer(
  window: Window,
  options: { hostname: string; yogaLayout?: YogaLayoutMap },
): void {
  const profile = selectProfile(options.hostname);
  console.log(
    `[hollow/gpu-presence] hostname=${options.hostname} → profile="${profile.unmaskedRenderer}" (${profile.platform})`
  );

  patchGetContext(window, profile);
  patchCanvas2D(window, profile, options.hostname);
  patchNavigator(window, profile);

  if (options.yogaLayout) {
    patchComputedStyle(window, options.yogaLayout);
  }
}

// Re-export for external inspection / testing
export { selectProfile, hostnameToSeed, PROFILE_NVIDIA_RTX, PROFILE_APPLE_M2, PROFILE_INTEL_IRIS };
