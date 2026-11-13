import { shader } from './shader'

/** Total running time, and the point at which the wall fully hides the page. */
export const DURATION_MS = 2200
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
const TEXTURE_COPY_DST = 0x2
const TEXTURE_BINDING = 0x4
const UNIFORM_FLOATS = 48 // mat4 + 8 × vec4
const LABEL = 'Thruline'
const LABEL_WIDTH = 1024
const LABEL_HEIGHT = 224

interface Renderer {
  device: GPUDevice
  format: GPUTextureFormat
  tiles: GPURenderPipeline
  veil: GPURenderPipeline
  cube: GPUBuffer
  uniforms: GPUBuffer
  bindGroup: GPUBindGroup
  /** Width ÷ height of the inked part of the wordmark texture. */
  labelAspect: number
}

export interface PortalOptions {
  /** Click position in CSS pixels; the ripple starts here. */
  x: number
  y: number
  /** true: FreeLLMAPI → Thruline. false: the way back. */
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
    entries: [
      { binding: 0, visibility: STAGE_VERTEX | STAGE_FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: STAGE_FRAGMENT, texture: {} },
      { binding: 2, visibility: STAGE_FRAGMENT, sampler: {} },
    ],
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
  // The wordmark is drawn once with the page's own typeface and sampled by the tile shader.
  const ink = document.createElement('canvas')
  ink.width = LABEL_WIDTH
  ink.height = LABEL_HEIGHT
  const pen = ink.getContext('2d')
  if (!pen) return null
  pen.font = `650 ${Math.round(LABEL_HEIGHT * 0.72)}px ${getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif'}`
  pen.textAlign = 'center'
  pen.textBaseline = 'middle'
  pen.fillStyle = '#fff'
  pen.fillText(LABEL, LABEL_WIDTH / 2, LABEL_HEIGHT / 2, LABEL_WIDTH * 0.96)
  const labelTexture = device.createTexture({
    size: [LABEL_WIDTH, LABEL_HEIGHT], format: 'rgba8unorm',
    usage: TEXTURE_BINDING | TEXTURE_COPY_DST | TEXTURE_RENDER_ATTACHMENT,
  })
  device.queue.copyExternalImageToTexture({ source: ink }, { texture: labelTexture, premultipliedAlpha: true }, [LABEL_WIDTH, LABEL_HEIGHT])
  const labelSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  const bindGroup = device.createBindGroup({ layout, entries: [
    { binding: 0, resource: { buffer: uniforms } },
    { binding: 1, resource: labelTexture.createView() },
    { binding: 2, resource: labelSampler },
  ] })
  return { device, format, tiles, veil, cube, uniforms, bindGroup, labelAspect: LABEL_WIDTH / LABEL_HEIGHT }
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
  // Wordmark: about two tiles tall, centred under the mark and clear of the wall's lower edge.
  const labelHalfHeight = Math.min(cell * 1.25, wallHeight * 0.06)
  const labelY = -Math.min(wallHeight * 0.34 * 0.62 + cell * 1.6 + labelHalfHeight, wallHeight * 0.5 - labelHalfHeight * 1.3)
  data.set([0, labelY, labelHalfHeight * gpu.labelAspect, labelHalfHeight], 44)

  await new Promise<void>(resolve => {
    const start = performance.now()
    let covered = false
    const finish = () => {
      if (!covered) { covered = true; options.onCovered() }
      canvas.remove()
      colorTarget.destroy()
      depthTarget.destroy()
      resolve()
    }
    const frame = (now: number) => {
      const t = Math.min((now - start) / DURATION_MS, 1)
      if (!covered && t >= COVERED_AT) { covered = true; options.onCovered() }
      data[22] = t
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
