import { shader } from './shader'

/** Total running time, and the point at which the wall fully hides the page. */
export const DURATION_MS = 1700
export const COVERED_AT = 0.5

const SAMPLES = 4
const FOV = (40 * Math.PI) / 180
const CAMERA_DISTANCE = 6
// WebGPU flag values (the DOM typings declare the types but not these globals).
const STAGE_VERTEX = 0x1
const STAGE_FRAGMENT = 0x2
const BUFFER_COPY_DST = 0x8
const BUFFER_VERTEX = 0x20
const BUFFER_UNIFORM = 0x40
const TEXTURE_RENDER_ATTACHMENT = 0x10
const UNIFORM_FLOATS = 44 // mat4 + 7 × vec4

interface Renderer {
  device: GPUDevice
  format: GPUTextureFormat
  tiles: GPURenderPipeline
  veil: GPURenderPipeline
  cube: GPUBuffer
  uniforms: GPUBuffer
  bindGroup: GPUBindGroup
}

export interface PortalOptions {
  /** Click position in CSS pixels; the ripple starts here. */
  x: number
  y: number
  /** true: FreeLLMAPI → Xwitch. false: the way back. */
  entering: boolean
  dark: boolean
  /** Called once, when the wall hides the page. Swap the route here. */
  onCovered: () => void
}

let renderer: Promise<Renderer | null> | null = null

export function portalSupported() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Unit cube as 36 vertices of position + normal. */
function cubeVertices() {
  const data: number[] = []
  const faces: Array<[number[], number[], number[]]> = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  ]
  for (const [n, a, b] of faces) {
    const corner = (i: number, j: number) => [0, 1, 2].map(k => (n[k] + a[k] * i + b[k] * j) * 0.5)
    for (const [i, j] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) data.push(...corner(i, j), ...n)
  }
  return new Float32Array(data)
}

async function createRenderer(): Promise<Renderer | null> {
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) return null
  const device = await adapter.requestDevice()
  // A lost device (tab backgrounded, driver reset) is rebuilt on the next run.
  void device.lost.then(() => { renderer = null })
  const format = navigator.gpu.getPreferredCanvasFormat()
  const module = device.createShaderModule({ code: shader })
  const layout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: STAGE_VERTEX | STAGE_FRAGMENT, buffer: { type: 'uniform' } }],
  })
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] })
  const tiles = await device.createRenderPipelineAsync({
    layout: pipelineLayout,
    vertex: {
      module, entryPoint: 'tileVertex',
      buffers: [{ arrayStride: 24, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
      ] }],
    },
    fragment: { module, entryPoint: 'tileFragment', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'back' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    multisample: { count: SAMPLES },
  })
  const veil = await device.createRenderPipelineAsync({
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'veilVertex' },
    fragment: { module, entryPoint: 'veilFragment', targets: [{
      format,
      blend: {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      },
    }] },
    primitive: { topology: 'triangle-list' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
    multisample: { count: SAMPLES },
  })
  const vertices = cubeVertices()
  const cube = device.createBuffer({ size: vertices.byteLength, usage: BUFFER_VERTEX | BUFFER_COPY_DST })
  device.queue.writeBuffer(cube, 0, vertices)
  const uniforms = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: BUFFER_UNIFORM | BUFFER_COPY_DST })
  const bindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniforms } }] })
  return { device, format, tiles, veil, cube, uniforms, bindGroup }
}

/** Build the GPU device and pipelines ahead of the first click. Safe to call repeatedly. */
export function warmPortal() {
  if (!portalSupported()) return Promise.resolve(null)
  renderer ??= createRenderer().catch(() => null)
  return renderer
}

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)

/**
 * Play the transition on a full-screen canvas above the page.
 * Resolves when it finishes; rejects if WebGPU is unavailable before anything
 * was drawn, in which case `onCovered` has not been called.
 */
export async function playPortal(options: PortalOptions): Promise<void> {
  const gpu = await warmPortal()
  if (!gpu) throw new Error('WebGPU unavailable')
  const { device } = gpu

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const cssWidth = window.innerWidth
  const cssHeight = window.innerHeight
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(cssWidth * dpr))
  canvas.height = Math.max(1, Math.round(cssHeight * dpr))
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483000;display:block;'
  const context = canvas.getContext('webgpu') as GPUCanvasContext | null
  if (!context) throw new Error('WebGPU canvas unavailable')
  context.configure({ device, format: gpu.format, alphaMode: 'premultiplied' })
  const size = [canvas.width, canvas.height]
  const colorTarget = device.createTexture({ size, format: gpu.format, sampleCount: SAMPLES, usage: TEXTURE_RENDER_ATTACHMENT })
  const depthTarget = device.createTexture({ size, format: 'depth24plus', sampleCount: SAMPLES, usage: TEXTURE_RENDER_ATTACHMENT })
  document.body.appendChild(canvas)

  // The wordmark sits under the tile mark while the switch is thrown.
  const wordmark = document.createElement('div')
  wordmark.textContent = 'Xwitch'
  wordmark.setAttribute('aria-hidden', 'true')
  wordmark.style.cssText = `position:fixed;left:0;right:0;top:calc(50% + ${Math.round(cssHeight * 0.34) + 26}px);z-index:2147483001;`
    + 'text-align:center;font:650 clamp(20px,2.4vw,30px)/1 var(--font-sans,system-ui),sans-serif;letter-spacing:.01em;'
    + 'color:#f4f7ff;opacity:0;pointer-events:none;will-change:opacity,transform;'
  if (options.entering) document.body.appendChild(wordmark)

  // The wall sits at z = 0 and exactly fills the camera's view.
  const aspect = cssWidth / cssHeight
  const wallHeight = 2 * CAMERA_DISTANCE * Math.tan(FOV / 2)
  const wallWidth = wallHeight * aspect
  const cols = Math.min(44, Math.max(12, Math.round(cssWidth / 46)))
  const cell = wallWidth / cols
  const rows = Math.ceil(wallHeight / cell)
  const originX = (options.x / cssWidth - 0.5) * wallWidth
  const originY = (0.5 - options.y / cssHeight) * wallHeight
  const reach = Math.hypot(Math.abs(originX) + wallWidth / 2, Math.abs(originY) + wallHeight / 2)

  const f = 1 / Math.tan(FOV / 2)
  const near = 0.05
  const far = 60
  const a = far / (near - far)
  const b = (near * far) / (near - far)
  const data = new Float32Array(UNIFORM_FLOATS)
  data.set([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, a, -1, 0, 0, -CAMERA_DISTANCE * a + b, CAMERA_DISTANCE], 0)
  data.set([cols, rows, cell, cell * 0.16], 16)
  data.set([originX, originY, 0, options.entering ? 1 : 0], 20)
  data.set([...rgb(options.dark ? '#26282d' : '#eceef1'), 1], 24)
  data.set([...rgb(options.dark ? '#3565e0' : '#2457d6'), 1], 28)
  data.set([...rgb('#f4f7ff'), 1], 32)
  data.set([...rgb(options.dark ? '#0b0d11' : '#141922'), 1], 36)
  data.set([wallWidth, wallHeight, CAMERA_DISTANCE, reach], 40)

  await new Promise<void>(resolve => {
    const start = performance.now()
    let covered = false
    const finish = () => {
      if (!covered) { covered = true; options.onCovered() }
      canvas.remove()
      wordmark.remove()
      colorTarget.destroy()
      depthTarget.destroy()
      resolve()
    }
    const frame = (now: number) => {
      const t = Math.min((now - start) / DURATION_MS, 1)
      if (!covered && t >= COVERED_AT) { covered = true; options.onCovered() }
      data[22] = t
      const shown = Math.min(Math.max((t - 0.56) / 0.1, 0), 1) * (1 - Math.min(Math.max((t - 0.72) / 0.07, 0), 1))
      wordmark.style.opacity = String(shown)
      wordmark.style.transform = `translateY(${(1 - shown) * 8}px)`
      try {
        device.queue.writeBuffer(gpu.uniforms, 0, data)
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: colorTarget.createView(), resolveTarget: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'discard',
          }],
          depthStencilAttachment: { view: depthTarget.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
        })
        pass.setBindGroup(0, gpu.bindGroup)
        pass.setPipeline(gpu.veil)
        pass.draw(3)
        pass.setPipeline(gpu.tiles)
        pass.setVertexBuffer(0, gpu.cube)
        pass.draw(36, cols * rows)
        pass.end()
        device.queue.submit([encoder.finish()])
      } catch {
        finish() // never leave the overlay stuck on screen
        return
      }
      if (t < 1) requestAnimationFrame(frame)
      else finish()
    }
    requestAnimationFrame(frame)
  })
}
