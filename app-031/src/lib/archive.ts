// 项目存档（JSON）导入导出：版本兼容、默认值补齐、未知字段保留、缺项重算标记
//
// 单位与精度约定（全库统一，导入导出不得改变，缺字段按此补齐）：
// - 长度：毫米 mm，整数（显示时 Math.round 取整）
// - 面积：内部恒为平方毫米 mm²（整数），仅展示时 ÷1e6 折平方米，保留 2 位小数
// - 金额：分 cents（整数），仅展示时 ÷100 折元，保留 2 位小数
// - 利用率：0~1 比值，展示为百分比保留 1 位小数
// - 封边长度：米 m，保留 2 位小数
//
// 兼容策略（两条路里选定的一条，见 README「项目存档兼容」）：
//   老存档的排样结果缺字段时，按当前明细用排样内核（nestJob）整体重算一遍，
//   并重算结果打 recomputedAt/recomputedFields 标记——各页面与打印单据据此标明
//   「导入重算版」，不冒充当时那一次。代价：与当年发到车间的旧版单据可能不一致。
import type { Job, RegisteredOffcut } from '../types'
import { nestJob } from './packing'
import { uid } from './format'
import boardsData from '../data/boards.json'

/** 当前存档结构版本。v1 = 早期版本（无余料档、无按柜体分批、结果字段不全）。 */
export const ARCHIVE_VERSION = 2

export interface FilledDefault {
  path: string // 字段路径，如 useOffcutIds / boards[0].kind / result.savedBoards
  value: string // 补入的默认值（展示用）
  reason: string
}

export interface NormalizeOk {
  ok: true
  job: Job
  filled: FilledDefault[] // 本次按默认值补齐的字段（逐项列出）
  preservedUnknown: string[] // 原样保留的未知字段（顶层路径）
  recompute?: { missing: string[] } // 结果缺项 → 已用排样内核重算
}

export interface NormalizeErr {
  ok: false
  error: string
}

export type NormalizeOutcome = NormalizeOk | NormalizeErr

export interface ImportPlan {
  ok: boolean
  error?: string
  job?: Job // 规范化后的完整项目（尚未写入本机存档）
  filled: FilledDefault[]
  preservedUnknown: string[]
  recompute?: { missing: string[] }
  conflict?: {
    identical: boolean // 内容完全一致 → 重复导入，不写成两版
    existingName: string
    diffs: string[] // 本机 vs 文件 差异清单
  }
  missingOffcutRefs: number // 文件引用但本机没有的登记余料块数
  staleOffcuts: number // 本机余料登记里挂在本项目旧结果上的条数（重算后按旧值保留，需人工核对）
}

// ---------- 基础判断 ----------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

const KNOWN_JOB_KEYS = new Set([
  'id',
  'name',
  'createdAt',
  'boards',
  'parts',
  'kerfMm',
  'trimMm',
  'useOffcutIds',
  'batchByCabinet',
  'result',
  'schemaVersion'
])

const KNOWN_RESULT_KEYS = new Set([
  'sheets',
  'boardsUsed',
  'boardsByType',
  'edgeBandM',
  'unplaced',
  'baselineBoards',
  'savedBoards',
  'savedCents',
  'totalCostCents',
  'stockShortage',
  'elapsedMs',
  'generatedAt',
  'recomputedAt',
  'recomputedFields',
  'origGeneratedAt'
])

const GRAINS = new Set(['length', 'width', 'none'])
const EDGES = new Set(['top', 'bottom', 'left', 'right'])

/** 排样结果必填字段及校验（缺任意一项即触发整体重算）。 */
const RESULT_REQUIRED: [string, (v: unknown) => boolean][] = [
  ['sheets', Array.isArray],
  ['boardsUsed', isNum],
  ['boardsByType', isObj],
  ['edgeBandM', (v) => isObj(v) && isNum(v.exposed) && isNum(v.normal)],
  ['unplaced', Array.isArray],
  ['baselineBoards', isNum],
  ['savedBoards', isNum],
  ['savedCents', isNum],
  ['totalCostCents', isNum],
  ['stockShortage', Array.isArray],
  ['elapsedMs', isNum],
  ['generatedAt', isNum]
]

const SHEET_REQUIRED: [string, (v: unknown) => boolean][] = [
  ['index', isNum],
  ['boardId', isStr],
  ['boardName', isStr],
  ['material', isStr],
  ['thicknessMm', isNum],
  ['wMm', isNum],
  ['hMm', isNum],
  ['priceCents', isNum],
  ['placements', Array.isArray],
  ['steps', Array.isArray],
  ['usedAreaMm2', isNum],
  ['boardAreaMm2', isNum],
  ['utilization', isNum],
  ['offcuts', Array.isArray]
]

const PLACEMENT_REQUIRED: [string, (v: unknown) => boolean][] = [
  ['partId', isStr],
  ['instanceId', isStr],
  ['boardIndex', isNum],
  ['x', isNum],
  ['y', isNum],
  ['lenMm', isNum],
  ['widMm', isNum],
  ['origLen', isNum],
  ['origWid', isNum],
  ['rotated', isBool],
  ['seq', isNum],
  ['code', isStr],
  ['name', isStr],
  ['cabinet', isStr],
  ['exposed', isBool],
  ['grain', (v) => isStr(v) && GRAINS.has(v)],
  ['edgeBands', Array.isArray]
]

function fmtDefault(v: unknown): string {
  const s = JSON.stringify(v)
  return s !== undefined && s.length <= 40 ? s : '[已补齐]'
}

/**
 * 规范化项目存档：在解析后的对象上就地补默认值（不做白名单重建，未知字段自然保留）。
 * 结构性字段（板/零件尺寸）缺失才报错；其余一律按约定默认值补齐并逐项记录。
 */
export function normalizeJob(raw: unknown): NormalizeOutcome {
  if (!isObj(raw)) return { ok: false, error: '文件内容不是项目对象' }
  const obj = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>
  const filled: FilledDefault[] = []
  const fill = (path: string, value: unknown, reason: string): void => {
    filled.push({ path, value: fmtDefault(value), reason })
  }

  // —— 项目级 ——
  if (!isStr(obj.id) || obj.id === '') {
    obj.id = uid('job')
    fill('id', obj.id, '原文件缺项目编号，按新编号补齐（仅此一种情况允许生成）')
  }
  if (!isStr(obj.name) || obj.name.trim() === '') {
    obj.name = '未命名项目'
    fill('name', obj.name, '缺项目名称')
  }
  if (!isNum(obj.createdAt)) {
    const now = Date.now()
    obj.createdAt = now
    fill('createdAt', new Date(now).toLocaleString('zh-CN'), '缺创建时间，按导入时间补齐')
  }
  if (!Array.isArray(obj.boards)) return { ok: false, error: '文件缺少 boards（板材列表），不是有效的项目存档' }
  if (!Array.isArray(obj.parts)) return { ok: false, error: '文件缺少 parts（零件清单），不是有效的项目存档' }
  if (!isNum(obj.kerfMm) || obj.kerfMm <= 0) {
    obj.kerfMm = boardsData.defaults.kerfMm
    fill('kerfMm', obj.kerfMm, `缺锯路，按默认 ${boardsData.defaults.kerfMm}mm 补齐`)
  }
  if (!isNum(obj.trimMm) || obj.trimMm < 0) {
    obj.trimMm = boardsData.defaults.trimMm
    fill('trimMm', obj.trimMm, `缺修边，按默认 ${boardsData.defaults.trimMm}mm 补齐`)
  }
  if (!Array.isArray(obj.useOffcutIds)) {
    obj.useOffcutIds = []
    fill('useOffcutIds', [], '早期版本无余料板档，按空数组补齐（本单不使用登记余料）')
  }
  if (!isBool(obj.batchByCabinet)) {
    obj.batchByCabinet = false
    fill('batchByCabinet', false, '早期版本无按柜体分批项，按 false（不分批）补齐')
  }
  if (!isNum(obj.schemaVersion)) {
    obj.schemaVersion = ARCHIVE_VERSION
    fill('schemaVersion', ARCHIVE_VERSION, '早期版本未标注结构版本，按当前版本补齐')
  }

  // —— 板材 ——
  for (let i = 0; i < obj.boards.length; i++) {
    const b = obj.boards[i]
    if (!isObj(b)) return { ok: false, error: `boards[${i}] 不是对象` }
    if (!isNum(b.wMm) || b.wMm <= 0 || !isNum(b.hMm) || b.hMm <= 0) {
      return { ok: false, error: `boards[${i}] 缺板材尺寸（wMm/hMm），无法按默认值补齐` }
    }
    if (!isStr(b.id) || b.id === '') {
      b.id = uid('b')
      fill(`boards[${i}].id`, b.id, '缺板材 id')
    }
    if (!isNum(b.thicknessMm) || b.thicknessMm <= 0) {
      b.thicknessMm = 18
      fill(`boards[${i}].thicknessMm`, 18, '缺厚度，按 18mm 补齐')
    }
    if (!isStr(b.material) || b.material === '') {
      b.material = '未标注'
      fill(`boards[${i}].material`, '未标注', '缺材质')
    }
    if (!isStr(b.name) || b.name === '') {
      b.name = `${b.material} ${b.wMm}×${b.hMm}×${b.thicknessMm}`
      fill(`boards[${i}].name`, b.name, '缺板材名，按规格生成')
    }
    if (!isNum(b.priceCents) || b.priceCents < 0) {
      b.priceCents = 0
      fill(`boards[${i}].priceCents`, 0, '缺单价，按 0 分补齐')
    }
    if (!isNum(b.quantity) || b.quantity < 0) {
      b.quantity = 0
      fill(`boards[${i}].quantity`, 0, '缺库存张数，按 0（不限）补齐')
    }
    if (b.kind !== 'stock' && b.kind !== 'offcut') {
      b.kind = 'stock'
      fill(`boards[${i}].kind`, 'stock', '早期版本无余料板档，按常规板材补齐')
    }
  }

  // —— 零件 ——
  for (let i = 0; i < obj.parts.length; i++) {
    const p = obj.parts[i]
    if (!isObj(p)) return { ok: false, error: `parts[${i}] 不是对象` }
    if (!isNum(p.lenMm) || p.lenMm <= 0 || !isNum(p.widMm) || p.widMm <= 0) {
      return { ok: false, error: `parts[${i}] 缺零件尺寸（lenMm/widMm），无法按默认值补齐` }
    }
    if (!isStr(p.id) || p.id === '') {
      p.id = uid('p')
      fill(`parts[${i}].id`, p.id, '缺零件 id')
    }
    if (!isStr(p.code) || p.code === '') {
      p.code = `P${i + 1}`
      fill(`parts[${i}].code`, p.code, '缺零件编号，按行号生成')
    }
    if (!isStr(p.name) || p.name === '') {
      p.name = `零件${i + 1}`
      fill(`parts[${i}].name`, p.name, '缺零件名称')
    }
    if (!isNum(p.qty) || p.qty < 1) {
      p.qty = 1
      fill(`parts[${i}].qty`, 1, '缺数量，按 1 补齐')
    } else {
      p.qty = Math.floor(p.qty)
    }
    if (!isStr(p.grain) || !GRAINS.has(p.grain)) {
      p.grain = 'none'
      fill(`parts[${i}].grain`, 'none', '缺纹理要求，按无要求补齐')
    }
    if (!Array.isArray(p.edgeBands)) {
      p.edgeBands = []
      fill(`parts[${i}].edgeBands`, [], '缺封边设置，按不封边补齐')
    } else {
      p.edgeBands = (p.edgeBands as unknown[]).filter((e) => isStr(e) && EDGES.has(e))
    }
    if (!isStr(p.cabinet) || p.cabinet === '') {
      p.cabinet = '未分组'
      fill(`parts[${i}].cabinet`, '未分组', '缺柜体分组')
    }
    if (!isBool(p.exposed)) {
      p.exposed = false
      fill(`parts[${i}].exposed`, false, '缺见光标记，按非见光补齐')
    }
    if (!isStr(p.boardId)) p.boardId = ''
  }

  // —— 排样结果：完整则原样保留（当时那一版）；缺项则按当前明细用内核整体重算并标记 ——
  let recompute: { missing: string[] } | undefined
  if (obj.result === null) {
    delete obj.result
    fill('result', '（空结果已移除）', '原文件 result 为 null，按未排样处理')
  } else if (isObj(obj.result)) {
    const r = obj.result
    const missing: string[] = []
    for (const [key, test] of RESULT_REQUIRED) {
      if (!test(r[key])) missing.push(`result.${key}`)
    }
    if (Array.isArray(r.sheets)) {
      r.sheets.forEach((s, si) => {
        if (!isObj(s)) {
          missing.push(`result.sheets[${si}]`)
          return
        }
        for (const [key, test] of SHEET_REQUIRED) {
          if (!test(s[key])) missing.push(`result.sheets[${si}].${key}`)
        }
        if (Array.isArray(s.placements)) {
          s.placements.forEach((pl, pi) => {
            if (!isObj(pl)) {
              missing.push(`result.sheets[${si}].placements[${pi}]`)
              return
            }
            for (const [key, test] of PLACEMENT_REQUIRED) {
              if (!test(pl[key])) missing.push(`result.sheets[${si}].placements[${pi}].${key}`)
            }
          })
        }
      })
    }
    if (missing.length > 0) {
      // 重算：与 runNest 同源调用 nestJob，保证各页面/打印/存档是同一批数
      const fresh = nestJob(JSON.parse(JSON.stringify({ ...obj, result: undefined })) as Job)
      fresh.recomputedAt = Date.now()
      fresh.recomputedFields = missing
      if (isNum(r.generatedAt)) fresh.origGeneratedAt = r.generatedAt
      // 老结果里的未知字段原样搬到重算结果上，不许丢
      for (const k of Object.keys(r)) {
        if (!KNOWN_RESULT_KEYS.has(k)) (fresh as unknown as Record<string, unknown>)[k] = r[k]
      }
      obj.result = fresh
      recompute = { missing }
    }
  } else if (obj.result !== undefined) {
    delete obj.result
    fill('result', '（无效结果已移除）', '原文件 result 结构无效，按未排样处理')
  }

  const preservedUnknown = Object.keys(obj).filter((k) => !KNOWN_JOB_KEYS.has(k))
  return { ok: true, job: obj as unknown as Job, filled, preservedUnknown, recompute }
}

/** 键序无关的规范化 JSON（判重用）。导入重算产生的时间戳不参与一致性判断。 */
const VOLATILE_KEYS = new Set(['elapsedMs', 'generatedAt', 'recomputedAt'])

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isObj(v)) {
    const body = Object.keys(v)
      .filter((k) => !VOLATILE_KEYS.has(k) && v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')
    return `{${body}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** 本机项目 vs 文件项目 的差异清单（冲突时展示给人定夺）。 */
export function diffJobs(local: Job, incoming: Job): string[] {
  const d: string[] = []
  if (local.name !== incoming.name) d.push(`名称：本机「${local.name}」／文件「${incoming.name}」`)
  if (local.createdAt !== incoming.createdAt) d.push('创建时间不同')
  const qty = (j: Job): number => j.parts.reduce((a, p) => a + p.qty, 0)
  if (local.parts.length !== incoming.parts.length || qty(local) !== qty(incoming)) {
    d.push(
      `零件：本机 ${local.parts.length} 种 / ${qty(local)} 件，文件 ${incoming.parts.length} 种 / ${qty(incoming)} 件`
    )
  }
  if (local.boards.length !== incoming.boards.length) {
    d.push(`板材：本机 ${local.boards.length} 种，文件 ${incoming.boards.length} 种`)
  }
  if (local.kerfMm !== incoming.kerfMm || local.trimMm !== incoming.trimMm) {
    d.push(`锯路/修边：本机 ${local.kerfMm}/${local.trimMm}mm，文件 ${incoming.kerfMm}/${incoming.trimMm}mm`)
  }
  if (local.batchByCabinet !== incoming.batchByCabinet) {
    d.push(`按柜体分批：本机${local.batchByCabinet ? '开' : '关'}，文件${incoming.batchByCabinet ? '开' : '关'}`)
  }
  if (!!local.result !== !!incoming.result) {
    d.push(`排样结果：本机${local.result ? '有' : '无'}，文件${incoming.result ? '有' : '无'}`)
  } else if (local.result && incoming.result) {
    if (local.result.boardsUsed !== incoming.result.boardsUsed) {
      d.push(`用板张数：本机 ${local.result.boardsUsed} 张，文件 ${incoming.result.boardsUsed} 张`)
    }
    if (local.result.generatedAt !== incoming.result.generatedAt) d.push('结果生成时间不同')
    const lr = local.result.recomputedAt != null
    const ir = incoming.result.recomputedAt != null
    if (lr !== ir) d.push(`重算标记：本机${lr ? '是导入重算版' : '是原始版'}，文件相反`)
  }
  if (d.length === 0) d.push('名称、清单与结果概要一致，仅细节字段不同')
  return d
}

/**
 * 生成导入计划：只核对、不写入。确认后由 store.applyImportPlan 整批写入；
 * 取消即整批退回，本机存档不变。
 */
export function planImport(
  json: string,
  existingJobs: Job[],
  localOffcuts: RegisteredOffcut[]
): ImportPlan {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return {
      ok: false,
      error: '不是有效的 JSON 文件',
      filled: [],
      preservedUnknown: [],
      missingOffcutRefs: 0,
      staleOffcuts: 0
    }
  }
  const norm = normalizeJob(raw)
  if (!norm.ok) {
    return {
      ok: false,
      error: norm.error,
      filled: [],
      preservedUnknown: [],
      missingOffcutRefs: 0,
      staleOffcuts: 0
    }
  }
  const plan: ImportPlan = {
    ok: true,
    job: norm.job,
    filled: norm.filled,
    preservedUnknown: norm.preservedUnknown,
    recompute: norm.recompute,
    missingOffcutRefs: 0,
    staleOffcuts: 0
  }
  const existing = existingJobs.find((j) => j.id === norm.job.id)
  if (existing) {
    const identical = canonicalJson(existing) === canonicalJson(norm.job)
    plan.conflict = {
      identical,
      existingName: existing.name,
      diffs: identical ? [] : diffJobs(existing, norm.job)
    }
  }
  plan.missingOffcutRefs = norm.job.useOffcutIds.filter(
    (id) => !localOffcuts.some((o) => o.id === id)
  ).length
  if (norm.recompute) {
    plan.staleOffcuts = localOffcuts.filter((o) => o.jobId === norm.job.id).length
  }
  return plan
}
