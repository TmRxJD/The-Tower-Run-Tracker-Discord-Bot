import {
  buildNapiRsCanvasChartRenderRuntime,
  renderSharedTableChartPng,
  type SharedTableChartRenderInput,
} from '@tmrxjd/platform/tools'
import { createCanvas } from '@napi-rs/canvas'

const runtime = buildNapiRsCanvasChartRenderRuntime((width, height) => createCanvas(width, height))

export async function renderViewRunsTablePng(input: SharedTableChartRenderInput): Promise<Buffer> {
  const bytes = await renderSharedTableChartPng(input, runtime)
  return Buffer.from(bytes)
}
