import { UNIFORM_FLOATS, type Effect } from './effect'

// WebGPU flag values (the DOM typings declare the types but not these globals).
const BUFFER_COPY_DST = 0x8
const BUFFER_UNIFORM = 0x40
const STAGE_VERTEX = 0x1
const STAGE_FRAGMENT = 0x2

/** Fragment work scales with pixels, so very large screens render smaller and stretch. */
const MAX_PIXELS = 2_600_000
const MAX_SCALE = 1.5

interface Gpu {
  device: GPUDevice
  format: GPUTextureFormat
}
export interface EffectPipes {
  layout: GPUBindGroupLayout
  background: GPURenderPipeline
  stars: GPURenderPipeline | null
}

let gpuPromise: Promise<Gpu | null> | null = null
const pipes = new Map<Effect['id'], Promise<EffectPipes>>()

export function overlaySupported() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

async function createGpu(): Promise<Gpu | null> {
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) return null
  const device = await adapter.requestDevice()
  // A lost device (tab backgrounded, driver reset) is rebuilt on the next run.
  void device.lost.then(() => { gpuPromise = null; pipes.clear() })
  return { device, format: navigator.gpu.getPreferredCanvasFormat() }
}

/**
 * Two pipelines over one shared uniform block: the full-screen background
 * (premultiplied "over"), then the star sprites (additive, drawn on top).
 */
export async function buildPipes(device: GPUDevice, format: GPUTextureFormat, effect: Effect): Promise<EffectPipes> {
  const module = device.createShaderModule({ code: effect.wgsl })
  const layout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: STAGE_VERTEX | STAGE_FRAGMENT, buffer: { type: 'uniform' } }],
  })
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] })
  const over: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  }
  const add: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one' },
    alpha: { srcFactor: 'one', dstFactor: 'one' },
  }
  const background = await device.createRenderPipelineAsync({
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend: over }] },
    primitive: { topology: 'triangle-list' },
  })
  const stars = effect.particles
    ? await device.createRenderPipelineAsync({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vsStar' },
      fragment: { module, entryPoint: 'fsStar', targets: [{ format, blend: add }] },
      primitive: { topology: 'triangle-list' },
    })
    : null
  return { layout, background, stars }
}

/** Record one frame: background first, then the stars. */
export function drawEffect(pass: GPURenderPassEncoder, effect: Effect, set: EffectPipes, bindGroup: GPUBindGroup) {
  pass.setBindGroup(0, bindGroup)
  pass.setPipeline(set.background)
  pass.draw(3)
  if (set.stars && effect.particles) {
    pass.setPipeline(set.stars)
    pass.draw(6, effect.particles)
  }
}

function pipesFor(gpu: Gpu, effect: Effect) {
  let set = pipes.get(effect.id)
  if (!set) {
    set = buildPipes(gpu.device, gpu.format, effect)
    // A shader that fails to compile must not poison later runs with a stale rejection.
    set.catch(() => pipes.delete(effect.id))
    pipes.set(effect.id, set)
  }
  return set
}

/** Build the device and this effect's pipeline ahead of the first click. Safe to call repeatedly. */
export function warmEffect(effect: Effect) {
  if (!overlaySupported()) return Promise.resolve(null)
  gpuPromise ??= createGpu().catch(() => null)
  return gpuPromise.then(gpu => (gpu ? pipesFor(gpu, effect) : null)).catch(() => null)
}

export interface PlayOptions {
  /** Where the transition starts, in CSS pixels. */
  x: number
  y: number
  dark: boolean
  /** Called once, when the page is fully hidden. Swap the route here. */
  onCovered: () => void
}

/**
 * Play an effect on a full-screen canvas above the page. Resolves when it
 * finishes; rejects if WebGPU is unavailable before anything was drawn, in
 * which case `onCovered` has not been called.
 */
export async function playEffect(effect: Effect, options: PlayOptions): Promise<void> {
  gpuPromise ??= createGpu().catch(() => null)
  const gpu = await gpuPromise
  if (!gpu) throw new Error('WebGPU unavailable')
  const set = await pipesFor(gpu, effect)
  const { device } = gpu

  const cssWidth = window.innerWidth
  const cssHeight = window.innerHeight
  const scale = Math.min(window.devicePixelRatio || 1, MAX_SCALE, Math.sqrt(MAX_PIXELS / (cssWidth * cssHeight)))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(cssWidth * scale))
  canvas.height = Math.max(1, Math.round(cssHeight * scale))
  canvas.setAttribute('aria-hidden', 'true')
  canvas.dataset.pageTransition = effect.id
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483000;display:block;'
  const context = canvas.getContext('webgpu') as GPUCanvasContext | null
  if (!context) throw new Error('WebGPU canvas unavailable')
  context.configure({ device, format: gpu.format, alphaMode: 'premultiplied' })

  const uniforms = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: BUFFER_UNIFORM | BUFFER_COPY_DST })
  const bindGroup = device.createBindGroup({
    layout: set.layout,
    entries: [{ binding: 0, resource: { buffer: uniforms } }],
  })

  const originX = options.x * scale
  const originY = options.y * scale
  const reach = Math.hypot(Math.max(options.x, cssWidth - options.x), Math.max(options.y, cssHeight - options.y)) * scale
  const [c0, c1, c2, c3] = effect.palette(options.dark)
  const data = new Float32Array(UNIFORM_FLOATS)
  data.set([canvas.width, canvas.height, originX, originY, 0, options.dark ? 1 : 0, reach, scale], 0)
  data.set(c0, 8)
  data.set(c1, 12)
  data.set(c2, 16)
  data.set(c3, 20)

  document.body.appendChild(canvas)

  await new Promise<void>(resolve => {
    const start = performance.now()
    let covered = false
    let done = false
    const finish = () => {
      if (done) return
      done = true
      window.clearTimeout(watchdog)
      // Whatever happened, the route must have changed by the time the overlay goes.
      if (!covered) { covered = true; options.onCovered() }
      canvas.remove()
      uniforms.destroy()
      resolve()
    }
    // requestAnimationFrame stops in a hidden tab; never let that strand the navigation.
    const watchdog = window.setTimeout(finish, effect.duration + 1500)
    const frame = (now: number) => {
      if (done) return
      const t = Math.min(Math.max((now - start) / effect.duration, 0), 1)
      if (!covered && t >= effect.coveredAt) { covered = true; options.onCovered() }
      data[4] = t
      try {
        device.queue.writeBuffer(uniforms, 0, data)
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store',
          }],
        })
        drawEffect(pass, effect, set, bindGroup)
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
