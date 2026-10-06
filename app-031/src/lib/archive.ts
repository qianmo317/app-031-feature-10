// 项目存档导入/导出：版本兼容、字段迁移、差异核对（纯函数，不写本机存档）
//
// 【单位与精度约定】重算值与界面显示共用同一套（改动落在本文件与 format.ts，各页面随动）：
//   长度   毫米 mm，整数（重算/生成的值 Math.round 到 1mm），界面 0 位小数
//   面积   平方毫米 mm² 整数存储与计算，显示时折平方米 m² 保留 2 位（format.areaM2）
//   金额   分 cents 整数存储与计算，显示时折元保留 2 位（format.money）
//   利用率 0~1 比值存储，显示百分数保留 1 位（format.pct）
//   封边长 米 m，保留 2 位（0.01m = 1cm 精度）
// 文件里已存在的合法数值一律原样保留（不在此处做取整/改写），只有缺失或非法时才补默认/重算。
//
// 【存档版本】
//   v1  早期裸 Job JSON：板材无余料板类型(kind/offcutId)、无材质，项目无按柜体分批
//       (batchByCabinet)与余料引用(useOffcutIds)，result 缺 unplaced/baselineBoards/
//       savedBoards/savedCents/totalCostCents/stockShortage/elapsedMs/generatedAt，
//       sheet 可能缺 steps/offcuts/boardName 等
//   v2  信封格式 { format:'fco-archive', version:2, exportedAt, jobs:[Job...] }（当前导出）
// 导入兼容 v1 裸对象 / v2 信封 / 裸数组；导出一律写 v2。v2 文件导回不产生任何迁移改动，
// 导出去再读回来逐字段一模一样（selftest 有断言）。
//
// 【缺字段策略（已确认的取舍）】
//   老结果里缺的数一律【按当前明细由排样内核重算】（deriveResultStats / rebuildFromPlacements，
//   与 nestJob 同一条判定），并逐项写进 result.migrated.fields / sheet.migratedFields 标记，
//   不冒充当年那一次。代价：与已发到车间的旧打印单据可能不一致——因此排样页、统计页、
//   打印的下料单/标签上都带「导入重算」字样。另一方案（留空待人工补）未采用。
import type {
  Board,
  CutStep,
  EdgeSide,
  GrainDemand,
  Job,
  NestResult,
  OffcutInfo,
  Part,
  Placement,
  SheetResult
} from '../types'
import { deriveResultStats, nestJob } from './packing'
import { rebuildFromPlacements } from './cuts'
import { EPS } from './geometry'
import { uid } from './format'
import boardsData from '../data/boards.json'

export const ARCHIVE_FORMAT = 'fco-archive'
export const ARCHIVE_VERSION = 2

export interface MigrationNote {
  path: string // 字段路径，如 result.edgeBandM
  action: '补默认值' | '重算'
  detail: string
}

export interface PlanEntry {
  job: Job // 迁移后的完整对象（未知字段原样保留）
  notes: MigrationNote[] // 本次补了哪几项（默认值 + 重算）
  recomputed: string[] // 其中属于重算的字段路径
  status: 'new' | 'same' | 'conflict' // 与本机已有项目的关系
  diff: string[] // 冲突时与本机版本的差异清单
}

export interface ImportPlan {
  ok: boolean
  errors: string[]
  entries: PlanEntry[]
}

/** 导出 v2 信封格式（支持多项目整批）。 */
export function exportArchive(jobs: Job[]): string {
  return JSON.stringify(
    { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, exportedAt: Date.now(), jobs },
    null,
    2
  )
}

/** 深比较（对象键序无关、undefined 视为不存在；数组顺序敏感）。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => deepEqual(x, b[i]))
  }
  if (typeof a === 'object') {
    const oa = a as Record<string, unknown>
    const ob = b as Record<string, unknown>
    const ka = Object.keys(oa).filter((k) => oa[k] !== undefined)
    const kb = Object.keys(ob).filter((k) => ob[k] !== undefined)
    if (ka.length !== kb.length) return false
    return ka.every((k) => deepEqual(oa[k], ob[k]))
  }
  return false
}

// ---------- 解析入口 ----------

/** 解析存档文件并生成导入计划（纯函数，不写本机；调用方确认后才 commit）。 */
export function parseArchive(json: string, localJobs: Job[]): ImportPlan {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, errors: ['文件不是合法 JSON，无法导入'], entries: [] }
  }
  let raws: unknown[] = []
  if (Array.isArray(parsed)) {
    raws = parsed
  } else if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    if (Array.isArray(o.jobs)) raws = o.jobs // v2 信封
    else if (o.job && typeof o.job === 'object') raws = [o.job]
    else raws = [o] // v1 裸 Job
  }
  const errors: string[] = []
  const entries: PlanEntry[] = []
  const seen = new Set<string>()
  if (raws.length === 0) errors.push('文件中没有可导入的项目')
  for (const raw of raws) {
    const m = migrateJob(raw)
    if (!m) {
      errors.push('存在不是合法项目存档的条目（缺 boards/parts 清单），已跳过')
      continue
    }
    if (seen.has(m.job.id)) {
      errors.push(`文件内项目编号 ${m.job.id} 重复，已跳过重复条目`)
      continue
    }
    seen.add(m.job.id)
    const existing = localJobs.find((j) => j.id === m.job.id)
    const status: PlanEntry['status'] = !existing
      ? 'new'
      : deepEqual(existing, m.job)
        ? 'same'
        : 'conflict'
    entries.push({
      job: m.job,
      notes: m.notes,
      recomputed: m.recomputed,
      status,
      diff: status === 'conflict' ? diffJobs(existing as Job, m.job) : []
    })
  }
  return { ok: entries.length > 0, errors, entries }
}

/** 与本机版本逐条对比，生成人读的差异清单。 */
export function diffJobs(local: Job, incoming: Job): string[] {
  const lines: string[] = []
  const cmp = (label: string, va: unknown, vb: unknown, fmt?: (v: unknown) => string): void => {
    if (!deepEqual(va, vb)) {
      const f = fmt ?? ((v: unknown) => String(v))
      lines.push(`${label}：本机「${f(va)}」↔ 文件「${f(vb)}」`)
    }
  }
  const dateFmt = (v: unknown): string =>
    Number(v) > 0 ? new Date(Number(v)).toLocaleString('zh-CN') : '缺失'
  cmp('项目名', local.name, incoming.name)
  cmp('创建时间', local.createdAt, incoming.createdAt, dateFmt)
  cmp('锯路', local.kerfMm, incoming.kerfMm, (v) => `${v}mm`)
  cmp('修边', local.trimMm, incoming.trimMm, (v) => `${v}mm`)
  cmp('按柜体分批', local.batchByCabinet, incoming.batchByCabinet, (v) => (v ? '是' : '否'))
  cmp('板材种数', local.boards.length, incoming.boards.length)
  cmp('零件种数', local.parts.length, incoming.parts.length)
  cmp(
    '零件总件数',
    local.parts.reduce((a, p) => a + p.qty, 0),
    incoming.parts.reduce((a, p) => a + p.qty, 0)
  )
  cmp(
    '排样结果',
    local.result ? `${local.result.boardsUsed} 张板` : '无',
    incoming.result ? `${incoming.result.boardsUsed} 张板` : '无'
  )
  if (local.result && incoming.result) {
    cmp('结果生成时间', local.result.generatedAt, incoming.result.generatedAt, dateFmt)
  }
  return lines.length > 0 ? lines : ['仅未知扩展字段或字段顺序不同']
}

// ---------- 字段迁移 ----------

interface Ctx {
  notes: MigrationNote[]
  recomputed: string[]
}

function note(ctx: Ctx, path: string, action: MigrationNote['action'], detail: string): void {
  ctx.notes.push({ path, action, detail })
  if (action === '重算') ctx.recomputed.push(path)
}

/** 数值读取：数字或数字字符串原样返回（不取整、不改写），其余为 undefined。 */
function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

const GRAINS: GrainDemand[] = ['length', 'width', 'none']
const SIDES: EdgeSide[] = ['top', 'bottom', 'left', 'right']

/**
 * 迁移单个项目对象：缺失字段按写明的默认值补上（逐项记录），缺失的结果数值由
 * 排样内核重算（逐项标记）；已存在的值与未知扩展字段一律原样保留。
 * 返回 null 表示该条目根本不是项目存档（致命，跳过）。
 */
export function migrateJob(raw: unknown): { job: Job; notes: MigrationNote[]; recomputed: string[] } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  if (!Array.isArray(rec.boards) || !Array.isArray(rec.parts)) return null
  const ctx: Ctx = { notes: [], recomputed: [] }
  const job = raw as Job

  // ---- 项目级 ----
  if (typeof job.id !== 'string' || !job.id) {
    job.id = uid('job')
    note(ctx, 'id', '补默认值', '项目编号缺失，已生成新编号')
  }
  if (typeof job.name !== 'string' || !job.name) {
    job.name = '未命名项目'
    note(ctx, 'name', '补默认值', '项目名缺失，补「未命名项目」')
  }
  if (num(job.createdAt) === undefined) {
    job.createdAt = Date.now()
    note(ctx, 'createdAt', '补默认值', '创建时间缺失，以本次导入时间代替（仅此一种情况会动创建时间）')
  }
  if (num(job.kerfMm) === undefined) {
    job.kerfMm = boardsData.defaults.kerfMm
    note(ctx, 'kerfMm', '补默认值', `锯路缺失，按默认 ${job.kerfMm}mm`)
  }
  if (num(job.trimMm) === undefined) {
    job.trimMm = boardsData.defaults.trimMm
    note(ctx, 'trimMm', '补默认值', `修边缺失，按默认 ${job.trimMm}mm`)
  }
  if (!Array.isArray(job.useOffcutIds)) {
    job.useOffcutIds = []
    note(ctx, 'useOffcutIds', '补默认值', '早期版本无余料引用列表，补空数组')
  }
  if (typeof job.batchByCabinet !== 'boolean') {
    job.batchByCabinet = false
    note(ctx, 'batchByCabinet', '补默认值', '早期版本无按柜体分批开关，补 false（不分批）')
  }

  // ---- 板材 ----
  const boards: Board[] = []
  rec.boards.forEach((rb, i) => {
    if (!rb || typeof rb !== 'object') {
      note(ctx, `boards[${i}]`, '补默认值', '板材条目无效，已丢弃')
      return
    }
    const b = rb as Board
    const w = num(b.wMm)
    const h = num(b.hMm)
    if (w === undefined || h === undefined || w <= 0 || h <= 0) {
      note(ctx, `boards[${i}]`, '补默认值', '板材尺寸缺失或无效，已丢弃该板材')
      return
    }
    if (typeof b.id !== 'string' || !b.id) {
      b.id = uid('b')
      note(ctx, `boards[${i}].id`, '补默认值', '板材编号缺失，已生成')
    }
    if (typeof b.name !== 'string' || !b.name) {
      b.name = `板材 ${Math.round(w)}×${Math.round(h)}`
      note(ctx, `boards[${i}].name`, '补默认值', `板材名缺失，补「${b.name}」`)
    }
    if (num(b.thicknessMm) === undefined) {
      b.thicknessMm = 18
      note(ctx, `boards[${i}].thicknessMm`, '补默认值', '厚度缺失，按 18mm')
    }
    if (num(b.priceCents) === undefined) {
      b.priceCents = 0
      note(ctx, `boards[${i}].priceCents`, '补默认值', '单价缺失，按 0 分')
    }
    if (num(b.quantity) === undefined) {
      b.quantity = 0
      note(ctx, `boards[${i}].quantity`, '补默认值', '库存张数缺失，按 0（不限）')
    }
    if (typeof b.material !== 'string' || !b.material) {
      b.material = '未标注材质'
      note(ctx, `boards[${i}].material`, '补默认值', '材质缺失，补「未标注材质」')
    }
    if (b.kind !== 'stock' && b.kind !== 'offcut') {
      b.kind = 'stock'
      note(ctx, `boards[${i}].kind`, '补默认值', '早期版本无余料板类型，按常规板材 stock')
    }
    boards.push(b)
  })
  job.boards = boards

  // ---- 零件 ----
  const parts: Part[] = []
  rec.parts.forEach((rp, i) => {
    if (!rp || typeof rp !== 'object') {
      note(ctx, `parts[${i}]`, '补默认值', '零件条目无效，已丢弃')
      return
    }
    const p = rp as Part
    const len = num(p.lenMm)
    const wid = num(p.widMm)
    if (len === undefined || wid === undefined || len <= 0 || wid <= 0) {
      note(ctx, `parts[${i}]`, '补默认值', `零件「${p.name ?? p.code ?? i}」长宽缺失或无效，已丢弃`)
      return
    }
    if (typeof p.id !== 'string' || !p.id) {
      p.id = uid('p')
      note(ctx, `parts[${i}].id`, '补默认值', '零件编号缺失，已生成')
    }
    if (typeof p.code !== 'string') {
      p.code = ''
      note(ctx, `parts[${i}].code`, '补默认值', '零件代号缺失，补空串')
    }
    if (typeof p.name !== 'string' || !p.name) {
      p.name = p.code || `零件${i + 1}`
      note(ctx, `parts[${i}].name`, '补默认值', `零件名缺失，补「${p.name}」`)
    }
    const qty = num(p.qty)
    if (qty === undefined || qty <= 0) {
      p.qty = 1
      note(ctx, `parts[${i}].qty`, '补默认值', '数量缺失或无效，按 1')
    } else if (qty !== Math.floor(qty)) {
      p.qty = Math.floor(qty)
      note(ctx, `parts[${i}].qty`, '补默认值', `数量取整为 ${p.qty}`)
    }
    if (!GRAINS.includes(p.grain)) {
      p.grain = 'none'
      note(ctx, `parts[${i}].grain`, '补默认值', '纹理要求缺失或非法，按「无要求」')
    }
    if (!Array.isArray(p.edgeBands)) {
      p.edgeBands = []
      note(ctx, `parts[${i}].edgeBands`, '补默认值', '封边列表缺失，补空（不封边）')
    } else {
      p.edgeBands = p.edgeBands.filter((s): s is EdgeSide => SIDES.includes(s as EdgeSide))
    }
    if (typeof p.cabinet !== 'string' || !p.cabinet) {
      p.cabinet = '未分组'
      note(ctx, `parts[${i}].cabinet`, '补默认值', '柜体缺失，补「未分组」')
    }
    if (typeof p.exposed !== 'boolean') {
      p.exposed = false
      note(ctx, `parts[${i}].exposed`, '补默认值', '见光标记缺失，按非见光')
    }
    if (typeof p.boardId !== 'string') {
      p.boardId = ''
      note(ctx, `parts[${i}].boardId`, '补默认值', '指定板材缺失，按自动选板')
    }
    parts.push(p)
  })
  job.parts = parts

  // ---- 排样结果 ----
  if (rec.result !== undefined && rec.result !== null) {
    if (typeof rec.result !== 'object') {
      job.result = undefined
      note(ctx, 'result', '补默认值', '结果数据非法，已忽略（项目按未排样打开）')
    } else {
      migrateResult(job, rec.result as NestResult, ctx)
    }
  }
  return { job, notes: ctx.notes, recomputed: ctx.recomputed }
}

function migrateResult(job: Job, rr: NestResult, ctx: Ctx): void {
  const sheetsRaw = Array.isArray(rr.sheets) ? rr.sheets.filter((s) => s && typeof s === 'object') : null
  // 结果存在但没有任何板的摆法明细：按当前明细整体重算（代价：与历史版本不一致，全程标记）
  const needFullRenest =
    !sheetsRaw || sheetsRaw.length === 0 || sheetsRaw.some((s) => !Array.isArray((s as SheetResult).placements))
  if (needFullRenest) {
    if (job.parts.length > 0 && job.boards.length > 0) {
      const fresh = nestJob(job)
      fresh.migrated = { at: Date.now(), fields: ['result（整体重算）'] }
      job.result = fresh
      note(ctx, 'result', '重算', '原结果缺排样明细，已按当前明细整体重算（与历史版本不一致，已标记）')
      ctx.recomputed.push('result（整体重算）')
    } else {
      job.result = undefined
      note(ctx, 'result', '补默认值', '原结果缺排样明细且板材/零件为空，无法重算，按未排样打开')
    }
    return
  }

  const sheets = sheetsRaw.map((s, i) => migrateSheet(job, s as SheetResult, i, ctx))
  rr.sheets = sheets

  // 结果级统计：缺哪项补哪项，全部来自 deriveResultStats（与 nestJob 同一条判定）
  const derived = deriveResultStats(job, sheets)
  const topFields = [
    'boardsUsed',
    'boardsByType',
    'edgeBandM',
    'unplaced',
    'baselineBoards',
    'savedBoards',
    'savedCents',
    'totalCostCents',
    'stockShortage'
  ] as const
  for (const f of topFields) {
    if (rr[f] === undefined) {
      ;(rr as unknown as Record<string, unknown>)[f] = derived[f]
      note(ctx, `result.${f}`, '重算', '老结果缺该字段，按当前明细由排样内核重算')
    }
  }
  if (num(rr.elapsedMs) === undefined) {
    rr.elapsedMs = 0
    note(ctx, 'result.elapsedMs', '补默认值', '原始耗时缺失，记 0（不代表真实排样耗时）')
  }
  if (num(rr.generatedAt) === undefined) {
    rr.generatedAt = 0
    note(ctx, 'result.generatedAt', '补默认值', '原始生成时间缺失，记 0')
  }
  if (ctx.recomputed.length > 0) {
    const prev = Array.isArray(rr.migrated?.fields) ? rr.migrated.fields : []
    rr.migrated = { at: Date.now(), fields: [...new Set([...prev, ...ctx.recomputed])] }
  }
}

function migrateSheet(job: Job, s: SheetResult, idx: number, ctx: Ctx): SheetResult {
  const path = `result.sheets[${idx}]`
  const migratedFields: string[] = Array.isArray(s.migratedFields) ? [...s.migratedFields] : []
  const mark = (f: string): void => {
    if (!migratedFields.includes(f)) migratedFields.push(f)
  }
  const board = job.boards.find((b) => b.id === s.boardId)

  if (typeof s.index !== 'number') {
    s.index = idx
    note(ctx, `${path}.index`, '补默认值', `板序号缺失，按数组顺序 ${idx}`)
  }
  if (typeof s.boardId !== 'string') {
    s.boardId = board?.id ?? ''
    note(ctx, `${path}.boardId`, '补默认值', '板材引用缺失')
  }
  if (typeof s.boardName !== 'string' || !s.boardName) {
    s.boardName = board?.name ?? '未知板材'
    note(ctx, `${path}.boardName`, '补默认值', `板名缺失，补「${s.boardName}」`)
  }
  if (typeof s.material !== 'string' || !s.material) {
    s.material = board?.material ?? '未标注材质'
    note(ctx, `${path}.material`, '补默认值', '材质缺失')
  }
  if (num(s.thicknessMm) === undefined) {
    s.thicknessMm = board?.thicknessMm ?? 18
    note(ctx, `${path}.thicknessMm`, '补默认值', `厚度缺失，按 ${s.thicknessMm}mm`)
  }
  if (num(s.wMm) === undefined) {
    s.wMm = board?.wMm ?? 2440
    note(ctx, `${path}.wMm`, '补默认值', `板长缺失，按 ${s.wMm}mm`)
  }
  if (num(s.hMm) === undefined) {
    s.hMm = board?.hMm ?? 1220
    note(ctx, `${path}.hMm`, '补默认值', `板宽缺失，按 ${s.hMm}mm`)
  }
  if (num(s.priceCents) === undefined) {
    s.priceCents = board ? (board.kind === 'offcut' ? 0 : board.priceCents) : 0
    note(ctx, `${path}.priceCents`, '补默认值', '单价缺失，按板材清单取值')
  }

  // 就位零件：展示冗余字段从零件清单回填
  const partById = new Map(job.parts.map((p) => [p.id, p]))
  s.placements.forEach((pl: Placement, pi: number) => {
    const part = partById.get(pl.partId)
    const pp = `${path}.placements[${pi}]`
    if (typeof pl.partId !== 'string') {
      pl.partId = part?.id ?? ''
      note(ctx, `${pp}.partId`, '补默认值', '零件引用缺失')
    }
    if (num(pl.x) === undefined) {
      pl.x = 0
      note(ctx, `${pp}.x`, '补默认值', 'X 坐标缺失，记 0')
    }
    if (num(pl.y) === undefined) {
      pl.y = 0
      note(ctx, `${pp}.y`, '补默认值', 'Y 坐标缺失，记 0')
    }
    if (num(pl.lenMm) === undefined) {
      pl.lenMm = part?.lenMm ?? 0
      note(ctx, `${pp}.lenMm`, '补默认值', '就位长度缺失，按零件清单尺寸')
    }
    if (num(pl.widMm) === undefined) {
      pl.widMm = part?.widMm ?? 0
      note(ctx, `${pp}.widMm`, '补默认值', '就位宽度缺失，按零件清单尺寸')
    }
    if (num(pl.origLen) === undefined) {
      pl.origLen = part?.lenMm ?? pl.lenMm
      note(ctx, `${pp}.origLen`, '补默认值', '原始长度缺失，按零件清单尺寸')
    }
    if (num(pl.origWid) === undefined) {
      pl.origWid = part?.widMm ?? pl.widMm
      note(ctx, `${pp}.origWid`, '补默认值', '原始宽度缺失，按零件清单尺寸')
    }
    if (typeof pl.instanceId !== 'string' || !pl.instanceId) {
      pl.instanceId = `${pl.partId}#${pi + 1}`
      note(ctx, `${pp}.instanceId`, '补默认值', '实例编号缺失，按「零件#序号」补')
    }
    if (typeof pl.boardIndex !== 'number') {
      pl.boardIndex = idx
      note(ctx, `${pp}.boardIndex`, '补默认值', '所属板序号缺失')
    }
    if (typeof pl.seq !== 'number') {
      pl.seq = pi + 1
      note(ctx, `${pp}.seq`, '补默认值', '下料序号缺失，按板内顺序')
    }
    if (typeof pl.rotated !== 'boolean') {
      pl.rotated = false
      note(ctx, `${pp}.rotated`, '补默认值', '旋转标记缺失，按未旋转')
    }
    if (typeof pl.code !== 'string') {
      pl.code = part?.code ?? ''
      note(ctx, `${pp}.code`, '补默认值', '零件代号缺失，按零件清单回填')
    }
    if (typeof pl.name !== 'string') {
      pl.name = part?.name ?? ''
      note(ctx, `${pp}.name`, '补默认值', '零件名缺失，按零件清单回填')
    }
    if (typeof pl.cabinet !== 'string' || !pl.cabinet) {
      pl.cabinet = part?.cabinet ?? '未分组'
      note(ctx, `${pp}.cabinet`, '补默认值', '柜体缺失，按零件清单回填')
    }
    if (typeof pl.exposed !== 'boolean') {
      pl.exposed = part?.exposed ?? false
      note(ctx, `${pp}.exposed`, '补默认值', '见光标记缺失，按零件清单回填')
    }
    if (!GRAINS.includes(pl.grain)) {
      pl.grain = part?.grain ?? 'none'
      note(ctx, `${pp}.grain`, '补默认值', '纹理缺失，按零件清单回填')
    }
    if (!Array.isArray(pl.edgeBands)) {
      pl.edgeBands = part ? [...part.edgeBands] : []
      note(ctx, `${pp}.edgeBands`, '补默认值', '封边缺失，按零件清单回填')
    }
  })

  // 刀路 / 余料：缺则由同一内核（rebuildFromPlacements，微调重算同款）从摆法还原
  const needSteps = !Array.isArray(s.steps) || s.steps.length === 0
  const needOffcuts = !Array.isArray(s.offcuts)
  if (needSteps || needOffcuts) {
    const rebuilt = rebuildFromPlacements(s.wMm, s.hMm, job.kerfMm, job.trimMm, idx, s.placements)
    if (rebuilt) {
      if (needSteps) {
        s.steps = rebuilt.steps
        mark('steps')
        note(ctx, `${path}.steps`, '重算', '刀路缺失，已由摆法经内核还原（与历史刀序可能不同）')
      }
      if (needOffcuts) {
        s.offcuts = leftoversToOffcuts(rebuilt.leftovers)
        mark('offcuts')
        note(ctx, `${path}.offcuts`, '重算', '余料缺失，已由摆法经内核还原')
      }
    } else {
      if (needSteps) {
        s.steps = []
        mark('steps')
        note(ctx, `${path}.steps`, '重算', '无法由摆法还原贯通刀路（非 guillotine 布局），刀路留空，需重新排样')
      }
      if (needOffcuts) {
        s.offcuts = []
        mark('offcuts')
        note(ctx, `${path}.offcuts`, '重算', '无法由摆法还原余料，留空')
      }
    }
  } else {
    s.steps.forEach((st: CutStep, si: number) => {
      const sp = `${path}.steps[${si}]`
      if (num(st.at) === undefined) {
        st.at = 0
        note(ctx, `${sp}.at`, '补默认值', '切割位置缺失，记 0')
      }
      if (!Array.isArray(st.span) || st.span.length !== 2) {
        st.span = [0, Math.round(st.axis === 'v' ? s.hMm : s.wMm)]
        note(ctx, `${sp}.span`, '补默认值', '贯通区间缺失，按全板幅')
      }
      if (typeof st.order !== 'number') {
        st.order = si
        note(ctx, `${sp}.order`, '补默认值', '刀序缺失，按数组顺序')
      }
      if (st.kind !== 'trim' && st.kind !== 'cut') {
        st.kind = 'cut'
        note(ctx, `${sp}.kind`, '补默认值', '刀型缺失，按裁切刀')
      }
      if (typeof st.label !== 'string') {
        st.label =
          st.axis === 'v'
            ? `沿 X = ${Math.round(st.at)}mm 竖切`
            : `沿 Y = ${Math.round(st.at)}mm 横切`
        note(ctx, `${sp}.label`, '补默认值', '刀路说明缺失，按坐标生成')
      }
    })
  }

  // 面积与利用率（mm² 整数）
  if (num(s.usedAreaMm2) === undefined) {
    s.usedAreaMm2 = s.placements.reduce((a, p) => a + Math.round(p.origLen * p.origWid), 0)
    mark('usedAreaMm2')
    note(ctx, `${path}.usedAreaMm2`, '重算', '已用面积缺失，按零件净面积累加（不含锯路）')
  }
  if (num(s.boardAreaMm2) === undefined) {
    s.boardAreaMm2 = Math.round(s.wMm * s.hMm)
    mark('boardAreaMm2')
    note(ctx, `${path}.boardAreaMm2`, '重算', '板面积缺失，按板幅重算')
  }
  if (num(s.utilization) === undefined) {
    s.utilization = s.boardAreaMm2 > 0 ? s.usedAreaMm2 / s.boardAreaMm2 : 0
    mark('utilization')
    note(ctx, `${path}.utilization`, '重算', '利用率缺失，按 净面积/板面积 重算')
  }
  if (migratedFields.length > 0) s.migratedFields = migratedFields
  return s
}

/** 余料矩形 → OffcutInfo：长度取整到 mm、面积 mm² 整数、两边 ≥300mm 才标可用，按面积降序。 */
function leftoversToOffcuts(leftovers: { x: number; y: number; w: number; h: number }[]): OffcutInfo[] {
  const min = boardsData.defaults.offcutMinMm
  return leftovers
    .filter((r) => r.w >= 2 && r.h >= 2)
    .map((r) => {
      const wMm = Math.round(r.w)
      const hMm = Math.round(r.h)
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        wMm,
        hMm,
        areaMm2: Math.round(r.w * r.h),
        usable: r.w >= min - EPS && r.h >= min - EPS
      }
    })
    .sort((a, b) => b.areaMm2 - a.areaMm2)
}
